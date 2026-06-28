// pi-config.test.ts
// pi-config.ts の挙動を Node.js 組み込みの node:test + node:assert で検証する。

import { describe, it } from "node:test";
import { ok, strict as assert } from "node:assert";
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

// bash -n を使ってシェルスクリプトの構文チェックを行う。
// 構文エラーがある場合は例外を送出する。
const assertShellSyntax = (script: string): void => {
  const { execSync } = require("node:child_process");
  const tmpFile = join(tmpdir(), `pi-test-${Date.now()}.sh`);
  writeFileSync(tmpFile, script);
  try {
    execSync(`bash -n "${tmpFile}"`, { encoding: "utf-8" });
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    throw new Error(
      `シェルスクリプトの構文エラー: ${error.stderr || error.message}`,
    );
  } finally {
    rmSync(tmpFile, { force: true });
  }
};

// awk を使って case ブロック内の行を抽出するヘルパー。
// 正規表現パースに比べ、空白や改行の変更に対して耐性がある。
const extractCaseLinesWithAwk = (
  script: string,
  startPattern: string,
): string[] => {
  const { execSync } = require("node:child_process");
  // awk スクリプト: startPattern 以降の case ブロック内の行を抽出
  // 注意: awk では \s が使えないため [[:space:]] を使う
  const awkScript = `
/${startPattern}/ { found=1; next }
found && /^[[:space:]]+case / { in_case=1; next }
found && in_case && /^[[:space:]]+esac/ { exit }
found && in_case && /\) pi / { print }
  `;
  const tmpFile = join(tmpdir(), `pi-awk-${Date.now()}.sh`);
  writeFileSync(tmpFile, script);
  try {
    const result = execSync(`awk '${awkScript}' "${tmpFile}"`, {
      encoding: "utf-8",
    });
    return result
      .split("\n")
      .filter((line: string) => line.trim().length > 0);
  } catch {
    return [];
  } finally {
    rmSync(tmpFile, { force: true });
  }
};

// buildInitScript の出力から pi-resume 関数部分だけを抽出して case 行の配列を返す。
// awk を使って pi-resume() 関数定義以降の case ブロックから case 行を抽出する。
// 正規表現パースに比べ、空白や改行の変更に対して耐性がある。
const extractPiResumeCases = (script: string): string[] => {
  return extractCaseLinesWithAwk(script, "^pi-resume\\(\\)");
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

