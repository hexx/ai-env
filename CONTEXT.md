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

## Sessions

**Session**:
pi の会話の単位。UUID で識別され（部分一致も可）、ホストの `~/.pi/agent/sessions/` に JSONL として保存される。ai-env は「新規セッションで pi を起動する（デフォルト起動）」か「既存セッションを再開する（--resume / --session）」のどちらかで pi を起動する。
_Avoid_: チャット履歴, 会話ログ

**Project Session**:
`pi-projects.json` の `projects.<name>.session` に定義されたセッション。`--resume` で再開される。
_Avoid_: 設定済みセッション, 保存セッション

**Explicit Session**:
CLI の `--session <id>` で直接指定されたセッション。プロジェクト設定を上書きして 1 回だけ再開される（コンテナ内 `pi-resume` 関数には反映されない）。
_Avoid_: CLI session（pi の `--session-id` と紛らわしい）, 上書きセッション

**Resume**:
既存セッションに接続して pi を起動する操作。経路は 2 つ：`--resume`（プロジェクトセッション）と `--session`（明示セッション）。
_Avoid_: 引き継ぐ（README の旧表現）, 継続
