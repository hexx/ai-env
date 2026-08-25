# 仕様: Ctx CLI のサンドボックス内インストール

## 背景・目的

ai-env サンドボックス内で `ctx` コマンドが「command not found」となり、
ローカルエージェント履歴検索（ctx-agent-history-search スキル）が機能しない問題が発生した。

### 根本原因

Dockerfile の ctx インストール RUN（旧 L105-112）は `USER pi` より前、すなわち **root で実行**される。
一方、ctx.rs 公式インストーラー（https://ctx.rs/install）はインストール先を次のように決める:

```sh
bin_dir="${CTX_BIN_DIR:-${HOME:-}/.local/bin}"
```

そのため root 実行時はデフォルトの `$HOME/.local/bin` = `/root/.local/bin` へバイナリが配置され、
pi ユーザー（PATH=`/home/pi/.local/bin:/usr/local/sbin:...`）からは PATH も権限も届かず、
コマンドが存在しないのと同じ状態になっていた。

対照的に、同 Dockerfile の uv は `UV_INSTALL_DIR=/usr/local/bin` を明示しており、
herdr / rtk は `USER pi` 切替後にインストールして `~/.local/bin` に入る設計だった。
ctx だけがどちらのパターンにも乗っていなかったことが破綻点。

### スコープ

本仕様は **サンドボックス内限定** の修復を扱う。ホスト（macOS）側の ctx は
config.toml の `[upgrade] auto = "apply"` により 0.25.0 → 1.0.2 へ自動更新されており稼働中のため触らない。

## 用語

用語の定義は [CONTEXT.md](../../CONTEXT.md) の Agent History Search セクションに従う。

- **Ctx CLI**: ctx.rs 製のローカルエージェント履歴検索 CLI（`ctx` コマンド）
- **Index Data**: Ctx CLI が管理する索引データ（`~/.ctx` 配下の work.sqlite 等）。ホストと共有する破棄禁止資産

## 修正仕様

### インストール先

- `CTX_BIN_DIR=/usr/local/bin` を明示し、全ユーザーの PATH 上へ配置する
- Dockerfile 内の既存パターン（uv の `UV_INSTALL_DIR=/usr/local/bin`）と同一方針
- `/usr/local/bin` は root 所有のため、pi ユーザーによるバイナリ改ざんも不可（Playwright ブラウザと同じ思想）

### インストーラーオプション

| オプション | 理由 |
| --- | --- |
| `--no-setup` | 索引初期化（ctx setup）をビルド時に行わない。Index Data はホスト共有資産であり、ビルド時に root の `/root/.ctx` を作るのは無意味かつ混乱のもと |
| `--no-skill` | ctx agent スキルはホストの `~/.pi` がコンテナへマウント済み（`index-helpers.ts` の volume マウント）のため重複して入れない |
| `--no-pro-trial` | pro 体験版の自動開始という副作用を避ける |

※ `VAR=x curl ... | sh` 形式では変数が curl 側にしか渡らないため、uv と同様に
スクリプトを `/tmp` へダウンロードしてから `CTX_BIN_DIR=... sh /tmp/install-ctx.sh` として実行する。

### バージョン方針

- バージョン固定なし（stable channel 最新）。pi-coding-agent / playwright 等と同一方針
- ホスト側も既に 1.x へ更新済みのため、Index Data のスキーマ互換性リスクは低い
- メジャーバージョン差異で Index Data 非互換が顕在化した場合は固定化を再考する

## 動作仕様

- コンテナ内で `ctx --version` が応答する（pi ユーザーから）
- `ctx search` はマウントされた `/home/pi/.ctx`（= ホスト `~/.ctx` の同一実体）を参照する
  （`index-helpers.ts`: `--volume=${home}/.ctx:/home/pi/.ctx` により実現。今回の変更対象外）
- 索引の初期化・再構築が必要になった場合は、実行時にユーザー自身が `ctx setup` を実行する（ビルド時は行わない）

## 検証手順

1. ホスト側でイメージを再ビルドする
2. コンテナ内で以下を確認する:

```bash
ctx --version              # バイナリが pi の PATH 上にあること
which ctx                  # /usr/local/bin/ctx であること
ctx status                 # /home/pi/.ctx（ホスト共有 Index Data）を参照できること
ctx search "<既知の語>"    # ホスト側セッションが検索できること
```

## 実装箇所

- `Dockerfile` — 「3. ctx.rs のインストール」RUN ブロック

## 非スコープ

- CI へのコンテナ内 ctx 起動確認の組込み（別 issue として `issues/` に記録）
- ホスト側 macOS 環境の ctx 管理（自動アップグレード運用のまま）
- Index Data のバックアップ・マイグレーション戦略
