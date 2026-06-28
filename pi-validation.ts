// pi-validation.ts
// pi-projects.ts から抽出したバリデーション用ヘルパー群。
// 設定値の検証に使う正規表現マッチや CLI オプションの検証を担当する。

import {
  SAFE_ENV_NAME_PATTERN,
  SAFE_ENV_PATTERN,
  SAFE_MODEL_PATTERN,
  SAFE_SHELL_PATTERN,
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

// CLI オプション (--provider / --model / --api-key-env) を既存の SAFE_*_PATTERN で検証する。
// undefined は未指定としてそのまま返す。検証エラー時は Error を投げる。
// index.ts 側で parse 前に呼び、cli* 値を安全な形に正規化する用途を想定。
export const validateCliOverrides = (params: {
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
}): { provider?: string; model?: string; apiKeyEnv?: string } => {
  const result: { provider?: string; model?: string; apiKeyEnv?: string } = {};
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
  return result;
};
