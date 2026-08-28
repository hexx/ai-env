// index-helpers.ts
// index.ts から抽出した、テスト可能なヘルパー関数群。
// クレデンシャル取得、ホスト IP 検出、コンテナ起動引数組み立て、ログの
// シークレットマスキングなど、CLI エントリポイントから独立して検証できる
// 責務を集約する。

import {
  type AiEnvConfig,
  type ProfileConfig,
  type ProjectConfig,
  buildInitScript,
  loadAiEnvConfig,
  validateProfileCredentialAccess,
} from "./pi-projects";
import {
  CREDENTIAL_NAMES,
  SAFE_SHELL_PATTERN,
  type CredentialName,
} from "./pi-types";
import { execFileSync, spawnSync } from "node:child_process";
import { basename } from "node:path";
import { platform } from "node:os";

// ===== 定数 =====

export const EXIT_ERROR = 1;
export const IMAGE_NAME = "pi-sandbox";

// コンテナ内の固定パス。Dockerfile 上のレイアウトと密結合しているため、
// 定数として抽出することで変更点を発見しやすくする。
// ワークスペースはプロジェクトごとに /workspace/<プロジェクト名> へマウントし、
// コンテナ内 cwd をプロジェクト別に分けて pi のセッション整理(cwd ベース)を機能させる
// (docs/adr/0005 参照)。
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_SSH = "/tmp/.ssh";
const CONTAINER_PI_HOME = "/home/pi/.pi";
const CONTAINER_RTK_CONFIG = "/home/pi/.rtk";
const CONTAINER_CTX = "/home/pi/.ctx";

// pi は子セッションのヘッダーに parentSession としてセッションファイルの絶対パスを
// 保存する。コンテナ内の /home/pi/.pi/agent/sessions をそのまま使うと、ホスト側の
// ctx が /Users/.../.pi/agent/sessions から親を解決できないため、ホストと同じ絶対パスを
// コンテナ内からも見せる。
export const hostPiSessionDir = (home: string): string =>
  `${home}/.pi/agent/sessions`;

// ===== 型 =====

export interface CredentialSource {
  args: string[];
  file: string;
  name: CredentialName;
}

// execFileSync をテスト時にモックできるよう、依存性注入用の関数型を定義。
// 3 つの関数(getHostIp / getCredential / loadCredentials)で共有する。
type ExecFn = (file: string, args: string[], options: { encoding: "utf8" }) => string;

// runContainer の引数をまとめて渡すための型。
// パラメータ数を抑えつつ、コンテキストを明示的に扱えるようにする。
export interface RunContext {
  apiKeyEnv: string | undefined;
  attachMode: boolean;
  bashMode: boolean;
  model: string | undefined;
  // --new: 新規セッションで pi を起動する(デフォルトは pi -c で前回セッションを続行)。
  newMode: boolean;
  provider: string | undefined;
  // CLI の --session <id> で直接指定された明示セッション。
  session: string | undefined;
  credentials: PartialCredentials;
  herdrPaneId: string;
  home: string;
  hostIp: string;
  hostProjectName: string;
  profile: ProfileConfig;
  profileName: string;
  projects: Record<string, ProjectConfig>;
}

// ===== クレデンシャル定義 =====
// 配列のキーは sort-keys ルールに合わせて args, file, name のアルファベット順。

