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
// --session <id> を出力に含める。
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
// sessionId は cliSession が指定されていればそれを優先し(--session は再開を内包)、
// なければ includeSession が true のときだけ config.session を --session フラグに
// 変換する。デフォルト起動(ai-env)では新しいセッションで pi を立ち上げたいので
// sessionId は渡さない。includeSession は省略時 true で後方互換を維持
// (既存呼び出しは pi-resume 関数用途なので true で正しい)。
// cliSession は --resume と排他(--session 単体で再開を内包)のため、実際には
// デフォルト起動(includeSession: false)でのみ渡される。
export const generateCaseBody = (params: {
  projects: Record<string, ProjectConfig>;
  defaultProvider: string | undefined;
  defaultModel: string | undefined;
  defaultApiKeyEnv: string | undefined;
  cliProvider: string | undefined;
  cliModel: string | undefined;
  cliApiKeyEnv: string | undefined;
  // CLI の --session <id> で直接指定された明示セッション。
  // 指定時はプロジェクト設定の session より優先して --session フラグに変換する。
  cliSession?: string;
  // *) ブランチの挙動。
  //   true:  警告メッセージ + pi (引数なし)。pi-resume 関数の既存挙動を保持。
  //   false: CLI > profile のフォールバック値で pi を起動。ai-env デフォルト起動用。
  warnOnUnknown: boolean;
  // プロジェクト case で config.session を --session <id> として組み立てるかどうか。
  //   true:  pi-resume 関数用。プロジェクトセッションを再開する。
  //   false: デフォルト起動用。config.session は使わない(新しいセッションで pi を起動)。
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
    cliSession,
    warnOnUnknown,
    includeSession = true,
  } = params;
  const projectCases = Object.entries(projects)
    .map(([project, config]) => {
      // 優先度: CLI > project > profile。CLI で明示上書きが可能。
      // sessionId は cliSession(明示セッション) > config.session(プロジェクトセッション)。
      const flags = buildPiFlags({
        provider: cliProvider ?? config.provider ?? defaultProvider,
        model: cliModel ?? config.model ?? defaultModel,
        apiKeyEnv: cliApiKeyEnv ?? config.apiKeyEnv ?? defaultApiKeyEnv,
        sessionId: cliSession ?? (includeSession ? config.session : undefined),
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
    // sessionId は cliSession のみ(未知プロジェクトは設定上のプロジェクトセッションを持たない)。
    const fallbackFlags = buildPiFlags({
      provider: cliProvider ?? defaultProvider,
      model: cliModel ?? defaultModel,
      apiKeyEnv: undefined,
      sessionId: cliSession,
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

// ホスト herdr の Agent Presence 確立を待つシェルブロック（resume / default モード用）。
// コンテナ起動直後は herdr サーバーがコンテナプロセス（HERDR_AGENT ヒント）を検出する前で、
// pi の session_start 報告（pane.report_agent_session）が無視されると、サーバーのセッション
// 参照が旧セッションに固定されたまま状態報告が全て拒否され、サイドバーが更新されなくなる
// （herdr 0.8.0 の回帰、詳細は docs/adr/0003-herdr-session-reanchor-race.md）。
// --bash モードでは pi を自動起動しないため待機しない（自己修復パッチは適用される）。
const HERDR_PRESENCE_WAIT = `# ホスト herdr の Agent Presence 確立を待機（最大 10 秒、ADR 0003）
# pi の session_start 報告が presence 未確立で無視されないようにする。
# 確立しなくても pi の起動自体は続行する（agent_start 時の自己修復パッチが補完する）。
if [ -n "\${HERDR_PANE_ID:-}" ]; then
  timeout 10 bash -c '
    for _ in $(seq 1 10); do
      if timeout 2 herdr agent explain "$HERDR_PANE_ID" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
  ' || true
fi`;

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
  // CLI の --session <id> (明示セッション)。bash モードでは PI_SESSION として export、
  // デフォルト起動では --session フラグとして pi に渡す。--resume とは排他。
  cliSession?: string;
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
    cliSession,
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
    if (cliSession !== undefined) {
      exportLines.push(`export PI_SESSION="${cliSession}"`);
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
      HERDR_PRESENCE_WAIT,
    });
  }
  // デフォルト起動(--resume / --bash なし): pi-resume と同じ case 解決をインライン化。
  // プロジェクト側の provider / model / apiKeyEnv が反映され、未知プロジェクトでは
  // CLI > profile のフォールバックで pi を起動する。sessionId は cliSession 以外は
  // 渡さない(新しいセッションで pi を起動する)。セッションを再開したい場合は
  // --resume(プロジェクトセッション)または --session <id>(明示セッション)を指定する。
  const caseBody = generateCaseBody({
    projects,
    defaultProvider,
    defaultModel,
    defaultApiKeyEnv,
    cliProvider,
    cliModel,
    cliApiKeyEnv,
    cliSession,
    includeSession: false,
    warnOnUnknown: false,
  });
  const template = loadTemplate("default-mode.sh.template");
  return renderTemplate(template, {
    COMMON_SCRIPT: commonScript,
    CASE_BODY: caseBody,
    HERDR_PRESENCE_WAIT,
  });
};