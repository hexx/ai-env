# ai-env

私専用のAI開発用Dockerサンドボックス環境を簡単に起動するためのCLIツール。

## 概要

macOS ホスト上から、Keychain や `gh auth token` から動的にクレデンシャルを取得し、
`pi-private-sandbox` イメージを使ったインタラクティブなサンドボックス環境を立ち上げる。

## 必要要件

- Node.js >= 20
- macOS (Keychain アクセスに `security` コマンドを使用)
- Docker
- `gh` CLI (GitHub トークン取得用)

## インストール

```bash
npm install
```

## 使い方

```bash
# 開発時
npm run start

# グローバルインストール
npm install -g .
ai-env
```

## クレデンシャル

以下のクレデンシャルを実行時に動的に取得する:

| 用途 | 取得元 |
| --- | --- |
| `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | macOS Keychain |
| `OPENCODE_API_KEY` | macOS Keychain |
| `OPENROUTER_API_KEY` | macOS Keychain |
| `GH_TOKEN` | `gh auth token` |

## pi セッション再開設定

コンテナ内で `pi-resume <project>` を使うと、事前定義したプロジェクトのセッションを再開できる。

設定は `~/.config/ai-env/pi-projects.json` に JSON ファイルとして配置する。
リポジトリの [`pi-projects.example.json`](./pi-projects.example.json) を参考に作成すること:

```json
{
  "ai-env": {
    "session": "019ec00f-6774-7719-9d32-0ce0acf7892f",
    "provider": "opencode-go",
    "model": "minimax-m3"
  },
  "mindmap": "019e9b9f-e299-7b7f-a1c1-cc6c5753efc4"
}
```

値は文字列(セッション ID のみ)とオブジェクト(`session` 必須、`provider` / `model` 任意)の両方を受け付ける。
オブジェクト形式の場合、`pi-resume` 実行時は `--provider <p> --model <m> --thinking high --session <s>` の順で組み立てる。`--thinking high` は常に付与される。

設定ファイルパスは環境変数 `AI_ENV_PI_PROJECTS` で上書き可能。