export const CREDENTIAL_SOURCES: CredentialSource[] = [
  {
    args: ["find-generic-password", "-s", "BRAVE_SEARCH_API_KEY", "-w"],
    file: "security",
    name: "BRAVE_SEARCH_API_KEY",
  },
  {
    args: ["find-generic-password", "-s", "DEEPSEEK_API_KEY", "-w"],
    file: "security",
    name: "DEEPSEEK_API_KEY",
  },
  {
    args: ["auth", "token"],
    file: "gh",
    name: "GH_TOKEN",
  },
  {
    args: ["find-generic-password", "-s", "JINA_API_KEY", "-w"],
    file: "security",
    name: "JINA_API_KEY",
  },
  {
    args: ["find-generic-password", "-s", "LLM_API_KEY", "-w"],
    file: "security",
    name: "LLM_API_KEY",
  },
  {
    args: ["find-generic-password", "-s", "OPENAI_API_KEY", "-w"],
    file: "security",
    name: "OPENAI_API_KEY",
  },
  {
    args: ["find-generic-password", "-s", "OPENCODE_API_KEY", "-w"],
    file: "security",
    name: "OPENCODE_API_KEY",
  },
  {
    args: ["find-generic-password", "-s", "OPENROUTER_API_KEY", "-w"],
    file: "security",
    name: "OPENROUTER_API_KEY",
  },
  {
    args: ["find-generic-password", "-s", "QWEN_TOKEN_PLAN_API_KEY", "-w"],
    file: "security",
    name: "QWEN_TOKEN_PLAN_API_KEY",
  },
  {
    args: [
      "find-generic-password",
      "-s",
      "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
      "-w",
    ],
    file: "security",
    name: "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  },
];

// Credentials 型は CREDENTIAL_NAMES の登録一覧から導出する。
// CREDENTIAL_SOURCES は各Credential Keyの取得方法を定義し、Profileの
// credentialKeys と同じ CredentialName 型で整合性を保つ。
export type Credentials = Record<CredentialName, string>;

// ベストエフォート取得 / 部分的なテストを容易にするための型。
// 必須キーが欠落する可能性を許容する。
export type PartialCredentials = Partial<Credentials>;

// stderr にダンプする container コマンドの --env=KEY=VALUE のうち、
// KEY が CREDENTIAL_SOURCES のいずれかと一致するか、末尾が _API_KEY / _TOKEN
// で終わるものの VALUE を *** に置き換えるための正規表現。
// CREDENTIAL_SOURCES 由来 + サフィックス由来の二段構えにすることで、
// 追加クレデンシャルを構造的にカバーしつつ OCR_LLM_TOKEN のような派生
// シークレット変数もマスク対象に含める。
const redactableNames = CREDENTIAL_SOURCES.map((s) => s.name).join("|");
export const SECRET_ENV_PATTERN = new RegExp(
  `^--env=(?<key>${redactableNames}|[A-Z0-9_]+(?:_API_KEY|_TOKEN))=.*$`,
  "u",
);

// ===== ヘルパー関数 =====

/**
 * macOS の en0 インターフェースからホストの IP アドレスを取得する。
 * Apple Container では host.docker.internal (Docker の特殊ホスト名) が使えないため、
 * ホスト IP を明示的にコンテナに渡す必要がある。
 *
 * `exec` はテスト容易性のために依存性注入できるようオプション引数化している。
 * デフォルトは `node:child_process` の `execFileSync`。
 */
export const getHostIp = (exec: ExecFn = execFileSync as ExecFn): string => {
  try {
    return exec("ipconfig", ["getifaddr", "en0"], {
      encoding: "utf8",
    }).trim();
  } catch {
    // en0 が使えない場合は en1 を試す (有線/無線の切り替え対応)
    try {
      return exec("ipconfig", ["getifaddr", "en1"], {
        encoding: "utf8",
      }).trim();
    } catch {
      throw new Error(
        "ホストの IP アドレスを取得できませんでした。ネットワーク接続を確認してください。",
      );
    }
  }
};

/**
 * 指定した実行ファイルを引数配列で実行し、標準出力の内容を trim して返す。
 * 取得に失敗した場合は空文字を返す。
 * execFileSync を使うことでシェル経由のインジェクションを防ぐ。
 *
 * `exec` はテスト容易性のために依存性注入できるようオプション引数化している。
 */
export const getCredential = (
  file: string,
  args: string[],
  exec: ExecFn = execFileSync as ExecFn,
): string => {
  try {
    return exec(file, args, {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
};

export const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が未設定です。`);
  }
  return value;
};

// ホストの cwd をパスセグメント('/' 区切り)に分割し、いずれかのプロファイル名
// と完全一致するセグメントがあればそれを返す。サブストリング一致(例:
// cwd='/home/user/framework' で profile='work' が誤検出)を防ぐ。
// どちらも含まれない場合はエラー(プロファイル自動判別は曖昧さを許容しない)。
export const detectProfileName = (
  cwd: string,
  profiles: Record<string, ProfileConfig>,
): string => {
  const segments = cwd.split("/");
  for (const name of Object.keys(profiles)) {
    if (segments.includes(name)) {
      return name;
    }
  }
  throw new Error(
    `カレントディレクトリ '${cwd}' のパスセグメントにプロファイル(${Object.keys(profiles).join(", ")})のいずれも見つかりません。プロファイル名のいずれかをパスセグメントとして含めてください。`,
  );
};

const getAllowedCredentialEntries = (
  credentials: PartialCredentials,
  allowedNames: readonly CredentialName[],
): Array<{ name: CredentialName; value: string }> => {
  const allowed = new Set(allowedNames);
  const entries: Array<{ name: CredentialName; value: string }> = [];
  for (const { name } of CREDENTIAL_SOURCES) {
    if (!allowed.has(name)) continue;
    const value = credentials[name];
    if (value) entries.push({ name, value });
  }
  return entries;
};

export const buildEnvArgs = (params: {
  credentials: PartialCredentials;
  herdrPaneId: string;
  hostIp: string;
  profile: ProfileConfig;
  profileName: string;
  requiredApiKeyEnv?: string;
}): string[] => {
  const allowedKeys = new Set(params.profile.credentialKeys);
  const ocrCredentialName = params.profile.OCR_LLM_TOKEN_KEY as CredentialName;
  if (!CREDENTIAL_NAMES.includes(ocrCredentialName) || !allowedKeys.has(ocrCredentialName)) {
    throw new Error(
      `プロファイル '${params.profileName}' の OCR_LLM_TOKEN_KEY '${params.profile.OCR_LLM_TOKEN_KEY}' が credentialKeys に含まれていません。`,
    );
  }

  // OCR_LLM_TOKEN_KEY で指定されたクレデンシャルを取り出して OCR_LLM_TOKEN に注入。
  // 未取得なら明確なエラーで停止(undefined 文字列が注入されるのを防ぐ)。
  const ocrToken = params.credentials[ocrCredentialName];
  if (!ocrToken) {
    throw new Error(
      `プロファイルが参照するクレデンシャル '${params.profile.OCR_LLM_TOKEN_KEY}' が取得できません。macOS Keychain の登録状態を確認してください。`,
    );
  }

  if (params.requiredApiKeyEnv !== undefined) {
    const requiredCredentialName = params.requiredApiKeyEnv as CredentialName;
    if (!CREDENTIAL_NAMES.includes(requiredCredentialName) || !allowedKeys.has(requiredCredentialName)) {
      throw new Error(
        `選択された apiKeyEnv '${params.requiredApiKeyEnv}' が Profile '${params.profileName}' の credentialKeys に含まれていません。`,
      );
    }
    if (!params.credentials[requiredCredentialName]) {
      throw new Error(
        `選択されたクレデンシャル '${params.requiredApiKeyEnv}' が取得できません。macOS Keychain の登録状態を確認してください。`,
      );
    }
  }

  const allowedCredentialEntries = getAllowedCredentialEntries(
    params.credentials,
    params.profile.credentialKeys,
  );
  const envArgs = [
    `--env=HERDR_PANE_ID=${params.herdrPaneId}`,
    `--env=HOST_IP=${params.hostIp}`,
    `--env=AI_ENV_PROFILE=${params.profileName}`,
    `--env=OCR_USE_ANTHROPIC=${params.profile.OCR_USE_ANTHROPIC}`,
    `--env=OCR_LLM_URL=${params.profile.OCR_LLM_URL}`,
    "--env=OCR_LLM_TOKEN",
    `--env=OCR_LLM_MODEL=${params.profile.OCR_LLM_MODEL}`,
  ];

  // 許可されたクレデンシャルだけをコンテナへ注入する。
  // 未取得の任意キーは空の環境変数を作らず、警告は loadCredentials 側に任せる。
  for (const { name } of allowedCredentialEntries) {
    // 値はspawnSyncの子プロセス環境へ渡し、argvには秘密値を含めない。
    envArgs.push(`--env=${name}`);
  }
  return envArgs;
};

// pi のセッション保存先をホストと同じ絶対パスに固定する。pi はこの値を
// セッションディレクトリとして使い、parentSession にホストからも解決できるパスを書く。
export const buildPiSessionEnvArgs = (home: string): string[] => [
  `--env=PI_CODING_AGENT_SESSION_DIR=${hostPiSessionDir(home)}`,
];

// プロジェクトごとのコンテナ内ワークスペースパス(/workspace/<プロジェクト名>)。
// マウント先(buildVolumeArgs)とコンテナ内 cwd(workdir)の両方で使用する。
// 2 箇所で独立に構築するとズレた場合にコンテナの cwd が未マウントのディレクトリを
// 指してしまい、プロジェクト別のセッション分離が静かに壊れるため、単一ヘルパーに集約する。
export const projectWorkspacePath = (projectName: string): string =>
  `${CONTAINER_WORKSPACE}/${projectName}`;

// ワークスペースはプロジェクトごとに /workspace/<プロジェクト名> へマウントする。
// コンテナ内 cwd をプロジェクト別に分けることで、pi のセッション整理(cwd ベース)が
// そのプロジェクトのセッションだけを対象に機能する(docs/adr/0005 参照)。
export const buildVolumeArgs = (home: string, projectName: string): string[] => [
  `--volume=${process.cwd()}:${projectWorkspacePath(projectName)}`,
  `--volume=${home}/.ssh:${CONTAINER_SSH}:ro`,
  `--volume=${home}/.pi:${CONTAINER_PI_HOME}`,
  // 上記の .pi マウントとは別に、pi が parentSession に書くホスト絶対パスも
  // コンテナ内で有効にする。二重マウントだが、設定/拡張機能は従来どおり
  // /home/pi/.pi から参照し、セッションだけはホストパスを正本として扱う。
  `--volume=${hostPiSessionDir(home)}:${hostPiSessionDir(home)}`,
  `--volume=${home}/.config/rtk:${CONTAINER_RTK_CONFIG}`,
  `--volume=${home}/.ctx:${CONTAINER_CTX}`,
];

export const buildContainerArgs = (
  envArgs: string[],
  volumeArgs: string[],
  initScript: string,
  hostProjectName?: string,
): string[] => {
  const labelArgs = hostProjectName
    ? ["--label", `ai-env.project=${hostProjectName}`]
    : [];
  return [
    "run",
    "-it",
    "--rm",
    ...envArgs,
    ...volumeArgs,
    ...labelArgs,
    "--entrypoint",
    "/bin/bash",
    IMAGE_NAME,
    "-c",
    initScript,
  ];
};

export const loadCredentials = (
  allowedNames: readonly CredentialName[],
  exec: ExecFn = execFileSync as ExecFn,
): PartialCredentials => {
  const credentials: PartialCredentials = {};
  const allowed = new Set(allowedNames);
  for (const { name, file, args } of CREDENTIAL_SOURCES) {
    if (!allowed.has(name)) continue;
    const value = getCredential(file, args, exec);
    if (!value) {
      // 許可された任意キーの未取得は警告にとどめ、コンテナ起動を継続する。
      // OCR_LLM_TOKEN_KEY / requiredApiKeyEnv がこのキーを参照している場合は
      // buildEnvArgs 側で個別にエラーになる。
      console.error(
        `警告: クレデンシャル '${name}' の取得に失敗しました。macOS Keychain の登録状態 / 'gh auth login' の完了を確認してください。`,
      );
      continue;
    }
    credentials[name] = value;
  }
  return credentials;
};

// stderr に出力される container コマンドラインから、API キーやトークンに
// 該当する値を *** に置き換える。redactSecrets の SECURITY 上の重要性:
// コンテナに渡す引数にはクレデンシャルが含まれるため、ログにダンプする前に
// 必ずマスクしないとキー漏洩の経路になる。
export const redactSecrets = (args: string[]): string[] =>
  args.map((arg) => arg.replace(SECRET_ENV_PATTERN, "--env=$<key>=***"));

// Profileで許可され、取得できた秘密値だけを子プロセス環境へ組み立てる。
// container run は '--env=KEY' で子プロセス環境から値を継承するため、
// 秘密値をcontainerのargvへ埋め込まずにコンテナへ渡せる。
export const buildCredentialProcessEnv = (
  credentials: PartialCredentials,
  profile: ProfileConfig,
): Record<string, string> => {
  const env: Record<string, string> = {};
  const allowedKeys = new Set(profile.credentialKeys);
  for (const { name, value } of getAllowedCredentialEntries(credentials, profile.credentialKeys)) {
    env[name] = value;
  }
  const ocrCredentialName = profile.OCR_LLM_TOKEN_KEY as CredentialName;
  if (CREDENTIAL_NAMES.includes(ocrCredentialName) && allowedKeys.has(ocrCredentialName)) {
    const ocrToken = credentials[ocrCredentialName];
    if (ocrToken) env.OCR_LLM_TOKEN = ocrToken;
  }
  return env;
};

// herdr 0.8.0 以降、フルライフサイクル統合（pi 等）の状態報告は
// Agent Presence（ペインで agent が起動中とサーバーが認識した状態）の確立が前提。
// Docker 内で動く agent はプロセス名検出が効かないため、ホスト herdr は
// プロセスの環境変数 HERDR_AGENT=<agent> を検出経路として使う（ADR 0002）。
// pi を起動するモード（--bash 以外）ではこのヒントを付与し、--bash では
// 付与しない（コンテナ内で別 agent を動かす自由を維持するため）。
export const buildContainerProcessEnv = (
  bashMode: boolean,
  base: NodeJS.ProcessEnv = process.env,
  secretEnv: Record<string, string> = {},
): NodeJS.ProcessEnv => {
  const withSecrets = Object.keys(secretEnv).length > 0
    ? { ...base, ...secretEnv }
    : base;
  return bashMode ? withSecrets : { ...withSecrets, HERDR_AGENT: "pi" };
};

export const runContainer = (
  args: string[],
  env: NodeJS.ProcessEnv,
  spawn: typeof spawnSync = spawnSync,
): number => {
  const result = spawn("container", args, { env, stdio: "inherit" });
  if (result.error) {
    console.error("container の実行に失敗しました:", result.error.message);
    return EXIT_ERROR;
  }
  if (result.signal) {
    // 子プロセスがシグナルで終了した場合、status は null になる。
    // 原因をユーザーに伝えるため、シグナル名を stderr に出力する。
    console.error(`container がシグナル ${result.signal} で終了しました。`);
    return EXIT_ERROR;
  }
  return result.status ?? EXIT_ERROR;
};

export const isMacOS = (getPlatform: () => NodeJS.Platform = platform): boolean =>
  getPlatform() === "darwin";

// CLI フラグの組み合わせ制約を検証する。
// 違反時はエラーメッセージ文字列、問題なければ undefined を返す。
// index.ts の main() から呼び出し、メッセージを stderr に出力して exit 1 する。
// ルール:
//   - --new は新規セッションでの起動を指定するため --session(再開を内包)と排他。
//   - --attach は pi を起動しないため --bash / --new / --session と排他。
//   - --bash は pi を起動しないため --new と排他。
export const validateFlagCombination = (params: {
  attach: boolean;
  bash: boolean;
  new: boolean;
  session: boolean;
}): string | undefined => {
  if (params.new && params.session) {
    return "--new は新規セッションでの起動を指定するため、--session と同時に指定できません。'ai-env --session <id>' でセッションを再開してください。";
  }
  if (params.attach && (params.bash || params.new || params.session)) {
    return "--attach は --bash / --new / --session と同時に指定できません。";
  }
  if (params.bash && params.new) {
    return "--bash は pi を起動しないため、--new と同時に指定できません。";
  }
  return undefined;
};

export const buildContainerName = (projectName: string): string =>
  `ai-env-${projectName}`;

export const buildAttachArgs = (containerId: string): string[] => [
  "exec",
  "-it",
  containerId,
  "/bin/bash",
];
/**
 * 指定したラベルを持つコンテナ（実行中・停止中含む）を検索し、
 * 最初に見つかったコンテナ ID を返す。
 * 見つからない場合は undefined を返す。
 *
 * container CLI には --filter オプションがないため、
 * container list --format json --all の JSON 出力からラベルを確認する。
 */
export const findContainerByLabel = (
  label: string,
  exec: ExecFn = execFileSync as ExecFn,
): string | undefined => {
  try {
    const result = exec(
      "container",
      ["list", "--format", "json", "--all"],
      {
        encoding: "utf8",
      },
    );
    const containers: Array<{
      configuration?: { id?: string; labels?: Record<string, string> };
    }> = JSON.parse(result);
    for (const container of containers) {
      const labels = container.configuration?.labels;
      if (!labels) continue;
      for (const [key, value] of Object.entries(labels)) {
        if (`${key}=${value}` === label) {
          return container.configuration?.id;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
};

export const attachToContainer = (projectName: string, env: NodeJS.ProcessEnv): number => {
  const label = `ai-env.project=${projectName}`;
  const containerId = findContainerByLabel(label);
  if (!containerId) {
    console.error(
      `カレントディレクトリ '${projectName}' で起動中のコンテナが見つかりません。先に 'ai-env' を実行してコンテナを起動してください。`,
    );
    return EXIT_ERROR;
  }
  const args = buildAttachArgs(containerId);
  console.error(`$ container ${args.join(" ")}`);
  return runContainer(args, env);
};

export const resolveRequiredApiKeyEnv = (params: {
  bashMode: boolean;
  cliApiKeyEnv: string | undefined;
  hostProjectName: string;
  profile: ProfileConfig;
  projects: Record<string, ProjectConfig>;
}): string | undefined => {
  // bashモードはProfile/Projectの値を自動起動へ渡さず、CLI指定だけを
  // PI_API_KEY_ENVとしてexportする。Profile/Projectの値は、bash内で
  // pi-resumeを明示的に呼んだときにだけ使われる。
  if (params.bashMode) return params.cliApiKeyEnv;
  const project = params.projects[params.hostProjectName];
  if (project !== undefined) {
    return params.cliApiKeyEnv ?? project.apiKeyEnv ?? params.profile.apiKeyEnv;
  }
  // 未知プロジェクトのデフォルト起動では、生成スクリプトが apiKeyEnv を
  // fallback に渡さない既存挙動を維持する。
  return undefined;
};

export const runContainerCommand = (ctx: RunContext): number => {
  if (ctx.attachMode) {
    return attachToContainer(ctx.hostProjectName, buildContainerProcessEnv(ctx.bashMode));
  }
  const requiredApiKeyEnv = resolveRequiredApiKeyEnv({
    bashMode: ctx.bashMode,
    cliApiKeyEnv: ctx.apiKeyEnv,
    hostProjectName: ctx.hostProjectName,
    profile: ctx.profile,
    projects: ctx.projects,
  });
  const envArgs = [
    ...buildEnvArgs({
      credentials: ctx.credentials,
      herdrPaneId: ctx.herdrPaneId,
      hostIp: ctx.hostIp,
      profile: ctx.profile,
      profileName: ctx.profileName,
      requiredApiKeyEnv,
    }),
    ...buildPiSessionEnvArgs(ctx.home),
  ];
  const env = buildContainerProcessEnv(
    ctx.bashMode,
    process.env,
    buildCredentialProcessEnv(ctx.credentials, ctx.profile),
  );
  const volumeArgs = buildVolumeArgs(ctx.home, ctx.hostProjectName);
  const initScript = buildInitScript({
    bashMode: ctx.bashMode,
    cliApiKeyEnv: ctx.apiKeyEnv,
    cliModel: ctx.model,
    cliProvider: ctx.provider,
    cliSession: ctx.session,
    defaultApiKeyEnv: ctx.profile.apiKeyEnv,
    defaultModel: ctx.profile.model,
    defaultProvider: ctx.profile.provider,
    newMode: ctx.newMode,
    projects: ctx.projects,
    workdir: projectWorkspacePath(ctx.hostProjectName),
  });
  const containerArgs = buildContainerArgs(envArgs, volumeArgs, initScript, ctx.hostProjectName);
  console.error(`$ container ${redactSecrets(containerArgs).join(" ")}`);
  return runContainer(containerArgs, env);
};

export const prepareEnvironment = (params: {
  apiKeyEnv: string | undefined;
  attachMode: boolean;
  bashMode: boolean;
  model: string | undefined;
  newMode: boolean;
  provider: string | undefined;
  session: string | undefined;
}): RunContext => {
  const home = requireEnv("HOME");
  const herdrPaneId = requireEnv("HERDR_PANE_ID");
  // ホスト側のカレントディレクトリ名 = プロジェクト名。
  // コンテナ内のマウント先ディレクトリ名(/workspace/<プロジェクト名>)と pi の
  // セッション整理(cwd ベース)に使うため、SAFE_SHELL_PATTERN で検証する。
  // 違反時はマウント先を安全に組み立てられないため起動を中断する。
  const hostProjectName = basename(process.cwd());
  if (!SAFE_SHELL_PATTERN.test(hostProjectName)) {
    throw new Error(
      `カレントディレクトリ名 '${hostProjectName}' が無効です(英数字・ハイフン・アンダースコア・ピリオドのみ許可)。コンテナ内のマウント先ディレクトリ名に使用します。`,
    );
  }
  const aiEnvConfig: AiEnvConfig = loadAiEnvConfig();
  const profileName = detectProfileName(process.cwd(), aiEnvConfig.profiles);
  const profile = aiEnvConfig.profiles[profileName]!;
  const cliApiKeyEnvForValidation =
    params.apiKeyEnv !== undefined &&
    (aiEnvConfig.projects[hostProjectName] !== undefined || params.bashMode)
      ? params.apiKeyEnv
      : undefined;
  validateProfileCredentialAccess({
    configPath: "<runtime>",
    hostProjectName,
    profileName,
    profile,
    projects: aiEnvConfig.projects,
    // 未知Projectの通常起動では、生成スクリプトがCLIのapiKeyEnvを使わない。
    cliApiKeyEnv: cliApiKeyEnvForValidation,
  });
  // Profile を確定してから許可されたクレデンシャルだけを Keychain から取得する。
  const credentials = loadCredentials(profile.credentialKeys);
  return {
    apiKeyEnv: params.apiKeyEnv,
    attachMode: params.attachMode,
    bashMode: params.bashMode,
    model: params.model,
    newMode: params.newMode,
    provider: params.provider,
    session: params.session,
    credentials,
    herdrPaneId,
    home,
    hostIp: getHostIp(),
    hostProjectName,
    profile,
    profileName,
    projects: aiEnvConfig.projects,
  };
};

export const handleError = (error: unknown): number => {
  if (error instanceof Error) {
    console.error(error.message);
    return EXIT_ERROR;
  }
  console.error("予期しないエラーが発生しました:", error);
  return EXIT_ERROR;
};
