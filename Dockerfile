# =========================================================
# Stage 2: メインイメージ
# =========================================================
# ベースイメージ: Node.js 24 LTS (Debian trixie-slim)
# Node 24 は Active LTS (2026-06 時点)。メジャーバージョンを明示固定して再現性を確保。
FROM node:24-trixie-slim

# デフォルトエディタの設定
ENV EDITOR=nano

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
# 2. 開発ツール・ライブラリのセットアップ
# =========================================================
# 必須npmパッケージのグローバルインストール。
# いずれも @latest を指定し、ビルドごとに最新版を取得する。
# - pi-coding-agent / open-code-review は個人開発パッケージ
# - pm2 は herdr-socat プロセスの管理に使用
# - --no-cache でレイヤにnpmキャッシュを残さない(イメージサイズ削減)
# ARG CACHEBUST を変更するとこの行以降のレイヤーが再実行される。
ARG CACHEBUST=1
RUN npm install -g --no-cache \
        @earendil-works/pi-coding-agent@latest \
        @alibaba-group/open-code-review@latest \
        hunkdiff@latest \
        pm2@latest

# =========================================================
# 3. ctx.rs のインストール
# =========================================================
# 公式インストールスクリプトでプレビルドバイナリを取得
# サプライチェーンリスク: ダウンロードしたスクリプトを直接実行しているため
# ctx.rs のエンドポイントが改ざんされた場合に任意コードが実行される可能性あり。
# 一時ファイル方式でパイプのサイレント失敗を防止 (curl 失敗時にビルドが止まる)。
RUN curl -fsSL -o /tmp/ctx-install.sh https://ctx.rs/install \
    && sh /tmp/ctx-install.sh \
    && rm /tmp/ctx-install.sh

# =========================================================
# 4. 実行ユーザーと環境の設定
# =========================================================
# セキュリティ向上のため、非rootユーザー (pi) を作成
RUN groupadd -r pi && useradd -r -m -g pi pi

WORKDIR /workspace

# pi-coding-agent を最新状態へアップデート。
RUN pi update --all

USER pi

# herdr のインストール
# サプライチェーンリスク: ダウンロードしたスクリプトを直接実行しているため
# herdr.dev のエンドポイントが改ざんされた場合に任意コードが実行される可能性あり。
# herdr 公式のインストール方法に従っているため、本 Dockerfile ではチェックサム
# 検証を追加できない。将来的にパッケージマネージャー対応があれば移行推奨。
RUN curl -fsSL https://herdr.dev/install.sh | sh \
    && curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh

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
