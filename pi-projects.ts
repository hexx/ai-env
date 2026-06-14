// pi-projects.ts
// pi セッション再開用の設定(JSON)を読み込み、コンテナ用 pi-resume シェル関数と
// 初期化スクリプトを生成する責務を集約したモジュール。

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// ===== 型定義 =====

// 設定ファイル 1 プロジェクトぶんの設定。
// 後方互換のため、value がオブジェクトではなく「セッション ID 文字列」の
// 形式でも受け付ける(parseProjectValue で正規化)。
export interface ProjectConfig {
  session: string;
  provider?: string;
  model?: string;
}

// ===== 定数 =====

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
// プロジェクト名 / セッション ID / provider / model に許可する文字セット
// (シェルメタ文字を排除し bash case 文への安全な埋め込みを保証)。
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u;

// pi セッション再開設定(JSON)のファイルパス。
// 環境変数 AI_ENV_PI_PROJECTS で上書き可能(テストやカスタム配置用)。
// 関数化しているのは、テスト時に env を切り替えられるよう評価を実行時に行うため。
const getPiProjectsConfigPath = (): string =>
  process.env.AI_ENV_PI_PROJECTS ??
  join(homedir(), ".config", "ai-env", "pi-projects.json");

// ===== 関数生成 =====

// 任意の値から '--name <value>' フラグ文字列を生成(空文字なら空文字)。
// 値は SAFE_ID_PATTERN で英数字・ハイフン・アンダースコアのみに制限済みなので
// スペース区切り・非クォートで十分。シンプルに保たれる方を採用。
// no-ternary ルール下で三元演算子を避けるため関数化。
const buildOptionalFlag = (name: string, value: string | undefined): string => {
  if (value) {
    return `--${name} ${value}`;
  }
  return "";
};

// piProjects(Record<string, ProjectConfig>) からコンテナ用 pi-resume シェル関数を生成。
// 各 case では '--provider <p> --model <m> --thinking high --session <s>' の順で組み立てる。
// provider / model は存在する場合のみ付与。
const generatePiResumeFunc = (
  piProjects: Record<string, ProjectConfig>,
): string => {
  const cases = Object.entries(piProjects)
    .map(([project, config]) => {
      const flags = [
        buildOptionalFlag("provider", config.provider),
        buildOptionalFlag("model", config.model),
        "--thinking high",
        `--session ${config.session}`,
      ].join(" ");
      return `    ${project}) pi ${flags} ;;`;
    })
    .join("\n");
  const available = Object.keys(piProjects).join(" ");
  return [
    "pi-resume() {",
    // 引数省略時は HOST_PROJECT_NAME 環境変数(= ホストの cwd ディレクトリ名)を
    // プロジェクト名として自動採用。コンテナ内の $PWD は常に /workspace なので
    // $(basename "$PWD") では 'workspace' 固定になり機能しないため、ホスト側で
    // 算出した値を環境変数経由で受け取る。
    // 通常文字列内に bash の ${1:-...} を含むため oxlint ルールを部分抑止。
    // oxlint-disable-next-line no-template-curly-in-string
    '  local project="${1:-$HOST_PROJECT_NAME}"',
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
  piProjects: Record<string, ProjectConfig>,
): string => {
  const piResumeFunc = generatePiResumeFunc(piProjects);
  return String.raw`cp -r /tmp/.ssh ~/.ssh && \
chown -R $(id -u):$(id -g) ~/.ssh && \
chmod 700 ~/.ssh && \
find ~/.ssh -type f -exec chmod 600 {} \; && \
mkdir -p ~/.config/herdr && \
socat UNIX-LISTEN:/home/pi/.config/herdr/herdr.sock,fork,reuseaddr TCP:host.docker.internal:9123 &

cat << 'PI_RESUME_EOF' >> /home/pi/.bashrc
${piResumeFunc}
PI_RESUME_EOF

exec /bin/bash`;
};

// ===== 設定読み込み =====

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
          `  "<project-name>": { "session": "<uuid>", "provider": "<p>", "model": "<m>" },\n` +
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
      `設定ファイル ${configPath} の形式が不正です。プロジェクト名→設定のオブジェクトが必要です。`,
    );
  }
  return parsed as Record<string, unknown>;
};

