// pi-validation.ts
// pi-projects.ts から抽出したバリデーション用ヘルパー群。
// 設定値の検証に使う正規表現マッチや CLI オプションの検証を担当する。

import {
  CREDENTIAL_NAMES,
  SAFE_ENV_NAME_PATTERN,
  SAFE_ENV_PATTERN,
  SAFE_MODEL_PATTERN,
  SAFE_SHELL_PATTERN,
  type CredentialName,
  type ProfileConfig,
  type ProjectConfig,
} from "./pi-types";

// ===== ヘルパー =====

// unknown 型のエラーから人間可読なメッセージを取り出すヘルパ。
export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

// 許可文字の人間可読説明(pattern → 説明文のマップ)。エラーメッセージで使用。
// 参照等価で比較するため RegExp は同一インスタンスである必要があり、
// モジュールレベルの SAFE_*_PATTERN 定数を使う。
const PATTERN_DESCRIPTIONS = new Map<RegExp, string>([
  [SAFE_SHELL_PATTERN, "英数字・ハイフン・アンダースコア・ピリオド"],
  [SAFE_MODEL_PATTERN, "英数字・ハイフン・アンダースコア・ピリオド・コロン"],
  [SAFE_ENV_PATTERN, "英数字・ハイフン・アンダースコア・ピリオド・コロン・スラッシュ等(URL 用)"],
  [SAFE_ENV_NAME_PATTERN, "英字またはアンダースコア始まり + 英数字とアンダースコア(POSIX 環境変数名)"],
]);

// 非空文字列を要求し、指定された pattern を満たすことを検証。
// 違反時は Error を投げる。合格時は値をそのまま返す。
// 4 つのパラメータをオブジェクト引数パターンにまとめて max-params を回避。
export const requireSafeId = (params: {
  configPath: string;
  fieldName: string;
  key: string;
  pattern: RegExp;
  rawValue: unknown;
}): string => {
  const { configPath, fieldName, key, pattern, rawValue } = params;
  if (typeof rawValue !== "string" || rawValue === "") {
    throw new Error(
      `設定ファイル ${configPath} の値が無効です: ${key}.${fieldName} は非空文字列である必要があります`,
    );
  }
  if (!pattern.test(rawValue)) {
    const allowed = PATTERN_DESCRIPTIONS.get(pattern) ?? "(unknown pattern)";
    throw new Error(
      `設定ファイル ${configPath} の値が無効です: ${key}.${fieldName} = ${JSON.stringify(rawValue)} (許可文字: ${allowed})`,
    );
  }
  return rawValue;
};

// CREDENTIAL_NAMES に登録されたクレデンシャル名であることを検証。
// credentialKeys / OCR_LLM_TOKEN_KEY の設定値に使う。
export const requireCredentialName = (params: {
  configPath: string;
  fieldName: string;
  key: string;
  rawValue: unknown;
}): CredentialName => {
  const { configPath, fieldName, key, rawValue } = params;
  const value = requireSafeId({
    configPath,
    fieldName,
    key,
    pattern: SAFE_ENV_NAME_PATTERN,
    rawValue,
  });
  if (!(CREDENTIAL_NAMES as readonly string[]).includes(value)) {
    throw new Error(
      `設定ファイル ${configPath} の値が無効です: ${key}.${fieldName} = ${JSON.stringify(value)} (登録済みクレデンシャル: ${CREDENTIAL_NAMES.join(", ")})`,
    );
  }
  return value as CredentialName;
};

// Profile の credentialKeys 配列を検証する。
// 未登録名・重複・空配列を拒否し、参照名を CredentialName に絞り込む。
export const parseCredentialKeys = (
  configPath: string,
  key: string,
  rawValue: unknown,
): CredentialName[] => {
  if (!Array.isArray(rawValue) || rawValue.length === 0) {
    throw new Error(
      `設定ファイル ${configPath} の ${key} に有効な credentialKeys がありません。既存Profileを移行するには、pi-projects.example.jsonを参考に必要なクレデンシャル名だけを配列で追加してください`,
    );
  }
  const result: CredentialName[] = [];
  const seen = new Set<CredentialName>();
  for (const [index, value] of rawValue.entries()) {
    const credentialName = requireCredentialName({
      configPath,
      fieldName: `credentialKeys[${index}]`,
      key,
      rawValue: value,
    });
    if (seen.has(credentialName)) {
      throw new Error(
        `設定ファイル ${configPath} の値が無効です: ${key}.credentialKeys に同じクレデンシャル '${credentialName}' が重複しています`,
      );
    }
    seen.add(credentialName);
    result.push(credentialName);
  }
  return result;
};

