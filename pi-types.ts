// pi-types.ts
// ai-env の型定義とバリデーション用定数を集約したモジュール。

// ===== 型定義 =====

// 設定ファイル 1 プロジェクトぶんの設定。
// 後方互換のため、value がオブジェクトではなく「セッション ID 文字列」の
// 形式でも受け付ける(parseProjectValue で正規化)。
export interface ProjectConfig {
  session: string;
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
}

// プロファイル 1 個ぶんの OCR 全体設定。
// OCR_LLM_TOKEN_KEY には CREDENTIAL_SOURCES のキー名(例: "OPENCODE_API_KEY")を
// 指定し、credentials[OCR_LLM_TOKEN_KEY] を --env=OCR_LLM_TOKEN= に注入する。
// provider / model / apiKeyEnv はプロジェクト側の未指定時のフォールバック値として
// 利用される(ProjectConfig の同名フィールドが優先される)。
export interface ProfileConfig {
  OCR_USE_ANTHROPIC: string;
  OCR_LLM_URL: string;
  OCR_LLM_TOKEN_KEY: string;
  OCR_LLM_MODEL: string;
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
}

// 設定ファイル全体の構造。
export interface AiEnvConfig {
  profiles: Record<string, ProfileConfig>;
  projects: Record<string, ProjectConfig>;
}

// ===== バリデーション用定数 =====

// pi セッション ID として登録可能なプロジェクト数の下限(0 件は不可)。
export const MIN_PROJECTS = 1;
// プロファイル数の下限(0 件は不可)。
export const MIN_PROFILES = 1;

// プロジェクト名 / セッション ID / provider などの「シェルを経由する
// 値」に使う文字セット。bash case パターン(?, *, [, ])やコマンド置換
// ($, `)等のシェルメタ文字を排除。URL には使えない。
// model は model:thinkingLevel のコロン区切り書式を許容するため
// 別途 SAFE_MODEL_PATTERN を使用する。
export const SAFE_SHELL_PATTERN = /^[a-zA-Z0-9._-]+$/u;

// model 値に使う文字セット。
// pi の --model フラグは model:thinkingLevel のコロン区切り書式を
// サポートしているため、SAFE_SHELL_PATTERN にコロン(:) を追加。
// シェル引数としてのコロンは特別な意味を持たず安全。
export const SAFE_MODEL_PATTERN = /^[a-zA-Z0-9._:-]+$/u;

// POSIX 準拠のシェル環境変数名バリデーションパターン。
// 英字またはアンダースコアで始まり、英数字とアンダースコアのみ。
// apiKeyEnv (コンテナ内の環境変数名) に使用。SAFE_SHELL_PATTERN と異なり
// ドット(.)やハイフン(-)は不可(シェルが $MY.KEY を $MY として展開するため)。
export const SAFE_ENV_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;

// OCR_LLM_URL やより複雑な model 名など「container --env=KEY=VALUE の値として
// そのまま渡す」用途に許容する文字セット。spawnSync 経由なのでシェルを
// 通さず、VALUE 内のスペース以外で分割されることはない。URL で必要になる
// ':' '/' '@' '?' '&' '=' '#' '%' '+' を含むことができる。
export const SAFE_ENV_PATTERN = /^[a-zA-Z0-9._:/@?&=#%+-]+$/u;
