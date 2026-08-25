# ai-env

私専用の AI 開発用 Docker サンドボックスを起動する CLI のコンテキスト。ホストのマシン状態（認証情報・設定・エージェント状態）をコンテナへ安全に引き継ぎ、どのホストプロジェクトからでも同一の AI 開発環境を再現する。

## Language

**Sandbox**:
ai-env が起動する Docker コンテナ（イメージ名 `pi-sandbox`）。AI エージェントがホストを汚さずにコマンドを実行できる隔離環境。
_Avoid_: container（文脈なしで使う場合）, VM

**Profile**:
ホストプロジェクトのパスセグメントから判定されるサンドボックスの用途区分（`pi-work` / `pi-private`）。コンテナへ渡す認証情報と有効化する拡張機能を切り替える。
_Avoid_: environment, mode

**RTK**:
サンドボックス内に導入する出力圧縮プロキシ（rtk-ai/rtk, "Rust Token Killer"）。エージェントが読む bash コマンド出力を圧縮し、トークン消費を削減する。pi 公式連携（`rtk init -g --agent pi`）で拡張機能として組み込む。
_Avoid_: Rust Type Kit（crates.io の同名別プロジェクト）, token killer（略さず呼ぶ場合以外）

## Herdr Integration

**Agent Presence**:
herdr サーバーが各ペインで動作中のエージェントを特定した状態。フォアグラウンドプロセスのバイナリ名（`pi` 等）か、そのプロセスの環境変数 `HERDR_AGENT=<agent>` で判定される。Docker コンテナ内で動く agent はホストからプロセス名が見えないため、`HERDR_AGENT` が唯一の検出経路となる。
_Avoid_: 検出（画面検出と区別するため）

**Screen Detection（画面検出）**:
ペインのターミナルバッファを agent 別マニフェストと照合して状態を推定する仕組み（pi のマニフェストは "Working..." 文字列のみ）。Agent Presence が確立した後でのみ有効になる。
_Avoid_: detection（カタカナ表記を優先）

**Full-Lifecycle Integration（フルライフサイクル統合）**:
pi / omp / opencode / kilo / kimi / mastracode など、ソケット API（`pane.report_agent`）で状態とネイティブセッションを直接報告する公式統合。herdr 0.8.0 以降、この権限が有効になるには Agent Presence の確立が前提。
_Avoid_: 公式統合（対象が曖昧）

**Pending Report（保留状態報告）**:
Agent Presence 未確立の間に届いたフルライフサイクル統合からの状態報告。サーバーは受理（`ok`）するが適用せず保留し、Presence 確立後にセッションと seq を検証して適用する。
_Avoid_: 無視された報告（受理はされている）

## Sessions

**Session**:
pi の会話の単位。UUID で識別され（部分一致も可）、ホストの `~/.pi/agent/sessions/` にセッション開始時の cwd ごとに JSONL として保存される。コンテナ内では cwd がプロジェクトごとに分かれているため（Project Directory）、セッションもプロジェクト単位で整理される。コンテナ内 pi の保存先も `PI_CODING_AGENT_SESSION_DIR` でホストと同じ絶対パスに合わせ、子セッションの `parentSession` をホストの ctx から解決可能にする（ADR 0008）。
_Avoid_: チャット履歴, 会話ログ

**Project Name**:
ホストのカレントディレクトリ名。コンテナ内のマウント先ディレクトリ名（`/workspace/<プロジェクト名>`）と pi のセッション整理のキーになる。ai-env はホスト側で basename を検証（英数字・`._-`）してからマウント先を組み立てる。
_Avoid_: プロジェクトパス, HOST_PROJECT_NAME（廃止された環境変数）

**Project Directory**:
コンテナ内のプロジェクトごとの作業ディレクトリ（`/workspace/<プロジェクト名>`）。プロジェクトの内容はホストの cwd がマウントされる。pi のセッション整理（cwd ベース）がプロジェクト単位で機能するための仕組み（ADR 0005）。
_Avoid_: workspace（文脈なし）

**Explicit Session**:
CLI の `--session <id>` で直接指定されたセッション。1 回だけ再開される（コンテナ内 `pi-resume` 関数には反映されない）。
_Avoid_: CLI session（pi の `--session-id` と紛らわしい）, 上書きセッション

## Agent History Search

**Ctx CLI**:
ctx.rs 製のローカルエージェント履歴検索 CLI（`ctx` コマンド）。ホスト側で履歴を Index Data に取り込み、サンドボックス内では検索クライアントとして利用する（ADR 0007、ADR 0009）。
_Avoid_: ctx.rs（ベンダー名と CLI 名の混同）

**Index Data**:
Ctx CLI が管理する索引データ（`~/.ctx` 配下）。ホストとサンドボックスで virtiofs 経由により同一実体を共有する破棄禁止の資産であり、ホスト側の Ctx CLI を書き込み主体とし、サンドボックス側から再インデックス・削除を行わない。
_Avoid_: キャッシュ（破棄可能な一時物と誤解される）, DB（単体では何の DB か不明）

**Pi History Source**:
ホストの `~/.pi/agent/sessions/` に保存される、全プロジェクトの Pi セッション JSONL。Ctx が取り込みの読み取り元とする正規の履歴ソースであり、バックアップディレクトリは通常の対象に含めない。
_Avoid_: チャット履歴, セッションのコピー

**Import**:
Pi History Source を読み取り、ホスト側の Index Data に検索可能な世代として反映する処理。セッションファイル自体の修正・移動・削除は行わない。
_Avoid_: セッション移行, コピー

**Search Client**:
サンドボックス内で Index Data を読み取り、履歴を検索・表示する Ctx CLI の役割。Index Data の更新や Pi History Source の取り込みは担当しない。
_Avoid_: インデクサー, 履歴管理者

**Resume**:
既存セッションに接続して pi を起動・切り替える操作。経路は `pi -c`（最新セッションの続行）、`/resume`（プロジェクト内ピッカー）、`--session`（明示セッション）。
_Avoid_: 引き継ぐ（README の旧表現）, 継続

## Tool Ownership

**User-Owned Tool（ユーザー領域ツール）**:
pi ユーザーが所有者となり `~/.local/bin` 配下にインストールされる CLI ツール（herdr / rtk / pm2 / ctx）。Dockerfile の `USER pi` 以降のステップでインストールされ、権限調整なしで pi から実行できる。pi から改ざん可能（ADR 0007 で受容したトレードオフ）。
_Avoid_: ローカルツール（ホスト側との混同）, グローバルツール（システム領域と混同）

**System-Owned Tool（システム領域ツール）**:
root が所有者となり `/usr/local` 配下にインストールされるイメージ基盤系ツール（node / npm / uv / playwright / pi-coding-agent / open-code-review / hunkdiff 等）。全ユーザーの PATH から利用できるが、実行ユーザー視点の権限調整が必要になりがち（ADR 0007）。
_Avoid_: グローバルツール（root 所有と非 root 所有の区別が曖昧）, イメージツール（Tool Ownership と混同）

**PM2**:
コンテナ内で herdr 用 `socat` プロセスを管理するプロセスマネージャー。ユーザー領域ツールとして pi が実行し、起動できない場合は socat 直接起動へ縮退する（docs/spec/0003-pm2-runtime.md）。
_Avoid_: プロセス監視（PM2 を指さない汎用語）