// 非空文字列を要求し、SAFE_ID_PATTERN を満たすことを検証。
// 違反時は Error を投げる。合格時は値をそのまま返す。
// 4 つのパラメータをオブジェクト引数パターンにまとめて max-params を回避。
const requireSafeId = (params: {
  configPath: string;
  fieldName: string;
  key: string;
  rawValue: unknown;
}): string => {
  const { configPath, fieldName, key, rawValue } = params;
  if (typeof rawValue !== "string" || rawValue === "") {
    throw new Error(
      `設定ファイル ${configPath} の値が無効です: ${key}.${fieldName} は非空文字列である必要があります`,
    );
  }
  if (!SAFE_ID_PATTERN.test(rawValue)) {
    throw new Error(
      `設定ファイル ${configPath} の値が無効です: ${key}.${fieldName} = ${JSON.stringify(rawValue)} (英数字・ハイフン・アンダースコアのみ許可)`,
    );
  }
  return rawValue;
};

// 単一の value を ProjectConfig に正規化。
// - 文字列: { session: value } として扱う(後方互換)
// - オブジェクト: session / provider? / model? を検証して抽出
// - それ以外: エラー
const parseProjectObject = (
  configPath: string,
  key: string,
  obj: Record<string, unknown>,
): ProjectConfig => {
  const config: ProjectConfig = {
    session: requireSafeId({
      configPath,
      fieldName: "session",
      key,
      rawValue: obj.session,
    }),
  };
  if ("provider" in obj) {
    config.provider = requireSafeId({
      configPath,
      fieldName: "provider",
      key,
      rawValue: obj.provider,
    });
  }
  if ("model" in obj) {
    config.model = requireSafeId({
      configPath,
      fieldName: "model",
      key,
      rawValue: obj.model,
    });
  }
  return config;
};

const parseProjectValue = (
  configPath: string,
  key: string,
  value: unknown,
): ProjectConfig => {
  if (typeof value === "string") {
    return {
      session: requireSafeId({
        configPath,
        fieldName: "session",
        key,
        rawValue: value,
      }),
    };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return parseProjectObject(configPath, key, value as Record<string, unknown>);
  }
  throw new Error(
    `設定ファイル ${configPath} の値が無効です: ${key} = ${JSON.stringify(value)} (文字列または { session, provider?, model? } オブジェクトが必要)`,
  );
};

// 単一の (key, value) エントリを検証して結果に追加。
const validateAndCollect = (entry: {
  configPath: string;
  key: string;
  result: Record<string, ProjectConfig>;
  value: unknown;
}): void => {
  if (!SAFE_ID_PATTERN.test(entry.key)) {
    throw new Error(
      `設定ファイル ${entry.configPath} のキーが無効です: "${entry.key}" (英数字・ハイフン・アンダースコアのみ許可)`,
    );
  }
  entry.result[entry.key] = parseProjectValue(
    entry.configPath,
    entry.key,
    entry.value,
  );
};

// パース済みの unknown 値を Record<string, ProjectConfig> に変換・検証。
const extractProjects = (
  configPath: string,
  parsed: unknown,
): Record<string, ProjectConfig> => {
  const obj = toProjectsObject(configPath, parsed);
  const result: Record<string, ProjectConfig> = {};
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

// 設定ファイルから pi プロジェクト → 設定(ProjectConfig)マッピングを読み込む。
// ファイル不在・JSON 不正・構造不正はすべて例外を投げ、
// main の try/catch で一貫してエラーメッセージ表示 + exit 1 する。
export const loadPiProjects = (): Record<string, ProjectConfig> => {
  const cp = getPiProjectsConfigPath();
  return extractProjects(cp, parseConfigJson(cp, readConfigContent(cp)));
};
