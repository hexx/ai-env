// pi-projects.ts
// pi セッション再開用の設定(JSON)を読み込み、コンテナ用 pi-resume シェル関数と
// 初期化スクリプトを生成する責務を集約したモジュール。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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

// pi セッション再開設定(JSON)のファイルパスを返す。
// 環境変数 AI_ENV_PI_PROJECTS で上書き可能(テストやカスタム配置用)。
// 関数化しているのは、テスト時に env を切り替えられるよう評価を実行時に行うため。
const getPiProjectsConfigPath = (): string =>
  process.env.AI_ENV_PI_PROJECTS ??
  path.join(homedir(), ".config", "ai-env", "pi-projects.json");

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

# pi セッション再開用コマンド(設定ファイルから自動生成)
${piResumeFunc}

exec /bin/bash`;
};

// 設定ファイルの存在チェックと読み込み。見つからなければエラー。
const readConfigContent = (configPath: string): string => {
  if (!existsSync(configPath)) {
    throw new Error(
      `設定ファイル ${configPath} が見つかりません。\n` +
        `以下の形式で JSON ファイルを作成し、pi セッション ID を登録してください:\n` +
        `{\n` +
        `  "<project-name>": "<session-uuid>",\n` +
        `  ...\n` +
        `}\n` +
        `リポジトリの pi-projects.example.json を参考にしてください。`,
    );
  }
  return readFileSync(configPath, "utf8");
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

// パース済みの unknown 値を Record<string, string> に変換・検証。
const extractProjects = (
  configPath: string,
  parsed: unknown,
): Record<string, string> => {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      `設定ファイル ${configPath} の形式が不正です。プロジェクト名→UUID のオブジェクトが必要です。`,
    );
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || value.length < MIN_VALUE_LENGTH) {
      throw new Error(
        `設定ファイル ${configPath} の値が無効です: ${key} = ${JSON.stringify(value)} (非空文字列が必要)`,
      );
    }
    result[key] = value;
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
