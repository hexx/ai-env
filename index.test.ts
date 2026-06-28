// index.test.ts
// index-helpers.ts の挙動を Node.js 組み込みの node:test + node:assert で検証する。
// セキュリティクリティカルな redactSecrets / buildVolumeArgs を重点的にカバーし、
// 副作用を持つ関数は依存性注入パターンでモック関数を渡してテストする。
//
// 実行: `npm test` (package.json 経由で `node --import tsx --test` を呼び出す)
//
// カバー範囲:
//  - SECRET_ENV_PATTERN 正規表現の単体テスト
//  - redactSecrets による API_KEY/TOKEN 値のマスキング
//  - buildVolumeArgs による SSH 鍵の :ro 読み取り専用マウント保証
//  - buildEnvArgs / buildContainerArgs の引数組み立て
//  - detectProfileName によるパスセグメントベースのプロファイル自動判別
//  - requireEnv / handleError / isMacOS の基本動作
//  - getCredential / getHostIp / loadCredentials / runContainer の依存性注入モックテスト

import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  CREDENTIAL_SOURCES,
  IMAGE_NAME,
  SECRET_ENV_PATTERN,
  buildContainerArgs,
  buildEnvArgs,
  buildVolumeArgs,
  detectProfileName,
  getCredential,
  getHostIp,
  handleError,
  isMacOS,
  loadCredentials,
  redactSecrets,
  requireEnv,
  runContainer,
  type Credentials,
} from "./index-helpers";
import { type ProfileConfig } from "./pi-types";

// ===== テスト用ヘルパー =====

const sampleProfile = (overrides: Partial<ProfileConfig> = {}): ProfileConfig => ({
  OCR_LLM_MODEL: "mimo-v2.5-pro",
  OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
  OCR_LLM_URL: "https://opencode.ai/zen/go/v1",
  OCR_USE_ANTHROPIC: "false",
  ...overrides,
});

const sampleCredentials = (): Credentials => ({
  GH_TOKEN: "ghp_abc123",
  LLM_API_KEY: "sk-llm-xyz",
  OPENCODE_API_KEY: "sk-oc-999",
  OPENROUTER_API_KEY: "sk-or-555",
  XIAOMI_TOKEN_PLAN_SGP_API_KEY: "xmi-777",
});

// テスト用の exec モック。呼び出しごとに (string | Error) のシーケンスを返す。
// Error を返すと throw、文字列を返すとその値を返す。
const makeExecMock = (
  responses: Array<string | Error>,
) => {
  let i = 0;
  return ((_file: string, _args: string[], _options: { encoding: "utf8" }) => {
    const response = responses[i++] ?? "";
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }) as unknown as (file: string, args: string[], options: { encoding: "utf8" }) => string;
};

// ===== SECRET_ENV_PATTERN =====

describe("SECRET_ENV_PATTERN", () => {
  it("末尾が _API_KEY の env 値をマッチしてキー名をキャプチャする", () => {
    const m = SECRET_ENV_PATTERN.exec("--env=OPENCODE_API_KEY=secret-value");
    assert.ok(m, "マッチすること");
    assert.equal(m?.groups?.key, "OPENCODE_API_KEY");
  });

  it("末尾が _TOKEN の env 値もマッチする", () => {
    const m = SECRET_ENV_PATTERN.exec("--env=GH_TOKEN=ghp_xyz");
    assert.ok(m, "マッチすること");
    assert.equal(m?.groups?.key, "GH_TOKEN");
  });

  it("末尾が _API_KEY や _TOKEN でない env 値はマッチしない", () => {
    assert.equal(SECRET_ENV_PATTERN.test("--env=HOST_IP=192.168.1.1"), false);
    assert.equal(SECRET_ENV_PATTERN.test("--env=OCR_LLM_MODEL=mimo"), false);
  });

  it("--env= プレフィックスがない値はマッチしない", () => {
    assert.equal(SECRET_ENV_PATTERN.test("OPENCODE_API_KEY=secret"), false);
  });

  it("小文字を含むキー名(_api_key 等)はマッチしない(大文字のみ)", () => {
    // セキュリティ要件: 正規表現は大文字のみに限定し、誤検出を防ぐ。
    assert.equal(SECRET_ENV_PATTERN.test("--env=opencode_api_key=v"), false);
  });
});

// ===== redactSecrets =====

