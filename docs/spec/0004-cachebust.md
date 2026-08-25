# 仕様: Dockerfile のビルドキャッシュバスティング（ARG CACHEBUST）

## 背景・目的

Dockerfile はビルド時に最新版を取得する依存が多い:

- npm グローバル: `playwright@latest` / `pi-coding-agent@latest` / `open-code-review@latest` / `hunkdiff@latest` / `pm2@latest`
- curl インストーラ: uv（astral） / ctx.rs / herdr / rtk（バージョン無固定）

レイヤーキャッシュによりこれらが再実行されないと、「同じ Dockerfile でビルドしたのに
イメージに古い @latest が残る」状態になる。そこでキャッシュバスティングを行い、
必要なときだけこれらのレイヤーを再実行できるようにする。

2026-06 に `ENV CACHE="..."`（アンチパターン: 環境変数がイメージ内に残り続ける）から
`ARG CACHEBUST` へ移行した（issue 202606280659）。しかし当初の実装は ARG の宣言のみで
RUN から参照されておらず、`--build-arg` を渡してもキャッシュは無効化されない
「機能していない」状態だった。本仕様はその実装を完成させる。

## 仕組み

- BuildKit 系ビルダーのキャッシュキーは、RUN 命令文中で**参照された** ARG の値を含む
  （宣言のみの ARG はキャッシュキーに影響しない）
- Dockerfile は npm インストールの RUN 末尾で `echo "CACHEBUST=${CACHEBUST}"` により
  ARG を参照する。出力はビルドログに残り、バストが効いていることの確認にも使える
- ARG はイメージに残らない（ENV との違い）
- キャッシュ無効化は以降の全レイヤーに波及するため、参照は 1 箇所で足りる

## 使い方

| 用途 | コマンド |
| --- | --- |
| 通常ビルド（キャッシュ利用） | `container build -t pi-sandbox .` |
| npm 以降を最新化 | `container build --build-arg CACHEBUST=$(date +%s) -t pi-sandbox .` |

## 対象範囲

- **再実行される**: npm インストール以降の全レイヤー
  （npm install → playwright ブラウザ → ctx → pm2 → herdr / rtk → ビルド時検証）
- **対象外**: apt（gh 等）・uv のレイヤー（Debian / 公式定版のため。
  イメージ全体を最初から作り直す場合は `container build --no-cache` を使う）

## 検証手順

1. `container build --build-arg CACHEBUST=1 -t pi-sandbox .` が成功する
2. 同じコマンドをもう一度実行し、npm インストール以降が `CACHED` になること
3. `--build-arg CACHEBUST=$(date +%s)` で再ビルドし、ビルドログに
   `CACHEBUST=<値>` が表示され、npm インストール以降が再実行されること
4. 通常の `ai-env` 起動が従来どおりできること
5. `npm test` / `npx oxlint` が通ること

## 非スコープ

- apt / uv レイヤーのバスト対象化（検証は手順 3 で代替できる）
- 各ツールのバージョン固定方針の変更（@latest 方針は従来どおり）
- CI へのビルド検証の組込み（別 issue: `issues/issue-202608252223-ci-ctx-check.md`）
