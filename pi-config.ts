// pi-config.ts
// pi-projects.ts から抽出した設定ファイル読み込み関連の責務を集約。
// JSONC パース、バリデーション、AiEnvConfig の構築を担当する。

import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import stripJsonComments from "strip-json-comments";
import {
  type AiEnvConfig,
  type ProfileConfig,
  type ProjectConfig,
  MIN_PROFILES,
  MIN_PROJECTS,
  SAFE_ENV_PATTERN,
  SAFE_ENV_NAME_PATTERN,
  SAFE_MODEL_PATTERN,
  SAFE_SHELL_PATTERN,
} from "./pi-types";
import {
  errorMessage,
  requireSafeId,
  toPlainObject,
  validateProjectKey,
} from "./pi-validation";

// ===== パス =====

// pi セッション再開設定(JSON)のファイルパス。
// 環境変数 AI_ENV_PI_PROJECTS で上書き可能(テストやカスタム配置用)。
// 関数化しているのは、テスト時に env を切り替えられるよう評価を実行時に行うため。
export const getAiEnvConfigPath = (): string =>
  process.env.AI_ENV_PI_PROJECTS ??
  join(homedir(), ".config", "ai-env", "pi-projects.json");

// ===== 設定ファイル読み込み =====

// 設定ファイルの読み込み。ENOENT は呼び出し元でハンドリングする。
export const readConfigContent = (configPath: string): string =>
  readFileSync(configPath, "utf8");

// JSONC (JSON with Comments) パースを実行。
// コメントを除去した後に JSON.parse を実行し、失敗時はファイル名と原因を含めて再 throw。
export const parseConfigJson = (configPath: string, content: string): unknown => {
  try {
    const stripped = stripJsonComments(content);
    return JSON.parse(stripped);
  } catch (error) {
    throw new Error(
      `設定ファイル ${configPath} の JSON パースに失敗: ${errorMessage(error)}`,
      { cause: error },
    );
  }
};