// Profile / Project / CLI が選択した apiKeyEnv が Profile の
// credentialKeys に含まれることを検証する。CLI でも許可リストを迂回させない。
export const requireAllowedCredentialName = (params: {
  configPath: string;
  fieldName: string;
  key: string;
  rawValue: unknown;
  allowedKeys: readonly CredentialName[];
}): CredentialName => {
  const credentialName = requireCredentialName(params);
  if (!params.allowedKeys.includes(credentialName)) {
    throw new Error(
      `設定ファイル ${params.configPath} の値が無効です: ${params.key}.${params.fieldName} = ${JSON.stringify(credentialName)} は Profile の credentialKeys に含まれていません`,
    );
  }
  return credentialName;
};

// Profile の全設定、Project の apiKeyEnv、CLI の apiKeyEnv が
// Profile の許可リストと整合することを検証する。
export const validateProfileCredentialAccess = (params: {
  configPath: string;
  hostProjectName: string;
  profileName: string;
  profile: ProfileConfig;
  projects: Record<string, ProjectConfig>;
  cliApiKeyEnv?: string;
}): void => {
  const { configPath, hostProjectName, profileName, profile, projects, cliApiKeyEnv } = params;
  requireAllowedCredentialName({
    configPath,
    fieldName: "OCR_LLM_TOKEN_KEY",
    key: `profiles.${profileName}`,
    rawValue: profile.OCR_LLM_TOKEN_KEY,
    allowedKeys: profile.credentialKeys,
  });
  if (profile.apiKeyEnv !== undefined) {
    requireAllowedCredentialName({
      configPath,
      fieldName: "apiKeyEnv",
      key: `profiles.${profileName}`,
      rawValue: profile.apiKeyEnv,
      allowedKeys: profile.credentialKeys,
    });
  }
  const project = projects[hostProjectName];
  if (project?.apiKeyEnv !== undefined) {
    requireAllowedCredentialName({
      configPath,
      fieldName: "apiKeyEnv",
      key: `projects.${hostProjectName}`,
      rawValue: project.apiKeyEnv,
      allowedKeys: profile.credentialKeys,
    });
  }
  if (cliApiKeyEnv !== undefined) {
    requireAllowedCredentialName({
      configPath: "<cli>",
      fieldName: "apiKeyEnv",
      key: "--api-key-env",
      rawValue: cliApiKeyEnv,
      allowedKeys: profile.credentialKeys,
    });
  }
};

// プロジェクトキー名(英数字・ハイフン・アンダースコア・ピリオドのみ)を検証。
export const validateProjectKey = (configPath: string, key: string): void => {
  if (!SAFE_SHELL_PATTERN.test(key)) {
    throw new Error(
      `設定ファイル ${configPath} のキーが無効です: "${key}" (英数字・ハイフン・アンダースコア・ピリオドのみ許可)`,
    );
  }
};

// unknown 値を Record<string, unknown> に変換。
// 期待型でない場合はエラー。呼び出し側では narrowed type として使える。
export const toPlainObject = (
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

// ===== CLI オプション検証 =====

// CLI オプション (--provider / --model / --api-key-env / --session) を既存の
// SAFE_*_PATTERN で検証する。undefined は未指定としてそのまま返す。
// 検証エラー時は Error を投げる。
// index.ts 側で parse 前に呼び、cli* 値を安全な形に正規化する用途を想定。
// session は pi のセッション ID (部分 ID 可) であり、pi 自身の検証と同一文字セットの
// SAFE_SHELL_PATTERN で検証する。
export const validateCliOverrides = (params: {
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  session?: string;
}): { provider?: string; model?: string; apiKeyEnv?: string; session?: string } => {
  const result: { provider?: string; model?: string; apiKeyEnv?: string; session?: string } = {};
  if (params.provider !== undefined) {
    result.provider = requireSafeId({
      configPath: "<cli>",
      fieldName: "provider",
      key: "--provider",
      pattern: SAFE_SHELL_PATTERN,
      rawValue: params.provider,
    });
  }
  if (params.model !== undefined) {
    result.model = requireSafeId({
      configPath: "<cli>",
      fieldName: "model",
      key: "--model",
      pattern: SAFE_MODEL_PATTERN,
      rawValue: params.model,
    });
  }
  if (params.apiKeyEnv !== undefined) {
    result.apiKeyEnv = requireSafeId({
      configPath: "<cli>",
      fieldName: "apiKeyEnv",
      key: "--api-key-env",
      pattern: SAFE_ENV_NAME_PATTERN,
      rawValue: params.apiKeyEnv,
    });
  }
  if (params.session !== undefined) {
    result.session = requireSafeId({
      configPath: "<cli>",
      fieldName: "session",
      key: "--session",
      pattern: SAFE_SHELL_PATTERN,
      rawValue: params.session,
    });
  }
  return result;
};
