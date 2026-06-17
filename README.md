# ai-env

私専用のAI開発用Dockerサンドボックス環境を簡単に起動するためのCLIツール。

## 概要

macOS ホスト上から、Keychain や `gh auth token` から動的にクレデンシャルを取得し、
`pi-sandbox` イメージを使ったインタラクティブなサンドボックス環境を立ち上げる。

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

設定は `~/.config/ai-env/pi-projects.json` に JSON ファイルとして配置する。
リポジトリの [`pi-projects.example.json`](./pi-projects.example.json) を参考に作成すること。

### 設定ファイルの構造

```json
{
  "profiles": {
    "pi-private": {
      "OCR_USE_ANTHROPIC": "false",
      "OCR_LLM_URL": "https://opencode.ai/zen/go/v1",
      "OCR_LLM_TOKEN_KEY": "OPENCODE_API_KEY",
      "OCR_LLM_MODEL": "mimo-v2.5-pro"
    }
  },
  "projects": {
    "ai-env": {
      "session": "019ec00f-...",
      "provider": "opencode-go",
      "model": "minimax-m3"
    },
    "mindmap": "019e9b9f-..."
  }
}
```

* `profiles`: 仕事用 / プライベート用など用途別のプロファイル。各プロファイルに OCR 全体設定を記述。
* `projects`: pi セッション再開用のプロジェクト定義。値は文字列(セッション ID のみ)とオブジェクト(`session` 必須、`provider` / `model` 任意)の両方を受け付ける。オブジェクト形式では `pi-resume` 実行時に `--provider <p> --model <m> --thinking high --session <s>` の順で組み立てる(常に `--thinking high` 付与)。
* `OCR_LLM_TOKEN_KEY`: CREDENTIAL_SOURCES のキー名を指定。`credentials[OCR_LLM_TOKEN_KEY]` の値が `--env=OCR_LLM_TOKEN=...` に注入される。

### プロファイルの自動判別

`ai-env` 実行時のカレントディレクトリに、いずれかのプロファイル名(例: `pi-private`, `pi-work`)が含まれていれば、該当プロファイルが自動選択される。含まれない場合はエラー(利用可能なプロファイル名一覧を案内)。

例:
* `cd ~/work/pi-work && ai-env` → `pi-work` プロファイルが選択
* `cd ~/private/pi-private && ai-env` → `pi-private` プロファイルが選択

設定ファイルパスは環境変数 `AI_ENV_PI_PROJECTS` で上書き可能。