describe("redactSecrets", () => {
  it("API_KEY を含む env 引数の値を *** に置き換える", () => {
    const redacted = redactSecrets(["--env=OPENCODE_API_KEY=secret-value"]);
    assert.deepEqual(redacted, ["--env=OPENCODE_API_KEY=***"]);
  });

  it("_TOKEN で終わる env 引数の値も *** に置き換える", () => {
    const redacted = redactSecrets(["--env=GH_TOKEN=ghp_abc"]);
    assert.deepEqual(redacted, ["--env=GH_TOKEN=***"]);
  });

  it("複数の引数を一括でマスクする(混在ケース)", () => {
    const args = [
      "run",
      "-it",
      "--env=HOST_IP=192.168.1.1",
      "--env=OPENCODE_API_KEY=secret-1",
      "--env=OCR_LLM_TOKEN=secret-2",
      "--env=LLM_API_KEY=secret-3",
      "--volume=/tmp:/workspace",
    ];
    const redacted = redactSecrets(args);
    assert.deepEqual(redacted, [
      "run",
      "-it",
      "--env=HOST_IP=192.168.1.1",
      "--env=OPENCODE_API_KEY=***",
      "--env=OCR_LLM_TOKEN=***",
      "--env=LLM_API_KEY=***",
      "--volume=/tmp:/workspace",
    ]);
  });

  it("空配列は空配列を返す", () => {
    assert.deepEqual(redactSecrets([]), []);
  });

  it("マッチしない引数はそのまま返す(非破壊的)", () => {
    const args = ["run", "--rm", "--name=pi-sandbox"];
    const redacted = redactSecrets(args);
    assert.deepEqual(redacted, args);
  });
});

// ===== buildVolumeArgs =====

describe("buildVolumeArgs", () => {
  it("SSH 鍵を :ro (読み取り専用) でマウントする", () => {
    // セキュリティクリティカル: :ro が抜けるとコンテナからホストのSSH鍵を改変可能になる。
    const args = buildVolumeArgs("/Users/test");
    const sshArg = args.find((a) => a.includes(".ssh"));
    assert.ok(sshArg, "SSH マウント引数が存在する");
    assert.match(sshArg!, /:ro$/, "末尾が :ro で終わる(読み取り専用)");
  });

  it("3 つのボリュームマウントが含まれる(cwd, .ssh, .pi)", () => {
    const args = buildVolumeArgs("/Users/test");
    const volumeArgs = args.filter((a) => a.startsWith("--volume="));
    assert.equal(volumeArgs.length, 3, "3 つの --volume 引数");
    assert.ok(volumeArgs.some((a) => a.endsWith(":/workspace")), "cwd → /workspace");
    assert.ok(volumeArgs.some((a) => a.includes("/Users/test/.ssh")), ".ssh の絶対パス");
    assert.ok(volumeArgs.some((a) => a.endsWith(":/home/pi/.pi")), ".pi → /home/pi/.pi");
  });
});

// ===== buildEnvArgs =====

