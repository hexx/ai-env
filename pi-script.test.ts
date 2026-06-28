// pi-script.test.ts
// pi-script.ts の挙動を Node.js 組み込みの node:test + node:assert で検証する。

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
    assertShellSyntax(script);
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
    assertShellSyntax(script);
    const cases = extractPiResumeCases(script);
    const taskCase = cases.find((line) => line.includes("task-manager"));
    assert.ok(taskCase, "task-manager の case 行が存在する");
    assert.match(taskCase, /--api-key "\$PROFILE_KEY"/);
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
    assertShellSyntax(script);
    const cases = extractPiResumeCases(script);
    const withProjectKey = cases.find((line) => line.includes("with-project-key"));
    const withProfileKey = cases.find((line) => line.includes("with-profile-key"));
    assert.ok(withProjectKey && withProfileKey, "2 つの case 行が全て存在する");
    assert.match(withProjectKey, /--api-key "\$PROJECT_KEY"/);
    assert.doesNotMatch(withProjectKey, /PROFILE_KEY/);
    assert.match(withProfileKey, /--api-key "\$PROFILE_KEY"/);
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
    assertShellSyntax(script);
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
      (_configPath) => {
        const config = loadAiEnvConfig();
        assert.equal(config.projects["test-project"]?.model, "deepseek-v4-flash:xhigh");
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
      (_configPath) => {
        const config = loadAiEnvConfig();
        assert.equal(config.profiles["pi-work"]?.model, "deepseek-v4-flash:xhigh");
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

// ===== デフォルト起動: プロジェクト設定の反映 =====
//
// 課題 #issue-202606280835 の主修正。ai-env を --resume / --bash なしで起動した時、
// projects 内の provider / model / apiKeyEnv が反映されるべき。
// デフォルト起動では pi-resume と同じ case 解決をインライン化するため、
// テストでは case ベースのスクリプト出力を検証する。

// デフォルト起動モード時のスクリプトを生成し、case 本体と project 解決ロジックを返す。
// awk を使って project="${HOST_PROJECT_NAME}" 以降の case ブロックの本体を切り出す。
// 正規表現パースに比べ、空白や改行の変更に対して耐性がある。
const extractDefaultCaseBody = (script: string): string => {
  const { execSync } = require("node:child_process");
  const tmpFile = join(tmpdir(), `pi-default-${Date.now()}.sh`);
  writeFileSync(tmpFile, script);
  try {
    // awk で2番目の case ブロックを切り出す（1番目は pi-resume 関数内）
    // コメント行（# で始まる行）は除外する
    const result = execSync(
      `awk 'BEGIN { count=0 } /^[[:space:]]*case / { count++; if (count == 2) { in_case=1; next } } in_case && /esac/ { exit } in_case { print }' "${tmpFile}"`,
      { encoding: "utf-8" }
    );
    const body = result.trim();
    if (!body) {
      throw new Error("default case body が見つからない");
    }
    return body;
  } catch (err) {
    if (err instanceof Error && err.message.includes("default case body")) {
      throw err;
    }
    throw new Error("default case body が見つからない");
  } finally {
    rmSync(tmpFile, { force: true });
  }
};

// デフォルト起動時の指定プロジェクトの case 行(例: "    pi) pi ... ;;")を抽出する。
// 文字列包含で検索する（awk で抽出済みのため、正規表現不要）。
const findDefaultCaseLine = (
  script: string,
  project: string,
): string | undefined => {
  const body = extractDefaultCaseBody(script);
  const lines = body.split("\n");
  return lines.find(
    (line) => line.includes(`${project})`) && line.includes("pi"),
  );
};

describe("buildInitScript - デフォルト起動でプロジェクト設定を反映", () => {
  it("プロジェクト側の provider / model / apiKeyEnv が pi コマンドに渡る", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {
        pi: {
          apiKeyEnv: "LLM_API_KEY",
          model: "deepseek-v4-flash:xhigh",
          provider: "opencode-go",
          session: "019f0b62-a4db-75ad-af9f-d78d43604605",
        },
      },
    });
    assertShellSyntax(script);
    const caseLine = findDefaultCaseLine(script, "pi");
    assert.ok(caseLine, "pi の case 行が存在する");
    assert.match(caseLine, /--provider opencode-go/);
    assert.match(caseLine, /--model deepseek-v4-flash:xhigh/);
    assert.match(caseLine, /--api-key "\$LLM_API_KEY"/);
    assert.match(caseLine, /--session 019f0b62-a4db-75ad-af9f-d78d43604605/);
  });

  it("プロジェクト設定とプロフィールデフォルトが混在しても各プロジェクトのケースが正しく生成される", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: "PROFILE_KEY",
      defaultModel: "claude-3-5-sonnet-20241022",
      defaultProvider: "anthropic",
      projects: {
        // プロジェクト側に明示 → プロジェクト側の値
        "ai-env": {
          apiKeyEnv: "PROJECT_KEY",
          model: "minimax-m3",
          provider: "opencode-go",
          session: "019ec00f-6774-7719-9d32-0ce0acf7892f",
        },
        // プロジェクト側に未指定 → プロフィールデフォルト
        "task-manager": {
          session: "019ea76f-92d3-7442-a675-b79162e7f1c7",
        },
      },
    });
    assertShellSyntax(script);
    const aiEnvLine = findDefaultCaseLine(script, "ai-env");
    const taskLine = findDefaultCaseLine(script, "task-manager");
    assert.ok(aiEnvLine && taskLine);
    assert.match(aiEnvLine, /--provider opencode-go/);
    assert.match(aiEnvLine, /--model minimax-m3/);
    assert.match(aiEnvLine, /--api-key "\$PROJECT_KEY"/);
    assert.match(taskLine, /--provider anthropic/);
    assert.match(taskLine, /--model claude-3-5-sonnet-20241022/);
    assert.match(taskLine, /--api-key "\$PROFILE_KEY"/);
  });

  it("projects が空でもシェルスクリプトとして成立する(*) 分岐で pi を起動)", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {},
    });
    assertShellSyntax(script);
    const body = extractDefaultCaseBody(script);
    assert.match(body, /^\s*\*\) pi ;;$/m);
  });

  it("未知プロジェクト用 *) 分岐ではプロフィールデフォルトで pi を起動する", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: "PROFILE_KEY",
      defaultModel: "claude-3-5-sonnet-20241022",
      defaultProvider: "anthropic",
      projects: {
        known: {
          session: "019ea76f-92d3-7442-a675-b79162e7f1c7",
        },
      },
    });
    assertShellSyntax(script);
    const body = extractDefaultCaseBody(script);
    assert.match(body, /^\s*\*\) pi --provider anthropic --model claude-3-5-sonnet-20241022 ;;$/m);
  });
});

