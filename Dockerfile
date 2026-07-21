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
    && apt-get install -y --no-install-recommends \
        gh \
        openssh-client \
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
# ARG CACHEBUST を変更するとこの行以降のレイヤーが再実行される。
ARG CACHEBUST=1
RUN npm install -g --no-cache \
        playwright@latest \
        @earendil-works/pi-coding-agent@latest \
        @alibaba-group/open-code-review@latest \
        hunkdiff@latest \
        pm2@latest

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
# 公式インストールスクリプトを使用
# サプライチェーンリスク: ダウンロードしたスクリプトを直接実行しているため
# ctx.rs のエンドポイントが改ざんされた場合に任意コードが実行される可能性あり。
RUN curl -fsSL -o /tmp/install-ctx.sh https://ctx.rs/install \
    && sh /tmp/install-ctx.sh \
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
RUN curl -fsSL https://herdr.dev/install.sh | sh \
    && curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh \
    && rm -rf /home/pi/.cache /tmp/*

# =========================================================
# 5. ユーザー固有の設定とエントリーポイント
# =========================================================
# マウントしたディレクトリでのGit権限エラー対策
RUN git config --global --add safe.directory /workspace

# herdr用環境変数とパスの設定
ENV HERDR_ENV=1 \
    HERDR_SOCKET_PATH=/home/pi/.config/herdr/herdr.sock \
    PATH="/home/pi/.local/bin:${PATH}"

# デフォルトの起動コマンド
CMD ["bash"]
