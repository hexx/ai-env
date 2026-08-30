# クレデンシャルは Credential Allowlist 経由を唯一の正規ルートにする

`~/.pi` は rw でサンドボックスへマウントされているため、pi の `/login` で `~/.pi/agent/auth.json` に API キーを保存すれば、ai-env のコード変更なしに鍵をコンテナへ届けられる。それでも各 Credential Key を ai-env の `CREDENTIAL_SOURCES`（macOS Keychain）へ登録し、Profile の `credentialKeys` で許可したものだけを注入する経路を唯一の正規ルートとする。
`auth.json` は全 Profile で共通の 1 ファイルであり、そこに置いた鍵は `pi-private` も `pi-work` も等しく見てしまう。ADR 0010 で引いた「Profile を秘密情報の境界にする」判断がマウント経由で静かに迂回されることになるため、これは意図的な禁止である。

## Considered Options

- **`/login` → `auth.json`（マウント共有）**: 実装ゼロで最も手軽。Profile 境界を無効化するため却下。将来「なぜ ai-env 側でキー登録が必要なのか」を問う読者が必ずここに到達する。
- **`models.json` の `apiKey: "!security find-generic-password -ws ..."`**: pi がモデル要求時にコマンド実行で鍵を解決する。コンテナ内に `security` は無く、仮にホストで効いても Profile の許可リストを素通りになるため却下。
- **`CREDENTIAL_SOURCES` 登録 + `credentialKeys` 許可**（採用）: 取得元をホスト 1 箇所に置き、Profile 単位の注入だけ ai-env が決める。

## Consequences

- 新しいモデルをサンドボックスで使うには **Provider Catalog（pi 所有、ADR 0006 追記）の宣言**と**ai-env の Credential Key 登録**の 2 箇所が必要になる。この 2 段構成は冗長ではなく、前者は全 Profile 共通で伝播し、後者は Profile ごとに越境しないという非対称を表している。前者だけ見て「鍵は向こうが持ってるから動くはず」と誤認しないこと。
- 未登録のキーはサンドボックスでは使えない（`/model` で unavailable になる）。登録漏れは pi 側のエラーとして現れ、ai-env は検出しない。
