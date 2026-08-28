// pi-script.test.ts
// pi-script.ts の挙動を Node.js 組み込みの node:test + node:assert で検証する。

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInitScript, loadAiEnvConfig } from "./pi-projects";

// ===== ヘルパー =====

// テスト共通の workdir(コンテナ内のプロジェクト作業ディレクトリ)。
const TEST_WORKDIR = "/workspace/test-project";

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
found && in_case && /) pi / { print }
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

// デフォルト起動モード時のスクリプトを生成し、case 本体と project 解決ロジックを返す。
// awk を使って project="$(basename "$PWD")" 以降の case ブロックの本体を切り出す。
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

// デフォルト起動時の指定プロジェクトの case 行(例: "    pi) pi -c ... ;;")を抽出する。
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

// ===== 共通: workdir への cd =====

describe("buildInitScript - 共通初期化", () => {
  it("プロジェクトの作業ディレクトリへ cd する", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {},
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    assert.match(script, new RegExp(`^cd ${TEST_WORKDIR}$`, "m"));
  });

  it("pi-resume 関数のプロジェクト名デフォルトはカレントディレクトリ名から解決する", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {},
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    assert.match(script, /local project="\$\{1:-\$\(basename "\$PWD"\)\}"/);
  });
});

// ===== herdr ブリッジの PM2 縮退運用 =====

describe("buildInitScript - herdr ブリッジの PM2 縮退運用", () => {
  const baseParams = {
    defaultApiKeyEnv: undefined,
    defaultModel: undefined,
    defaultProvider: undefined,
    projects: {},
    workdir: TEST_WORKDIR,
  };

  it("PM2 起動経路と socat 直接起動のフォールバックを含む", () => {
    const script = buildInitScript(baseParams);
    assertShellSyntax(script);
    assert.match(script, /if command -v pm2/);
    assert.match(script, /pm2 start socat --name "herdr-socat"/);
    assert.match(
      script,
      /socat UNIX-LISTEN:\/home\/pi\/.config\/herdr\/herdr\.sock,fork,reuseaddr \\\n      TCP:\$\{HOST_IP\}:9123 &/,
    );
    assert.match(script, /HERDR_SOCAT_PID=\$!/);
    assert.match(script, /cleanup_herdr_bridge/);
  });

  it("PM2 と socat が使えない場合も pi 起動へ進む警告を含む", () => {
    const script = buildInitScript(baseParams);
    assertShellSyntax(script);
    assert.match(script, /socat の起動にも失敗したため、herdr ブリッジなしで続行します/);
    assert.match(script, /socat が見つからないため、herdr ブリッジなしで続行します/);
  });

  it("デフォルトモードでは herdr ブリッジのクリーンアップを実行する", () => {
    const script = buildInitScript(baseParams);
    assertShellSyntax(script);
    assert.match(script, /\nrc=\$\?\ncleanup_herdr_bridge\nexit \$rc/);
  });

  it("bash モードの exec /bin/bash を維持する", () => {
    const script = buildInitScript({ ...baseParams, bashMode: true });
    assertShellSyntax(script);
    assert.match(script, /\nexec \/bin\/bash$/m);
  });
});

// ===== apiKeyEnv フォールバック =====