describe("buildEnvArgs", () => {
  it("profile.OCR_LLM_TOKEN_KEY で指定されたクレデンシャルを OCR_LLM_TOKEN に注入する", () => {
    const envArgs = buildEnvArgs({
      credentials: sampleCredentials(),
      herdrPaneId: "pane-1",
      hostIp: "192.168.1.10",
      hostProjectName: "my-project",
      profile: sampleProfile({ OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY" }),
    });
    const ocrTokenArg = envArgs.find((a) => a.startsWith("--env=OCR_LLM_TOKEN="));
    assert.equal(ocrTokenArg, "--env=OCR_LLM_TOKEN=sk-oc-999");
  });

  it("OCR_LLM_TOKEN_KEY が CREDENTIAL_SOURCES に存在しないクレデンシャルを参照するとエラー", () => {
    assert.throws(
      () =>
        buildEnvArgs({
          credentials: sampleCredentials(),
          herdrPaneId: "pane-1",
          hostIp: "192.168.1.10",
          hostProjectName: "my-project",
          profile: sampleProfile({ OCR_LLM_TOKEN_KEY: "NON_EXISTENT_KEY" }),
        }),
      /OCR_LLM_TOKEN_KEY|NON_EXISTENT_KEY/,
    );
  });

  it("指定されたクレデンシャル値が空文字ならエラー(undefined 注入を防ぐ)", () => {
    const creds = sampleCredentials();
    (creds as Record<string, string>).OPENCODE_API_KEY = "";
    assert.throws(
      () =>
        buildEnvArgs({
          credentials: creds,
          herdrPaneId: "pane-1",
          hostIp: "192.168.1.10",
          hostProjectName: "my-project",
          profile: sampleProfile({ OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY" }),
        }),
      /OPENCODE_API_KEY/,
    );
  });

  it("全クレデンシャルが env 引数として含まれる(全 12 個)", () => {
    const envArgs = buildEnvArgs({
      credentials: sampleCredentials(),
      herdrPaneId: "pane-1",
      hostIp: "192.168.1.10",
      hostProjectName: "my-project",
      profile: sampleProfile(),
    });
    const envCount = envArgs.filter((a) => a.startsWith("--env=")).length;
    assert.equal(envCount, 12, "12 個の --env 引数");
  });
});

// ===== buildContainerArgs =====

describe("buildContainerArgs", () => {
  it("IMAGE_NAME を含む container run コマンドを組み立てる", () => {
    const args = buildContainerArgs([], [], "echo hello");
    assert.equal(args[0], "run");
    assert.ok(args.includes("-it"));
    assert.ok(args.includes("--rm"));
    assert.ok(args.includes(IMAGE_NAME));
    assert.ok(args.includes("/bin/bash"));
  });

  it("envArgs / volumeArgs を展開した順序で配置する", () => {
    const args = buildContainerArgs(
      ["--env=A=1", "--env=B=2"],
      ["--volume=/x:/y"],
      "echo",
    );
    const envIdx = args.indexOf("--env=A=1");
    const volIdx = args.indexOf("--volume=/x:/y");
    const entryIdx = args.indexOf("--entrypoint");
    assert.ok(envIdx > 0 && volIdx > envIdx, "env → volume の順");
    assert.ok(entryIdx > volIdx, "entrypoint は volume より後");
  });
});

// ===== detectProfileName =====

describe("detectProfileName", () => {
  const profiles = {
    "pi-private": sampleProfile(),
    "pi-work": sampleProfile(),
  };

  it("パスセグメントにプロファイル名を含む場合、その名前を返す", () => {
    assert.equal(detectProfileName("/Users/me/work/pi-work/proj", profiles), "pi-work");
    assert.equal(detectProfileName("/Users/me/pi-private", profiles), "pi-private");
  });

  it("プロファイル名を含まないパスはエラー", () => {
    assert.throws(
      () => detectProfileName("/Users/me/random-project", profiles),
      /pi-private|pi-work/,
    );
  });

  it("プロファイル名と無関係なパスはエラー(誤検出防止)", () => {
    assert.throws(
      () => detectProfileName("/Users/me/framework", profiles),
      /pi-private|pi-work/,
    );
  });
});

// ===== requireEnv =====

describe("requireEnv", () => {
  const originalHome = process.env.HOME;
  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it("設定されている環境変数の値を返す", () => {
    process.env.HOME = "/Users/test";
    assert.equal(requireEnv("HOME"), "/Users/test");
  });

  it("未設定の環境変数はエラーを投げる", () => {
    delete process.env.HOME;
    assert.throws(() => requireEnv("HOME"), /HOME.*未設定/);
  });
});

// ===== isMacOS =====

describe("isMacOS", () => {
  it("platform() が 'darwin' のとき true を返す", () => {
    assert.equal(isMacOS(() => "darwin"), true);
  });

  it("platform() が 'linux' のとき false を返す", () => {
    assert.equal(isMacOS(() => "linux"), false);
  });

  it("引数省略時はデフォルトの platform() を使う", () => {
    // 現在の実行環境のプラットフォームを返す
    const platform = process.platform;
    assert.equal(isMacOS(), platform === "darwin");
  });
});

// ===== handleError =====

describe("handleError", () => {
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

  it("Error インスタンスは .message を stderr に出力して EXIT_ERROR を返す", () => {
    const code = handleError(new Error("boom"));
    assert.equal(code, 1);
    assert.equal(captured[0], "boom");
  });

  it("Error でない値は '予期しないエラー' プレフィックス付きで stderr に出力", () => {
    const code = handleError("string error");
    assert.equal(code, 1);
    assert.match(captured[0] ?? "", /予期しないエラー/);
  });
});

// ===== getCredential (依存性注入モック) =====

describe("getCredential", () => {
  it("exec の戻り値を trim して返す", () => {
    const exec = makeExecMock(["  value\n"]);
    assert.equal(getCredential("any", [], exec), "value");
  });

  it("exec が失敗したら空文字を返す(例外を投げない)", () => {
    const exec = makeExecMock([new Error("command failed")]);
    assert.equal(getCredential("any", [], exec), "");
  });
});

// ===== getHostIp (依存性注入モック) =====

describe("getHostIp", () => {
  it("en0 から IP を取得できればその値を返す", () => {
    const exec = makeExecMock(["192.168.1.42\n"]);
    assert.equal(getHostIp(exec), "192.168.1.42");
  });

  it("en0 が失敗したら en1 を試行する", () => {
    const exec = makeExecMock([
      new Error("en0 not found"),
      "10.0.0.5\n",
    ]);
    assert.equal(getHostIp(exec), "10.0.0.5");
  });

  it("en0 / en1 どちらも失敗したらエラーを投げる", () => {
    const exec = makeExecMock([
      new Error("en0 fail"),
      new Error("en1 fail"),
    ]);
    assert.throws(() => getHostIp(exec), /ホストの IP アドレスを取得/);
  });
});

// ===== loadCredentials (依存性注入モック) =====

describe("loadCredentials", () => {
  it("CREDENTIAL_SOURCES にある全クレデンシャルを名前付きで取得する", () => {
    const exec = makeExecMock(["ghp_abc", "sk-llm", "sk-oc", "sk-or", "xmi-777"]);
    const creds = loadCredentials(exec);
    assert.equal(creds.GH_TOKEN, "ghp_abc");
    assert.equal(creds.LLM_API_KEY, "sk-llm");
    assert.equal(creds.OPENCODE_API_KEY, "sk-oc");
    assert.equal(creds.OPENROUTER_API_KEY, "sk-or");
    assert.equal(creds.XIAOMI_TOKEN_PLAN_SGP_API_KEY, "xmi-777");
  });

  it("いずれかのクレデンシャルが空ならエラーを投げる", () => {
    // 2 番目(LLM_API_KEY)だけ空文字を返すモック
    const exec = makeExecMock(["v1", "", "v3", "v4", "v5"]);
    assert.throws(() => loadCredentials(exec), /LLM_API_KEY/);
  });

  it("CREDENTIAL_SOURCES の name と Credentials のキーが一致する", () => {
    // 型安全性の構造的保証: 配列に新エントリ追加で型も拡張される
    const exec = makeExecMock(["v1", "v2", "v3", "v4", "v5"]);
    const creds = loadCredentials(exec);
    for (const src of CREDENTIAL_SOURCES) {
      assert.ok(src.name in creds, `${src.name} が creds に存在する`);
    }
  });
});

// ===== CREDENTIAL_SOURCES 整合性 =====

describe("CREDENTIAL_SOURCES", () => {
  it("全エントリに非空の name / file / args がある", () => {
    for (const src of CREDENTIAL_SOURCES) {
      assert.ok(src.name.length > 0, "name が空でない");
      assert.ok(src.file.length > 0, "file が空でない");
      assert.ok(Array.isArray(src.args), "args が配列");
    }
  });
});

// ===== runContainer (依存性注入モック) =====

describe("runContainer", () => {
  const originalConsoleError = console.error;

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it("spawn の status を返す(正常終了 0)", () => {
    const spawn = (() => ({
      pid: 1,
      output: [],
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      status: 0,
      signal: null,
    })) as unknown as typeof import("node:child_process").spawnSync;
    assert.equal(runContainer(["run"], spawn), 0);
  });

  it("status が null で signal があれば EXIT_ERROR を返す", () => {
    console.error = () => {};
    const spawn = (() => ({
      pid: 1,
      output: [],
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      status: null,
      signal: "SIGTERM",
    })) as unknown as typeof import("node:child_process").spawnSync;
    assert.equal(runContainer(["run"], spawn), 1);
  });

  it("error プロパティを含む結果を返したら EXIT_ERROR を返す", () => {
    console.error = () => {};
    const spawn = (() => {
      const err = new Error("spawn ENOENT");
      return {
        pid: 0,
        output: [],
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        status: null,
        signal: null,
        error: err,
      };
    }) as unknown as typeof import("node:child_process").spawnSync;
    assert.equal(runContainer(["run"], spawn), 1);
  });
});
