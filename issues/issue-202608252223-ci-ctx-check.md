---
title: "CI へのコンテナ内 ctx 起動確認の組込み"
status: TODO
created: 2026-08-25T22:23:00+09:00
---

# CI へのコンテナ内 ctx 起動確認の組込み

> ※ 記録メモ: 本 issue 作成時点では ctx は `/usr/local/bin` へインストールする方式だった。
>   その後ビルド時検証の問題を機に、インストール先はユーザー領域（pi の `~/.local/bin`）へ
>   変更された（docs/adr/0007-tool-install-location.md / docs/spec/0002-ctx-install.md）。
>   CI で検証する「期待される動作」自体は変わらない。

## 背景・前提条件 (Context)

### 期待される挙動 vs 実際の挙動
- **期待**: Dockerfile を変更したら、イメージが正しくビルドされコンテナ内ツール（特に `ctx`）が起動することを CI が自動検証する
- **実際**: `.github/workflows/ci.yml` は `npm ci` → `npx oxlint` → `npm test` のみで、Docker イメージのビルド検証もコンテナ内ツールの起動確認も行っていない

### 経緯

2026-08-25、ai-env サンドボックス内で `ctx` が使えない問題（root でインストールされたため `/root/.local/bin` に配置され pi ユーザーの PATH から到達不能になるバグ）が発覚した。原因分析と Dockerfile 修正は完了済み（`docs/spec/0002-ctx-install.md` 参照）。ただし手動検証のみであり、**同じ種類の破綻（root 実行による `$HOME/.local/bin` 配置漏れ等）を CI が検出できない状態が残っている**。

本 issue は spec 0002 の非スコープとして切り出した、CI 強化タスクである。

### エラーログ / スタックトレース

サンドボックス内での再現時の出力（逐語）:

```
/bin/bash: line 1: ctx: command not found
```

### 再現手順
1. 修正前の Dockerfile でイメージをビルドしコンテナを起動する
2. コンテナ内で以下を実行する:

```bash
which ctx   # 何も出力されない（/usr/local/bin/ctx が存在しないため）
ctx --version
# /bin/bash: line 1: ctx: command not found
```

### 環境情報
- OS: ホスト macOS（arm64）/ サンドボックス node:24-trixie-slim（Debian）
- 言語/ランタイム: Node.js 24 LTS、Docker
- 起動方法: ai-env CLI による `docker run`（`index-helpers.ts`）

### 関連ファイル / コード
- `.github/workflows/ci.yml`

```yaml
jobs:
  test-and-lint:
    runs-on: ubuntu-latest
    steps:
      - name: Run tests
        run: npm test
```

- `Dockerfile`（修正後の ctx インストール箇所）

```dockerfile
RUN curl -fsSL -o /tmp/install-ctx.sh https://ctx.rs/install \
    && CTX_BIN_DIR=/usr/local/bin sh /tmp/install-ctx.sh --no-setup --no-skill --no-pro-trial \
    && rm /tmp/install-ctx.sh
```

### 試したが駄目だったこと
- なし（本タスクは未着手）

## 解決すべきゴール (Goal)
- [ ] CI に Docker イメージのビルド検証ステップを追加する
- [ ] ビルド後、コンテナ内で `ctx --version` が成功することを検証する
- [ ] 可能なら `ctx status` も併せて検証する（索引データがない環境での挙動に注意。エラー終了しないことが確認できればよい）
- [ ] 既存ジョブ（oxlint / npm test）を壊さないこと
- [ ] ビルド時間の増加を許容範囲に収める（必要ならキャッシュ活用や `--only-shell chromium` 相当の工夫を検討）

### 完了条件（検証方法）
- GitHub Actions の push 時ワークフローに docker build + コンテナ内 `ctx --version` 確認が組み込まれ、グリーンになること
- 意図的に Dockerfile の ctx インストールを壊した場合に CI が落ちること（検出力の確認）

## 補足（任意）

- `CTX_BIN_DIR=/usr/local/bin` パターン（uv と同一）は他ツール追加時にも流用可能。CI 追加時に「全ユーザー PATH 上のバイナリが pi ユーザーから見えるか」の一般チェックへ拡張してもよい
- 参考仕様: `docs/spec/0002-ctx-install.md`