describe("buildInitScript - apiKeyEnv フォールバック", () => {
  it("プロジェクト側に apiKeyEnv がある場合、プロジェクト側の値を使う", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: "PROFILE_KEY",
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {
        "ai-env": {
          apiKeyEnv: "PROJECT_KEY",
        },
      },
      workdir: TEST_WORKDIR,
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
        "task-manager": {},
      },
      workdir: TEST_WORKDIR,
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
        },
        "with-profile-key": {},
      },
      workdir: TEST_WORKDIR,
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
        "task-manager": {},
      },
      workdir: TEST_WORKDIR,
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
            credentialKeys: ["OPENCODE_API_KEY"],
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
            OCR_LLM_MODEL: "claude-3-5-sonnet-20241022",
          },
        },
        projects: {
          "test-project": {
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
            credentialKeys: ["OPENCODE_API_KEY"],
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
            OCR_LLM_MODEL: "claude-3-5-sonnet-20241022",
            model: "deepseek-v4-flash:xhigh",
          },
        },
        projects: {
          "test-project": {},
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
            credentialKeys: ["OPENCODE_API_KEY"],
            OCR_USE_ANTHROPIC: "true",
            OCR_LLM_URL: "https://api.anthropic.com/v1/messages",
            OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
            OCR_LLM_MODEL: "claude-3-5-sonnet-20241022",
          },
        },
        projects: {
          "test-project": {
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
// ai-env を --new / --bash なしで起動した時、projects 内の provider / model /
// apiKeyEnv が反映され、pi -c で前回セッションを続行する(セッションがなければ新規作成)。
// デフォルト起動では pi-resume と同じ case 解決をインライン化するため、
// テストでは case ベースのスクリプト出力を検証する。

describe("buildInitScript - デフォルト起動でプロジェクト設定を反映", () => {
  it("プロジェクト側の provider / model / apiKeyEnv が pi -c に渡る", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {
        pi: {
          apiKeyEnv: "LLM_API_KEY",
          model: "deepseek-v4-flash:xhigh",
          provider: "opencode-go",
        },
      },
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    const caseLine = findDefaultCaseLine(script, "pi");
    assert.ok(caseLine, "pi の case 行が存在する");
    // デフォルト起動は pi -c(前回セッションの続行)
    assert.match(caseLine, /pi -c --provider opencode-go/);
    assert.match(caseLine, /--model deepseek-v4-flash:xhigh/);
    assert.match(caseLine, /--api-key "\$LLM_API_KEY"/);
    // デフォルト起動では --session を付けない(--session は cliSession のみ)。
    assert.doesNotMatch(caseLine, /--session/);
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
        },
        // プロジェクト側に未指定 → プロフィールデフォルト
        "task-manager": {},
      },
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    const aiEnvLine = findDefaultCaseLine(script, "ai-env");
    const taskLine = findDefaultCaseLine(script, "task-manager");
    assert.ok(aiEnvLine && taskLine);
    assert.match(aiEnvLine, /pi -c --provider opencode-go/);
    assert.match(aiEnvLine, /--model minimax-m3/);
    assert.match(aiEnvLine, /--api-key "\$PROJECT_KEY"/);
    assert.match(taskLine, /pi -c --provider anthropic/);
    assert.match(taskLine, /--model claude-3-5-sonnet-20241022/);
    assert.match(taskLine, /--api-key "\$PROFILE_KEY"/);
  });

  it("projects が空でもシェルスクリプトとして成立する(*) 分岐で pi -c を起動)", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {},
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    const body = extractDefaultCaseBody(script);
    assert.match(body, /^\s*\*\) pi -c ;;$/m);
  });

  it("未知プロジェクト用 *) 分岐ではプロフィールデフォルトで pi -c を起動する", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: "PROFILE_KEY",
      defaultModel: "claude-3-5-sonnet-20241022",
      defaultProvider: "anthropic",
      projects: {
        known: {},
      },
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    const body = extractDefaultCaseBody(script);
    assert.match(body, /^\s*\*\) pi -c --provider anthropic --model claude-3-5-sonnet-20241022 ;;$/m);
  });
});

// ===== --new モード =====

