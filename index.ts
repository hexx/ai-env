import {
  type AiEnvConfig,
  type ProfileConfig,
  type ProjectConfig,
  buildInitScript,
  loadAiEnvConfig,
} from "./pi-projects";
import { execFileSync, spawnSync } from "node:child_process";
import { Command } from "commander";
import { basename } from "node:path";
import { platform } from "node:os";

// ===== 定数 =====

const EXIT_ERROR = 1;
const IMAGE_NAME = "pi-sandbox";

// stderr にダンプする docker コマンドの --env=KEY=VALUE のうち、
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

const buildDockerArgs = (
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

const runDocker = (args: string[]): number => {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.error) {
    console.error("dockerの実行に失敗しました:", result.error.message);
    return EXIT_ERROR;
  }
  if (result.signal) {
    // 子プロセスがシグナルで終了した場合、status は null になる。
    // 原因をユーザーに伝えるため、シグナル名を stderr に出力する。
    console.error(`dockerがシグナル ${result.signal} で終了しました。`);
    return EXIT_ERROR;
  }
  return result.status ?? EXIT_ERROR;
};

const isMacOS = (): boolean => platform() === "darwin";

// runDockerContainer の引数をまとめて渡すための型。
// パラメータ数を抑えつつ、コンテキストを明示的に扱えるようにする。
interface RunContext {
  credentials: Credentials;
  herdrPaneId: string;
  home: string;
  hostProjectName: string;
  profile: ProfileConfig;
  projects: Record<string, ProjectConfig>;
}

const runDockerContainer = (ctx: RunContext): number => {
  const envArgs = buildEnvArgs({
    credentials: ctx.credentials,
    herdrPaneId: ctx.herdrPaneId,
    hostProjectName: ctx.hostProjectName,
    profile: ctx.profile,
  });
  const volumeArgs = buildVolumeArgs(ctx.home);
  const initScript = buildInitScript(ctx.projects, ctx.profile.provider, ctx.profile.model);
  const dockerArgs = buildDockerArgs(envArgs, volumeArgs, initScript);
  console.error(`$ docker ${redactSecrets(dockerArgs).join(" ")}`);
  return runDocker(dockerArgs);
};

const prepareEnvironment = (): RunContext => {
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
    credentials,
    herdrPaneId,
    home,
    hostProjectName,
    profile: aiEnvConfig.profiles[profileName],
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

const main = (): number => {
  try {
    if (!isMacOS()) {
      console.error(
        "ai-env は macOS 専用です(macOS Keychain 'security' コマンド / 'host.docker.internal' を前提にしています)。",
      );
      return EXIT_ERROR;
    }
    return runDockerContainer(prepareEnvironment());
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
  .action(() => {
    process.exit(main());
  });

program.parse();