// パース済みの unknown 値が AiEnvConfig の最上位構造を持つことを検証。
// 旧形式(平らに project=session 形式)の場合は新構造の案内を出して中断。
export const toAiEnvConfigObject = (
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

// ===== プロファイルパース =====

// プロファイルの必須 OCR フィールド 4 つを SAFE_ENV_PATTERN で検証。
export const parseProfileOcrFields = (
  configPath: string,
  name: string,
  profileObj: Record<string, unknown>,
): ProfileConfig => {
  const key = `profiles.${name}`;
  const OCR_LLM_MODEL = requireSafeId({ configPath, fieldName: "OCR_LLM_MODEL", key, pattern: SAFE_ENV_PATTERN, rawValue: profileObj.OCR_LLM_MODEL });
  const OCR_LLM_TOKEN_KEY = requireSafeId({ configPath, fieldName: "OCR_LLM_TOKEN_KEY", key, pattern: SAFE_ENV_PATTERN, rawValue: profileObj.OCR_LLM_TOKEN_KEY });
  const OCR_LLM_URL = requireSafeId({ configPath, fieldName: "OCR_LLM_URL", key, pattern: SAFE_ENV_PATTERN, rawValue: profileObj.OCR_LLM_URL });
  const OCR_USE_ANTHROPIC = requireSafeId({ configPath, fieldName: "OCR_USE_ANTHROPIC", key, pattern: SAFE_ENV_PATTERN, rawValue: profileObj.OCR_USE_ANTHROPIC });
  return { OCR_LLM_MODEL, OCR_LLM_TOKEN_KEY, OCR_LLM_URL, OCR_USE_ANTHROPIC };
};

// プロファイルのオプション(provider/model/apiKeyEnv)をそれぞれ適切な pattern で検証。
// provider はシェル経由で参照する識別子なので SAFE_SHELL_PATTERN、
// model は model:thinkingLevel のコロン区切り書式を許容するため SAFE_MODEL_PATTERN、
// apiKeyEnv は POSIX 環境変数名として --api-key "$ENV" で参照するため SAFE_ENV_NAME_PATTERN
// (ドット・ハイフンは不可) で検証する。
const parseProfileOptionalFields = (params: {
  configPath: string;
  name: string;
  profileObj: Record<string, unknown>;
  result: ProfileConfig;
}): void => {
  const { configPath, name, profileObj, result } = params;
  const key = `profiles.${name}`;
  if ("provider" in profileObj) {
    result.provider = requireSafeId({ configPath, fieldName: "provider", key, pattern: SAFE_SHELL_PATTERN, rawValue: profileObj.provider });
  }
  if ("model" in profileObj) {
    result.model = requireSafeId({ configPath, fieldName: "model", key, pattern: SAFE_MODEL_PATTERN, rawValue: profileObj.model });
  }
  if ("apiKeyEnv" in profileObj) {
    result.apiKeyEnv = requireSafeId({ configPath, fieldName: "apiKeyEnv", key, pattern: SAFE_ENV_NAME_PATTERN, rawValue: profileObj.apiKeyEnv });
  }
};

// 単一プロファイルをパース・検証。必須 4 フィールド(OCR_*)は SAFE_ENV_PATTERN、
// オプションの provider は SAFE_SHELL_PATTERN、model は SAFE_MODEL_PATTERN でバリデーション。
export const parseProfileEntry = (
  configPath: string,
  name: string,
  raw: unknown,
): ProfileConfig => {
  const profileObj = toPlainObject(configPath, `profiles.${name}`, raw);
  const result = parseProfileOcrFields(configPath, name, profileObj);
  parseProfileOptionalFields({ configPath, name, profileObj, result });
  return result;
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

// ===== プロジェクトパース =====

// オブジェクト形式の value から ProjectConfig を組み立てる。
export const parseProjectObjectValue = (
  configPath: string,
  key: string,
  obj: Record<string, unknown>,
): ProjectConfig => {
  const config: ProjectConfig = {
    session: requireSafeId({ configPath, fieldName: "session", key, pattern: SAFE_SHELL_PATTERN, rawValue: obj.session }),
  };
  if ("provider" in obj) {
    config.provider = requireSafeId({ configPath, fieldName: "provider", key, pattern: SAFE_SHELL_PATTERN, rawValue: obj.provider });
  }
  if ("model" in obj) {
    config.model = requireSafeId({ configPath, fieldName: "model", key, pattern: SAFE_MODEL_PATTERN, rawValue: obj.model });
  }
  if ("apiKeyEnv" in obj) {
    config.apiKeyEnv = requireSafeId({ configPath, fieldName: "apiKeyEnv", key, pattern: SAFE_ENV_NAME_PATTERN, rawValue: obj.apiKeyEnv });
  }
  return config;
};

// 単一の (key, value) エントリを ProjectConfig に変換。文字列とオブジェクトの両対応。
export const parseProjectEntry = (
  configPath: string,
  key: string,
  value: unknown,
): ProjectConfig => {
  if (typeof value === "string") {
    return {
      session: requireSafeId({ configPath, fieldName: "session", key, pattern: SAFE_SHELL_PATTERN, rawValue: value }),
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

// デフォルトの AiEnvConfig を生成する（設定ファイル未存在時用）。
export const getDefaultConfig = (): AiEnvConfig => {
  console.error(
    "pi-projects.json が見つからないため、デフォルト設定で起動します。\n" +
      "後ほど pi-projects.example.json を参考に設定ファイルを作成してください。",
  );
  return {
    profiles: {
      "pi-private": {
        OCR_LLM_MODEL: "mimo-v2.5-pro",
        OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
        OCR_LLM_URL: "https://opencode.ai/zen/go/v1",
        OCR_USE_ANTHROPIC: "false",
      },
    },
    projects: {
      "pi-private": {
        session: randomUUID(),
      },
    },
  };
};

// ===== 公開 API =====

// 設定ファイルから AiEnvConfig(profiles + projects)を読み込む。
// 旧形式(平らな project 形式)の場合はエラーメッセージで案内して中断。
// ファイル不在・JSON 不正・構造不正はすべて例外を投げ、
// main の try/catch で一貫してエラーメッセージ表示 + exit 1 する。
export const loadAiEnvConfig = (): AiEnvConfig => {
  const configPath = getAiEnvConfigPath();
  try {
    const { profiles, projects } = toAiEnvConfigObject(
      configPath,
      parseConfigJson(configPath, readConfigContent(configPath)),
    );
    return {
      profiles: parseProfiles(configPath, profiles),
      projects: parseProjects(configPath, projects),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return getDefaultConfig();
    }
    throw error;
  }
};
