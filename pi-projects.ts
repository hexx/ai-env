// pi-projects.ts
// pi セッション再開用の設定(JSON)を読み込み、コンテナ用 pi-resume シェル関数と
// 初期化スクリプトを生成する責務を集約したモジュール。
// v2: profiles(OCR 全体設定)+ projects(pi セッション)の二層構造に拡張。

/* oxlint-disable max-lines -- 包括的バリデーションのため行数が増える */

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

// プロファイル 1 個ぶんの OCR 全体設定。
// OCR_LLM_TOKEN_KEY には CREDENTIAL_SOURCES のキー名(例: "OPENCODE_API_KEY")を
// 指定し、credentials[OCR_LLM_TOKEN_KEY] を --env=OCR_LLM_TOKEN= に注入する。
export interface ProfileConfig {
  OCR_USE_ANTHROPIC: string;
  OCR_LLM_URL: string;
  OCR_LLM_TOKEN_KEY: string;
  OCR_LLM_MODEL: string;
}

// 設定ファイル全体の構造。
export interface AiEnvConfig {
  profiles: Record<string, ProfileConfig>;
  projects: Record<string, ProjectConfig>;
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
// プロファイル数の下限(0 件は不可)。
const MIN_PROFILES = 1;
// プロジェクト名 / セッション ID / provider / model / OCR_LLM_URL に許可する文字セット
// (シェルメタ文字を排除し bash case 文および docker --env 引数への
// 安全な埋め込みを保証)。model 名や URL には '.' ':' '/' を含むものが
// 一般的なためそれらも許容。
const SAFE_ID_PATTERN = /^[a-zA-Z0-9._:/@?&=#%+-]+$/u;

// pi セッション再開設定(JSON)のファイルパス。
// 環境変数 AI_ENV_PI_PROJECTS で上書き可能(テストやカスタム配置用)。
// 関数化しているのは、テスト時に env を切り替えられるよう評価を実行時に行うため。
const getAiEnvConfigPath = (): string =>
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

// projects(Record<string, ProjectConfig>) からコンテナ用 pi-resume シェル関数を生成。
// 各 case では '--provider <p> --model <m> --thinking high --session <s>' の順で組み立てる。
// provider / model は存在する場合のみ付与。
const generatePiResumeFunc = (
  projects: Record<string, ProjectConfig>,
): string => {
  const cases = Object.entries(projects)
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
  const available = Object.keys(projects).join(" ");
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
  projects: Record<string, ProjectConfig>,
): string => {
  const piResumeFunc = generatePiResumeFunc(projects);
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
          `以下の形式で JSON ファイルを作成し、profiles と projects を登録してください:\n` +
          `{\n` +
          `  "profiles": {\n` +
          `    "pi-private": {\n` +
          `      "OCR_USE_ANTHROPIC": "false",\n` +
          `      "OCR_LLM_URL": "https://opencode.ai/zen/go/v1",\n` +
          `      "OCR_LLM_TOKEN_KEY": "OPENCODE_API_KEY",\n` +
          `      "OCR_LLM_MODEL": "mimo-v2.5-pro"\n` +
          `    }\n` +
          `  },\n` +
          `  "projects": { ... }\n` +
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

// パース済みの unknown 値が AiEnvConfig の最上位構造を持つことを検証。
// 旧形式(平らに project=session 形式)の場合は新構造の案内を出して中断。
const toAiEnvConfigObject = (
  configPath: string,
  parsed: unknown,
): { profiles: unknown; projects: unknown } => {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `設定ファイル ${configPath} の形式が不正です。{ profiles: {...}, projects: {...} } 構造のオブジェクトが必要です。`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (!("profiles" in obj) || !("projects" in obj)) {
    throw new Error(
      `設定ファイル ${configPath} の形式が不正です。\n` +
        `新構造 { profiles: {...}, projects: {...} } が必要です。\n` +
        `リポジトリの pi-projects.example.json を参考にしてください。\n` +
        `(旧形式 { "<project>": "<session>" } および { "<project>": { session, provider?, model? } } はサポート対象外です。)`,
    );
  }
  return { profiles: obj.profiles, projects: obj.projects };
};

// unknown 値を Record<string, unknown> に変換。
// 期待型でない場合はエラー。呼び出し側では narrowed type として使える。
const toPlainObject = (
  configPath: string,
  fieldName: string,
  raw: unknown,
): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `設定ファイル ${configPath} の ${fieldName} がオブジェクトではありません。`,
    );
  }
  return raw as Record<string, unknown>;
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

// 単一プロファイルをパース・検証。4 つの必須文字列フィールドを SAFE_ID_PATTERN で検証。
const parseProfileEntry = (
  configPath: string,
  name: string,
  raw: unknown,
): ProfileConfig => {
  const profileObj = toPlainObject(configPath, `profiles.${name}`, raw);
  const fields = {
    OCR_LLM_MODEL: profileObj.OCR_LLM_MODEL,
    OCR_LLM_TOKEN_KEY: profileObj.OCR_LLM_TOKEN_KEY,
    OCR_LLM_URL: profileObj.OCR_LLM_URL,
    OCR_USE_ANTHROPIC: profileObj.OCR_USE_ANTHROPIC,
  };
  for (const field of Object.keys(fields)) {
    requireSafeId({
      configPath,
      fieldName: field,
      key: `profiles.${name}`,
      rawValue: fields[field as keyof typeof fields],
    });
  }
  return fields as ProfileConfig;
};

// profiles ブロックをパース・検証。Record<string, ProfileConfig> に変換。
const parseProfiles = (
  configPath: string,
  raw: unknown,
): Record<string, ProfileConfig> => {
  const obj = toPlainObject(configPath, "profiles", raw);
  const result: Record<string, ProfileConfig> = {};
  for (const [name, config] of Object.entries(obj)) {
    result[name] = parseProfileEntry(configPath, name, config);
  }
  if (Object.keys(result).length < MIN_PROFILES) {
    throw new Error(`設定ファイル ${configPath} の 'profiles' が空です。最低 1 つのプロファイルが必要です。`);
  }
  return result;
};

// プロジェクトキー名(英数字・ハイフン・アンダースコアのみ)を検証。
const validateProjectKey = (configPath: string, key: string): void => {
  if (!SAFE_ID_PATTERN.test(key)) {
    throw new Error(
      `設定ファイル ${configPath} のキーが無効です: "${key}" (英数字・ハイフン・アンダースコアのみ許可)`,
    );
  }
};

// オブジェクト形式の value から ProjectConfig を組み立てる。
const parseProjectObjectValue = (
  configPath: string,
  key: string,
  obj: Record<string, unknown>,
): ProjectConfig => {
  const config: ProjectConfig = {
    session: requireSafeId({ configPath, fieldName: "session", key, rawValue: obj.session }),
  };
  if ("provider" in obj) {
    config.provider = requireSafeId({ configPath, fieldName: "provider", key, rawValue: obj.provider });
  }
  if ("model" in obj) {
    config.model = requireSafeId({ configPath, fieldName: "model", key, rawValue: obj.model });
  }
  return config;
};

// 単一の (key, value) エントリを ProjectConfig に変換。文字列とオブジェクトの両対応。
const parseProjectEntry = (
  configPath: string,
  key: string,
  value: unknown,
): ProjectConfig => {
  if (typeof value === "string") {
    return {
      session: requireSafeId({ configPath, fieldName: "session", key, rawValue: value }),
    };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return parseProjectObjectValue(configPath, key, value as Record<string, unknown>);
  }
  throw new Error(
    `設定ファイル ${configPath} の値が無効です: ${key} = ${JSON.stringify(value)} (文字列または { session, provider?, model? } オブジェクトが必要)`,
  );
};

// projects ブロックをパース・検証。session 必須/provider・model 任意(後方互換で文字列値も受付)。
const parseProjects = (
  configPath: string,
  raw: unknown,
): Record<string, ProjectConfig> => {
  const obj = toPlainObject(configPath, "projects", raw);
  const result: Record<string, ProjectConfig> = {};
  for (const [key, value] of Object.entries(obj)) {
    validateProjectKey(configPath, key);
    result[key] = parseProjectEntry(configPath, key, value);
  }
  if (Object.keys(result).length < MIN_PROJECTS) {
    throw new Error(`設定ファイル ${configPath} の 'projects' にプロジェクトが定義されていません。`);
  }
  return result;
};

// 設定ファイルから AiEnvConfig(profiles + projects)を読み込む。
// 旧形式(平らな project 形式)の場合はエラーメッセージで案内して中断。
// ファイル不在・JSON 不正・構造不正はすべて例外を投げ、
// main の try/catch で一貫してエラーメッセージ表示 + exit 1 する。
export const loadAiEnvConfig = (): AiEnvConfig => {
  const configPath = getAiEnvConfigPath();
  const { profiles, projects } = toAiEnvConfigObject(
    configPath,
    parseConfigJson(configPath, readConfigContent(configPath)),
  );
  return {
    profiles: parseProfiles(configPath, profiles),
    projects: parseProjects(configPath, projects),
  };
};
