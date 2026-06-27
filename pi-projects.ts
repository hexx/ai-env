// pi-projects.ts
// pi セッション再開用の設定(JSON)を読み込み、コンテナ用 pi-resume シェル関数と
// 初期化スクリプトを生成する責務を集約したモジュール。
// v2: profiles(OCR 全体設定)+ projects(pi セッション)の二層構造に拡張。

/* oxlint-disable max-lines -- 包括的バリデーションのため行数が増える */

import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import stripJsonComments from "strip-json-comments";

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
// プロジェクト名 / セッション ID / provider などの「シェルを経由する
// 値」に使う文字セット。bash case パターン(?, *, [, ])やコマンド置換
// ($, `)等のシェルメタ文字を排除。URL には使えない。
// model は model:thinkingLevel のコロン区切り書式を許容するため
// 別途 SAFE_MODEL_PATTERN を使用する。
const SAFE_SHELL_PATTERN = /^[a-zA-Z0-9._-]+$/u;

// model 値に使う文字セット。
// pi の --model フラグは model:thinkingLevel のコロン区切り書式を
// サポートしているため、SAFE_SHELL_PATTERN にコロン(:) を追加。
// シェル引数としてのコロンは特別な意味を持たず安全。
const SAFE_MODEL_PATTERN = /^[a-zA-Z0-9._:-]+$/u;

// POSIX 準拠のシェル環境変数名バリデーションパターン。
// 英字またはアンダースコアで始まり、英数字とアンダースコアのみ。
// apiKeyEnv (コンテナ内の環境変数名) に使用。SAFE_SHELL_PATTERN と異なり
// ドット(.)やハイフン(-)は不可(シェルが $MY.KEY を $MY として展開するため)。
const SAFE_ENV_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;

// OCR_LLM_URL やより複雑な model 名など「container --env=KEY=VALUE の値として
// そのまま渡す」用途に許容する文字セット。spawnSync 経由なのでシェルを
// 通さず、VALUE 内のスペース以外で分割されることはない。URL で必要になる
// ':' '/' '@' '?' '&' '=' '#' '%' '+' を含むことができる。
const SAFE_ENV_PATTERN = /^[a-zA-Z0-9._:/@?&=#%+-]+$/u;

// pi セッション再開設定(JSON)のファイルパス。
// 環境変数 AI_ENV_PI_PROJECTS で上書き可能(テストやカスタム配置用)。
// 関数化しているのは、テスト時に env を切り替えられるよう評価を実行時に行うため。
const getAiEnvConfigPath = (): string =>
  process.env.AI_ENV_PI_PROJECTS ??
  join(homedir(), ".config", "ai-env", "pi-projects.json");

// ===== 関数生成 =====

// 任意の値から '--name <value>' フラグ文字列を生成(空文字なら空文字)。
// 値は SAFE_SHELL_PATTERN または SAFE_MODEL_PATTERN でシェルメタ文字を
// 排除済みなのでスペース区切り・非クォートで十分。シンプルに保たれる方を採用。
// no-ternary ルール下で三元演算子を避けるため関数化。
const buildOptionalFlag = (name: string, value: string | undefined): string => {
  if (value) {
    return `--${name} ${value}`;
  }
  return "";
};

// pi に渡すフラグ文字列を組み立てる(provider / model / apiKeyEnv / sessionId)。
// 空の値は省略。apiKeyEnv がある場合は --api-key "$ENV" 形式で展開し、
// シェル実行時に $ENV が解決される。sessionId が指定された場合のみ
// --session <id> を出力に含める(プロジェクト case のみ。*) 分岐では不要)。
// 値の優先順位解決(CLI > Project > Profile)は呼び出し側で行う。
const buildPiFlags = (params: {
  provider: string | undefined;
  model: string | undefined;
  apiKeyEnv: string | undefined;
  sessionId?: string;
}): string => {
  const { provider, model, apiKeyEnv, sessionId } = params;
  const apiKeyFlag = apiKeyEnv ? `--api-key "$${apiKeyEnv}"` : "";
  const parts: string[] = [
    buildOptionalFlag("provider", provider),
    buildOptionalFlag("model", model),
    apiKeyFlag,
  ];
  if (sessionId) {
    parts.push(`--session ${sessionId}`);
  }
  return parts.filter((p) => p !== "").join(" ");
};

// case 文の本体を生成する。pi-resume 関数と ai-env デフォルト起動の両方で共有する。
// 各プロジェクトの case ブランチ、*) ブランチともに「CLI > Project > Profile」の優先度。
// ただし *) ブランチでは project 値が存在しないため「CLI > profile」となる。
// 思考レベルなど pi 側オプションは明示的に渡さない(pi のデフォルトに委ねる)。
const generateCaseBody = (params: {
  projects: Record<string, ProjectConfig>;
  defaultProvider: string | undefined;
  defaultModel: string | undefined;
  defaultApiKeyEnv: string | undefined;
  cliProvider: string | undefined;
  cliModel: string | undefined;
  cliApiKeyEnv: string | undefined;
  // *) ブランチの挙動。
  //   "warn": 警告メッセージ + pi (引数なし)。pi-resume 関数の既存挙動を保持。
  //   "defaults": CLI > profile のフォールバック値で pi を起動。ai-env デフォルト起動用。
  unknownStrategy: "warn" | "defaults";
}): string => {
  const {
    projects,
    defaultProvider,
    defaultModel,
    defaultApiKeyEnv,
    cliProvider,
    cliModel,
    cliApiKeyEnv,
    unknownStrategy,
  } = params;
  const projectCases = Object.entries(projects)
    .map(([project, config]) => {
      // 優先度: CLI > project > profile。CLI で明示上書きが可能。
      const flags = buildPiFlags({
        provider: cliProvider ?? config.provider ?? defaultProvider,
        model: cliModel ?? config.model ?? defaultModel,
        apiKeyEnv: cliApiKeyEnv ?? config.apiKeyEnv ?? defaultApiKeyEnv,
        sessionId: config.session,
      });
      return `    ${project}) pi ${flags} ;;`;
    })
    .join("\n");
  let unknownBranch: string;
  if (unknownStrategy === "warn") {
    unknownBranch = [
      '    *) echo "Warning: Unknown project - trying pi with defaults" >&2',
      "       pi ;;",
    ].join("\n");
  } else {
    // defaults: CLI > profile の優先度でフォールバック。
    // apiKeyEnv は *) 分岐では渡さない(pi-resume の `pi` 引数なし挙動と整合させ、
    // シェル関数未注入時の混乱を避けるため)。
    const fallbackFlags = buildPiFlags({
      provider: cliProvider ?? defaultProvider,
      model: cliModel ?? defaultModel,
      apiKeyEnv: undefined,
    });
    unknownBranch = fallbackFlags
      ? `    *) pi ${fallbackFlags} ;;`
      : "    *) pi ;;";
  }
  return projectCases ? `${projectCases}\n${unknownBranch}` : unknownBranch;
};

// projects(Record<string, ProjectConfig>) からコンテナ用 pi-resume シェル関数を生成。
// 各 case では '--provider <p> --model <m> --api-key "$<env>" --session <s>' の順で組み立てる。
// provider / model / apiKeyEnv は存在する場合のみ付与。プロファイル側から渡される
// デフォルト値(defaultProvider / defaultModel / defaultApiKeyEnv)はプロジェクト側
// で同名フィールドが未指定のときのフォールバックとして使われる。
// 思考レベルなどの pi 側オプションは明示的に渡さない(pi のデフォルトに委ねる)。
const generatePiResumeFunc = (params: {
  projects: Record<string, ProjectConfig>;
  defaultProvider: string | undefined;
  defaultModel: string | undefined;
  defaultApiKeyEnv: string | undefined;
  cliProvider: string | undefined;
  cliModel: string | undefined;
  cliApiKeyEnv: string | undefined;
}): string => {
  const caseBody = generateCaseBody({ ...params, unknownStrategy: "warn" });
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
    caseBody,
    "  esac",
    "}",
  ].join("\n");
};