// ===== CLI オーバーライド =====

describe("buildInitScript - CLI オーバーライド (CLI > Project > Profile)", () => {
  it("デフォルト起動で CLI の provider / model が未知プロジェクト用 *) 分岐で使われる", () => {
    const script = buildInitScript({
      cliModel: "claude-opus-4-7",
      cliProvider: "anthropic",
      defaultApiKeyEnv: undefined,
      defaultModel: "claude-3-5-sonnet-20241022",
      defaultProvider: "anthropic",
      projects: {
        known: {
          session: "019ea76f-92d3-7442-a675-b79162e7f1c7",
        },
      },
    });
    assertShellSyntax(script);
    const body = extractDefaultCaseBody(script);
    assert.match(body, /^\s*\*\) pi --provider anthropic --model claude-opus-4-7 ;;$/m);
  });

  it("CLI の provider / model はプロジェクト case より優先される", () => {
    const script = buildInitScript({
      cliModel: "override-model",
      cliProvider: "override-provider",
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {
        pi: {
          model: "original-model",
          provider: "original-provider",
          session: "019f0b62-a4db-75ad-af9f-d78d43604605",
        },
      },
    });
    assertShellSyntax(script);
    const caseLine = findDefaultCaseLine(script, "pi");
    assert.ok(caseLine);
    assert.match(caseLine, /--provider override-provider/);
    assert.match(caseLine, /--model override-model/);
    assert.doesNotMatch(caseLine, /original-provider/);
    assert.doesNotMatch(caseLine, /original-model/);
  });

  it("pi-resume 関数では *) 分岐に警告メッセージ+ pi (引数なし) を維持する", () => {
    const script = buildInitScript({
      cliModel: "override-model",
      cliProvider: "override-provider",
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {},
      resume: true,
    });
    assertShellSyntax(script);
    // pi-resume 関数内の *) 分岐は警告 + pi (引数なし) を維持。
    assert.match(script, /Warning: Unknown project - trying pi with defaults/);
    // 関数の直後の呼び出しでは pi-resume を使う(デフォルト起動と区別)。
    assert.match(script, /\npi-resume\n/);
  });
});

// ===== --bash モードの CLI オーバーライド =====

describe("buildInitScript - --bash モードで CLI オプションを env 変数として export", () => {
  it("--provider を指定すると PI_PROVIDER として export される", () => {
    const script = buildInitScript({
      bashMode: true,
      cliProvider: "opencode-go",
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {},
    });
    assertShellSyntax(script);
    assert.match(script, /^export PI_PROVIDER="opencode-go"$/m);
    assert.match(script, /\nexec \/bin\/bash$/m);
  });

  it("3 つの CLI オプション全て指定すると 3 つの env 変数として export される", () => {
    const script = buildInitScript({
      bashMode: true,
      cliApiKeyEnv: "WORK_API_KEY",
      cliModel: "deepseek-v4-flash:xhigh",
      cliProvider: "opencode-go",
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {},
    });
    assertShellSyntax(script);
    assert.match(script, /^export PI_PROVIDER="opencode-go"$/m);
    assert.match(script, /^export PI_MODEL="deepseek-v4-flash:xhigh"$/m);
    assert.match(script, /^export PI_API_KEY_ENV="WORK_API_KEY"$/m);
  });

  it("CLI オプションが何も指定されなければ export 行は出力されない", () => {
    const script = buildInitScript({
      bashMode: true,
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {},
    });
    assertShellSyntax(script);
    assert.doesNotMatch(script, /^export PI_/m);
    assert.match(script, /\nexec \/bin\/bash$/m);
  });

  it("--bash モードでも pi-resume 関数は .bashrc に注入される", () => {
    const script = buildInitScript({
      bashMode: true,
      cliProvider: "opencode-go",
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {
        pi: {
          session: "019f0b62-a4db-75ad-af9f-d78d43604605",
        },
      },
    });
    assertShellSyntax(script);
    // pi-resume 関数が bashrc に注入される。
    assert.match(script, /pi-resume\(\) \{/);
  });
});

// ===== validateCliOverrides =====

