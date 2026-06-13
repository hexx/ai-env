// pi-projects.ts
// pi セッション再開用の設定(JSON)を読み込み、コンテナ用 pi-resume シェル関数と
// 初期化スクリプトを生成する責務を集約したモジュール。

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// unknown 型のエラーから人間可読なメッセージを取り出すヘルパ。
// no-ternary ルール下で三元演算子を避けるため関数化。
const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

// pi セッション ID として登録可能なプロジェクト数の下限(0 件は不可)。
const MIN_PROJECTS = 1;
// セッション ID 文字列の最小長(空文字は不可)。
const MIN_VALUE_LENGTH = 1;
// プロジェクト名 / セッション ID に許可する文字セット(シェルメタ文字を排除し
// bash case 文への安全な埋め込みを保証)。
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u;

// pi セッション再開設定(JSON)のファイルパスを返す。
// 環境変数 AI_ENV_PI_PROJECTS で上書き可能(テストやカスタム配置用)。
// 関数化しているのは、テスト時に env を切り替えられるよう評価を実行時に行うため。
const getPiProjectsConfigPath = (): string =>
  process.env.AI_ENV_PI_PROJECTS ??
  join(homedir(), ".config", "ai-env", "pi-projects.json");

// piProjects(Record<string, string>) からコンテナ用 pi-resume シェル関数を生成。
// bash の case 文でプロジェクト名をディスパッチし、未知のプロジェクトは
// 利用可能プロジェクト一覧とともにエラー終了する。
const generatePiResumeFunc = (
  piProjects: Record<string, string>,
): string => {
  const cases = Object.entries(piProjects)
    .map(
      ([project, sessionId]) =>
        `    ${project}) pi --resume ${sessionId} ;;`,
    )
    .join("\n");
  const available = Object.keys(piProjects).join(" ");
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

// コンテナ起動直後にコンテナ内で実行する初期化スクリプトを生成。
// SSH 鍵セットアップ → socat ブリッジ → pi-resume 関数定義 → bash 起動の順。
export const buildInitScript = (
  piProjects: Record<string, string>,
): string => {
  const piResumeFunc = generatePiResumeFunc(piProjects);
  return String.raw`cp -r /tmp/.ssh ~/.ssh && \
chown -R $(id -u):$(id -g) ~/.ssh && \
chmod 700 ~/.ssh && \
find ~/.ssh -type f -exec chmod 600 {} \; && \
mkdir -p ~/.config/herdr && \
socat UNIX-LISTEN:/home/pi/.config/herdr/herdr.sock,fork,reuseaddr TCP:host.docker.internal:9123 &

# pi セッション再開用コマンドを .bashrc に追記
# (直接定義すると exec /bin/bash で消えるため、次のシェルに引き継ぐ)
cat << 'EOF' >> ~/.bashrc
${piResumeFunc}
EOF

exec /bin/bash`;
};

// 設定ファイルの読み込み。ENOENT は「ファイル不在」として扱い、その他は
// そのまま再 throw(TOCTOU 回避のため existsSync チェックは行わない)。
const readConfigContent = (configPath: string): string => {
  try {
    return readFileSync(configPath, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(
        `設定ファイル ${configPath} が見つかりません。\n` +
          `以下の形式で JSON ファイルを作成し、pi セッション ID を登録してください:\n` +
          `{\n` +
          `  "<project-name>": "<session-uuid>",\n` +
          `  ...\n` +
          `}\n` +
          `リポジトリの pi-projects.example.json を参考にしてください。`,
        { cause: error },
      );
    }
    throw error;
  }
};

// JSON パースを実行。失敗時はファイル名と原因を含めて再 throw。
const parseConfigJson = (configPath: string, content: string): unknown => {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `設定ファイル ${configPath} の JSON パースに失敗: ${errorMessage(error)}`,
      { cause: error },
    );
  }
};

// パース済みの unknown 値を Record<string, unknown> に変換。
// 期待型でない場合はエラー。呼び出し側では narrowed type として使える。
const toProjectsObject = (
  configPath: string,
  parsed: unknown,
): Record<string, unknown> => {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      `設定ファイル ${configPath} の形式が不正です。プロジェクト名→UUID のオブジェクトが必要です。`,
    );
  }
  return parsed as Record<string, unknown>;
};

// 単一の (key, value) エントリを検証して結果に追加。
const validateAndCollect = (entry: {
  configPath: string;
  key: string;
  result: Record<string, string>;
  value: unknown;
}): void => {
  if (!SAFE_ID_PATTERN.test(entry.key)) {
    throw new Error(
      `設定ファイル ${entry.configPath} のキーが無効です: "${entry.key}" (英数字・ハイフン・アンダースコアのみ許可)`,
    );
  }
  const { value } = entry;
  if (typeof value !== "string" || value.length < MIN_VALUE_LENGTH) {
    throw new Error(
      `設定ファイル ${entry.configPath} の値が無効です: ${entry.key} = ${JSON.stringify(value)} (非空文字列が必要)`,
    );
  }
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(
      `設定ファイル ${entry.configPath} の値が無効です: ${entry.key} = ${JSON.stringify(value)} (英数字・ハイフン・アンダースコアのみ許可)`,
    );
  }
  entry.result[entry.key] = value;
};

// パース済みの unknown 値を Record<string, string> に変換・検証。
const extractProjects = (
  configPath: string,
  parsed: unknown,
): Record<string, string> => {
  const obj = toProjectsObject(configPath, parsed);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    validateAndCollect({ configPath, key, result, value });
  }
  if (Object.keys(result).length < MIN_PROJECTS) {
    throw new Error(
      `設定ファイル ${configPath} にプロジェクトが定義されていません。`,
    );
  }
  return result;
};

// 設定ファイルから pi プロジェクト → セッションID マッピングを読み込む。
// ファイル不在・JSON 不正・構造不正はすべて例外を投げ、
// main の try/catch で一貫してエラーメッセージ表示 + exit 1 する。
export const loadPiProjects = (): Record<string, string> => {
  const configPath = getPiProjectsConfigPath();
  return extractProjects(configPath, parseConfigJson(configPath, readConfigContent(configPath)));
};
