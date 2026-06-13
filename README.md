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
