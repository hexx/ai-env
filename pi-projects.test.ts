// pi-projects.test.ts
// pi-projects.ts の挙動を Node.js 組み込みの node:test + node:assert で検証する。
// 外部テストフレームワークに依存しないことで、追加の devDependency を導入せず
// 軽量に動作確認できる。
//
// 実行: `npm test` (package.json 経由で `node --import tsx --test` を呼び出す)
//
// カバー範囲:
//  - ProfileConfig.apiKeyEnv のパースとバリデーション
//  - buildInitScript が生成する pi-resume シェル関数での apiKeyEnv フォールバック挙動
//    - プロジェクト側に apiKeyEnv あり → プロジェクト側の値を使用
//    - プロジェクト側になし + プロファイル側に apiKeyEnv あり → プロファイル側の値を使用
//    - どちらも未指定 → --api-key フラグを出力しない

import { describe, it } from "node:test";
import { ok, strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInitScript, loadAiEnvConfig } from "./pi-projects";

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

// buildInitScript の出力から pi-resume 関数部分だけを抽出して case 行の配列を返す。
// 文字列マッチで「<project>) pi ... ;;」の行を切り出す。
const extractPiResumeCases = (script: string): string[] => {
  // pi-resume 関数本体は cat << 'PI_RESUME_EOF' ... PI_RESUME_EOF で囲まれた
  // ブロックと、その直後に同じ内容で書き出される「実行用ブロック」の 2 箇所に
  // 出力される。重複を除外するためどちらかに絞らず、空行でない case 行だけ拾う。
  const lines = script.split("\n");
  return lines.filter((line) => /^\s+[a-zA-Z0-9_-]+\) pi .*;;$/.test(line));
};

// ===== バリデーション =====

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
      (configPath) => {
        const config = loadAiEnvConfig();
        assert.equal(config.profiles["pi-work"]?.apiKeyEnv, "WORK_API_KEY");
        // configPath を引数として消費(未使用警告回避と意図の明示)。
        ok(configPath.length > 0);
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

describe("buildInitScript - apiKeyEnv フォールバック", () => {
  it("プロジェクト側に apiKeyEnv がある場合、プロジェクト側の値を使う", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: "PROFILE_KEY",
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {
        "ai-env": {
          apiKeyEnv: "PROJECT_KEY",
          session: "019ec00f-6774-7719-9d32-0ce0acf7892f",
        },
      },
    });
    const cases = extractPiResumeCases(script);
    const aiEnvCase = cases.find((line) => line.includes("ai-env"));
    assert.ok(aiEnvCase, "ai-env の case 行が存在する");
    assert.match(aiEnvCase, /--api-key "\$PROJECT_KEY"/);
    assert.doesNotMatch(aiEnvCase, /PROFILE_KEY/);
  });

  it("プロジェクト側に apiKeyEnv がない場合、プロファイルの defaultApiKeyEnv を使う", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: "PROFILE_KEY",
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {
        "task-manager": {
          session: "019ea76f-92d3-7442-a675-b79162e7f1c7",
        },
      },
    });
    const cases = extractPiResumeCases(script);
    const taskCase = cases.find((line) => line.includes("task-manager"));
    assert.ok(taskCase, "task-manager の case 行が存在する");
    assert.match(taskCase, /--api-key "\$PROFILE_KEY"/);
  });

  it("プロジェクト側にもプロファイル側にも apiKeyEnv がない場合、--api-key フラグを出力しない", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {
        "skills": {
          session: "019ea74c-38d6-7700-89b8-c24f47f19e9e",
        },
      },
    });
    const cases = extractPiResumeCases(script);
    const skillsCase = cases.find((line) => line.includes("skills"));
    assert.ok(skillsCase, "skills の case 行が存在する");
    assert.doesNotMatch(skillsCase, /--api-key/);
  });

  it("複数のプロジェクトで apiKeyEnv の有無が混在していてもそれぞれ正しく生成される", () => {
    // プロジェクト単位で apiKeyEnv を持つもの / プロファイルからのフォールバックを
    // 受けるもの / デフォルト自身も undefined のため --api-key を出さないものを混在させる。
    const script = buildInitScript({
      defaultApiKeyEnv: "PROFILE_KEY",
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {
        "with-project-key": {
          apiKeyEnv: "PROJECT_KEY",
          session: "11111111-1111-1111-1111-111111111111",
        },
        "with-profile-key": {
          session: "22222222-2222-2222-2222-222222222222",
        },
      },
    });
    const cases = extractPiResumeCases(script);
    const withProjectKey = cases.find((line) => line.includes("with-project-key"));
    const withProfileKey = cases.find((line) => line.includes("with-profile-key"));
    assert.ok(withProjectKey && withProfileKey, "2 つの case 行が全て存在する");
    assert.match(withProjectKey, /--api-key "\$PROJECT_KEY"/);
    assert.doesNotMatch(withProjectKey, /PROFILE_KEY/);
    assert.match(withProfileKey, /--api-key "\$PROFILE_KEY"/);
  });

  it("defaultApiKeyEnv が undefined で全プロジェクトも未指定なら --api-key は出ない", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {
        "no-profile-no-project": {
          session: "33333333-3333-3333-3333-333333333333",
        },
      },
    });
    const cases = extractPiResumeCases(script);
    const noKey = cases.find((line) => line.includes("no-profile-no-project"));
    assert.ok(noKey, "case 行が存在する");
    assert.doesNotMatch(noKey, /--api-key/);
  });

  it("buildInitScript に defaultApiKeyEnv を渡さなくても型エラーなく動作する(オプショナル)", () => {
    // defaultApiKeyEnv を省略しても undefined として扱われ、--api-key は出力されない。
    const script = buildInitScript({
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {
        "task-manager": {
          session: "019ea76f-92d3-7442-a675-b79162e7f1c7",
        },
      },
    });
    const cases = extractPiResumeCases(script);
    assert.ok(cases.some((line) => line.includes("task-manager")));
    assert.ok(!script.includes("--api-key"), "--api-key フラグは出力されない");
  });

  it("プロジェクトの model にコロン区切り書式を指定できる(deepseek-v4-flash:xhigh)", async () => {
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
          "test-project": {
            session: "019ec00f-6774-7719-9d32-0ce0acf7892f",
            model: "deepseek-v4-flash:xhigh",
          },
        },
      },
      (configPath) => {
        const config = loadAiEnvConfig();
        assert.equal(config.projects["test-project"]?.model, "deepseek-v4-flash:xhigh");
        ok(configPath.length > 0);
      },
    );
  });

  it("プロファイルの model にコロン区切り書式を指定できる", async () => {
    await withTempConfig(
      {
        profiles: {
          "pi-work": {
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "WORK_API_KEY",
            OCR_LLM_MODEL: "claude-3-5-sonnet-20241022",
            model: "deepseek-v4-flash:xhigh",
          },
        },
        projects: {
          "test-project": {
            session: "019ec00f-6774-7719-9d32-0ce0acf7892f",
          },
        },
      },
      (configPath) => {
        const config = loadAiEnvConfig();
        assert.equal(config.profiles["pi-work"]?.model, "deepseek-v4-flash:xhigh");
        ok(configPath.length > 0);
      },
    );
  });

  it("プロジェクトの model に不正文字(シェルメタ文字)は引き続き拒否する", async () => {
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
          "test-project": {
            session: "019ec00f-6774-7719-9d32-0ce0acf7892f",
            model: "deepseek-v4-flash;rm -rf /",
          },
        },
      },
      () => {
        assert.throws(
          () => loadAiEnvConfig(),
          /model/,
        );
      },
    );
  });
});
