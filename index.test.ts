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
  buildAttachArgs,
  buildContainerArgs,
  buildContainerName,
  buildContainerProcessEnv,
  buildCredentialProcessEnv,
  buildEnvArgs,
  buildPiSessionEnvArgs,
  buildVolumeArgs,
  findContainerByLabel,
  detectProfileName,
  getCredential,
  getHostIp,
  handleError,
  isMacOS,
  loadCredentials,
  redactSecrets,
  requireEnv,
  runContainer,
  resolveRequiredApiKeyEnv,
  validateFlagCombination,
  type Credentials,
} from "./index-helpers";
import { CREDENTIAL_NAMES, type ProfileConfig } from "./pi-types";

// ===== テスト用ヘルパー =====

const sampleProfile = (overrides: Partial<ProfileConfig> = {}): ProfileConfig => ({
  credentialKeys: [...CREDENTIAL_NAMES],
  OCR_LLM_MODEL: "mimo-v2.5-pro",
  OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
  OCR_LLM_URL: "https://opencode.ai/zen/go/v1",
  OCR_USE_ANTHROPIC: "false",
  ...overrides,
});

const sampleCredentials = (): Credentials => ({
  BRAVE_SEARCH_API_KEY: "brave-111",
  DEEPSEEK_API_KEY: "sk-ds-123",
  GH_TOKEN: "ghp_abc123",
  JINA_API_KEY: "jina-xyz789",
  LLM_API_KEY: "sk-llm-xyz",
  OPENAI_API_KEY: "sk-openai-123",
  OPENCODE_API_KEY: "sk-oc-999",
  OPENROUTER_API_KEY: "sk-or-555",
  QWEN_TOKEN_PLAN_API_KEY: "qwen-888",
  XIAOMI_TOKEN_PLAN_SGP_API_KEY: "xmi-777",
  ZAI_PLATFORM_API_KEY: "zai-424",
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

  it("CREDENTIAL_SOURCES 由来の BRAVE_SEARCH_API_KEY も *** に置き換える", () => {
    // BRAVE_SEARCH_API_KEY は CREDENTIAL_SOURCES に追加されたことで
    // SECRET_ENV_PATTERN のマスク対象(末尾 _API_KEY)に自動で含まれる。
    const redacted = redactSecrets(["--env=BRAVE_SEARCH_API_KEY=brave-secret"]);
    assert.deepEqual(redacted, ["--env=BRAVE_SEARCH_API_KEY=***"]);
  });

  it("ZAI_PLATFORM_API_KEY も登録だけでマスク対象になる", () => {
    // 追加クレデンシャルでマスク漏れが起きないことの回帰テスト。
    const redacted = redactSecrets(["--env=ZAI_PLATFORM_API_KEY=zai-secret"]);
    assert.deepEqual(redacted, ["--env=ZAI_PLATFORM_API_KEY=***"]);
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
    const args = buildVolumeArgs("/Users/test", "my-project");
    const sshArg = args.find((a) => a.includes(".ssh"));
    assert.ok(sshArg, "SSH マウント引数が存在する");
    assert.match(sshArg!, /:ro$/, "末尾が :ro で終わる(読み取り専用)");
  });

  it("6 つのボリュームマウントが含まれる(cwd, .ssh, .pi, セッション, .config/rtk, .ctx)", () => {
    const args = buildVolumeArgs("/Users/test", "my-project");
    const volumeArgs = args.filter((a) => a.startsWith("--volume="));
    assert.equal(volumeArgs.length, 6, "6 つの --volume 引数");
    assert.ok(volumeArgs.some((a) => a.endsWith(":/workspace/my-project")), "cwd → /workspace/my-project");
    assert.ok(volumeArgs.some((a) => a.includes("/Users/test/.ssh")), ".ssh の絶対パス");
    assert.ok(volumeArgs.some((a) => a.endsWith(":/home/pi/.pi")), ".pi → /home/pi/.pi");
    assert.ok(
      volumeArgs.some((a) => a.endsWith(":/Users/test/.pi/agent/sessions")),
      "セッション → ホストと同じ絶対パス",
    );
    assert.ok(volumeArgs.some((a) => a.endsWith(":/home/pi/.rtk")), ".config/rtk → /home/pi/.rtk");
    assert.ok(volumeArgs.some((a) => a.endsWith(":/home/pi/.ctx")), ".ctx → /home/pi/.ctx");
  });
});

