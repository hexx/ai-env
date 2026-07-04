---
description: Apple Silicon Mac で動く軽量 Linux コンテナランタイム `container` の利用者向けリファレンス。`container run`、`container build`、`container image pull/push`、`container machine`、ボリューム・ネットワーク・DNS・設定ファイルなど、日常的なコマンドの使い方を網羅する。`container` コマンドの使い方やトラブルシューティングに関する質問で使用する。
metadata:
    github-path: skills/apple-container
    github-ref: refs/heads/main
    github-repo: https://github.com/hexx/skills
    github-tree-sha: a85574857754da3eb6606f365a02f41f94478301
name: apple-container
---
# apple-container（`container` CLI）

Apple 製の `container` ツールは、Linux コンテナを **軽量 VM 1 つ = コンテナ 1 個** の方式で Mac 上に起動するランタイム。OCI 互換イメージを使うため Docker / podman で作ったイメージがそのまま動く。リポジトリは [apple/container](https://github.com/apple/container)。

> このスキルは **利用者向け**。ソースコードの修正やビルド方法ではなく、`container` コマンドを使う側の知識を扱う。

## 動作要件

- **Apple Silicon Mac**（Intel Mac 不可）
- **macOS 26 推奨**。macOS 15 でも動くが以下が制限される（issue は再現環境が macOS 26 でないと対応されない）。
  - コンテナ間ネットワーク通信不可（すべてのコンテナが default ネットワークに孤立して所属）
  - `container network` コマンド利用不可
  - `--network` 指定はエラー
  - サブネットは `192.168.64.1/24` 固定（vmnet との不整合でネットが完全に切れることがある）

### 対応アーキテクチャ

ゲストとして動かせるのは `linux/arm64`（ネイティブ）と `linux/amd64`（Rosetta 経由）の 2 つだけ。

- `container system kernel set --arch` は CLI ヘルプで `amd64` / `arm64` の 2 値しか受け付けないと明記。
- `container run --arch` / `container build --arch` は CLI 側で値を弾かないので `riscv64` / `ppc64le` / `s390x` などを書いてもイメージ pull や VM 起動まで進んでしまうが、ゲストプロセス起動時に `Exec format error` で失敗する。

## インストール・起動

### 初回インストール

```bash
brew install container
container system start
```

初回はカーネルのダウンロードを促すプロンプトが出る。`Y` で承認。`brew services start container` でログイン時に自動起動するサービスとして登録することもできる。

### アップグレード

```bash
container system stop
brew upgrade container
container system start
```

### アンインストール

```bash
container system stop
brew uninstall container
```

ユーザーデータ（`~/.config/container` など）は `brew uninstall` では消えないので、不要なら手動で削除する。

### 起動確認

```bash
container system status
container system version
container list --all      # 空でも応答すれば OK
```

## CLI の全体構造

サブコマンドツリーは大きく分けて以下のグループ。

| グループ | 主なコマンド |
|:--|:--|
| コンテナ | `run` / `create` / `start` / `stop` / `kill` / `delete` (`rm`) / `list` (`ls`) / `exec` / `logs` / `inspect` / `stats` / `copy` (`cp`) / `export` / `prune` |
| イメージ | `build` / `image pull` / `image push` / `image list` / `image inspect` / `image tag` / `image save` / `image load` / `image delete` / `image prune` |
| ビルダー | `builder start` / `builder status` / `builder stop` / `builder delete` |
| ネットワーク（macOS 26+） | `network create` / `network list` / `network inspect` / `network delete` / `network prune` |
| ボリューム | `volume create` / `volume list` / `volume inspect` / `volume delete` / `volume prune` |
| レジストリ | `registry login` / `registry logout` / `registry list` |
| コンテナマシン | `machine create` / `machine run` / `machine list` / `machine inspect` / `machine set` / `machine set-default` / `machine logs` / `machine stop` / `machine delete`（alias: `m`） |
| システム | `system start` / `system stop` / `system status` / `system version` / `system logs` / `system df` / `system dns ...` / `system kernel set` / `system property list` |

ヘルプ全般は `container --help` / `container <subcommand> --help`。

## コンテナを動かす（`container run`）

### 基本

```bash
container run -it ubuntu:latest /bin/bash                # 対話シェル
container run -d --name web -p 8080:80 nginx:latest      # バックグラウンドで Web サーバー
container run --rm alpine echo hello                      # 終了後に削除
```

イメージ名にレジストリを省略すると `~/.config/container/config.toml` の `[registry] domain` が補完される（デフォルト `docker.io`）。

### よく使うオプション

| 用途 | フラグ |
|:--|:--|
| 名前付け | `--name <id>` |
| バックグラウンド | `-d` / `--detach` |
| 自動削除 | `--rm` |
| 対話 | `-i` / `-t`（合わせて `-it`） |
| 環境変数 | `-e KEY=VAL` / `-e KEY`（ホストから継承） / `--env-file <path>` |
| 作業ディレクトリ | `-w /path` |
| ユーザー | `-u name|uid[:gid]` / `--uid` / `--gid` |
| `ulimit` | `--ulimit <type>=<soft>[:<hard>]` |

### リソース

```bash
container run --cpus 8 --memory 32g big              # 既定は 4 CPU / 1 GiB
container run --shm-size 1G img                      # /dev/shm のサイズ
container run --tmpfs /tmp img                       # tmpfs マウント
```

### ファイル共有

`--volume` と `--mount` は同じ機能の別表記。

```bash
# ホストの ~/Desktop/assets をコンテナの /content/assets にマウント
container run -v ${HOME}/Desktop/assets:/content/assets python:alpine ls /content/assets

# 同じことを --mount で
container run --mount source=${HOME}/Desktop/assets,target=/content/assets,readonly python:alpine ls /content/assets
```

匿名ボリューム（`-v /path` 形式）は `--rm` を付けても **自動削除されない**（Docker と違う）。`container volume rm <anon-id>` で明示的に消す。

### ポート公開

```bash
container run -d --rm -p 127.0.0.1:8080:8000 node:latest                  # IPv4
container run -d --rm -p '[::1]:8080:8000' node:latest                    # IPv6
container run -d --rm -p 8080:80/udp img                                  # プロトコル指定
```

書式: `[host-ip:]host-port:container-port[/protocol]`。複数ネットワーク接続時は最初に attach したインターフェイスへ転送される。

### マルチプラットフォーム

対応するのは `arm64`（ネイティブ）と `amd64`（Rosetta 経由）の 2 つのみ。

```bash
container build --arch arm64 --arch amd64 -t img .
container run --arch amd64 --rm img uname -a        # amd64 は Rosetta 経由で動く
```

### SSH エージェント転送

```bash
container run -it --rm --ssh alpine sh
# 内部: SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock が設定される
```

### Linux capability

既定では制限された capability セット（`CAP_NET_BIND_SERVICE` などのみ）。

```bash
container run --cap-add NET_ADMIN alpine ip link set lo down
container run --cap-add ALL alpine sh
container run --cap-drop ALL --cap-add SETUID --cap-add SETGID alpine id
```

`CAP_` 接頭辞、大文字小文字は不問。`--cap-drop` が `--cap-add` より先に処理される（`--cap-drop ALL --cap-add ALL` は ALL を付与）。

### init プロセス

シグナル転送・ゾンビ刈り取りが必要なら `--init`。

```bash
container run --init ubuntu:latest my-app
```

カスタム init イメージ（`vminitd` をラップする独自バイナリ）は `--init-image <image>` で指定。VM ブート時に独自ロジックを差し込みたい場合に使う。

### ネスト仮想化

M3 以降の Apple Silicon と `CONFIG_KVM=y` 付きカーネルが必要。

```bash
container run --virtualization --kernel /path/to/vmlinux-kvm --rm ubuntu sh -c "dmesg | grep kvm"
```

## イメージのビルド（`container build`）

```bash
container build -t my-app:latest .                                # Dockerfile を探してビルド
container build -f docker/Dockerfile.prod -t my-app:prod .        # Dockerfile を明示
container build --build-arg NODE_VERSION=18 -t my-app .           # build-arg
container build --target production --no-cache -t my-app:prod .   # ステージ指定
container build -t my-app:latest -t my-app:v1.0.0 .               # 複数タグ
```

ファイル探索順は `Dockerfile` → `Containerfile`。

### ビルダーのリソース

ビルダーは別の VM（既定 2 CPU / 2 GiB）。大きなビルドが詰まったら：

```bash
container builder stop && container builder delete
container builder start --cpus 8 --memory 32g
```

ビルド時に Rosetta を使わせない設定：

```toml
# ~/.config/container/config.toml
[build]
rosetta = false
```

## イメージ管理

```bash
container image list                                              # ローカルイメージ
container image inspect web-test | jq                             # 詳細 JSON
container image pull alpine:latest                                # 取得
container image push registry.example.com/me/img:latest           # 送出
container image tag web-test registry.example.com/me/web:latest   # 別名付与
container image save -o img.tar img1 img2                          # tar に保存
container image load -i img.tar                                    # tar から読み込み
container image delete web-test                                    # 削除
container image prune -a                                           # 未使用を一括削除
```

### レジストリ認証

```bash
container registry login some-registry.example.com                # 対話入力
echo $TOKEN | container registry login --password-stdin -u me reg # stdin
container registry list
container registry logout some-registry.example.com
```

レジストリ既定値は `[registry] domain` で変更。`--scheme auto`（既定）はループバック・RFC1918・既定 DNS ドメインの場合のみ HTTP、それ以外は HTTPS を選ぶ。

## コンテナ管理

```bash
container ls                          # 実行中
container ls -a                       # 停止中も含む
container ls --format json --all | jq '.[] | .configuration.id'

container inspect my-web-server | jq
container logs my-web-server                # 標準出力ログ
container logs --boot my-web-server         # VM ブートログ
container logs -f -n 100 my-web-server      # 末尾 100 行を tail -f

container exec -it my-web-server sh          # 既存コンテナにシェルで入る
container exec my-web-server ls /content

container cp ./config.json my-web-server:/etc/app/   # ホスト→コンテナ
container cp my-web-server:/var/log/app.log ./       # コンテナ→ホスト

container stop my-web-server                  # SIGTERM、5 秒後 SIGKILL
container stop -s SIGINT -t 30 my-web-server
container kill my-web-server                   # 即時 SIGKILL
container rm my-web-server                     # 停止後に削除
container rm -f my-web-server                  # 実行中でも強制削除
container prune                                # 停止中のコンテナをまとめて削除
```

### ステータス監視

```bash
container stats                              # 全コンテナを top 風に表示
container stats --no-stream my-web-server    # 単発スナップショット
container stats --format json --no-stream my-web-server | jq
```

### ファイルシステムのエクスポート

```bash
container stop my-web-server
container export -o my-web-server.tar my-web-server
container export my-web-server > my-web-server.tar
```

## ネットワーク（macOS 26+）

`container system start` で `default`（vmnet）ネットワークが作られる。任意の隔離ネットワークを追加できる。

```bash
container network create foo
container network create foo --subnet 192.168.100.0/24 --subnet-v6 fd00:1234::/64
container network ls
container network inspect foo
container network delete foo                  # 接続中コンテナがあると削除不可
container network prune                       # 未接続のものを一括削除

container run -d --name web --network foo web-test
container run -d --network default,mac=02:42:ac:11:00:02 ubuntu     # MAC 指定
```

MAC を指定するときは第 1 オクテットの最下位 2 bit を `10`（ローカル管理・ユニキャスト）に。

既定サブネットを変えるには：

```toml
# ~/.config/container/config.toml
[network]
subnet = "192.168.100.1/24"
subnetv6 = "fd00:abcd::/64"
```

### ローカル DNS ドメイン

`container` には組み込み DNS がある。`--name my-web-server` で起動したコンテナを `my-web-server.<domain>` で名前解決できるようにする。

```bash
sudo container system dns create test                       # ドメイン test を登録
sudo container system dns create host.container.internal --localhost 203.0.113.113   # ホストの IP を返す
container system dns list
sudo container system dns delete test
```

注意（macOS のパケットフィルタ制約）:

- `--localhost` を使うと **Private Relay が無効化** される
- ローカルドメインのパケットフィルタ規則は **macOS 再起動で消える**

ホスト側のサービスへコンテナからアクセスしたいときの定番は `host.container.internal` パターン。

## ボリューム

名前付きボリュームと匿名ボリュームの 2 種類。匿名は `--rm` でも消えない点に注意。

```bash
container volume create myvol                                          # 名前付き作成
container volume create --opt journal=ordered myvol                    # ext4 ジャーナル指定
container volume create --opt journal=writeback:64m myvol              # ジャーナルサイズも指定
container volume create -s 10g myvol                                   # サイズ
container volume create --opt size=10g myvol                           # 同上（-s が優先）

container volume ls
container volume inspect myvol
container volume rm myvol                                              # 使用中は削除不可
container volume prune                                                 # 未参照のものを一括削除
```

ジャーナルモード：

- `ordered`（既定相当）: メタデータのみジャーナル、データはメタデータより先にディスクへ
- `writeback`: メタデータのみジャーナル、順序保証なし（最速・最も危険）
- `journal`: メタデータとデータ両方ジャーナル（最も安全）

## コンテナマシン（`container machine`、alias `m`）

「アプリ 1 つを動かすコンテナ」ではなく「**永続化された Linux 開発環境**」が欲しいときに使う。

特徴：

- OCI イメージから作る
- ホストのユーザーアカウントと同名のユーザーが作られる
- `$HOME` がそのまま `/Users/<username>` にマウントされる
- 停止しても FS が残る
- 通常の OCI コンテナと違い `/sbin/init` を起動する（`systemd` で長期サービス常駐が可能）

```bash
container machine create alpine:latest --name dev
container machine set-default dev
m run                                  # 対話シェル（既定マシン）
m run -n dev whoami                    # ホストのユーザー名が返る
m run -n dev pwd                       # /Users/<you>（Mac の $HOME がそのままマウントされている）
m run -n dev -- cat /proc/cpuinfo
m ls
m inspect dev
m stop dev
m rm dev                               # 永続ストレージごと削除
```

リソースは `set` で更新（次回起動から反映）：

```bash
m set -n dev cpus=4 memory=8G
m set -n dev home-mount=ro             # ro / rw / none
m set -n dev virtualization=true kernel=/path/to/vmlinux-kvm
m set -n dev kernel=                   # カスタムカーネル解除
m stop dev && m run -n dev -- nproc
```

### 独自イメージ

`/sbin/init` を含む Linux イメージなら何でも使える。最初の起動で自動でユーザー作成スクリプトが走るが、`/etc/machine/create-user.sh` をイメージ内に置けば独自プロビジョニングに差し替えられる（環境変数 `CONTAINER_USER` / `CONTAINER_UID` / `CONTAINER_GID` / `CONTAINER_HOME` / `CONTAINER_MACHINE_ID` が渡る）。

```dockerfile
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y dbus systemd openssh-server ...
RUN systemctl set-default multi-user.target
```

## システム

```bash
container system start                  # サービス起動
container system stop                   # サービス停止
container system status
container system version
container system logs -f                # サービスログ
container system logs --last 1h
container system df                     # イメージ・コンテナ・ボリュームのディスク使用量
```

### カーネル管理

`--arch` で指定できるのは `arm64`（既定）と `amd64` のみ。`amd64` ゲストは Rosetta で動くため通常は `arm64` カーネルだけで足りる。

```bash
container system kernel set --recommended                   # 推奨カーネルを取得・適用
container system kernel set --tar https://.../kata.tar.zst --binary opt/kata/.../vmlinux
container system kernel set --binary ./vmlinux --arch arm64 --force
```

### システムプロパティ

`~/.config/container/config.toml` の現在値を一覧表示。

```bash
container system property list                    # TOML
container system property list --format json
```

## 設定ファイル `~/.config/container/config.toml`

|セクション|主な用途|
|:--|:--|
|`[build]`|ビルダー VM の CPU / メモリ / Rosetta / image|
|`[container]`|`run` / `create` の既定 CPU・メモリ|
|`[dns]`|`domain`（コンテナ名に補完されるドメイン）|
|`[kernel]`|`binaryPath` / `url`（カーネルアーカイブ）|
|`[network]`|新規ネットワークの既定 `subnet` / `subnetv6`|
|`[registry]`|イメージ参照でレジストリ省略時の既定 `domain`|
|`[vminit]`|`vminitd` イメージ|
|`[plugin.<id>]`|プラグイン固有設定|

例：

```toml
[build]
rosetta = false
cpus = 4
memory = "4gb"

[container]
cpus = 4
memory = "1gb"

[dns]
domain = "test"

[network]
subnet = "192.168.100.0/24"
subnetv6 = "fd00:abcd::/64"

[registry]
domain = "ghcr.io"
```

### メモリ表記

二進系（1024 基数）。`b` / `k|kb|kib` / `m|mb|mib` / `g|gb|gib` / `t|tb|tib` / `p|pb|pib`。
裸の整数はバイト扱い。

### CIDR

IPv4 例 `"192.168.100.0/24"` / IPv6 例 `"fd00:abcd::/64"`。読み込み時に検証され、不正なら起動失敗。

## シェル補完

```bash
container --generate-completion-script zsh > ~/.oh-my-zsh/completions/_container
container --generate-completion-script bash > /opt/homebrew/etc/bash_completion.d/container
container --generate-completion-script fish > ~/.config/fish/completions/container.fish
```

ファイル名は zsh のみ `_container` 固定。

## 既知の制限

- **ホストへのメモリ返却が部分的**: Linux 側で free されたメモリが macOS まで返らないことがある。長時間動かしていると Activity Monitor で大きく見える。多数のメモリ集約型コンテナを動かしたら定期的に再起動する。
- **匿名ボリュームは `--rm` で消えない**: 明示的に `container volume rm` する。
- **macOS 15** ではコンテナ間通信・マルチネットワーク・`container network` がすべて使えない。

## クイックリファレンス

| やりたいこと | コマンド |
|:--|:--|
| サービス起動 / 停止 | `container system start` / `container system stop` |
| イメージ取得 | `container image pull <ref>` |
| イメージビルド | `container build -t <name> .` |
| 対話実行 | `container run -it <image> /bin/sh` |
| バックグラウンド実行 | `container run -d --name <name> --rm <image>` |
| ポート公開 | `container run -p 127.0.0.1:8080:80 <image>` |
| ボリュームマウント | `container run -v $HOME/x:/x <image>` |
| SSH 転送 | `container run --ssh <image>` |
| シェルに入る | `container exec -it <id> sh` |
| ログ追従 | `container logs -f <id>` |
| 起動ログ | `container logs --boot <id>` |
| 統計表示 | `container stats <id>` |
| コピー | `container cp <src> <dst>` |
| 停止・削除 | `container stop <id>` / `container rm <id>` |
| イメージ push | `container image push <ref>` |
| レジストリ認証 | `container registry login <host>` |
| ネットワーク作成 | `container network create <name>` |
| DNS ドメイン作成 | `sudo container system dns create <name>` |
| ボリューム作成 | `container volume create <name>` |
| マシン作成 | `container machine create <image> --name <id>` |
| マシンでシェル | `m run -n <id>` |
| ディスク使用量 | `container system df` |
| サービスログ | `container system logs -f` |
| バージョン確認 | `container system version` |
