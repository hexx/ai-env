# provider / model は ai-env で管理し続ける（pi の `.pi/settings.json` には移行しない）

コンテナ内 cwd のプロジェクト別化（ADR 0005）でセッション再開は pi 標準（`pi -c` / `/resume`）に寄せたが、
provider / model の設定は pi-projects.json の `profiles` / `projects` で管理し続ける。
pi のプロジェクト設定（`.pi/settings.json`）は cwd 直下の 1 プロジェクトしか扱えず、
「pi-work / pi-private など **プロファイル（プロジェクトの集まり）単位で AI を切り替える**」という
ai-env の主要ユースケースを表現できないため。`profiles` の provider / model は CLI フラグ
（`--provider` / `--model`）として pi に渡る（pi の解決順序で最優先）。

意図的な判断:

- **`.pi/settings.json` には移行しない**: pi は `cwd/.pi/settings.json` のみを読み、親ディレクトリ
  （プロファイルディレクトリ）の設定は読まれない。プロファイル単位のデフォルト切替は pi に
  寄せられない ai-env 固有の価値であり、「無駄な機能」ではない。
- **優先順位**: CLI フラグ（ai-env の `profiles` / `projects`）> `.pi/settings.json` > グローバル
  settings.json。ai-env が `--provider` / `--model` を渡すため、プロジェクトの `.pi/settings.json` は
  上書きされる。プロジェクト固有の設定を `.pi/settings.json` で行いたい場合は、`profiles` / `projects`
  の provider / model を指定しない（未指定なら pi の設定が生きる）。
- **セッション機能との対比**: セッション再開は pi 標準に寄せた（ADR 0005）が、provider / model は
  「プロファイル」という pi にない概念のため ai-env に残す。棚卸しの結果、セッション保存・再開まわり
  （ADR 0004 の `/save-session` 等）が pi 標準で代替可能な主な無駄であり、既に PR #124 で撤去済み。