// ===== buildPiSessionEnvArgs =====

describe("buildPiSessionEnvArgs", () => {
  it("pi のセッション保存先をホストと同じ絶対パスに設定する", () => {
    assert.deepEqual(buildPiSessionEnvArgs("/Users/test"), [
      "--env=PI_CODING_AGENT_SESSION_DIR=/Users/test/.pi/agent/sessions",
    ]);
  });
});

// ===== buildEnvArgs =====

describe("buildEnvArgs", () => {
  it("profile.OCR_LLM_TOKEN_KEY で指定されたクレデンシャルを OCR_LLM_TOKEN に注入する", () => {
    const envArgs = buildEnvArgs({
      credentials: sampleCredentials(),
      herdrPaneId: "pane-1",
      hostIp: "192.168.1.10",
      profileName: "pi-work",
      profile: sampleProfile({ OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY" }),
    });
    const ocrTokenArg = envArgs.find((a) => a === "--env=OCR_LLM_TOKEN");
    assert.equal(ocrTokenArg, "--env=OCR_LLM_TOKEN");
  });

  it("OCR_LLM_TOKEN_KEY が CREDENTIAL_SOURCES に存在しないクレデンシャルを参照するとエラー", () => {
    assert.throws(
      () =>
        buildEnvArgs({
          credentials: sampleCredentials(),
          herdrPaneId: "pane-1",
          hostIp: "192.168.1.10",
          hostProjectName: "my-project",
          profileName: "pi-work",
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
          profileName: "pi-work",
          profile: sampleProfile({ OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY" }),
        }),
      /OPENCODE_API_KEY/,
    );
  });

  it("許可された全クレデンシャルが env 引数として含まれる(全 18 個)", () => {
    const envArgs = buildEnvArgs({
      credentials: sampleCredentials(),
      herdrPaneId: "pane-1",
      hostIp: "192.168.1.10",
      profileName: "pi-work",
      profile: sampleProfile(),
    });
    const envCount = envArgs.filter((a) => a.startsWith("--env=")).length;
    assert.equal(envCount, 18, "18 個の --env 引数");
  });

  it("PartialCredentials(一部欠落)でもエラーなく組み立て、欠落した値の env は省略する", () => {
    const creds = sampleCredentials();
    // XIAOMI と OPENROUTER を意図的に欠落させる
    const partial: typeof creds = { ...creds };
    delete partial.XIAOMI_TOKEN_PLAN_SGP_API_KEY;
    delete partial.OPENROUTER_API_KEY;
    const envArgs = buildEnvArgs({
      credentials: partial,
      herdrPaneId: "pane-1",
      hostIp: "192.168.1.10",
      profileName: "pi-work",
      profile: sampleProfile({ OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY" }),
    });
    const xiaomi = envArgs.find((a) => a === "--env=XIAOMI_TOKEN_PLAN_SGP_API_KEY");
    const or = envArgs.find((a) => a === "--env=OPENROUTER_API_KEY");
    assert.equal(xiaomi, undefined);
    assert.equal(or, undefined);
  });

  it("Profileの許可リストにないクレデンシャルは env へ注入しない", () => {
    const envArgs = buildEnvArgs({
      credentials: sampleCredentials(),
      herdrPaneId: "pane-1",
      hostIp: "192.168.1.10",
      profileName: "pi-private",
      profile: sampleProfile({ credentialKeys: ["OPENCODE_API_KEY"] }),
    });
    assert.ok(envArgs.includes("--env=OPENCODE_API_KEY"));
    assert.ok(!envArgs.includes("--env=OPENAI_API_KEY"));
    assert.ok(!envArgs.includes("--env=LLM_API_KEY"));
  });

  it("選択中の apiKeyEnv が未取得ならエラーになる", () => {
    const credentials = sampleCredentials();
    delete credentials.OPENAI_API_KEY;
    assert.throws(
      () =>
        buildEnvArgs({
          credentials,
          herdrPaneId: "pane-1",
          hostIp: "192.168.1.10",
          profileName: "pi-private",
          profile: sampleProfile(),
          requiredApiKeyEnv: "OPENAI_API_KEY",
        }),
      /OPENAI_API_KEY/,
    );
  });

  it("ZAI_PLATFORM_API_KEY は値を argv に載せずキー名だけで注入する", () => {
    const envArgs = buildEnvArgs({
      credentials: sampleCredentials(),
      herdrPaneId: "pane-1",
      hostIp: "192.168.1.10",
      profileName: "pi-private",
      profile: sampleProfile({
        credentialKeys: ["OPENCODE_API_KEY", "ZAI_PLATFORM_API_KEY"],
      }),
    });
    assert.ok(envArgs.includes("--env=ZAI_PLATFORM_API_KEY"));
    assert.ok(!envArgs.some((a) => a.includes("zai-424")), "秘密値が argv に露出しない");
  });

  it("Profileの許可リストにない ZAI_PLATFORM_API_KEY は env へ注入しない", () => {
    const envArgs = buildEnvArgs({
      credentials: sampleCredentials(),
      herdrPaneId: "pane-1",
      hostIp: "192.168.1.10",
      profileName: "pi-work",
      profile: sampleProfile({ credentialKeys: ["OPENCODE_API_KEY"] }),
    });
    assert.ok(!envArgs.includes("--env=ZAI_PLATFORM_API_KEY"));
  });

  it("選択中の apiKeyEnv が ZAI_PLATFORM_API_KEY で未取得なら起動を中止する", () => {
    const credentials = sampleCredentials();
    delete credentials.ZAI_PLATFORM_API_KEY;
    assert.throws(
      () =>
        buildEnvArgs({
          credentials,
          herdrPaneId: "pane-1",
          hostIp: "192.168.1.10",
          profileName: "pi-private",
          profile: sampleProfile({
            credentialKeys: ["OPENCODE_API_KEY", "ZAI_PLATFORM_API_KEY"],
          }),
          requiredApiKeyEnv: "ZAI_PLATFORM_API_KEY",
        }),
      /ZAI_PLATFORM_API_KEY/,
    );
  });

  it("BRAVE_SEARCH_API_KEY が env 引数として注入される", () => {
    const envArgs = buildEnvArgs({
      credentials: sampleCredentials(),
      herdrPaneId: "pane-1",
      hostIp: "192.168.1.10",
      profileName: "pi-work",
      profile: sampleProfile(),
    });
    const braveArg = envArgs.find((a) => a === "--env=BRAVE_SEARCH_API_KEY");
    assert.equal(braveArg, "--env=BRAVE_SEARCH_API_KEY");
  });

  it("AI_ENV_PROFILE がプロファイル名で注入される", () => {
    const envArgs = buildEnvArgs({
      credentials: sampleCredentials(),
      herdrPaneId: "pane-1",
      hostIp: "192.168.1.10",
      profile: sampleProfile(),
      profileName: "pi-work",
    });
    const profileArg = envArgs.find((a) => a.startsWith("--env=AI_ENV_PROFILE="));
    assert.equal(profileArg, "--env=AI_ENV_PROFILE=pi-work");
  });
});

// ===== resolveRequiredApiKeyEnv =====

describe("resolveRequiredApiKeyEnv", () => {
  const profile = sampleProfile({ apiKeyEnv: "OPENCODE_API_KEY" });

  it("既知プロジェクトでは CLI > Project > Profile の順で解決する", () => {
    assert.equal(
      resolveRequiredApiKeyEnv({
        bashMode: false,
        cliApiKeyEnv: "OPENAI_API_KEY",
        hostProjectName: "ai-env",
        profile,
        projects: { "ai-env": { apiKeyEnv: "LLM_API_KEY" } },
      }),
      "OPENAI_API_KEY",
    );
    assert.equal(
      resolveRequiredApiKeyEnv({
        bashMode: false,
        cliApiKeyEnv: undefined,
        hostProjectName: "ai-env",
        profile,
        projects: { "ai-env": { apiKeyEnv: "LLM_API_KEY" } },
      }),
      "LLM_API_KEY",
    );
    assert.equal(
      resolveRequiredApiKeyEnv({
        bashMode: false,
        cliApiKeyEnv: undefined,
        hostProjectName: "ai-env",
        profile,
        projects: { "ai-env": {} },
      }),
      "OPENCODE_API_KEY",
    );
  });

  it("未知プロジェクトのデフォルト起動では apiKeyEnv を要求しない", () => {
    assert.equal(
      resolveRequiredApiKeyEnv({
        bashMode: false,
        cliApiKeyEnv: "OPENAI_API_KEY",
        hostProjectName: "unknown",
        profile,
        projects: {},
      }),
      undefined,
    );
  });

  it("bashモードではProfile/ProjectのapiKeyEnvを自動要求しない", () => {
    assert.equal(
      resolveRequiredApiKeyEnv({
        bashMode: true,
        cliApiKeyEnv: undefined,
        hostProjectName: "ai-env",
        profile,
        projects: { "ai-env": { apiKeyEnv: "LLM_API_KEY" } },
      }),
      undefined,
    );
  });

  it("未知プロジェクトのbashモードではCLIの apiKeyEnv を要求する", () => {
    assert.equal(
      resolveRequiredApiKeyEnv({
        bashMode: true,
        cliApiKeyEnv: "OPENAI_API_KEY",
        hostProjectName: "unknown",
        profile,
        projects: {},
      }),
      "OPENAI_API_KEY",
    );
  });
});

// ===== validateFlagCombination =====

describe("validateFlagCombination", () => {
  it("単独フラグはすべて許可する", () => {
    assert.equal(
      validateFlagCombination({ attach: false, bash: false, new: false, session: false }),
      undefined,
    );
    assert.equal(
      validateFlagCombination({ attach: false, bash: true, new: false, session: false }),
      undefined,
    );
    assert.equal(
      validateFlagCombination({ attach: false, bash: false, new: true, session: false }),
      undefined,
    );
    assert.equal(
      validateFlagCombination({ attach: false, bash: false, new: false, session: true }),
      undefined,
    );
  });

  it("--new と --session の同時指定はエラー(--new は新規セッションを指定するため)", () => {
    const error = validateFlagCombination({ attach: false, bash: false, new: true, session: true });
    assert.match(error ?? "", /--new/);
    assert.match(error ?? "", /--session/);
  });

  it("--attach と --bash / --new / --session の同時指定はエラー", () => {
    assert.match(
      validateFlagCombination({ attach: true, bash: true, new: false, session: false }) ?? "",
      /--attach/,
    );
    assert.match(
      validateFlagCombination({ attach: true, bash: false, new: true, session: false }) ?? "",
      /--attach/,
    );
    assert.match(
      validateFlagCombination({ attach: true, bash: false, new: false, session: true }) ?? "",
      /--attach/,
    );
  });

  it("--bash と --new の同時指定はエラー(--bash は pi を起動しないため)", () => {
    const error = validateFlagCombination({ attach: false, bash: true, new: true, session: false });
    assert.match(error ?? "", /--bash/);
    assert.match(error ?? "", /--new/);
  });

  it("--attach 単独なら許可する", () => {
    assert.equal(
      validateFlagCombination({ attach: true, bash: false, new: false, session: false }),
      undefined,
    );
  });
});

// ===== buildContainerName =====

describe("buildContainerName", () => {
  it("プロジェクト名からコンテナ名を生成する", () => {
    assert.equal(buildContainerName("my-project"), "ai-env-my-project");
  });

  it("空文字の場合は 'ai-env-' + 空文字になる", () => {
    assert.equal(buildContainerName(""), "ai-env-");
  });
});

// ===== buildAttachArgs =====

describe("buildAttachArgs", () => {
  it("container exec コマンドを組み立てる", () => {
    const args = buildAttachArgs("abc123");
    assert.deepEqual(args, ["exec", "-it", "abc123", "/bin/bash"]);
  });
});

// ===== findContainerByLabel =====

describe("findContainerByLabel", () => {
  it("ラベルにマッチするコンテナがあればその ID を返す", () => {
    const mockContainers = JSON.stringify([
      {
        configuration: {
          id: "abc123",
          labels: { "ai-env.project": "my-project" },
        },
      },
      {
        configuration: {
          id: "def456",
          labels: { "other-label": "other-value" },
        },
      },
    ]);
    const exec = makeExecMock([mockContainers]);
    assert.equal(findContainerByLabel("ai-env.project=my-project", exec), "abc123");
  });

  it("ラベルにマッチするコンテナがなければ undefined を返す", () => {
    const exec = makeExecMock([JSON.stringify([])]);
    assert.equal(findContainerByLabel("ai-env.project=nonexistent", exec), undefined);
  });

  it("exec が失敗したら undefined を返す", () => {
    const exec = makeExecMock([new Error("container not found")]);
    assert.equal(findContainerByLabel("ai-env.project=my-project", exec), undefined);
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

  it("hostProjectName が指定された場合、--label ai-env.project=... を含む", () => {
    const args = buildContainerArgs(["--env=A=1"], ["--volume=/x:/y"], "echo", "my-project");
    const labelIdx = args.indexOf("--label");
    assert.ok(labelIdx > 0, "--label が含まれる");
    assert.equal(args[labelIdx + 1], "ai-env.project=my-project");
    // --label は --entrypoint より前に配置される
    const entryIdx = args.indexOf("--entrypoint");
    assert.ok(labelIdx < entryIdx, "--label は --entrypoint より前");
  });

  it("hostProjectName が未指定の場合、--label を含まない", () => {
    const args = buildContainerArgs([], [], "echo");
    assert.ok(!args.includes("--label"), "--label が含まれない");
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
    // 取得順: BRAVE_SEARCH_API_KEY, DEEPSEEK_API_KEY, GH_TOKEN, JINA_API_KEY,
    //        LLM_API_KEY, OPENAI_API_KEY, OPENCODE_API_KEY, OPENROUTER_API_KEY,
    //        QWEN_TOKEN_PLAN_API_KEY, XIAOMI_TOKEN_PLAN_SGP_API_KEY, ZAI_PLATFORM_API_KEY
    const exec = makeExecMock([
      "brave-val",
      "sk-ds",
      "ghp_abc",
      "jina-val",
      "sk-llm",
      "sk-openai",
      "sk-oc",
      "sk-or",
      "qwen-888",
      "xmi-777",
      "zai-424",
    ]);
    const creds = loadCredentials(CREDENTIAL_NAMES, exec);
    assert.equal(creds.BRAVE_SEARCH_API_KEY, "brave-val");
    assert.equal(creds.DEEPSEEK_API_KEY, "sk-ds");
    assert.equal(creds.GH_TOKEN, "ghp_abc");
    assert.equal(creds.JINA_API_KEY, "jina-val");
    assert.equal(creds.LLM_API_KEY, "sk-llm");
    assert.equal(creds.OPENAI_API_KEY, "sk-openai");
    assert.equal(creds.OPENCODE_API_KEY, "sk-oc");
    assert.equal(creds.OPENROUTER_API_KEY, "sk-or");
    assert.equal(creds.QWEN_TOKEN_PLAN_API_KEY, "qwen-888");
    assert.equal(creds.XIAOMI_TOKEN_PLAN_SGP_API_KEY, "xmi-777");
    assert.equal(creds.ZAI_PLATFORM_API_KEY, "zai-424");
  });

  it("許可リスト外のクレデンシャルはKeychainから取得しない", () => {
    const exec = makeExecMock(["sk-openai"]);
    const creds = loadCredentials(["OPENAI_API_KEY"], exec);
    assert.deepEqual(creds, { OPENAI_API_KEY: "sk-openai" });
  });

  it("いずれかのクレデンシャルが空でもエラーを投げず、警告のみstderr に出力する(ベストエフォート)", () => {
    const originalConsoleError = console.error;
    const warnings: string[] = [];
    console.error = (msg: string) => {
      warnings.push(msg);
    };
    try {
      // 5 番目(LLM_API_KEY)だけ空文字を返すモック
      // BRAVE_SEARCH_API_KEY, DEEPSEEK_API_KEY, GH_TOKEN, JINA_API_KEY,
      // LLM_API_KEY, OPENAI_API_KEY, OPENCODE_API_KEY, OPENROUTER_API_KEY,
      // QWEN_TOKEN_PLAN_API_KEY, XIAOMI_TOKEN_PLAN_SGP_API_KEY, ZAI_PLATFORM_API_KEY
      const exec = makeExecMock(["v0", "v1", "v2", "v3", "", "v5", "v6", "v7", "v8", "v9", "v10"]);
      const creds = loadCredentials(CREDENTIAL_NAMES, exec);
      // 例外を投げない
      assert.equal(creds.LLM_API_KEY, undefined, "LLM_API_KEY は undefined");
      // 他のクレデンシャルは取得できている
      assert.equal(creds.GH_TOKEN, "v2");
      assert.equal(creds.JINA_API_KEY, "v3");
      assert.equal(creds.OPENCODE_API_KEY, "v6");
      // 警告メッセージにクレデンシャル名が含まれる
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /LLM_API_KEY/);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("CREDENTIAL_SOURCES の name と Credentials のキーが一致する", () => {
    // 型安全性の構造的保証: 配列に新エントリ追加で型も拡張される
    const exec = makeExecMock([
      "v1",
      "v2",
      "v3",
      "v4",
      "v5",
      "v6",
      "v7",
      "v8",
      "v9",
      "v10",
      "v11",
    ]);
    const creds = loadCredentials(CREDENTIAL_NAMES, exec);
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

  it("CREDENTIAL_NAMES の各名前に取得ソースがある", () => {
    for (const name of CREDENTIAL_NAMES) {
      assert.ok(CREDENTIAL_SOURCES.some((source) => source.name === name), `${name} の取得ソースが存在する`);
    }
  });

  it("ZAI_PLATFORM_API_KEY は Keychain サービス名と同名で取得される", () => {
    // 既存 10 キーと同じ流儀(取得元 = macOS Keychain、サービス名 = Credential Key)。
    const source = CREDENTIAL_SOURCES.find((s) => s.name === "ZAI_PLATFORM_API_KEY");
    assert.deepEqual(source?.args, ["find-generic-password", "-s", "ZAI_PLATFORM_API_KEY", "-w"]);
    assert.equal(source?.file, "security");
  });

  it("pi 組み込み zai の ZAI_API_KEY はあえて登録しない", () => {
    // Z.AI Coding Plan(定額)と Z.AI Platform API(従量)の課金経路分離。
    const names: readonly string[] = CREDENTIAL_NAMES;
    assert.equal(names.includes("ZAI_API_KEY"), false);
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
    assert.equal(runContainer(["run"], process.env, spawn), 0);
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
    assert.equal(runContainer(["run"], process.env, spawn), 1);
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
    assert.equal(runContainer(["run"], process.env, spawn), 1);
  });

  it("spawn に env が渡される(HERDR_AGENT ヒントが伝播する)", () => {
    let capturedOptions: { env?: NodeJS.ProcessEnv } | undefined;
    const spawn = ((
      _file: string,
      _args: string[],
      options: { env?: NodeJS.ProcessEnv },
    ) => {
      capturedOptions = options;
      return {
        pid: 1,
        output: [],
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        status: 0,
        signal: null,
      };
    }) as unknown as typeof import("node:child_process").spawnSync;
    const env = { ...process.env, HERDR_AGENT: "pi" };
    assert.equal(runContainer(["run"], env, spawn), 0);
    assert.equal(capturedOptions?.env?.HERDR_AGENT, "pi");
  });
});

// ===== buildCredentialProcessEnv =====

describe("buildCredentialProcessEnv", () => {
  it("許可されたクレデンシャルとOCR派生トークンを子プロセス環境へ組み立てる", () => {
    const env = buildCredentialProcessEnv(sampleCredentials(), sampleProfile());
    assert.equal(env.OPENAI_API_KEY, "sk-openai-123");
    assert.equal(env.OPENCODE_API_KEY, "sk-oc-999");
    assert.equal(env.ZAI_PLATFORM_API_KEY, "zai-424");
    assert.equal(env.OCR_LLM_TOKEN, "sk-oc-999");
  });

  it("許可リスト外のクレデンシャルを子プロセス環境へ組み立てない", () => {
    const env = buildCredentialProcessEnv(
      sampleCredentials(),
      sampleProfile({ credentialKeys: ["OPENCODE_API_KEY"] }),
    );
    assert.equal(env.OPENCODE_API_KEY, "sk-oc-999");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ZAI_PLATFORM_API_KEY, undefined);
    assert.equal(env.OCR_LLM_TOKEN, "sk-oc-999");
  });

  it("未登録または許可リスト外のOCRキーを派生環境へ組み立てない", () => {
    const env = buildCredentialProcessEnv(
      sampleCredentials(),
      sampleProfile({
        credentialKeys: ["OPENCODE_API_KEY"],
        OCR_LLM_TOKEN_KEY: "OPENROUTER_API_KEY",
      }),
    );
    assert.equal(env.OCR_LLM_TOKEN, undefined);
  });
});

// ===== buildContainerProcessEnv (HERDR_AGENT ヒント) =====

describe("buildContainerProcessEnv", () => {
  it("非 bash モードでは HERDR_AGENT=pi が付与される", () => {
    const base = { PATH: "/bin", HOME: "/home/pi" };
    const env = buildContainerProcessEnv(false, base);
    assert.equal(env.HERDR_AGENT, "pi");
    assert.equal(env.PATH, "/bin");
  });

  it("bash モードでは HERDR_AGENT が付与されない(既存 env をそのまま返す)", () => {
    const base = { PATH: "/bin" };
    const env = buildContainerProcessEnv(true, base);
    assert.equal(env.HERDR_AGENT, undefined);
    assert.equal(env, base);
  });

  it("デフォルトでは process.env をベースにする", () => {
    const env = buildContainerProcessEnv(false);
    assert.equal(env.HERDR_AGENT, "pi");
    assert.equal(env.PATH, process.env.PATH);
  });

  it("秘密値はbase環境を変更せず子プロセス環境へ追加する", () => {
    const base = { PATH: "/bin" };
    const env = buildContainerProcessEnv(true, base, {
      OPENAI_API_KEY: "secret",
    });
    assert.equal(env.OPENAI_API_KEY, "secret");
    assert.equal(base.OPENAI_API_KEY, undefined);
    assert.notEqual(env, base);
  });
});
