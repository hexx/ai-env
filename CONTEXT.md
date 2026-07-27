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
