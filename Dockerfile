# =========================================================
# メインイメージ（単一ステージ構成）
# =========================================================
# ベースイメージ: Node.js 24 LTS (Debian trixie-slim)
# Node 24 は Active LTS (2026-06 時点)。メジャーバージョンを明示固定して再現性を確保。
FROM node:24-trixie-slim

# Playwrightブラウザの共有インストールパスとデフォルトエディタの設定
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    EDITOR=nano

# =========================================================
# 1. システムパッケージとツールのインストール
# =========================================================
# 基本ツール、GitHub CLI、およびOpenSSHクライアントのインストール
# gh は GitHub 公式 apt リポジトリ (cli.github.com/packages) からインストールする。
# リポジトリ追加後に apt-get update を再実行しないと、apt はソースリストの変更を
# 自動検出できないことがある(BuildKit のレイヤーではタイムスタンプ比較が機能せず
# 自動 update が走らない)ため、Debian 側の古い gh がエラーなくインストールされて
# しまう。例: gh 2.46.0 は gh pr edit が Projects classic 廃止の GraphQL エラーで
# 壊れる。そのためリポジトリ追加後の明示的な update と、インストールされた gh が
# 公式リポジトリ由来であることの検証をビルド時に行う。検証は --version の表記に
# 依存せず、パッケージメタデータの Maintainer で判定する(公式は "GitHub"、
# Debian パッケージは "Debian Go Packaging Team")。
RUN apt-get update && apt-get install -y --no-install-recommends \
        wget \
        ca-certificates \
        gnupg \
        nano \
        git \
        socat \
        curl \
        python3 \
        python-is-python3 \
        jq \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg > /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        gh \
        openssh-client \
    && gh --version \
    && dpkg-query -W -f='${Maintainer}\n' gh | grep -qi 'github' \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# =========================================================
# 1.5 Python 用パッケージマネージャー uv のインストール
# =========================================================
# 公式インストールスクリプトを使用（Astral 製の高速パッケージマネージャ）。
# UV_INSTALL_DIR を sh に直接渡し、全ユーザーの PATH 上（/usr/local/bin）へ配置。
# ※ `VAR=x curl ... | sh` では VAR が左辺の curl にしか効かず右辺の sh へ渡らないため、
#    一旦スクリプトを /tmp へ落としてから実行し、&& で curl 失敗もビルドエラーにする。
# サプライチェーンリスク: ダウンロードしたスクリプトを直接実行しているため
# astral.sh のエンドポイントが改ざんされた場合に任意コードが実行される可能性あり。
RUN curl -LsSf https://astral.sh/uv/install.sh -o /tmp/uv-install.sh \
    && UV_INSTALL_DIR=/usr/local/bin sh /tmp/uv-install.sh \
    && rm /tmp/uv-install.sh

# =========================================================
# 2. 開発ツール・ライブラリのセットアップ
# =========================================================
# 必須npmパッケージのグローバルインストール。
# いずれも @latest を指定し、ビルドごとに最新版を取得する。
# - pi-coding-agent / open-code-review は個人開発パッケージ
# - playwright はバージョン固定すると依存解決の兼ね合いでビルドが
#   失敗する場合があるため @latest
# - pm2 は herdr-socat プロセスの管理に使用
# - --no-cache でレイヤにnpmキャッシュを残さない(イメージサイズ削減)
# root でグローバルインストールした PM2 は、root 所有を維持したまま
# pi ユーザーが読み取り・実行できる権限に正規化する。
# ARG CACHEBUST を変更するとこの行以降のレイヤーが再実行される。
ARG CACHEBUST=1
RUN npm install -g --no-cache \
        playwright@latest \
        @earendil-works/pi-coding-agent@latest \
        @alibaba-group/open-code-review@latest \
        hunkdiff@latest \
        pm2@latest \
    && chmod a+rx /usr/local/lib /usr/local/lib/node_modules \
    && chmod -R a+rX /usr/local/lib/node_modules/pm2 \
    && find /usr/local/lib/node_modules/pm2/bin -type f -exec chmod a+rx {} +

