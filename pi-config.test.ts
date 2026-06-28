// pi-config.test.ts
// pi-config.ts のパース関数と getDefaultConfig の単体テスト。
// loadAiEnvConfig 経由の間接テストは pi-projects.test.ts に委ね、
// ここでは各関数のエラーメッセージ・境界ケース・分岐網羅を直接検証する。
//
// 実行: `npm test` (package.json 経由で `node --import tsx --test` を呼び出す)
//
// カバー範囲:
//  - parseConfigJson: JSONC パース、構文エラー時のメッセージ
//  - toAiEnvConfigObject: 旧形式エラーメッセージ、型不正
//  - parseProfileEntry / parseProfileOcrFields: 必須/任意のフィールド判定
//  - parseProjectEntry: string/object 両対応
//  - parseProjectObjectValue: 必須 session + 任意 provider/model/apiKeyEnv
//  - getDefaultConfig: 出力構造 (pi-private デフォルト)
//  - getAiEnvConfigPath: AI_ENV_PI_PROJECTS 環境変数による上書き

import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  getAiEnvConfigPath,
  getDefaultConfig,
  parseConfigJson,
  parseProjectEntry,
  parseProjectObjectValue,
  parseProfileEntry,
  toAiEnvConfigObject,
} from "./pi-config";

// ===== parseConfigJson =====

describe("parseConfigJson", () => {
  it("通常の JSON をパースする", () => {
    const result = parseConfigJson("test.json", '{"a": 1}');
    assert.deepEqual(result, { a: 1 });
  });

  it("JSONC の行コメントを除去してパースする", () => {
    const result = parseConfigJson(
      "test.json",
      '{\n  // comment\n  "a": 1\n}',
    );
    assert.deepEqual(result, { a: 1 });
  });

  it("JSONC のブロックコメントを除去してパースする", () => {
    const result = parseConfigJson(
      "test.json",
      '{ /* comment */ "a": 1 }',
    );
    assert.deepEqual(result, { a: 1 });
  });

  it("構文エラー時はファイルパスを含めてエラーを投げる", () => {
    assert.throws(
      () => parseConfigJson("my-config.json", "{ broken"),
      /my-config\.json.*JSON パースに失敗/,
    );
  });
});

// ===== toAiEnvConfigObject =====

describe("toAiEnvConfigObject", () => {
  it("profiles / projects を含むオブジェクトを分割する", () => {
    const result = toAiEnvConfigObject("test.json", {
      profiles: { p: {} },
      projects: { x: "s" },
    });
    assert.deepEqual(result, {
      profiles: { p: {} },
      projects: { x: "s" },
    });
  });

  it("profiles / projects がない場合は旧形式エラーメッセージを投げる", () => {
    assert.throws(
      () => toAiEnvConfigObject("test.json", { "old-format": "value" }),
      /新構造.*profiles.*projects.*が必要です/,
    );
  });

  it("null は不正形式としてエラー", () => {
    assert.throws(
      () => toAiEnvConfigObject("test.json", null),
      /\{ profiles:.*projects:.*\}.*構造のオブジェクト/,
    );
  });

  it("配列も不正形式としてエラー", () => {
    assert.throws(
      () => toAiEnvConfigObject("test.json", [1, 2, 3]),
      /\{ profiles:.*projects:.*\}.*構造のオブジェクト/,
    );
  });

  it("文字列も不正形式としてエラー", () => {
    assert.throws(
      () => toAiEnvConfigObject("test.json", "string"),
      /\{ profiles:.*projects:.*\}.*構造のオブジェクト/,
    );
  });
});

// ===== parseProfileEntry =====

