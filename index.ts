/* oxlint-disable max-lines -- コマンド定義の見通しを優先 */

import { validateCliOverrides } from "./pi-projects";
import {
  EXIT_ERROR,
  handleError,
  isMacOS,
  prepareEnvironment,
  runContainerCommand,
  validateFlagCombination,
} from "./index-helpers";
import { Command } from "commander";

// ===== CLI オプション =====

interface CliOptions {
  apiKeyEnv?: string;
  attach?: boolean;
  bash?: boolean;
  model?: string;
  new?: boolean;
  provider?: string;
  session?: string;
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
    // --new は新規セッションでの起動、--session はセッション再開を内包するため、
    // それぞれ排他フラグとの組み合わせを検証する。
    // 違反時は該当メッセージを stderr に出力して exit 1。
    const combinationError = validateFlagCombination({
      attach: options.attach ?? false,
      bash: options.bash ?? false,
      new: options.new ?? false,
      session: options.session !== undefined,
    });
    if (combinationError) {
      console.error(combinationError);
      return EXIT_ERROR;
    }
    // CLI オプションを SAFE_*_PATTERN で検証(設定ファイルと同一ルールで弾く)。
    // 検証エラーは handleError でメッセージ表示 + exit 1。
    const validated = validateCliOverrides({
      apiKeyEnv: options.apiKeyEnv,
      model: options.model,
      provider: options.provider,
      session: options.session,
    });
    return runContainerCommand(
      prepareEnvironment({
        apiKeyEnv: validated.apiKeyEnv,
        attachMode: options.attach ?? false,
        bashMode: options.bash ?? false,
        model: validated.model,
        newMode: options.new ?? false,
        provider: validated.provider,
        session: validated.session,
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
  .option("--attach", "同じディレクトリで起動中のコンテナにアタッチする")
  .option("--bash", "pi を起動せずに bash シェルのみを起動する")
  .option("--new", "新しいセッションで pi を起動する(デフォルトは前回セッションの続行: pi -c)")
  .option(
    "--session <id>",
    "pi の --session フラグに渡すセッション ID(部分 ID 可、--new とは排他、bash モードでは PI_SESSION env 変数として export)",
  )
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