// コンテナ起動直後にコンテナ内で実行する初期化スクリプトを生成。
// SSH 鍵セットアップ → pm2 管理下の socat ブリッジ → pi-resume 関数定義 → pi 起動の順。
// pi 終了時に pm2 をクリーンアップしてコンテナを終了する。
// bash で $HOST_IP を変数展開するための参照文字列を返す。
// String.raw 内で '${HOST_IP}' を直接書くと TypeScript テンプレート式として
// 解釈されるため、ヘルパー関数を経由して文字列として埋め込む。
// oxlint-disable-next-line no-template-curly-in-string
const hostIpRef = (): string => "${HOST_IP}";

// bash で $HOST_PROJECT_NAME を変数展開するための参照文字列を返す。
// hostIpRef と同じく、String.raw 内で TypeScript テンプレート式として
// 解釈されないようヘルパー関数経由で文字列を埋め込む。
// oxlint-disable-next-line no-template-curly-in-string
const hostProjectNameRef = (): string => "${HOST_PROJECT_NAME}";

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

export const buildInitScript = (params: {
  projects: Record<string, ProjectConfig>;
  defaultProvider: string | undefined;
  defaultModel: string | undefined;
  defaultApiKeyEnv?: string;
  // CLI オプション。bash モードでは env 変数として export、
  // デフォルト起動ではプロジェクト未マッチ時のフォールバック値として使われる。
  cliProvider?: string;
  cliModel?: string;
  cliApiKeyEnv?: string;
  bashMode?: boolean;
  resume?: boolean;
}): string => {
  const {
    projects,
    defaultProvider,
    defaultModel,
    defaultApiKeyEnv,
    cliProvider,
    cliModel,
    cliApiKeyEnv,
    bashMode = false,
    resume = false,
  } = params;
  const piResumeFunc = generatePiResumeFunc({
    projects,
    defaultProvider,
    defaultModel,
    defaultApiKeyEnv,
    cliProvider,
    cliModel,
    cliApiKeyEnv,
  });

  const commonScript = String.raw`cp -r /tmp/.ssh ~/.ssh && \
chown -R $(id -u):$(id -g) ~/.ssh && \
chmod 700 ~/.ssh && \
find ~/.ssh -type f -exec chmod 600 {} \; && \
mkdir -p ~/.config/herdr && \
pm2 start socat --name "herdr-socat" -- UNIX-LISTEN:/home/pi/.config/herdr/herdr.sock,fork,reuseaddr TCP:${hostIpRef()}:9123

cat << 'PI_RESUME_EOF' >> /home/pi/.bashrc
${piResumeFunc}
PI_RESUME_EOF`;

  if (bashMode) {
    // CLI オプションが指定された場合のみ env 変数として export。
    // 未指定なら export しないため、コンテナ側 bash で未設定変数となり
    // シェル展開時に空文字として安全に取り扱える。
    // (String.raw ではなく通常のテンプレートリテラルで組み立てるのは
    //  ${cliProvider} などの TypeScript 補間が必要なため。)
    const exportLines: string[] = [];
    if (cliProvider !== undefined) {
      exportLines.push(`export PI_PROVIDER="${cliProvider}"`);
    }
    if (cliModel !== undefined) {
      exportLines.push(`export PI_MODEL="${cliModel}"`);
    }
    if (cliApiKeyEnv !== undefined) {
      exportLines.push(`export PI_API_KEY_ENV="${cliApiKeyEnv}"`);
    }
    const exportBlock =
      exportLines.length > 0 ? `\n${exportLines.join("\n")}\n` : "";
    return commonScript + exportBlock + String.raw`

exec /bin/bash`;
  }
  if (resume) {
    return commonScript + String.raw`

${piResumeFunc}
pi-resume
rc=$?
pm2 kill
exit $rc`;
  }
  // デフォルト起動(--resume / --bash なし): pi-resume と同じ case 解決をインライン化。
  // プロジェクト側の provider / model / apiKeyEnv が反映され、未知プロジェクトでは
  // CLI > profile のフォールバックで pi を起動する。
  const caseBody = generateCaseBody({
    projects,
    defaultProvider,
    defaultModel,
    defaultApiKeyEnv,
    cliProvider,
    cliModel,
    cliApiKeyEnv,
    unknownStrategy: "defaults",
  });
  return commonScript + String.raw`

project="${hostProjectNameRef()}"
case "$project" in
${caseBody}
esac
rc=$?
pm2 kill
exit $rc`;
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
      throw error;
    }
    throw error;
  }
};

