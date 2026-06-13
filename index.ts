#!/usr/bin/env -S npx tsx

import { Command } from "commander";
import { execFileSync, spawnSync } from "node:child_process";
import { platform } from "node:os";

// 設定値の定数化(将来的な差し替えをしやすくするため)
const IMAGE_NAME = "pi-private-sandbox";
const OCR_LLM_URL = "https://opencode.ai/zen/go/v1";
const OCR_LLM_MODEL = "mimo-v2.5-pro";

/**
 * 指定した実行ファイルを引数配列で実行し、標準出力の内容を trim して返す。
 * 取得に失敗した場合は空文字を返す。
 * execFileSync を使うことでシェル経由のインジェクションを防ぐ。
 */
function getCredential(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const program = new Command();

program
  .name("ai-env")
  .description("私専用のAI開発用Dockerサンドボックス環境を簡単に起動するCLI")
  .version("0.1.0")
  .action(() => {
    // macOS 専用ガード: 'security' コマンドと 'host.docker.internal' を前提にしている
    if (platform() !== "darwin") {
      console.error(
        "ai-env は macOS 専用です(macOS Keychain 'security' コマンド / 'host.docker.internal' を前提にしています)。",
      );
      process.exit(1);
    }

    // 1. クレデンシャルの宣言と取得
    const credentialSources: Array<{
      name: string;
      file: string;
      args: string[];
    }> = [
      {
        name: "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
        file: "security",
        args: [
          "find-generic-password",
          "-s",
          "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
          "-w",
        ],
      },
      {
        name: "OPENCODE_API_KEY",
        file: "security",
        args: ["find-generic-password", "-s", "OPENCODE_API_KEY", "-w"],
      },
      {
        name: "OPENROUTER_API_KEY",
        file: "security",
        args: ["find-generic-password", "-s", "OPENROUTER_API_KEY", "-w"],
      },
      {
        name: "GH_TOKEN",
        file: "gh",
        args: ["auth", "token"],
      },
    ];

    const credentials: Record<string, string> = {};
    for (const { name, file, args } of credentialSources) {
      const value = getCredential(file, args);
      if (!value) {
        console.error(
          `クレデンシャル '${name}' の取得に失敗しました。macOS Keychain の登録状態 / 'gh auth login' の完了を確認してください。`,
        );
        process.exit(1);
      }
      credentials[name] = value;
    }
    const {
      XIAOMI_TOKEN_PLAN_SGP_API_KEY,
      OPENCODE_API_KEY,
      OPENROUTER_API_KEY,
      GH_TOKEN,
    } = credentials;

    // 2. 必須環境変数のバリデーション
    const home = process.env.HOME;
    if (!home) {
      console.error("環境変数 HOME が未設定です。");
      process.exit(1);
    }
    const herdrPaneId = process.env.HERDR_PANE_ID;
    if (!herdrPaneId) {
      console.error("環境変数 HERDR_PANE_ID が未設定です。");
      process.exit(1);
    }

    // 3. 環境変数のマッピング
    const envArgs: string[] = [
      `-e HERDR_PANE_ID=${herdrPaneId}`,
      `-e OCR_LLM_URL=${OCR_LLM_URL}`,
      `-e OCR_LLM_TOKEN=${OPENCODE_API_KEY}`,
      `-e OCR_LLM_MODEL=${OCR_LLM_MODEL}`,
      `-e XIAOMI_TOKEN_PLAN_SGP_API_KEY=${XIAOMI_TOKEN_PLAN_SGP_API_KEY}`,
      `-e OPENROUTER_API_KEY=${OPENROUTER_API_KEY}`,
      `-e GH_TOKEN=${GH_TOKEN}`,
    ];

    // 4. ボリュームマウント
    const cwd = process.cwd();
    const volumeArgs: string[] = [
      `-v ${cwd}:/workspace`,
      `-v ${home}/.ssh:/tmp/.ssh:ro`,
      `-v ${home}/.pi:/home/pi/.pi`,
    ];

    // 5. コンテナ起動と初期化スクリプト
    const initScript =
      "cp -r /tmp/.ssh ~/.ssh && chown -R $(id -u):$(id -g) ~/.ssh && chmod 700 ~/.ssh && find ~/.ssh -type f -exec chmod 600 {} \\; && mkdir -p ~/.config/herdr && socat UNIX-LISTEN:/home/pi/.config/herdr/herdr.sock,fork,reuseaddr TCP:host.docker.internal:9123 & exec /bin/bash";

    // 組み立てたDockerコマンド
    const dockerArgs: string[] = [
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

    // 確認用にコマンドを stderr に出力(シークレットはマスク)
    const redactedArgs = dockerArgs.map((a) =>
      /-e\s+\w+(_API_KEY|_TOKEN)=.+/i.test(a)
        ? a.replace(/(=)(.+)/, "$1***")
        : a,
    );
    console.error(`$ docker ${redactedArgs.join(" ")}`);

    // 6. プロセスの実行
    const result = spawnSync("docker", dockerArgs, { stdio: "inherit" });
    if (result.error) {
      console.error("dockerの実行に失敗しました:", result.error.message);
      process.exit(1);
    }
    process.exit(result.status ?? 1);
  });

program.parse();
