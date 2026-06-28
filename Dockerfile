# ベースイメージ: Node.js 22 LTS (Debian bookworm-slim)
# Node 22 は Active LTS。再現性のためにメジャーバージョンを明示固定する。
FROM node:22-bookworm-slim

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
# 必須npmパッケージのグローバルインストール。
# バージョンを明示固定し、ビルドの再現性を確保する。
# 最新版を取得したい場合は Dockerfile を更新するか、--build-arg で
# バージョン文字列を上書きする運用が考えられる。
# - pi-coding-agent / open-code-review は個人開発パッケージで
#   バージョンタグの運用方針が未確定のため @latest のままとする
#   (Issue #202606280659 の対応時の妥協点)
# - pm2 は herdr-socat プロセスの管理に使用
# - --no-cache でレイヤにnpmキャッシュを残さない(イメージサイズ削減)
ARG PLAYWRIGHT_VERSION=1.50.0
ARG PM2_VERSION=5.4.3
RUN npm install -g --no-cache \
        playwright@${PLAYWRIGHT_VERSION} \
        @earendil-works/pi-coding-agent@latest \
        @alibaba-group/open-code-review@latest \
        pm2@${PM2_VERSION}

# Playwrightブラウザ本体と依存ライブラリのインストール。
# パーミッションは 755 とし、pi ユーザーがブラウザバイナリを実行できるが
# 改ざんできないように。所有者は root のままにする。
RUN npx playwright install --with-deps \
    && chmod -R 755 /ms-playwright

# =========================================================
# 3. 実行ユーザーと環境の設定
# =========================================================
# セキュリティ向上のため、非rootユーザー (pi) を作成
RUN groupadd -r pi && useradd -r -m -g pi pi

WORKDIR /workspace

# pi-coding-agent を最新状態へアップデート。
# ARG CACHEBUST を変更するとこの行以降のレイヤーが再実行される。
# (ENV ではなく ARG を使うことで、コンテナ内に環境変数が残らない)
# 例: docker build --build-arg CACHEBUST=$(date +%s) .
ARG CACHEBUST=1
RUN pi update --all

USER pi

# herdr のインストール
# サプライチェーンリスク: ダウンロードしたスクリプトを直接実行しているため
# herdr.dev のエンドポイントが改ざんされた場合に任意コードが実行される可能性あり。
# herdr 公式のインストール方法に従っているため、本 Dockerfile ではチェックサム
# 検証を追加できない。将来的にパッケージマネージャー対応があれば移行推奨。
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
