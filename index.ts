#!/usr/bin/env -S npx tsx

import { buildInitScript, loadPiProjects } from "./pi-projects";
import { execFileSync, spawnSync } from "node:child_process";
import { Command } from "commander";
import { platform } from "node:os";

// ===== 定数 =====

const EXIT_ERROR = 1;
const IMAGE_NAME = "pi-private-sandbox";
const OCR_LLM_URL = "https://opencode.ai/zen/go/v1";
const OCR_LLM_MODEL = "mimo-v2.5-pro";

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
  piProjects: Record<string, string>;
}

const runDockerContainer = (ctx: RunContext): number => {
  const envArgs = buildEnvArgs(ctx.herdrPaneId, ctx.credentials);
  const volumeArgs = buildVolumeArgs(ctx.home);
  const initScript = buildInitScript(ctx.piProjects);
  const dockerArgs = buildDockerArgs(envArgs, volumeArgs, initScript);
  console.error(`$ docker ${redactSecrets(dockerArgs).join(" ")}`);
  return runDocker(dockerArgs);
};

const prepareEnvironment = (): RunContext => {
  const credentials = loadCredentials();
  const home = requireEnv("HOME");
  const herdrPaneId = requireEnv("HERDR_PANE_ID");
  const piProjects = loadPiProjects();
  return { credentials, herdrPaneId, home, piProjects };
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
