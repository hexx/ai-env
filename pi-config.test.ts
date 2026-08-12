// pi-config.test.ts
// pi-config.ts の挙動を Node.js 組み込みの node:test + node:assert で検証する。

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAiEnvConfig } from "./pi-projects";

// ===== ヘルパー =====



// テスト用の一時ディレクトリ配下に pi-projects.json を書き出す。
// 戻り値は「ディレクトリ作成時に作った一時ディレクトリの cleanup 関数」。
// 呼び出し側はテスト終了時に cleanup() を呼ぶ(afterEach 的な使い方)。
const withTempConfig = async (
  content: object,
  fn: (configPath: string) => Promise<void> | void,
): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "pi-projects-test-"));
  const configPath = join(dir, "pi-projects.json");
  writeFileSync(configPath, JSON.stringify(content, null, 2));
  const previous = process.env.AI_ENV_PI_PROJECTS;
  process.env.AI_ENV_PI_PROJECTS = configPath;
  try {
    await fn(configPath);
  } finally {
    if (previous === undefined) {
      delete process.env.AI_ENV_PI_PROJECTS;
    } else {
      process.env.AI_ENV_PI_PROJECTS = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
};

// ===== テスト =====

describe("ProfileConfig.apiKeyEnv", () => {
  it("apiKeyEnv が POSIX 環境変数名として有効なら読み込める", async () => {
    await withTempConfig(
      {
        profiles: {
          "pi-work": {
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "WORK_API_KEY",
            OCR_LLM_MODEL: "claude-3-5-sonnet-20241022",
            apiKeyEnv: "WORK_API_KEY",
          },
        },
        projects: {
          "ai-env": {
            session: "019ec00f-6774-7719-9d32-0ce0acf7892f",
          },
        },
      },
      (_configPath) => {
        const config = loadAiEnvConfig();
        assert.equal(config.profiles["pi-work"]?.apiKeyEnv, "WORK_API_KEY");
      },
    );
  });

  it("apiKeyEnv にドットを含む不正値を指定するとエラー", async () => {
    await withTempConfig(
      {
        profiles: {
          "pi-work": {
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "WORK_API_KEY",
            OCR_LLM_MODEL: "claude-3-5-sonnet-20241022",
            apiKeyEnv: "WORK.API.KEY",
          },
        },
        projects: {
          "ai-env": {
            session: "019ec00f-6774-7719-9d32-0ce0acf7892f",
          },
        },
      },
      () => {
        assert.throws(
          () => loadAiEnvConfig(),
          /apiKeyEnv/,
        );
      },
    );
  });

  it("apiKeyEnv が空文字なら拒否する", async () => {
    await withTempConfig(
      {
        profiles: {
          "pi-work": {
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "WORK_API_KEY",
            OCR_LLM_MODEL: "claude-3-5-sonnet-20241022",
            apiKeyEnv: "",
          },
        },
        projects: {
          "ai-env": {
            session: "019ec00f-6774-7719-9d32-0ce0acf7892f",
          },
        },
      },
      () => {
        assert.throws(
          () => loadAiEnvConfig(),
          /apiKeyEnv/,
        );
      },
    );
  });
});

// ===== フォールバック挙動 =====


// ===== ProjectConfig.session 廃止 (ADR 0005) =====

// session は廃止された(コンテナ内 cwd をプロジェクトごとに分け、pi -c でセッション再開を
// 実現するため。docs/adr/0005 参照)。旧形式の session フィールド・文字列値は後方互換の
// ため読み飛ばされ、provider / model / apiKeyEnv のみが設定として使われる。

describe("ProjectConfig - session 廃止", () => {
  it("session なしのプロジェクト設定が読み込める", async () => {
    await withTempConfig(
      {
        profiles: {
          "pi-work": {
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "WORK_API_KEY",
            OCR_LLM_MODEL: "claude-3-5-sonnet-20241022",
          },
        },
        projects: {
          "ai-env": {
            provider: "opencode-go",
            model: "minimax-m3",
            apiKeyEnv: "LLM_API_KEY",
          },
          "task-manager": {},
        },
      },
      (_configPath) => {
        const config = loadAiEnvConfig();
        assert.equal(config.projects["ai-env"]?.provider, "opencode-go");
        assert.equal(config.projects["ai-env"]?.model, "minimax-m3");
        assert.equal(config.projects["ai-env"]?.apiKeyEnv, "LLM_API_KEY");
        // session は存在しない
        assert.ok(!("session" in config.projects["ai-env"]!));
        // 空オブジェクトのプロジェクトも許容される
        assert.deepEqual(config.projects["task-manager"], {});
      },
    );
  });

  it("旧形式の session フィールドは読み飛ばされる(後方互換)", async () => {
    await withTempConfig(
      {
        profiles: {
          "pi-work": {
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "WORK_API_KEY",
            OCR_LLM_MODEL: "claude-3-5-sonnet-20241022",
          },
        },
        projects: {
          "ai-env": {
            session: "019ec00f-6774-7719-9d32-0ce0acf7892f",
            provider: "opencode-go",
          },
        },
      },
      (_configPath) => {
        const config = loadAiEnvConfig();
        assert.equal(config.projects["ai-env"]?.provider, "opencode-go");
        assert.ok(!("session" in config.projects["ai-env"]!), "session は読み飛ばされる");
      },
    );
  });

  it("旧形式の文字列値(セッション ID のみ)は空設定として読み飛ばされる", async () => {
    await withTempConfig(
      {
        profiles: {
          "pi-work": {
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "WORK_API_KEY",
            OCR_LLM_MODEL: "claude-3-5-sonnet-20241022",
          },
        },
        projects: {
          "mindmap": "019e9b9f-e299-7b7f-a1c1-cc6c5753efc4",
        },
      },
      (_configPath) => {
        const config = loadAiEnvConfig();
        assert.deepEqual(config.projects["mindmap"], {});
      },
    );
  });
});