describe("buildInitScript - --new モード", () => {
  it("--new 指定時は pi -c を付けず、新しいセッションで pi を起動する", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      newMode: true,
      projects: {
        pi: {
          provider: "opencode-go",
        },
      },
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    const caseLine = findDefaultCaseLine(script, "pi");
    assert.ok(caseLine);
    assert.match(caseLine, /pi --provider opencode-go/);
    assert.doesNotMatch(caseLine, /-c/);
  });

  it("--new 指定時の *) フォールバックは pi (引数なし) になる", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      newMode: true,
      projects: {},
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    const body = extractDefaultCaseBody(script);
    assert.match(body, /^\s*\*\) pi ;;$/m);
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
        known: {},
      },
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    const body = extractDefaultCaseBody(script);
    assert.match(body, /^\s*\*\) pi -c --provider anthropic --model claude-opus-4-7 ;;$/m);
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
        },
      },
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    const caseLine = findDefaultCaseLine(script, "pi");
    assert.ok(caseLine);
    assert.match(caseLine, /--provider override-provider/);
    assert.match(caseLine, /--model override-model/);
    assert.doesNotMatch(caseLine, /original-provider/);
    assert.doesNotMatch(caseLine, /original-model/);
  });

  it("pi-resume 関数では *) 分岐に警告メッセージ+ pi -c (引数なし) を維持する", () => {
    const script = buildInitScript({
      cliModel: "override-model",
      cliProvider: "override-provider",
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {},
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    // pi-resume 関数内の *) 分岐は警告 + pi -c (引数なし) を維持。
    assert.match(script, /Warning: Unknown project - trying pi with defaults/);
    // フォールバック行は awk 抽出パターン( ") pi " )にマッチしないため、
    // pi-resume 関数ブロックを直接切り出して確認する。
    const piResumeFunc = script.match(/pi-resume\(\) \{[\s\S]*?\n\}/);
    assert.ok(piResumeFunc, "pi-resume 関数が存在する");
    assert.match(piResumeFunc[0], /Warning: Unknown project/);
    assert.match(piResumeFunc[0], /pi -c ;;\n  esac/);
  });
});

// ===== --session (明示セッション) =====

// --session <id> は CLI からセッション ID を直接指定して既存セッションを再開する
// 機能。--new と排他(--session は再開を内包)のため、デフォルト起動モードの
// case 解決に cliSession として渡される。provider / model / apiKeyEnv は従来どおり
// CLI > Project > Profile の優先順位で解決する。