# Playwrightブラウザ本体と依存ライブラリのインストール。
# パーミッションは 755 とし、pi ユーザーがブラウザバイナリを実行できるが
# 改ざんできないように。所有者は root のままにする。
#
# ブラウザは chromium の headless shell のみインストールする（--only-shell chromium）。
# 本サンドボックスはディスプレイサーバのない Docker コンテナ（headless 専用）で
# 動作するため、headed モードの GUI ブラウザ本体は不要。firefox / webkit は
# クロスブラウザテスト用途でのみ必要となるが、本環境のソース・テンプレート・CI に
# それらを使うコードはなく、AI エージェントによるスクレイピング / E2E / スクリーン
# ショット等の用途は chromium headless shell で全て賄える。
# 全ブラウザ（chromium headed + headless shell + firefox + webkit + ffmpeg）から
# headless shell + ffmpeg に絞ることで、ダウンロード換算で約 375MB（展開後の
# イメージレイヤーではそれ以上）のサイズ削減になる。
# 将来 headed モードや他ブラウザが必要になった場合は、本行の --only-shell を外すか
# `npx playwright install <browser>` を実行して再ビルドすること。
#
# --with-deps は内部で apt-get update/install を実行するため、実行後に
# apt のリスト/キャッシュと一時ファイルを削除してイメージサイズを削減する。
RUN npx playwright install --with-deps --only-shell chromium \
    && chmod -R 755 /ms-playwright \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/* /var/tmp/*

# =========================================================
# 3. ctx.rs のインストール
# =========================================================
# 公式インストールスクリプトを使用。
# CTX_BIN_DIR を明示し、全ユーザーの PATH 上（/usr/local/bin）へ配置。
# この RUN は root で実行されるため、デフォルト（$HOME/.local/bin）のままだと
# /root/.local/bin へインストールされ、pi ユーザーからは PATH も権限も届かず
# 「ctx: command not found」になる（docs/spec/0002-ctx-install.md 参照）。
# ※ `VAR=x curl ... | sh` では VAR が左辺の curl にしか効かず右辺の sh へ渡らないため、
#    一旦スクリプトを /tmp へ落としてから環境変数付きで実行する（uv と同一パターン）。
# オプション:
# --no-setup: 索引初期化（ctx setup）はビルド時に行わない。Index Data（~/.ctx）は
#   ホストと virtiofs で共有される破棄禁止資産であり、root の /root/.ctx を作っても無意味。
# --no-skill: ctx agent スキルはホストの ~/.pi がマウント済みのため重複して入れない。
# --no-pro-trial: pro 体験版の自動開始という副作用を避ける。
# サプライチェーンリスク: ダウンロードしたスクリプトを直接実行しているため
# ctx.rs のエンドポイントが改ざんされた場合に任意コードが実行される可能性あり。
RUN curl -fsSL -o /tmp/install-ctx.sh https://ctx.rs/install \
    && CTX_BIN_DIR=/usr/local/bin sh /tmp/install-ctx.sh --no-setup --no-skill --no-pro-trial \
    && rm /tmp/install-ctx.sh

# =========================================================
# 4. 実行ユーザーと環境の設定
# =========================================================
# セキュリティ向上のため、非rootユーザー (pi) を作成
RUN groupadd -r pi && useradd -r -m -g pi pi

WORKDIR /workspace

# pi-coding-agent を最新状態へアップデート。
# 実行ユーザーは pi（HOME=/home/pi）のため root のキャッシュは実行時に不要。
# イメージサイズ削減のためキャッシュと一時ファイルを削除する。
RUN pi update --all \
    && rm -rf /root/.cache /root/.npm /tmp/* /var/tmp/*

USER pi

# herdr のインストール
# サプライチェーンリスク: ダウンロードしたスクリプトを直接実行しているため
# herdr.dev のエンドポイントが改ざんされた場合に任意コードが実行される可能性あり。
# herdr 公式のインストール方法に従っているため、本 Dockerfile ではチェックサム
# 検証を追加できない。将来的にパッケージマネージャー対応があれば移行推奨。
# rtk も同様に master の install.sh を直接実行する（バージョン無固定）。herdr と同種の
# サプライチェーンリスクを認識した上で、最新版のフィルタ改善を追うため意図的に採用している。
# 詳細: docs/adr/0001-rtk-reintroduction.md
RUN curl -fsSL https://herdr.dev/install.sh | sh \
    && curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh \
    && rm -rf /home/pi/.cache /tmp/*

# =========================================================
# 5. ユーザー固有の設定とエントリーポイント
# =========================================================
# マウントしたディレクトリでのGit権限エラー対策
RUN git config --global --add safe.directory '/workspace/*'

# herdr用環境変数とパスの設定
ENV HERDR_ENV=1 \
    HERDR_SOCKET_PATH=/home/pi/.config/herdr/herdr.sock \
    PATH="/usr/local/bin:/home/pi/.local/bin:${PATH}"

# 実行ユーザー pi から、root でインストールした PM2 を実行できることを
# イメージビルド時に検証する。権限や PATH が壊れたイメージを実行時まで残さない。
RUN command -v pm2 \
    && pm2 --version

# デフォルトの起動コマンド
CMD ["bash"]