// JSONC (JSON with Comments) パースを実行。
// コメントを除去した後に JSON.parse を実行し、失敗時はファイル名と原因を含めて再 throw。
const parseConfigJson = (configPath: string, content: string): unknown => {
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

// 許可文字の人間可読説明(pattern → 説明文のマップ)。エラーメッセージで使用。
// 参照等価で比較するため RegExp は同一インスタンスである必要があり、
// モジュールレベルの SAFE_SHELL_PATTERN / SAFE_ENV_PATTERN 定数を使う。
const PATTERN_DESCRIPTIONS = new Map<RegExp, string>([
  [SAFE_SHELL_PATTERN, "英数字・ハイフン・アンダースコア・ピリオド"],
  [SAFE_MODEL_PATTERN, "英数字・ハイフン・アンダースコア・ピリオド・コロン"],
  [SAFE_ENV_PATTERN, "英数字・ハイフン・アンダースコア・ピリオド・コロン・スラッシュ等(URL 用)"],
  [SAFE_ENV_NAME_PATTERN, "英字またはアンダースコア始まり + 英数字とアンダースコア(POSIX 環境変数名)"],
]);;

// 非空文字列を要求し、指定された pattern を満たすことを検証。
// 違反時は Error を投げる。合格時は値をそのまま返す。
// 4 つのパラメータをオブジェクト引数パターンにまとめて max-params を回避。
const requireSafeId = (params: {
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

// プロファイルの必須 OCR フィールド 4 つを SAFE_ENV_PATTERN で検証。
const parseProfileOcrFields = (
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
const parseProfileEntry = (
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

// プロジェクトキー名(英数字・ハイフン・アンダースコアのみ)を検証。
const validateProjectKey = (configPath: string, key: string): void => {
  if (!SAFE_SHELL_PATTERN.test(key)) {
    throw new Error(
      `設定ファイル ${configPath} のキーが無効です: "${key}" (英数字・ハイフン・アンダースコア・ピリオドのみ許可)`,
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
const parseProjectEntry = (
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

// 設定ファイルから AiEnvConfig(profiles + projects)を読み込む。
// 旧形式(平らな project 形式)の場合はエラーメッセージで案内して中断。
// ファイル不在・JSON 不正・構造不正はすべて例外を投げ、
// main の try/catch で一貫してエラーメッセージ表示 + exit 1 する。
// デフォルトの AiEnvConfig を生成する（設定ファイル未存在時用）。
const getDefaultConfig = (): AiEnvConfig => {
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
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return getDefaultConfig();
    }
    throw error;
  }
};
