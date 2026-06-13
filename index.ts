#!/usr/bin/env -S npx tsx

import { Command } from "commander";
import { execSync, spawnSync } from "node:child_process";

/**
 * 指定したコマンドを `execSync` で実行し、標準出力の内容を trim して返す。
 * 取得に失敗した場合は空文字を返す。
 */
function getCredential(command: string): string {
  try {
    return execSync(command, {
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
    // 1. クレデンシャルの動的取得
    const XIAOMI_TOKEN_PLAN_SGP_API_KEY = getCredential(
      'security find-generic-password -s "XIAOMI_TOKEN_PLAN_SGP_API_KEY" -w',
    );
    const OPENCODE_API_KEY = getCredential(
      'security find-generic-password -s "OPENCODE_API_KEY" -w',
    );
    const OPENROUTER_API_KEY = getCredential(
      'security find-generic-password -s "OPENROUTER_API_KEY" -w',
    );
    const GH_TOKEN = getCredential("gh auth token");

    // 2. 環境変数のマッピング
    const envArgs: string[] = [
      `-e HERDR_PANE_ID=${process.env.HERDR_PANE_ID ?? ""}`,
      `-e OCR_LLM_URL=https://opencode.ai/zen/go/v1`,
      `-e OCR_LLM_TOKEN=${OPENCODE_API_KEY}`,
      `-e OCR_LLM_MODEL=mimo-v2.5-pro`,
      `-e XIAOMI_TOKEN_PLAN_SGP_API_KEY=${XIAOMI_TOKEN_PLAN_SGP_API_KEY}`,
      `-e OPENROUTER_API_KEY=${OPENROUTER_API_KEY}`,
      `-e GH_TOKEN=${GH_TOKEN}`,
    ];

    // 3. ボリュームマウント
    const cwd = process.cwd();
    const home = process.env.HOME ?? "";
    const volumeArgs: string[] = [
      `-v ${cwd}:/workspace`,
      `-v ${home}/.ssh:/tmp/.ssh:ro`,
      `-v ${home}/.pi:/home/pi/.pi`,
    ];

    // 4. コンテナ起動と初期化スクリプト
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
      "pi-private-sandbox",
      "-c",
      initScript,
    ];

    // 確認用にコマンドを stderr に出力
    console.error(`$ docker ${dockerArgs.join(" ")}`);

    // 5. プロセスの実行
    const result = spawnSync("docker", dockerArgs, { stdio: "inherit" });
    if (result.error) {
      console.error("dockerの実行に失敗しました:", result.error.message);
      process.exit(1);
    }
    process.exit(result.status ?? 1);
  });

program.parse();