describe("buildInitScript - --session (明示セッション)", () => {
  it("デフォルト起動 + cliSession で case に -c と --session <id> が含まれる", () => {
    const script = buildInitScript({
      cliSession: "019fe743-77fc-7ad5-82dd-4f64e7c64517",
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {
        pi: {
          apiKeyEnv: "LLM_API_KEY",
          model: "deepseek-v4-flash:xhigh",
          provider: "opencode-go",
        },
      },
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    const caseLine = findDefaultCaseLine(script, "pi");
    assert.ok(caseLine, "pi の case 行が存在する");
    assert.match(caseLine, /pi -c --provider opencode-go/);
    assert.match(caseLine, /--model deepseek-v4-flash:xhigh/);
    assert.match(caseLine, /--api-key "\$LLM_API_KEY"/);
    // 明示セッションが --session として渡る。
    assert.match(caseLine, /--session 019fe743-77fc-7ad5-82dd-4f64e7c64517/);
  });

  it("未知プロジェクト用 *) 分岐にも cliSession が --session として渡る", () => {
    const script = buildInitScript({
      cliSession: "019fe743-77fc-7ad5-82dd-4f64e7c64517",
      defaultApiKeyEnv: "PROFILE_KEY",
      defaultModel: "claude-3-5-sonnet-20241022",
      defaultProvider: "anthropic",
      projects: {
        known: {},
      },
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    const body = extractDefaultCaseBody(script);
    assert.match(
      body,
      /^\s*\*\) pi -c --provider anthropic --model claude-3-5-sonnet-20241022 --session 019fe743-77fc-7ad5-82dd-4f64e7c64517 ;;$/m,
    );
  });

  it("cliSession を渡さなければ --session を含まない(pi -c のみ)", () => {
    const script = buildInitScript({
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {
        pi: {},
      },
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    const caseLine = findDefaultCaseLine(script, "pi");
    assert.ok(caseLine);
    assert.doesNotMatch(caseLine, /--session/);
    assert.match(caseLine, /-c/);
  });

  it("cliSession は pi-resume 関数に焼き込まれない(ワンショット)", () => {
    const script = buildInitScript({
      cliSession: "019fe743-77fc-7ad5-82dd-4f64e7c64517",
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {
        pi: {},
      },
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    // pi-resume 関数は projects 設定のみを使い、cliSession は関数に反映されない。
    const cases = extractPiResumeCases(script);
    const piCase = cases.find((line) => line.includes("pi)"));
    assert.ok(piCase, "pi の case 行が pi-resume 関数内に存在する");
    assert.doesNotMatch(piCase, /019fe743-77fc-7ad5-82dd-4f64e7c64517/);
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
      workdir: TEST_WORKDIR,
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
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    assert.match(script, /^export PI_PROVIDER="opencode-go"$/m);
    assert.match(script, /^export PI_MODEL="deepseek-v4-flash:xhigh"$/m);
    assert.match(script, /^export PI_API_KEY_ENV="WORK_API_KEY"$/m);
  });

  it("--session を指定すると PI_SESSION として export される", () => {
    const script = buildInitScript({
      bashMode: true,
      cliSession: "019fe743-77fc-7ad5-82dd-4f64e7c64517",
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {},
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    assert.match(script, /^export PI_SESSION="019fe743-77fc-7ad5-82dd-4f64e7c64517"$/m);
    assert.match(script, /\nexec \/bin\/bash$/m);
  });

  it("CLI オプションが何も指定されなければ export 行は出力されない", () => {
    const script = buildInitScript({
      bashMode: true,
      defaultApiKeyEnv: undefined,
      defaultModel: undefined,
      defaultProvider: undefined,
      projects: {},
      workdir: TEST_WORKDIR,
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
        pi: {},
      },
      workdir: TEST_WORKDIR,
    });
    assertShellSyntax(script);
    // pi-resume 関数が bashrc に注入される。
    assert.match(script, /pi-resume\(\) \{/);
  });
});

// ===== herdr セッション再アンカー競合への対処（ADR 0003） =====

describe("buildInitScript - herdr セッション再アンカー競合への対処", () => {
  const baseParams = {
    defaultApiKeyEnv: undefined,
    defaultModel: undefined,
    defaultProvider: undefined,
    projects: {},
    workdir: TEST_WORKDIR,
  };

  it("デフォルト起動では pi 起動前に Agent Presence 待機ブロックが入る", () => {
    const script = buildInitScript(baseParams);
    assertShellSyntax(script);
    assert.match(script, /Agent Presence 確立を待機/);
    assert.match(script, /herdr agent explain/);
    // 待機ブロックが pi 起動 (case 解決) より前にあること。
    assert.ok(
      script.indexOf("herdr agent explain") < script.indexOf('project="$(basename "$PWD")"'),
    );
  });

  it("--new モードでも pi 起動前に Agent Presence 待機ブロックが入る", () => {
    const script = buildInitScript({ ...baseParams, newMode: true });
    assertShellSyntax(script);
    assert.match(script, /herdr agent explain/);
  });

  it("--bash モードでは Agent Presence 待機ブロックが入らない", () => {
    const script = buildInitScript({ ...baseParams, bashMode: true });
    assertShellSyntax(script);
    assert.doesNotMatch(script, /Agent Presence 確立を待機/);
    assert.doesNotMatch(script, /herdr agent explain/);
  });

  it("全モードで herdr-agent-state.ts への自己修復パッチが含まれる", () => {
    const script = buildInitScript(baseParams);
    assertShellSyntax(script);
    assert.match(script, /HERDR_INTEGRATION_VERSION=8/);
    assert.match(script, /void reportSession\("resume"\)/);
    assert.match(script, /sed -i 's\|void reportSession\(\);\|void reportSession\("resume"\);\|'/);
  });

  it("bash モードでも自己修復パッチは含まれる（後で pi を手動起動した場合に備える）", () => {
    const script = buildInitScript({ ...baseParams, bashMode: true });
    assertShellSyntax(script);
    assert.match(script, /HERDR_INTEGRATION_VERSION=8/);
  });
});