describe("parseProfileEntry", () => {
  const validProfile = {
    OCR_USE_ANTHROPIC: "false",
    OCR_LLM_URL: "https://api.example.com/v1",
    OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
    OCR_LLM_MODEL: "mimo-v2.5-pro",
  };

  it("必須 4 フィールドのみで ProfileConfig を組み立てる", () => {
    const result = parseProfileEntry("test.json", "pi-private", validProfile);
    assert.equal(result.OCR_LLM_MODEL, "mimo-v2.5-pro");
    assert.equal(result.OCR_LLM_TOKEN_KEY, "OPENCODE_API_KEY");
    assert.equal(result.OCR_LLM_URL, "https://api.example.com/v1");
    assert.equal(result.OCR_USE_ANTHROPIC, "false");
    assert.equal(result.provider, undefined);
    assert.equal(result.model, undefined);
    assert.equal(result.apiKeyEnv, undefined);
  });

  it("任意フィールド (provider / model / apiKeyEnv) も取り込む", () => {
    const result = parseProfileEntry("test.json", "pi-work", {
      ...validProfile,
      apiKeyEnv: "WORK_API_KEY",
      model: "claude-3-5-sonnet",
      provider: "anthropic",
    });
    assert.equal(result.provider, "anthropic");
    assert.equal(result.model, "claude-3-5-sonnet");
    assert.equal(result.apiKeyEnv, "WORK_API_KEY");
  });

  it("model にコロン区切り書式 (thinkingLevel) を許容する", () => {
    const result = parseProfileEntry("test.json", "p", {
      ...validProfile,
      model: "deepseek-v4-flash:xhigh",
    });
    assert.equal(result.model, "deepseek-v4-flash:xhigh");
  });

  it("model にシェルメタ文字を含むとエラー", () => {
    assert.throws(
      () =>
        parseProfileEntry("test.json", "p", {
          ...validProfile,
          model: "model;rm -rf /",
        }),
      /model/,
    );
  });

  it("必須 OCR_LLM_URL が欠落するとエラー", () => {
    const { OCR_LLM_URL: _, ...rest } = validProfile;
    void _;
    assert.throws(
      () => parseProfileEntry("test.json", "p", rest),
      /OCR_LLM_URL/,
    );
  });

  it("値ではない (string 以外) 場合はエラー", () => {
    assert.throws(
      () => parseProfileEntry("test.json", "p", "not an object"),
      /オブジェクトではありません/,
    );
  });

  it("空オブジェクトもエラー (必須欠落)", () => {
    assert.throws(
      () => parseProfileEntry("test.json", "p", {}),
      /OCR_LLM_MODEL|OCR_LLM_URL|OCR_LLM_TOKEN_KEY|OCR_USE_ANTHROPIC/,
    );
  });
});

// ===== parseProjectEntry =====

describe("parseProjectEntry", () => {
  it("文字列値は session として扱う (後方互換)", () => {
    const result = parseProjectEntry(
      "test.json",
      "my-project",
      "019ec00f-6774-7719-9d32-0ce0acf7892f",
    );
    assert.equal(result.session, "019ec00f-6774-7719-9d32-0ce0acf7892f");
    assert.equal(result.provider, undefined);
    assert.equal(result.model, undefined);
  });

  it("オブジェクト値は session + 任意フィールドとして組み立てる", () => {
    const result = parseProjectEntry("test.json", "my-project", {
      session: "abc",
      provider: "opencode-go",
      model: "mimo-v2.5-pro",
    });
    assert.equal(result.session, "abc");
    assert.equal(result.provider, "opencode-go");
    assert.equal(result.model, "mimo-v2.5-pro");
  });

  it("数値は不正形式としてエラー", () => {
    assert.throws(
      () => parseProjectEntry("test.json", "p", 123),
      /文字列または.*オブジェクトが必要/,
    );
  });

  it("配列は不正形式としてエラー", () => {
    assert.throws(
      () => parseProjectEntry("test.json", "p", ["session"]),
      /文字列または.*オブジェクトが必要/,
    );
  });

  it("null は不正形式としてエラー", () => {
    assert.throws(
      () => parseProjectEntry("test.json", "p", null),
      /文字列または.*オブジェクトが必要/,
    );
  });

  it("空文字 session はエラー", () => {
    assert.throws(
      () => parseProjectEntry("test.json", "p", ""),
      /session.*非空文字列/,
    );
  });
});

