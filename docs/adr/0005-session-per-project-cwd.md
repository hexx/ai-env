# コンテナ内の作業ディレクトリをプロジェクトごとに分けて pi 標準のセッション機能を活用する

コンテナ内の cwd を `/workspace` 固定としていたため、pi のセッション整理（cwd ベース）が機能せず、
全プロジェクトのセッションが `~/.pi/agent/sessions/--workspace--/` に混在していた。これを解消するため、
ワークスペースをプロジェクトごとに `/workspace/<プロジェクト名>` へマウントし、init スクリプトで
cd してから pi を起動する方式を採用した。

意図的な判断:

- **pi 標準のセッション機能を活用する**: `pi -c`（その cwd の最新セッションを続行、なければ新規作成）を
  デフォルト起動とし、`/resume`（ピッカー）がそのプロジェクトのセッションだけを表示するようにする。
  これにより pi-projects.json の `session` 固定（`ai-env --resume`）と、保存記録ベースの
  `/save-session` / `/resume-session` は廃止した（ADR 0004 を supersede）。セッション再開は
  `pi -c`（前回の続き）、`/resume`（プロジェクト内ピッカー）、`ai-env --session <id>`（明示）で実現する。
- **作業ディレクトリのマウント先は `/workspace/<basename>`**: シンプルさを優先し、cwd のホスト
  フルパス再現やハッシュ付与は採用しない。同名 basename の衝突は既存の projects キーと同じく
  basename が被らない運用で担保する（検証は SAFE_SHELL_PATTERN のみ）。なお、セッションファイルの
  `parentSession` をホストの ctx から解決可能にするための保存先パス整合は ADR 0008 で別途定める。
- **cd は init スクリプト（common.sh.template）で行う**: `--workdir` フラグは container CLI の
  対応可否が不明なため、ランタイム非依存の方法を採用。`--bash` モードでも cwd が正しい状態になる。
- **HOST_PROJECT_NAME 環境変数を廃止**: プロジェクト名は `$(basename "$PWD")` で解決できる。
  ただしマウント先ディレクトリ名に使うため、ホスト側で basename を SAFE_SHELL_PATTERN 検証する。
- **既存セッションの移行はしない**: `--workspace--/` に残った過去セッションは
  `--session <id>`（部分 UUID 検索）で再開可能。新セッションはプロジェクト別ディレクトリに作られる。
- **pi-projects.json の `session` フィールドは読み飛ばす**: 後方互換。`projects` は
  provider / model / apiKeyEnv のみを持つ。
