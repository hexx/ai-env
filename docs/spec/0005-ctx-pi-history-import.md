# 仕様: ホスト側の Pi 履歴取り込みとサンドボックス検索

## 背景・目的

ai-env では Pi のセッションファイルと Ctx の Index Data をホストとサンドボックスで共有している。サンドボックス内では Pi の履歴ソースがマウント境界のため自動選択できず、`ctx sources --provider pi` が `selector_unreconstructible` になることがある。

本仕様では、Pi 履歴の取り込みをホスト側に集約し、サンドボックス内の Ctx を Index Data の検索クライアントに限定する。これにより、明示パスによる一時的な取り込みをサンドボックスで行わず、共有 Index Data の書き込み主体を一つにする。

関連する用語は [CONTEXT.md](../../CONTEXT.md) の Agent History Search セクション、設計判断は [ADR 0009](../adr/0009-ctx-index-data-host-ownership.md) に従う。

## 用語

- **Pi History Source**: ホストの `~/.pi/agent/sessions/` にある全プロジェクトの Pi セッション JSONL
- **Import**: Pi History Source を読み取り、ホスト側の Index Data に検索可能な世代として反映する処理
- **Index Data**: Ctx が管理する `~/.ctx` 配下の検索インデックス。ホストとサンドボックスで共有するが、ホスト側を唯一の書き込み主体とする
- **Search Client**: サンドボックス内で Index Data を読み取り、検索・表示する Ctx

## スコープ

### 対象

- ホスト側の Pi History Source の初回取り込み
- ホスト側 Ctx の自動インデックス設定
- 手動 import と明示パスによるフォールバック
- サンドボックス内での読み取り専用検索
- import 失敗時の非停止運用
- 過去セッションの `parentSession` 不整合に対するベストエフォート方針

### 非対象

- Ctx のホスト版バイナリのインストール・アップグレード管理
- サンドボックス起動時の自動 import
- サンドボックス内からの `ctx setup` / `ctx import`
- `sessions.bak.*` などバックアップディレクトリの通常取り込み
- 過去セッションを自動的に書き換える移行ツール
- Index Data の削除・リセット・バックアップ戦略

## 所有権とアクセス境界

### ホスト側

ホスト側の Ctx だけが、次の操作で Index Data を更新する。

```bash
ctx setup
ctx import --provider pi
ctx index mode auto
```

ホスト側の自動インデックスは Pi History Source の更新を検出し、検証済みの Index Data 世代を公開する。手動更新が必要な場合も、ホスト側で `ctx import --provider pi` を実行する。

### サンドボックス側

サンドボックスの `/home/pi/.ctx` は、ホストの `~/.ctx` を読み取り専用で共有する。

実装時には `index-helpers.ts` のボリューム引数を次の形にする。

```text
--volume=${home}/.ctx:/home/pi/.ctx:ro
```

サンドボックス内の検索は、更新を明示的に無効化する。

```bash
ctx search "<query>" --refresh off
```

`ctx status`、`ctx show session`、`ctx show event` は、公開済み Index Data の読み取り操作として利用できる。`ctx import`、`ctx setup`、`ctx index mode auto` はサンドボックス内では実行しない。

## 初回セットアップ

ホスト側で次を実行する。

```bash
ctx status
ctx sources --provider pi --format json
ctx import --provider pi
ctx index mode auto
ctx status
```

この仕様の対象は Pi プロバイダーだけである。全プロバイダーを一括初期化する `ctx setup` は、別の履歴ソースも取り込む必要がある場合に限って使用する。

ホスト側でも通常の Pi 履歴ソース検出に失敗した場合だけ、ユーザーが正規パスを明示する。

```bash
ctx import --provider pi \
  --path "$HOME/.pi/agent/sessions"
```

`--path` は暗黙に適用しない。README や `ai-env` が自動的に別パスへフォールバックすることもない。

## 継続更新

通常はホスト側の `ctx index mode auto` による自動更新に任せる。

手動更新が必要な場合は次を実行する。

```bash
ctx import --provider pi
```

サンドボックスの起動時や `ctx search` の実行時に、Pi 履歴の import を開始してはならない。

## 状態確認

Pi 履歴ソースと Index Data の状態はホスト側で確認する。

```bash
ctx status
ctx index
ctx sources --provider pi --format json
```

サンドボックス内の `ctx sources` は、マウント境界を含む履歴ソースの自動検出結果を表示するため、Pi ソースが空または `selector_unreconstructible` になることがある。これはサンドボックス内で import を実行すべきことを意味しない。

## 失敗時の挙動

ホスト側の import または自動インデックスが失敗した場合は、次のように扱う。

- import コマンドは非ゼロ終了または失敗内容を報告する
- Pi と `ai-env` の起動は停止しない
- 直前に正常公開された Index Data 世代を検索に利用できる
- Pi のセッションファイルを変更・削除・移動しない
- Index Data の自動削除・自動リセットを行わない

Index Data の鮮度はホスト側の `ctx status` と `ctx index` で確認する。サンドボックスは、Index Data が古いことだけを理由に起動を拒否しない。

## 過去セッションの扱い

ADR 0008 より前に作成されたセッションには、`parentSession` が `/home/pi/.pi/...` を参照するものがある。通常の import ではこの値を修正しない。

- 取り込み可能な内容はベストエフォートで検索対象にする
- lineage 検証で拒否されたセッションは、Ctx の失敗・スキップ報告に従う
- ADR 0008 以降の新規セッションでは、ホストから解決できる絶対パスを保証する
- 過去の親子関係を完全に修復したい場合は、別途手動移行を行う

手動移行は通常仕様の自動処理ではなく、README に注意事項付きの手順として記載する。少なくとも Pi の停止、バックアップ、ドライラン、パス置換、再 import を必要とする。自動移行ツールは本仕様の対象外とする。

## 利用者向け手順

ホスト側の初回設定とサンドボックス側の検索手順を README に掲載する。`ai-env` に Ctx 専用サブコマンドは追加しない。

サンドボックス内で履歴を検索するときは、次を標準形とする。

```bash
ctx search "過去の判断" --refresh off
```

履歴ソースの認識や Index Data の更新状態を確認するときは、サンドボックスではなくホスト側で Ctx コマンドを実行する。

## 検証・受け入れ条件

- `buildVolumeArgs` が `/home/pi/.ctx` を `:ro` でマウントする
- 関連テストが読み取り専用マウントを検証する
- サンドボックス起動時に `ctx import` / `ctx setup` が実行されない
- `ctx search "<query>" --refresh off` が公開済み Index Data を検索できる
- サンドボックス内から Index Data の書き込みを行えない
- ホスト側の `ctx import --provider pi` で Pi 履歴を更新できる
- ホスト側の自動検出に失敗した場合、明示的な `--path` で更新できる
- import の失敗が Pi / `ai-env` の起動を阻害しない
- 通常の import が Pi のセッションファイルを変更しない
- 既存の Index Data をリセット・削除しない
- 過去セッションの `parentSession` を通常の import で書き換えない

## 実装箇所

- `index-helpers.ts` — `.ctx` ボリュームを読み取り専用に変更
- `index.test.ts` — ボリューム引数の期待値を更新
- `CONTEXT.md` — 用語と Index Data の所有権を記録
- `docs/adr/0009-ctx-index-data-host-ownership.md` — 境界の判断を記録
- `README.md` — 利用者向けの初回設定・検索手順を記載
