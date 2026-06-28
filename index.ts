/* oxlint-disable max-lines -- ホスト IP 取得や --bash オプション追加により行数が増える */

import {
  type AiEnvConfig,
  type ProfileConfig,
  type ProjectConfig,
  buildInitScript,
  loadAiEnvConfig,
  validateCliOverrides,
} from "./pi-projects";
import { execFileSync, spawnSync } from "node:child_process";
import { Command } from "commander";
import { basename } from "node:path";
import { platform } from "node:os";

// ===== 定数 =====

const EXIT_ERROR = 1;
const IMAGE_NAME = "pi-sandbox";

// stderr にダンプする container コマンドの --env=KEY=VALUE のうち、
// KEY が _API_KEY / _TOKEN で終わるものの VALUE を *** に置き換えるための正規表現。
const SECRET_ENV_PATTERN =
  /^--env=(?<key>[A-Z0-9_]+(?:_API_KEY|_TOKEN))=.*$/u;

// ===== 型 =====

interface CredentialSource {
  args: string[];
  file: string;
  name: string;
}

// ===== クレデンシャル定義 =====
// 配列のキーは sort-keys ルールに合わせて args, file, name のアルファベット順。

const CREDENTIAL_SOURCES: CredentialSource[] = [
  {
    args: ["auth", "token"],
    file: "gh",
    name: "GH_TOKEN",
  },
  {
    args: ["find-generic-password", "-s", "LLM_API_KEY", "-w"],
    file: "security",
    name: "LLM_API_KEY",
  },
  {
    args: ["find-generic-password", "-s", "OPENCODE_API_KEY", "-w"],
    file: "security",
    name: "OPENCODE_API_KEY",
  },
  {
    args: ["find-generic-password", "-s", "OPENROUTER_API_KEY", "-w"],
    file: "security",
    name: "OPENROUTER_API_KEY",
  },
  {
    args: [
      "find-generic-password",
      "-s",
      "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
      "-w",
    ],
    file: "security",
    name: "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  },
];

// Credentials 型を CREDENTIAL_SOURCES から導出。
// CREDENTIAL_SOURCES に新エントリを追加すれば型も自動拡張されるため、
// interface と配列の不整合による型漏れを構造的に防止できる。
type Credentials = Record<
  (typeof CREDENTIAL_SOURCES)[number]["name"],
  string
>;

// ===== ヘルパー関数 =====

/**
 * macOS の en0 インターフェースからホストの IP アドレスを取得する。
 * Apple Container では host.docker.internal (Docker の特殊ホスト名) が使えないため、
 * ホスト IP を明示的にコンテナに渡す必要がある。
 */
const getHostIp = (): string => {
  try {
    return execFileSync("ipconfig", ["getifaddr", "en0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // en0 が使えない場合は en1 を試す (有線/無線の切り替え対応)
    try {
      return execFileSync("ipconfig", ["getifaddr", "en1"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      throw new Error(
        "ホストの IP アドレスを取得できませんでした。ネットワーク接続を確認してください。",
      );
    }
  }
};

/**
 * 指定した実行ファイルを引数配列で実行し、標準出力の内容を trim して返す。
 * 取得に失敗した場合は空文字を返す。
 * execFileSync を使うことでシェル経由のインジェクションを防ぐ。
 */
const getCredential = (file: string, args: string[]): string => {
  try {
    return execFileSync(file, args, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
};

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が未設定です。`);
  }
  return value;
};

// ホストの cwd をパスセグメント('/' 区切り)に分割し、いずれかのプロファイル名
// と完全一致するセグメントがあればそれを返す。サブストリング一致(例:
// cwd='/home/user/framework' で profile='work' が誤検出)を防ぐ。
// どちらも含まれない場合はエラー(プロファイル自動判別は曖昧さを許容しない)。
const detectProfileName = (
  cwd: string,
  profiles: Record<string, ProfileConfig>,
): string => {
  const segments = cwd.split("/");
  for (const name of Object.keys(profiles)) {
    if (segments.includes(name)) {
      return name;
    }
  }
  throw new Error(
    `カレントディレクトリ '${cwd}' のパスセグメントにプロファイル(${Object.keys(profiles).join(", ")})のいずれも見つかりません。プロファイル名のいずれかをパスセグメントとして含めてください。`,
  );
};

const buildEnvArgs = (params: {
  credentials: Credentials;
  herdrPaneId: string;
  hostIp: string;
  hostProjectName: string;
  profile: ProfileConfig;
}): string[] => {
  // profile.OCR_LLM_TOKEN_KEY で指定されたクレデンシャルを取り出して OCR_LLM_TOKEN に注入。
  // 未定義なら明確なエラーで停止(undefined 文字列が注入されるのを防ぐ)。
  const ocrToken = params.credentials[params.profile.OCR_LLM_TOKEN_KEY];
  if (!ocrToken) {
    throw new Error(
      `プロファイルが参照するクレデンシャル '${params.profile.OCR_LLM_TOKEN_KEY}' が CREDENTIAL_SOURCES に存在しないか、取得に失敗しました。`,
    );
  }
  return [
    `--env=HERDR_PANE_ID=${params.herdrPaneId}`,
    `--env=HOST_IP=${params.hostIp}`,
    `--env=HOST_PROJECT_NAME=${params.hostProjectName}`,
    `--env=OCR_USE_ANTHROPIC=${params.profile.OCR_USE_ANTHROPIC}`,
    `--env=OCR_LLM_URL=${params.profile.OCR_LLM_URL}`,
    `--env=OCR_LLM_TOKEN=${ocrToken}`,
    `--env=OCR_LLM_MODEL=${params.profile.OCR_LLM_MODEL}`,
    `--env=XIAOMI_TOKEN_PLAN_SGP_API_KEY=${params.credentials.XIAOMI_TOKEN_PLAN_SGP_API_KEY}`,
    `--env=OPENCODE_API_KEY=${params.credentials.OPENCODE_API_KEY}`,
    `--env=OPENROUTER_API_KEY=${params.credentials.OPENROUTER_API_KEY}`,
    `--env=LLM_API_KEY=${params.credentials.LLM_API_KEY}`,
    `--env=GH_TOKEN=${params.credentials.GH_TOKEN}`,
  ];
};

const buildVolumeArgs = (home: string): string[] => [
  `--volume=${process.cwd()}:/workspace`,
  `--volume=${home}/.ssh:/tmp/.ssh:ro`,
  `--volume=${home}/.pi:/home/pi/.pi`,
];

const buildContainerArgs = (
  envArgs: string[],
  volumeArgs: string[],
  initScript: string,
): string[] => [
  "run",
  "-it",
  "--rm",
  ...envArgs,
  ...volumeArgs,
  "--entrypoint",
  "/bin/bash",
  IMAGE_NAME,
  "-c",
  initScript,
];

const loadCredentials = (): Credentials => {
  const credentials = {} as Record<string, string>;
  for (const { name, file, args } of CREDENTIAL_SOURCES) {
    const value = getCredential(file, args);
    if (!value) {
      throw new Error(
        `クレデンシャル '${name}' の取得に失敗しました。macOS Keychain の登録状態 / 'gh auth login' の完了を確認してください。`,
      );
    }
    credentials[name] = value;
  }
  return credentials as Credentials;
};

const redactSecrets = (args: string[]): string[] =>
  args.map((arg) => arg.replace(SECRET_ENV_PATTERN, "--env=$<key>=***"));

const runContainer = (args: string[]): number => {
  const result = spawnSync("container", args, { stdio: "inherit" });
  if (result.error) {
    console.error("container の実行に失敗しました:", result.error.message);
    return EXIT_ERROR;
  }
  if (result.signal) {
    // 子プロセスがシグナルで終了した場合、status は null になる。
    // 原因をユーザーに伝えるため、シグナル名を stderr に出力する。
    console.error(`container がシグナル ${result.signal} で終了しました。`);
    return EXIT_ERROR;
  }
  return result.status ?? EXIT_ERROR;
};

const isMacOS = (): boolean => platform() === "darwin";

// runContainer の引数をまとめて渡すための型。
// パラメータ数を抑えつつ、コンテキストを明示的に扱えるようにする。
interface RunContext {
  apiKeyEnv: string | undefined;
  bashMode: boolean;
  model: string | undefined;
  provider: string | undefined;
  resume: boolean;
  credentials: Credentials;
  herdrPaneId: string;
  home: string;
  hostIp: string;
  hostProjectName: string;
  profile: ProfileConfig;
  projects: Record<string, ProjectConfig>;
}

const runContainerCommand = (ctx: RunContext): number => {
  const envArgs = buildEnvArgs({
    credentials: ctx.credentials,
    herdrPaneId: ctx.herdrPaneId,
    hostIp: ctx.hostIp,
    hostProjectName: ctx.hostProjectName,
    profile: ctx.profile,
  });
  const volumeArgs = buildVolumeArgs(ctx.home);
  const initScript = buildInitScript({
    bashMode: ctx.bashMode,
    cliApiKeyEnv: ctx.apiKeyEnv,
    cliModel: ctx.model,
    cliProvider: ctx.provider,
    defaultApiKeyEnv: ctx.profile.apiKeyEnv,
    defaultModel: ctx.profile.model,
    defaultProvider: ctx.profile.provider,
    projects: ctx.projects,
    resume: ctx.resume,
  });
  const containerArgs = buildContainerArgs(envArgs, volumeArgs, initScript);
  console.error(`$ container ${redactSecrets(containerArgs).join(" ")}`);
  return runContainer(containerArgs);
};

const prepareEnvironment = (params: {
  apiKeyEnv: string | undefined;
  bashMode: boolean;
  model: string | undefined;
  provider: string | undefined;
  resume: boolean;
}): RunContext => {
  const credentials = loadCredentials();
  const home = requireEnv("HOME");
  const herdrPaneId = requireEnv("HERDR_PANE_ID");
  // ホスト側のカレントディレクトリ名を取り、コンテナに環境変数として渡す。
  // コンテナ内 $PWD は常に /workspace なので basename が 'workspace' 固定になり
  // 自動認識が機能しないため、ホスト側で先に算出する。
  const hostProjectName = basename(process.cwd());
  const aiEnvConfig: AiEnvConfig = loadAiEnvConfig();
  const profileName = detectProfileName(process.cwd(), aiEnvConfig.profiles);
  return {
    apiKeyEnv: params.apiKeyEnv,
    bashMode: params.bashMode,
    model: params.model,
    provider: params.provider,
    resume: params.resume,
    credentials,
    herdrPaneId,
    home,
    hostIp: getHostIp(),
    hostProjectName,
    // detectProfileName が profiles 内の存在を保証しているため non-null assertion を使用
    profile: aiEnvConfig.profiles[profileName]!,
    projects: aiEnvConfig.projects,
  };
};

const handleError = (error: unknown): number => {
  if (error instanceof Error) {
    console.error(error.message);
    return EXIT_ERROR;
  }
  console.error("予期しないエラーが発生しました:", error);
  return EXIT_ERROR;
};

// ===== メイン処理 =====

interface CliOptions {
  apiKeyEnv?: string;
  bash?: boolean;
  model?: string;
  provider?: string;
  resume?: boolean;
}

const main = (options: CliOptions): number => {
  try {
    if (!isMacOS()) {
      console.error(
        "ai-env は macOS 専用です(macOS Keychain 'security' コマンド / ホスト IP 取得に 'ipconfig' を前提にしています)。",
      );
      return EXIT_ERROR;
    }
    // CLI オプションを SAFE_*_PATTERN で検証(設定ファイルと同一ルールで弾く)。
    // 検証エラーは handleError でメッセージ表示 + exit 1。
    const validated = validateCliOverrides({
      apiKeyEnv: options.apiKeyEnv,
      model: options.model,
      provider: options.provider,
    });
    return runContainerCommand(
      prepareEnvironment({
        apiKeyEnv: validated.apiKeyEnv,
        bashMode: options.bash ?? false,
        model: validated.model,
        provider: validated.provider,
        resume: options.resume ?? false,
      }),
    );
  } catch (error) {
    return handleError(error);
  }
};

// ===== CLI エントリポイント =====

const program = new Command();

program
  .name("ai-env")
  .description("私専用のAI開発用Dockerサンドボックス環境を簡単に起動するCLI")
  .version("0.1.0")
  .option("--bash", "pi を起動せずに bash シェルのみを起動する")
  .option("--resume", "pi-projects.json のセッションを引き継いで起動する")
  .option(
    "--provider <provider>",
    "pi の --provider フラグに渡す値(bash モードでは PI_PROVIDER env 変数として export)",
  )
  .option(
    "--model <model>",
    "pi の --model フラグに渡す値(model:thinkingLevel 形式可、bash モードでは PI_MODEL env 変数として export)",
  )
  .option(
    "--api-key-env <envName>",
    "pi の --api-key で参照するコンテナ内環境変数名(例: LLM_API_KEY、bash モードでは PI_API_KEY_ENV として export)",
  )
  .action((options: CliOptions) => {
    process.exit(main(options));
  });

program.parse();
