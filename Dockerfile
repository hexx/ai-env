# ベースイメージ: Node.js 24 (Debian trixie-slim)
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
# 必須npmパッケージのグローバルインストール
RUN npm install -g playwright @earendil-works/pi-coding-agent @alibaba-group/open-code-review

# Playwrightブラウザ本体と依存ライブラリのインストール、および全ユーザーへのアクセス権限付与
RUN npx playwright install --with-deps \
    && chmod -R 777 /ms-playwright

# =========================================================
# 3. 実行ユーザーと環境の設定
# =========================================================
# セキュリティ向上のため、非rootユーザー (pi) を作成
RUN groupadd -r pi && useradd -r -m -g pi pi

WORKDIR /workspace

# pi-coding-agent を最新状態へアップデート
RUN pi update

USER pi

# herdr のインストール
RUN curl -fsSL https://herdr.dev/install.sh | sh

# =========================================================
# 4. ユーザー固有の設定とエントリーポイント
# =========================================================
# マウントしたディレクトリでのGit権限エラー対策
RUN git config --global --add safe.directory /workspace

# herdr用環境変数とパスの設定
ENV HERDR_ENV=1 \
    HERDR_SOCKET_PATH=/home/pi/.config/herdr/herdr.sock \
    PATH="/home/pi/.local/bin:${PATH}"

# デフォルトの起動コマンド
CMD ["bash"]
