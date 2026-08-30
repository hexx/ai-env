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
            credentialKeys: ["OPENAI_API_KEY", "OPENCODE_API_KEY"],
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
            OCR_LLM_MODEL: "claude-3-5-sonnet-20241022",
            apiKeyEnv: "OPENAI_API_KEY",
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
        assert.equal(config.profiles["pi-work"]?.apiKeyEnv, "OPENAI_API_KEY");
      },
    );
  });

  it("apiKeyEnv にドットを含む不正値を指定するとエラー", async () => {
    await withTempConfig(
      {
        profiles: {
          "pi-work": {
            credentialKeys: ["OPENAI_API_KEY", "OPENCODE_API_KEY"],
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
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
            credentialKeys: ["OPENAI_API_KEY", "OPENCODE_API_KEY"],
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
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

// ===== credentialKeys =====

describe("ProfileConfig.credentialKeys", () => {
  const baseProfile = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    credentialKeys: ["OPENAI_API_KEY", "OPENCODE_API_KEY"],
    OCR_USE_ANTHROPIC: "false",
    OCR_LLM_URL: "https://opencode.ai/zen/go/v1",
    OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
    OCR_LLM_MODEL: "mimo-v2.5-pro",
    ...overrides,
  });

  it("credentialKeys と apiKeyEnv を読み込める", async () => {
    await withTempConfig(
      {
        profiles: { "pi-private": baseProfile({ apiKeyEnv: "OPENAI_API_KEY" }) },
        projects: { "ai-env": {} },
      },
      () => {
        const config = loadAiEnvConfig();
        assert.deepEqual(config.profiles["pi-private"]?.credentialKeys, [
          "OPENAI_API_KEY",
          "OPENCODE_API_KEY",
        ]);
        assert.equal(config.profiles["pi-private"]?.apiKeyEnv, "OPENAI_API_KEY");
      },
    );
  });

  it("ZAI_PLATFORM_API_KEY と zai-platform プロバイダ設定を読み込める", async () => {
    // zai-platform は Pi の Provider Catalog(models.json)側で宣言するカスタム provider。
    // ai-env は名前を検証せず、パス表現だけ通す(SAFE_SHELL_PATTERN / SAFE_MODEL_PATTERN)。
    await withTempConfig(
      {
        profiles: {
          "pi-private": baseProfile({
            credentialKeys: ["OPENCODE_API_KEY", "ZAI_PLATFORM_API_KEY"],
            provider: "zai-platform",
            model: "glm-5.3-flash",
            apiKeyEnv: "ZAI_PLATFORM_API_KEY",
          }),
        },
        projects: { "ai-env": {} },
      },
      () => {
        const config = loadAiEnvConfig();
        assert.equal(config.profiles["pi-private"]?.provider, "zai-platform");
        assert.equal(config.profiles["pi-private"]?.model, "glm-5.3-flash");
        assert.equal(config.profiles["pi-private"]?.apiKeyEnv, "ZAI_PLATFORM_API_KEY");
      },
    );
  });

  it("credentialKeys がないProfileを拒否する", async () => {
    await withTempConfig(
      {
        profiles: {
          "pi-private": baseProfile({ credentialKeys: undefined }),
        },
        projects: { "ai-env": {} },
      },
      () => assert.throws(() => loadAiEnvConfig(), /credentialKeys/),
    );
  });

  it("未登録のクレデンシャルをcredentialKeysへ指定すると拒否する", async () => {
    // 例はあえて汎用的な未登録名を使う。ZAI_API_KEY(pi 組み込み zai = Z.AI Coding Plan)
    // も未登録だが、将来の対応で registered になる可能性があり、
    // 「未登録の例」としての fixture には据えない(docs/spec/0007)。
    await withTempConfig(
      {
        profiles: {
          "pi-private": baseProfile({ credentialKeys: ["NOT_A_CREDENTIAL_KEY"] }),
        },
        projects: { "ai-env": {} },
      },
      () => assert.throws(() => loadAiEnvConfig(), /登録済みクレデンシャル|NOT_A_CREDENTIAL_KEY/),
    );
  });

  it("OCR_LLM_TOKEN_KEY がcredentialKeysにないProfileを拒否する", async () => {
    await withTempConfig(
      {
        profiles: {
          "pi-private": baseProfile({
            credentialKeys: ["OPENAI_API_KEY"],
            OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
          }),
        },
        projects: { "ai-env": {} },
      },
      () => assert.throws(() => loadAiEnvConfig(), /OCR_LLM_TOKEN_KEY|credentialKeys/),
    );
  });

  it("ProfileのapiKeyEnvがcredentialKeysにない場合を拒否する", async () => {
    await withTempConfig(
      {
        profiles: {
          "pi-private": baseProfile({
            credentialKeys: ["OPENCODE_API_KEY"],
            apiKeyEnv: "OPENAI_API_KEY",
          }),
        },
        projects: { "ai-env": {} },
      },
      () => assert.throws(() => loadAiEnvConfig(), /apiKeyEnv|credentialKeys/),
    );
  });

  it("credentialKeys の重複を拒否する", async () => {
    await withTempConfig(
      {
        profiles: {
          "pi-private": baseProfile({
            credentialKeys: ["OPENAI_API_KEY", "OPENAI_API_KEY"],
          }),
        },
        projects: { "ai-env": {} },
      },
      () => assert.throws(() => loadAiEnvConfig(), /重複/),
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
            credentialKeys: ["LLM_API_KEY", "OPENCODE_API_KEY"],
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
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

  it("Project に zai-platform / glm-5.3-flash を指定できる", async () => {
    await withTempConfig(
      {
        profiles: {
          "pi-private": {
            credentialKeys: ["OPENCODE_API_KEY", "ZAI_PLATFORM_API_KEY"],
            OCR_USE_ANTHROPIC: "false",
            OCR_LLM_URL: "https://opencode.ai/zen/go/v1",
            OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
            OCR_LLM_MODEL: "mimo-v2.5-pro",
          },
        },
        projects: {
          "glm-playground": {
            provider: "zai-platform",
            model: "glm-5.3-flash",
            apiKeyEnv: "ZAI_PLATFORM_API_KEY",
          },
        },
      },
      () => {
        const config = loadAiEnvConfig();
        assert.equal(config.projects["glm-playground"]?.provider, "zai-platform");
        assert.equal(config.projects["glm-playground"]?.model, "glm-5.3-flash");
        assert.equal(config.projects["glm-playground"]?.apiKeyEnv, "ZAI_PLATFORM_API_KEY");
      },
    );
  });

  it("旧形式の session フィールドは読み飛ばされる(後方互換)", async () => {
    await withTempConfig(
      {
        profiles: {
          "pi-work": {
            credentialKeys: ["OPENCODE_API_KEY"],
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
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
            credentialKeys: ["OPENCODE_API_KEY"],
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
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
