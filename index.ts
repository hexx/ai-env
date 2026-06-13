#!/usr/bin/env -S npx tsx

import { execFileSync, spawnSync } from "node:child_process";
import { Command } from "commander";
import { platform } from "node:os";

// ===== 定数 =====

const EXIT_ERROR = 1;
const IMAGE_NAME = "pi-private-sandbox";
const OCR_LLM_URL = "https://opencode.ai/zen/go/v1";
const OCR_LLM_MODEL = "mimo-v2.5-pro";

// コンテナ起動直後にコンテナ内で実行する初期化スクリプト。
// socat で herdr.sock を TCP にブリッジしつつ、インタラクティブ bash を起動する。
const INIT_SCRIPT = String.raw`cp -r /tmp/.ssh ~/.ssh && chown -R $(id -u):$(id -g) ~/.ssh && chmod 700 ~/.ssh && find ~/.ssh -type f -exec chmod 600 {} \; && mkdir -p ~/.config/herdr && socat UNIX-LISTEN:/home/pi/.config/herdr/herdr.sock,fork,reuseaddr TCP:host.docker.internal:9123 & exec /bin/bash`;

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

interface Credentials {
  GH_TOKEN: string;
  OPENCODE_API_KEY: string;
  OPENROUTER_API_KEY: string;
  XIAOMI_TOKEN_PLAN_SGP_API_KEY: string;
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
    console.error(`環境変数 ${name} が未設定です。`);
    process.exit(EXIT_ERROR);
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
  const credentials = {} as Credentials;
  for (const { name, file, args } of CREDENTIAL_SOURCES) {
    const value = getCredential(file, args);
    if (!value) {
      console.error(
        `クレデンシャル '${name}' の取得に失敗しました。macOS Keychain の登録状態 / 'gh auth login' の完了を確認してください。`,
      );
      process.exit(EXIT_ERROR);
    }
    credentials[name as keyof Credentials] = value;
  }
  return credentials;
};

const redactSecrets = (args: string[]): string[] =>
  args.map((arg) => arg.replace(SECRET_ENV_PATTERN, "--env=$<key>=***"));

const runDocker = (args: string[]): number => {
  const result = spawnSync("docker", args, { stdio: "inherit" });
  if (result.error) {
    console.error("dockerの実行に失敗しました:", result.error.message);
    return EXIT_ERROR;
  }
  return result.status ?? EXIT_ERROR;
};

const isMacOS = (): boolean => {
  if (platform() === "darwin") {
    return true;
  }
  console.error(
    "ai-env は macOS 専用です(macOS Keychain 'security' コマンド / 'host.docker.internal' を前提にしています)。",
  );
  return false;
};

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

// ===== メイン処理 =====

const main = (): number => {
  if (!isMacOS()) {
    return EXIT_ERROR;
  }
  const credentials = loadCredentials();
  const home = requireEnv("HOME");
  const herdrPaneId = requireEnv("HERDR_PANE_ID");
  return runDockerContainer(credentials, home, herdrPaneId);
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
