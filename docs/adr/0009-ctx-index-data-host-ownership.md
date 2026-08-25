# Ctx の Index Data はホストが所有し、サンドボックスは読み取り専用で利用する

Pi の履歴ソースと Ctx の Index Data はホスト側で管理し、サンドボックス内の Ctx は検索クライアントに限定する。ホスト側の Ctx が `~/.pi/agent/sessions/` を読み取って Index Data（`~/.ctx`）を更新し、サンドボックスには Index Data を読み取り専用で共有する。

## 背景

ai-env は Pi のセッションディレクトリと Ctx の Index Data をホストとサンドボックスで共有している。サンドボックス内の Pi 履歴ソースはマウント境界のため自動検出できず、明示的な `--path` は将来のデフォルトとして記憶されない。また、共有 Index Data をホストとサンドボックスの両方から更新すると、所有権・同時実行・意図しない再インデックスの境界が曖昧になる。

## 判断

- Pi History Source はホストの `~/.pi/agent/sessions/` とする
- `ctx import`、`ctx setup`、自動インデックスはホスト側でのみ実行する
- サンドボックスの `/home/pi/.ctx` マウントは読み取り専用にする
- サンドボックス内の検索は `ctx search ... --refresh off` を標準とする
- Index Data の書き込み失敗や古さで Pi / ai-env の起動を停止しない
- 過去セッションの `parentSession` は通常の import で書き換えず、必要な場合だけ別の手動移行を行う

## 却下した選択肢

- **サンドボックス内から import する**: マウントされた履歴ソースの自動検出が不安定で、共有 Index Data の書き込み主体も曖昧になるため採用しない
- **サンドボックス起動時に毎回 import する**: 起動時間と共有 Index Data への競合を増やし、検索クライアントの責務を越えるため採用しない
- **過去セッションを自動修正する**: Pi のセッションファイルを書き換える破壊的な処理になるため採用しない

## 影響

ホスト側では初回に `ctx import --provider pi` と `ctx index mode auto` を実行する必要がある。サンドボックス内の `ctx sources` は履歴ソースの authoritative な確認手段ではなく、ホスト側の `ctx status`、`ctx index`、`ctx sources --provider pi` を使って状態を確認する。
