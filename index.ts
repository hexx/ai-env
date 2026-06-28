/* oxlint-disable max-lines -- コマンド定義の見通しを優先 */

import { validateCliOverrides } from "./pi-projects";
import {
  EXIT_ERROR,
  handleError,
  isMacOS,
  prepareEnvironment,
  runContainerCommand,
} from "./index-helpers";
import { Command } from "commander";

// ===== CLI オプション =====

interface CliOptions {
  apiKeyEnv?: string;
  bash?: boolean;
  model?: string;
  provider?: string;
  resume?: boolean;
}

// ===== メイン処理 =====

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
