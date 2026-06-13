#!/usr/bin/env -S npx tsx

import { execFileSync, spawnSync } from "node:child_process";
import { Command } from "commander";
import { platform } from "node:os";

// ===== 定数 =====

const EXIT_ERROR = 1;
const IMAGE_NAME = "pi-private-sandbox";
const OCR_LLM_URL = "https://opencode.ai/zen/go/v1";
const OCR_LLM_MODEL = "mimo-v2.5-pro";

// pi セッション再開用のプロジェクト名 → セッションID マッピング。
// コンテナ内で `pi-resume <project>` として使う。
const PI_PROJECTS: Record<string, string> = {
  "ai-env": "019ec00f-6774-7719-9d32-0ce0acf7892f",
  "ignite-timer": "019e950d-d3e4-7f42-ace9-e966f8ad9f27",
  "mindmap": "019e9b9f-e299-7b7f-a1c1-cc6c5753efc4",
  "misskey-pwa": "019e96ce-b2dc-7716-bab8-e53e74f1b0fd",
  "org-toolkit": "019ea73e-d499-7337-a4d8-d12d8be06c1a",
  "rss-reader": "019e99bb-c065-77cf-a458-a38ce1c0ef9e",
  "skills": "019ea74c-38d6-7700-89b8-c24f47f19e9e",
  "task-manager": "019ea76f-92d3-7442-a675-b79162e7f1c7",
};

// PI_PROJECTS からコンテナ用 pi-resume シェル関数を生成。
// bash の case 文でプロジェクト名をディスパッチし、未知のプロジェクトは
// 利用可能プロジェクト一覧とともにエラー終了する。
const generatePiResumeFunc = (): string => {
  const cases = Object.entries(PI_PROJECTS)
    .map(
      ([project, sessionId]) =>
        `    ${project}) pi --resume ${sessionId} ;;`,
    )
    .join("\n");
  const available = Object.keys(PI_PROJECTS).join(" ");
  return [
    "pi-resume() {",
    '  local project="$1"',
    '  case "$project" in',
    cases,
    '    *) echo "Unknown project: $project" >&2',
    `       echo "Available: ${available}" >&2`,
    "       return 1 ;;",
    "  esac",
    "}",
  ].join("\n");
};

const PI_RESUME_FUNC = generatePiResumeFunc();

// コンテナ起動直後にコンテナ内で実行する初期化スクリプト。
// SSH 鍵のセットアップ → socat ブリッジ → pi-resume 関数定義 → bash 起動の順に実行。
const INIT_SCRIPT = String.raw`cp -r /tmp/.ssh ~/.ssh && \
chown -R $(id -u):$(id -g) ~/.ssh && \
chmod 700 ~/.ssh && \
find ~/.ssh -type f -exec chmod 600 {} \; && \
mkdir -p ~/.config/herdr && \
socat UNIX-LISTEN:/home/pi/.config/herdr/herdr.sock,fork,reuseaddr TCP:host.docker.internal:9123 &

# pi セッション再開用コマンド(PI_PROJECTS から自動生成)
${PI_RESUME_FUNC}

exec /bin/bash`;

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

const buildEnvArgs = (
  herdrPaneId: string,
  credentials: Credentials,
): string[] => [
  `--env=HERDR_PANE_ID=${herdrPaneId}`,
  `--env=OCR_LLM_URL=${OCR_LLM_URL}`,
  `--env=OCR_LLM_TOKEN=${credentials.OPENCODE_API_KEY}`,
  `--env=OCR_LLM_MODEL=${OCR_LLM_MODEL}`,
  `--env=XIAOMI_TOKEN_PLAN_SGP_API_KEY=${credentials.XIAOMI_TOKEN_PLAN_SGP_API_KEY}`,
  `--env=OPENROUTER_API_KEY=${credentials.OPENROUTER_API_KEY}`,
  `--env=GH_TOKEN=${credentials.GH_TOKEN}`,
];

const buildVolumeArgs = (home: string): string[] => [
  `--volume=${process.cwd()}:/workspace`,
  `--volume=${home}/.ssh:/tmp/.ssh:ro`,
  `--volume=${home}/.pi:/home/pi/.pi`,
];

const buildDockerArgs = (
  envArgs: string[],
  volumeArgs: string[],
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
  INIT_SCRIPT,
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

const runDockerContainer = (
  credentials: Credentials,
  home: string,
  herdrPaneId: string,
): number => {
  const envArgs = buildEnvArgs(herdrPaneId, credentials);
  const volumeArgs = buildVolumeArgs(home);
  const dockerArgs = buildDockerArgs(envArgs, volumeArgs);
  console.error(`$ docker ${redactSecrets(dockerArgs).join(" ")}`);
  return runDocker(dockerArgs);
};

const prepareEnvironment = (): {
  credentials: Credentials;
  herdrPaneId: string;
  home: string;
} => {
  const credentials = loadCredentials();
  const home = requireEnv("HOME");
  const herdrPaneId = requireEnv("HERDR_PANE_ID");
  return { credentials, herdrPaneId, home };
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
    const { credentials, home, herdrPaneId } = prepareEnvironment();
    return runDockerContainer(credentials, home, herdrPaneId);
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
