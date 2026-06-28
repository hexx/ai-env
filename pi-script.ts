// pi-script.ts
// pi-projects.ts から抽出した、コンテナ用シェルスクリプト生成の責務を集約。
// pi-resume 関数や pi 起動スクリプトの文字列組み立てを担当する。

import { type ProjectConfig } from "./pi-types";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===== テンプレート読み込み =====

// テンプレートファイルのキャッシュ（初回読み込み時にのみファイルアクセス）
const templateCache = new Map<string, string>();

// 正規表現の特殊文字をエスケープする。
const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// テンプレートファイルを読み込む。キャッシュ付き。
const loadTemplate = (templateName: string): string => {
  const cached = templateCache.get(templateName);
  if (cached) {
    return cached;
  }
  const templatePath = join(__dirname, "templates", templateName);
  try {
    const content = readFileSync(templatePath, "utf-8");
    templateCache.set(templateName, content);
    return content;
  } catch (error) {
    throw new Error(
      `テンプレートファイル '${templateName}' の読み込みに失敗しました (${templatePath}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

// テンプレート内のプレースホルダーを置換する。
// {{KEY}} 形式のプレースホルダーを values の対応する値で置換する。
const renderTemplate = (
  template: string,
  values: Record<string, string>,
): string => {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(
      new RegExp(`\\{\\{${escapeRegex(key)}\\}\\}`, "g"),
      value,
    );
  }
  return result;
};

// ===== ヘルパー =====

// 任意の値から '--name <value>' フラグ文字列を生成(空文字なら空文字)。
// 値は SAFE_SHELL_PATTERN または SAFE_MODEL_PATTERN でシェルメタ文字を
// 排除済みなのでスペース区切り・非クォートで十分。シンプルに保たれる方を採用。
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
// sessionId は「セッションを引き継ぐ」シナリオ(--resume / pi-resume 関数経由)でのみ
// --session フラグとして組み立てる。デフォルト起動(ai-env)では新しいセッションで
// pi を立ち上げたいので sessionId は渡さない。includeSession は省略時 true で
// 後方互換を維持(既存呼び出しは pi-resume 関数用途なので true で正しい)。
export const generateCaseBody = (params: {
  projects: Record<string, ProjectConfig>;
  defaultProvider: string | undefined;
  defaultModel: string | undefined;
  defaultApiKeyEnv: string | undefined;
  cliProvider: string | undefined;
  cliModel: string | undefined;
  cliApiKeyEnv: string | undefined;
  // *) ブランチの挙動。
  //   true:  警告メッセージ + pi (引数なし)。pi-resume 関数の既存挙動を保持。
  //   false: CLI > profile のフォールバック値で pi を起動。ai-env デフォルト起動用。
  warnOnUnknown: boolean;
  // プロジェクト case で --session <id> を含めるかどうか。
  //   true:  pi-resume 関数用。sessionId を引き継ぐ。
  //   false: デフォルト起動用。sessionId は引き継がない(新しいセッションで pi を起動)。
  // 省略時は true。
  includeSession?: boolean;
}): string => {
  const {
    projects,
    defaultProvider,
    defaultModel,
    defaultApiKeyEnv,
    cliProvider,
    cliModel,
    cliApiKeyEnv,
    warnOnUnknown,
    includeSession = true,
  } = params;
  const projectCases = Object.entries(projects)
    .map(([project, config]) => {
      // 優先度: CLI > project > profile。CLI で明示上書きが可能。
      // sessionId は includeSession が true のときだけ --session フラグに変換する。
      const flags = buildPiFlags({
        provider: cliProvider ?? config.provider ?? defaultProvider,
        model: cliModel ?? config.model ?? defaultModel,
        apiKeyEnv: cliApiKeyEnv ?? config.apiKeyEnv ?? defaultApiKeyEnv,
        sessionId: includeSession ? config.session : undefined,
      });
      return `    ${project}) pi ${flags} ;;`;
    })
    .join("\n");
  let unknownBranch: string;
  if (warnOnUnknown) {
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
export const generatePiResumeFunc = (params: {
  projects: Record<string, ProjectConfig>;
  defaultProvider: string | undefined;
  defaultModel: string | undefined;
  defaultApiKeyEnv: string | undefined;
  cliProvider: string | undefined;
  cliModel: string | undefined;
  cliApiKeyEnv: string | undefined;
}): string => {
  const caseBody = generateCaseBody({ ...params, warnOnUnknown: true });
  const template = loadTemplate("pi-resume.sh.template");
  return renderTemplate(template, {
    CASE_BODY: caseBody,
  });
};

// 共通初期化スクリプトを生成する。
// テンプレートファイルから読み込み、pi-resume 関数を注入する。
const generateCommonScript = (piResumeFunc: string): string => {
  const template = loadTemplate("common.sh.template");
  return renderTemplate(template, {
    PI_RESUME_FUNC: piResumeFunc,
  });
};

// コンテナ起動直後にコンテナ内で実行する初期化スクリプトを生成。
// SSH 鍵セットアップ → pm2 管理下の socat ブリッジ → pi-resume 関数定義 → pi 起動の順。
// pi 終了時に pm2 をクリーンアップしてコンテナを終了する。
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

  const commonScript = generateCommonScript(piResumeFunc);

  if (bashMode) {
    // CLI オプションが指定された場合のみ env 変数として export。
    // 未指定なら export しないため、コンテナ側 bash で未設定変数となり
    // シェル展開時に空文字として安全に取り扱える。
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
    const template = loadTemplate("bash-mode.sh.template");
    return renderTemplate(template, {
      COMMON_SCRIPT: commonScript,
      EXPORT_BLOCK: exportBlock,
    });
  }
  if (resume) {
    const template = loadTemplate("resume-mode.sh.template");
    return renderTemplate(template, {
      COMMON_SCRIPT: commonScript,
      PI_RESUME_FUNC: piResumeFunc,
    });
  }
  // デフォルト起動(--resume / --bash なし): pi-resume と同じ case 解決をインライン化。
  // プロジェクト側の provider / model / apiKeyEnv が反映され、未知プロジェクトでは
  // CLI > profile のフォールバックで pi を起動する。sessionId は引き継がない
  // (新しいセッションで pi を起動する)。セッションを再開したい場合は --resume を指定する。
  const caseBody = generateCaseBody({
    projects,
    defaultProvider,
    defaultModel,
    defaultApiKeyEnv,
    cliProvider,
    cliModel,
    cliApiKeyEnv,
    includeSession: false,
    warnOnUnknown: false,
  });
  const template = loadTemplate("default-mode.sh.template");
  return renderTemplate(template, {
    COMMON_SCRIPT: commonScript,
    CASE_BODY: caseBody,
  });
};