// ===== parseProjectObjectValue =====

describe("parseProjectObjectValue", () => {
  it("session のみで組み立てる", () => {
    const result = parseProjectObjectValue("test.json", "p", {
      session: "abc",
    });
    assert.equal(result.session, "abc");
    assert.equal(result.provider, undefined);
  });

  it("apiKeyEnv を POSIX 環境変数名として許容する", () => {
    const result = parseProjectObjectValue("test.json", "p", {
      apiKeyEnv: "WORK_API_KEY",
      session: "abc",
    });
    assert.equal(result.apiKeyEnv, "WORK_API_KEY");
  });

  it("apiKeyEnv にドットを含むとエラー", () => {
    assert.throws(
      () =>
        parseProjectObjectValue("test.json", "p", {
          apiKeyEnv: "WORK.API.KEY",
          session: "abc",
        }),
      /apiKeyEnv/,
    );
  });

  it("session が欠落するとエラー", () => {
    assert.throws(
      () => parseProjectObjectValue("test.json", "p", {}),
      /session/,
    );
  });
});

// ===== getDefaultConfig =====

describe("getDefaultConfig", () => {
  const originalConsoleError = console.error;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    console.error = (msg: string) => {
      captured.push(msg);
    };
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it("profiles に pi-private プロファイルを含む", () => {
    const config = getDefaultConfig();
    assert.ok(config.profiles["pi-private"], "pi-private プロファイルが存在");
  });

  it("projects に pi-private プロジェクトを含む", () => {
    const config = getDefaultConfig();
    assert.ok(config.projects["pi-private"], "pi-private プロジェクトが存在");
  });

  it("プロジェクト session は UUID 形式 (v4, Node.js randomUUID)", () => {
    const config = getDefaultConfig();
    const session = config.projects["pi-private"]?.session;
    assert.ok(session, "session が存在する");
    // UUID v4 は 8-4-4-4-12 の形式。先頭グループがランダム、
    // 3 グループ目が "4" で始まり、4 グループ目が [89ab] のいずれか。
    assert.match(
      session!,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("OCR 設定は 4 つの必須フィールドを持つ", () => {
    const config = getDefaultConfig();
    const profile = config.profiles["pi-private"]!;
    assert.ok(profile.OCR_USE_ANTHROPIC);
    assert.ok(profile.OCR_LLM_URL);
    assert.ok(profile.OCR_LLM_TOKEN_KEY);
    assert.ok(profile.OCR_LLM_MODEL);
  });

  it("呼び出し時に警告メッセージを stderr に出力する", () => {
    getDefaultConfig();
    assert.ok(captured.length > 0, "警告メッセージが出力される");
    assert.match(captured[0] ?? "", /pi-projects\.json が見つからない/);
  });
});

// ===== getAiEnvConfigPath =====

describe("getAiEnvConfigPath", () => {
  const originalEnv = process.env.AI_ENV_PI_PROJECTS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AI_ENV_PI_PROJECTS;
    } else {
      process.env.AI_ENV_PI_PROJECTS = originalEnv;
    }
  });

  it("AI_ENV_PI_PROJECTS 環境変数が設定されているとそれを返す", () => {
    process.env.AI_ENV_PI_PROJECTS = "/custom/path/config.json";
    assert.equal(getAiEnvConfigPath(), "/custom/path/config.json");
  });

  it("環境変数が未設定なら ~/.config/ai-env/pi-projects.json を返す", () => {
    delete process.env.AI_ENV_PI_PROJECTS;
    const path = getAiEnvConfigPath();
    assert.match(path, /\.config\/ai-env\/pi-projects\.json$/);
  });
});
