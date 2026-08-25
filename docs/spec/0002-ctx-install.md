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

### インストーラーの設計変更（2026-08）

その後、ctx.rs 公式インストーラーはインストール先を「実行ユーザー所有」に限定し、
インストール先ディレクトリを `chmod 0700` する単一ユーザー前提の設計へ変更された:

```sh
[ "$bin_dir_owner" = "$(id -u)" ] ||
  fail "ctx install directory must be owned by the current user"
chmod 0700 "$secure_bin_dir" || fail "could not secure the ctx install directory"
```

`CTX_BIN_DIR=/usr/local/bin` による root 実行は所有者チェックは通るが、
`/usr/local/bin` 全体が 0700 になり pi は node / uv / pi を含む全システム領域ツールを
実行できなくなる（`pi update --all` 等が最初に失敗する）。したがって、
`/usr/local/bin` への配置はインストーラーの想定利用法に反し、維持できない。

これは「uv と同じパターン」とみなしていた前提（下記 修正仕様）の誤りであり、
uv（astral）と ctx.rs ではインストーラーの設計思想が異なる（docs/adr/0007 参照）。

### スコープ

本仕様は **サンドボックス内限定** の修復を扱う。ホスト（macOS）側の ctx は
config.toml の `[upgrade] auto = "apply"` により 0.25.0 → 1.0.2 へ自動更新されており稼働中のため触らない。

## 用語

用語の定義は [CONTEXT.md](../../CONTEXT.md) の Agent History Search セクションに従う。

- **Ctx CLI**: ctx.rs 製のローカルエージェント履歴検索 CLI（`ctx` コマンド）
- **Index Data**: Ctx CLI が管理する索引データ（`~/.ctx` 配下の work.sqlite 等）。ホストと共有する破棄禁止資産

## 修正仕様

### インストール先

- `USER pi` の後に公式インストーラーを実行し、既定の `$HOME/.local/bin`（=`/home/pi/.local/bin`）へ配置する
- `CTX_BIN_DIR` の指定は不要（インストーラー既定がユーザー領域のため）
- インストール先の根拠は「実行ユーザーが使うパーソナル CLI はユーザー領域へ」という方針
  （docs/adr/0007）。インストーラーの所有者制約・0700 化とも整合する
- `~/.local/bin` は既に `ENV PATH` で pi の PATH に含まれている（herdr / rtk と同経路）

### インストーラーオプション

| オプション | 理由 |
| --- | --- |
| `--no-setup` | 索引初期化（ctx setup）をビルド時に行わない。Index Data はホスト共有資産であり、ビルド時に root の `/root/.ctx` を作るのは無意味かつ混乱のもと |
| `--no-skill` | ctx agent スキルはホストの `~/.pi` がコンテナへマウント済み（`index-helpers.ts` の volume マウント）のため重複して入れない |
| `--no-pro-trial` | pro 体験版の自動開始という副作用を避ける |

※ `VAR=x curl ... | sh` 形式では変数が curl 側にしか渡らない。今回の方式は
`CTX_BIN_DIR` 指定が不要になったため、スクリプトを `/tmp` へダウンロードしてから
`sh /tmp/install-ctx.sh` として実行し、`&&` で失敗を検出する（uv と同様の安全策を維持）。

### バージョン方針

- バージョン固定なし（stable channel 最新）。pi-coding-agent / playwright 等と同一方針
- ホスト側も既に 1.x へ更新済みのため、Index Data のスキーマ互換性リスクは低い
- メジャーバージョン差異で Index Data 非互換が顕在化した場合は固定化を再考する

## 動作仕様

- コンテナ内で `ctx --version` が応答する（pi ユーザーから）
- `/home/pi/.ctx` はホストの `~/.ctx` と同一実体を参照するが、サンドボックス側では読み取り専用とする
  （実装要求は `docs/spec/0005-ctx-pi-history-import.md` を参照）
- サンドボックス内の検索は `--refresh off` を指定し、Index Data の更新を起こさない
- Pi 履歴の `setup` / `import` / `index mode` はホスト側でのみ実行する
- 索引の初期化・再構築は Docker イメージのビルド時にも、サンドボックス起動時にも行わない

## 検証手順

1. ホスト側で Pi 履歴の初回取り込みを行う（詳細は `docs/spec/0005-ctx-pi-history-import.md`）
2. ホスト側でイメージを再ビルドする
3. コンテナ内で以下を確認する:

```bash
ctx --version                           # バイナリが pi の PATH 上にあること
which ctx                               # /home/pi/.local/bin/ctx であること
ctx status                              # /home/pi/.ctx を読み取れること
ctx search "<既知の語>" --refresh off    # ホスト側で取り込んだセッションを検索できること
```

## 実装箇所

- `Dockerfile` — ユーザー領域ツールのインストール（herdr / rtk と同じ `USER pi` セクション）

## 非スコープ

- CI へのコンテナ内 ctx 起動確認の組込み（別 issue として `issues/` に記録）
- ホスト側 macOS 環境の ctx 管理（自動アップグレード運用のまま）
- Index Data のバックアップ・マイグレーション戦略
