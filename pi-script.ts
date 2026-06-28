// pi-script.ts
// pi-projects.ts から抽出した、コンテナ用シェルスクリプト生成の責務を集約。
// pi-resume 関数や pi 起動スクリプトの文字列組み立てを担当する。

import { type ProjectConfig } from "./pi-types";

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
export const generateCaseBody = (params: {
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
export const generatePiResumeFunc = (params: {
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
