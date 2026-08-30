# 仕様: サンドボックス内での Ctx 履歴検索（Sandbox Search Client）

## 背景・目的

ai-env サンドボックス内でエージェントが Ctx の履歴検索を実行した際、既定の `ctx search` が
次のエラーで失敗し、「ctx の履歴検索はデーモンが起動できず（サンドボックスの権限制約）
利用不可」と誤結論される事象が発生した:

```
✗ start or recover daemon before source-backed refresh
ctx daemon did not start: Operation not permitted (os error 1)
```

### 根本原因（調査で確認した事実）

1. Index Data（`~/.ctx`）は virtiofs でホストと共有され、更新主体はホスト側で常駐する
   Ctx デーモンである（docs/adr/0009-ctx-index-data-host-ownership.md）
2. サンドボックスからはホスト側デーモンの PID を `/proc` で確認できないため、`ctx status` は
   `daemon.lock` に記録された PID（ホスト側の PID 空間の値）を stale lock と誤判定する。
   実際にはホスト側デーモンは `status.json` の heartbeat を約 30 秒間隔で更新しており生存している
3. 既定の `ctx search` は検索に先立ち refresh のためにデーモンの起動・復旧を試みる
   （Daemon Attempt）。サンドボックスではコンテナの制約で
   `Operation not permitted (os error 1)` となり失敗する
4. したがって「デーモンが起動しない」は正しいが「履歴検索が利用不可」は誤りである。
   `ctx search --refresh off` は共有 Index Data に対して正常に機能する
5. `CTX_DAEMON_ENABLED=0` を設定すると Daemon Attempt が抑制され、既定の `ctx search` も
   エラーなく機能する（indexing mode が manual に切り替わる）

### 誤結論の構造

- スキル ctx-agent-history-search は `--refresh off` を必須としていないため、
  標準ワークフローの `ctx search` が Daemon Attempt に到達する
- `ctx status` の stale lock 表示が「ctx が壊れている」という誤解を誘発する

本仕様の目的は、サンドボックス内での Ctx 利用を Sandbox Search Client として定義し、
Daemon Attempt の失敗を履歴検索の利用不可と誤解釈する経路を断つことである。

## スコープ

サンドボックス内限定。ホスト（macOS）側の ctx 管理（デーモン運用・自動アップグレード）は
対象外とする（docs/spec/0002-ctx-install.md と同一方針）。

## 用語

用語の定義は [CONTEXT.md](../../CONTEXT.md) の Agent History Search セクションに従う。

- **Sandbox Search Client**: Search Client のうちサンドボックス内で動作する形態。
  Daemon Attempt を抑制し、ホスト側の Ctx CLI が更新した Index Data を virtiofs 経由で読み取る
- **Daemon Attempt**: Ctx CLI が Index Data 更新のためにデーモンの起動・復旧を試みる動作
- Ctx CLI / Index Data / Pi History Source / Import / Search Client も同セクションを参照

## 修正仕様

### Daemon Attempt の抑制

- Dockerfile で `ENV CTX_DAEMON_ENABLED=0` を設定する
- 配置は ctx install の RUN 直後とし、抑制理由のコメントを添える
- 環境変数の目的は Daemon Attempt の抑制のみである。検索時の Index Data 更新の回避は
  次節の `--refresh off` 規律で担保する

### 検索の標準動作

- サンドボックス内の検索は `--refresh off` を標準とする
  （docs/adr/0009-ctx-index-data-host-ownership.md の再確認）
- `CTX_DAEMON_ENABLED=0` 下では `--refresh off` なしの `ctx search` も manual refresh として
  機能するが、ホスト側が未取り込みの新規セッションが存在する場合は Index Data への書き込みが
  理論上起こり得る。ホスト側デーモンが常時取り込みを行うため実質的には発生しない前提を受容する
  （docs/adr/0009 の判断範囲内）。取り込みが必要な場合はホスト側で `ctx import` 等を実行する

### エージェントの行動指針

サンドボックス内のエージェントは以下に従う:

- `ctx search` が `Operation not permitted (os error 1)` または
  `start or recover daemon before source-backed refresh` で失敗した場合、
  デーモンの起動失敗自体は仕様どおりの挙動であり、履歴検索が使えないことを意味しない。
  `--refresh off` を付けて再実行して続行し、「履歴検索は利用不可」と報告しない
- `ctx status` の stale lock 表示はホスト側デーモンが `/proc` から見えないことによる誤判定の
  可能性があるため、ロックの除去・デーモンの再起動などの対処を試みない
- `ctx status` が `catching up` / `Refresh pending` 等を表示してもエラーではない
  （"search remains available" が併記される）
- `ctx import` / `ctx setup` / `ctx daemon run` / 再インデックス / Index Data の削除は
  サンドボックス内で実行しない（Index Data の書き込み主体はホスト側: docs/adr/0009）

### Index Data との境界

- Index Data の更新主体はホスト側の Ctx デーモン（docs/adr/0009）
- ホスト側デーモンが停止している場合も、サンドボックス側から復旧しない。
  検索は「古いインデックスでも検索できる」ことを優先し、起動や検索を止めない
- `/home/pi/.ctx` マウントの読み取り専用化は本仕様のスコープ外とし、将来判断とする

## 検証手順

1. ホスト側でイメージを再ビルドする
2. コンテナ内で以下を確認する:

```bash
ctx --version                            # pi の PATH 上にバイナリがあること（docs/spec/0002 再確認）
env CTX_DAEMON_ENABLED=0 ctx status      # "search remains available" で stale lock 誤判定が表面化しないこと
ctx search "<既知の語>" --refresh off    # 共有 Index Data から検索できること
ctx search "<既知の語>"                  # Daemon Attempt 抑制下でデフォルト検索もエラーなく通ること
```

対照確認（旧イメージ、`CTX_DAEMON_ENABLED=0` なし）では 4 つ目のコマンドが
`ctx daemon did not start: Operation not permitted (os error 1)` で失敗する。
本仕様はこの事象を排除する。

## 実装箇所

- `Dockerfile` — ctx install の RUN 直後に `ENV CTX_DAEMON_ENABLED=0` と理由コメントを追加

## 非スコープ

- スキル ctx-agent-history-search の改変（ホストの `~/.pi` とマウント共有され、上流タグ追従が
  あるため。エージェントの行動指針は本仕様側で定義する）
- `/home/pi/.ctx` マウントの読み取り専用化（docs/adr/0009 に明記済みの未実装部分、将来判断）
- ホスト側 macOS 環境の ctx 管理（デーモン運用・自動アップグレードのまま）
- Index Data のバックアップ・マイグレーション戦略
- CI へのコンテナ内 ctx 起動確認の組込み
