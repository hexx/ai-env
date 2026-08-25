# 仕様: PM2 実行権限と herdr ブリッジの縮退運用

## 背景・目的

ai-env のコンテナ起動時、初期化スクリプトが次の処理で停止する問題が発生した。

```text
/bin/bash: line 24: pm2: command not found
```

調査の結果、`/usr/local/bin/pm2` 自体はイメージ内に存在するものの、`pi` ユーザーから直接実行すると次のエラーになった。

```text
bash: /usr/local/bin/pm2: Permission denied
```

Dockerfile では PM2 を root でグローバル npm インストールし、実行時には非 root ユーザー `pi` を使用している。PM2 の実行ファイルまたはそのパッケージ内の依存ファイルが `pi` から読み取り・実行できない場合、起動スクリプトの `set -euo pipefail` により pi の起動前にコンテナ初期化が終了する。

本仕様の目的は次の2つである。

1. 正常なイメージでは、root 所有の PM2 を `pi` ユーザーが確実に実行できるようにする
2. 予期せず PM2 が実行できない場合でも、herdr 連携を可能な範囲で維持し、pi の作業環境を起動する

## 用語

- **PM2**: コンテナ内で herdr 用 `socat` プロセスを管理する Node.js プロセスマネージャー
- **herdr ブリッジ**: コンテナ内の Unix ソケットと、ホスト上の herdr TCP エンドポイントを接続する socat プロセス
- **縮退運用**: PM2 によるプロセス監視が利用できない場合に、socat の直接起動または herdr ブリッジなしで pi の起動を継続する運用

## 起動時の動作仕様

### 通常経路

1. `pm2` が PATH 上にあり、実行可能であることを確認する
2. `pm2 start socat --name "herdr-socat" -- ...` を実行する
3. 成功した場合、`HERDR_BRIDGE_MODE=pm2` とする
4. PM2 が socat のプロセス管理・自動再起動・監視を担当する

### PM2 フォールバック

次のいずれかに該当する場合、PM2 経路からフォールバックする。

- `command -v pm2` が失敗する
- `pm2 start socat ...` が非ゼロ終了する

フォールバック時は stderr に次の内容を含む日本語警告を出力する。

- PM2 を起動できないこと
- socat を直接起動すること
- PM2 の自動再起動・監視が無効になること

その後、`socat` が利用可能ならバックグラウンドで直接起動し、PID を `HERDR_SOCAT_PID` に保存する。PM2 の起動失敗が途中まで状態を作った可能性に備え、可能な場合は `pm2 delete herdr-socat` を実行してから直接起動する。

### socat も利用できない場合

`socat` が見つからない、または直接起動に失敗した場合は stderr に警告を出力する。ただし、Q1 で定めた縮退運用に従い、herdr ブリッジなしで pi の起動を継続する。

| PM2 | socat | 結果 |
|---|---|---|
| 起動成功 | — | PM2 管理下で socat を起動 |
| 起動失敗 | 直接起動成功 | socat を直接起動し、警告を表示 |
| 起動失敗 | 直接起動失敗 | herdr なしで pi を起動し、警告を表示 |

## 終了時の動作仕様

### デフォルトモード

- `HERDR_BRIDGE_MODE=pm2` の場合、既存の PM2 クリーンアップを実行する
- `HERDR_BRIDGE_MODE=socat` の場合、`HERDR_SOCAT_PID` のプロセスを終了する
- `HERDR_BRIDGE_MODE=none` の場合、追加のクリーンアップは行わない
- pi の終了コードはクリーンアップの成否で上書きせず、元の終了コードを返す

### `--bash` モード

現在の `exec /bin/bash` を維持する。直接起動した socat は、bash の終了に伴うコンテナ終了時にコンテナとともに終了する。bash モードのシグナル伝播と TTY 挙動を変更しないことを優先する。

## Dockerfile 仕様

### インストールと権限

- PM2 は root 所有の `/usr/local` にインストールする
- `/usr/local/lib/node_modules/pm2` 全体を `pi` から読み取り可能にする
- PM2 パッケージの `bin` 配下を `pi` から実行可能にする
- `/usr/local/bin` を PATH に明示する
- root 所有は維持し、pi ユーザーによる PM2 の改ざんは許可しない

### ビルド時検証

`USER pi` 後に次を実行する。

```bash
command -v pm2
pm2 --version
```

この検証に失敗するイメージは完成品として扱わず、実行時まで問題を持ち越さない。

## 実装対象

- `Dockerfile`
  - PM2 パッケージの読み取り・実行権限の正規化
  - `/usr/local/bin` を含む PATH の明示
  - `USER pi` 後の PM2 ビルド時検証
- `templates/common.sh.template`
  - PM2 起動結果の判定
  - socat 直接起動フォールバック
  - herdr ブリッジのモードと PID の管理
  - 警告の出力
  - クリーンアップ関数
- `templates/default-mode.sh.template`
  - 共通クリーンアップ関数の呼び出し
- `pi-script.ts`
  - 生成スクリプトの責務コメントの更新
- `pi-script.test.ts`
  - シェル構文、通常経路、フォールバック経路、終了処理、bash モードの検証

## 検証手順

### 自動検証

```bash
npm test
npx oxlint
```

### Docker イメージ検証

ホスト側でイメージを再ビルドし、`pi` ユーザーで確認する。

```bash
container build --no-cache -t pi-sandbox .
container run --rm --entrypoint /bin/bash pi-sandbox -lc '
  command -v pm2 && pm2 --version
'
```

### 通常起動検証

通常の `ai-env` 起動で、次を確認する。

- PM2 管理下で `herdr-socat` が起動する
- pi が起動する
- pi 終了後に herdr ブリッジがクリーンアップされる

### 縮退経路検証

使い捨ての検証コンテナで PM2 を実行不能にした状態を作り、次を確認する。

- PM2 起動失敗の警告が stderr に出る
- socat が直接起動する
- pi が起動する
- デフォルトモード終了時に直接起動した socat が終了する

PM2 と socat の両方を実行不能にした場合は、警告後に pi が起動することを確認する。

## 非スコープ

- PM2 のバージョン固定
- PM2 自体の自動更新ポリシー変更
- herdr 側のプロトコル変更
- PM2 以外のグローバル npm パッケージの権限ポリシー変更
- PM2 が利用できない場合の自動修復や再インストール
- ADR の追加
