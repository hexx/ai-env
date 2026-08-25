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

## Dockerイメージのビルド

`pi-sandbox` イメージはリポジトリの `Dockerfile` からビルドする:

```bash
# ビルド
container build -t pi-sandbox .

# ビルド済みイメージの確認
container images | grep pi-sandbox
```

リポジトリで `Dockerfile` が更新された場合は、上記コマンドで再ビルドする。

Dockerfile は npm の `@latest` や curl インストーラ（ctx / herdr / rtk 等）で
ビルド時に最新版を取得するため、最新版を取り込みたいときはキャッシュバスティングする:

```bash
container build --build-arg CACHEBUST=$(date +%s) -t pi-sandbox .
```

`CACHEBUST` の値を変えると npm インストール以降のレイヤー（playwright / ctx / pm2 /
herdr / rtk）が再実行される。apt（gh）と uv は対象外（詳細は `docs/spec/0004-cachebust.md`）。

## Ctx の Pi 履歴取り込み

Pi のセッション履歴は、ホスト側の Ctx CLI が Index Data（`~/.ctx`）へ取り込みます。
サンドボックス内の Ctx は検索クライアントとして動作し、Index Data を更新しません。
詳細は [`docs/spec/0005-ctx-pi-history-import.md`](./docs/spec/0005-ctx-pi-history-import.md) を参照してください。

### 初回設定（ホスト側）

```bash
ctx status
ctx sources --provider pi --format json
ctx import --provider pi
ctx index mode auto
ctx status
```

ホスト側でも Pi 履歴の自動検出に失敗した場合だけ、正規パスを明示して実行します。

```bash
ctx import --provider pi --path "$HOME/.pi/agent/sessions"
```

通常はホスト側の Ctx 自動インデックスが更新を行います。手動更新が必要な場合はホスト側で
`ctx import --provider pi` を実行してください。サンドボックスの起動時に import は行いません。

### サンドボックス内の検索

サンドボックスでは、Index Data の更新を起こさないよう `--refresh off` を指定します。

```bash
ctx search "検索したい内容" --refresh off
ctx status
```

Index Data の鮮度や Pi 履歴ソースの状態を確認する場合は、ホスト側で `ctx status`、
`ctx index`、`ctx sources --provider pi` を実行してください。過去セッションの古い
`parentSession` パスは自動修正せず、必要な場合だけ別途手動移行します。

## クレデンシャル

以下のクレデンシャルを実行時に動的に取得する:

| 用途 | 取得元 |
| --- | --- |
| `BRAVE_SEARCH_API_KEY` | macOS Keychain |
| `DEEPSEEK_API_KEY` | macOS Keychain |
| `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | macOS Keychain |
| `QWEN_TOKEN_PLAN_API_KEY` | macOS Keychain |
| `OPENCODE_API_KEY` | macOS Keychain |
| `OPENROUTER_API_KEY` | macOS Keychain |
| `LLM_API_KEY` | macOS Keychain |
| `JINA_API_KEY` | macOS Keychain |
| `GH_TOKEN` | `gh auth token` |

## pi セッション再開設定

設定は `~/.config/ai-env/pi-projects.json` に JSON ファイルとして配置する。
リポジトリの [`pi-projects.example.json`](./pi-projects.example.json) を参考に作成すること。
設定ファイルは JSONC (JSON with Comments) 形式をサポートしており、`//` 行コメントや `/* */` ブロックコメントを使用できる。

### コンテナ内のディレクトリ構成

コンテナ内の作業ディレクトリはプロジェクトごとに `/workspace/<プロジェクト名>` へマウントされる
(プロジェクト名 = ホスト側のカレントディレクトリ名)。これにより pi のセッション整理(cwd ベース)が
プロジェクトごとに機能し、`pi -c`(前回セッションの続行)や `/resume`(セッション選択)が
そのプロジェクトのセッションだけを対象に動作する(詳細は [docs/adr/0005-session-per-project-cwd.md](./docs/adr/0005-session-per-project-cwd.md) を参照)。

**制約**: プロジェクト名(ホストのカレントディレクトリ名)はマウント先ディレクトリ名に使用するため、
英数字・ハイフン・アンダースコア・ピリオドのみ許可される。これ以外の文字(日本語・スペース等)を含む
ディレクトリ名では `ai-env` は起動できない。

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
      "provider": "opencode-go",
      "model": "minimax-m3"
    },
    "mindmap": {}
  }
}
```

* `profiles`: 仕事用 / プライベート用など用途別のプロファイル。各プロファイルに OCR 全体設定を記述。オプションで `provider` と `model` を指定でき、プロジェクト側で未指定の場合のデフォルト値として使用される。
* `projects`: プロジェクトごとの pi 起動設定。`provider` / `model` / `apiKeyEnv` を任意で指定し、未指定時はプロファイルのデフォルト値にフォールバックする。`apiKeyEnv` はコンテナ内の API キー用環境変数名(例: `LLM_API_KEY`)で、生成シェルでは `$LLM_API_KEY` としてランタイム展開される。旧形式の `session` フィールド(セッション ID)は廃止されたが、後方互換のため読み飛ばされる(セッション再開は `pi -c` が担う)。
* `OCR_LLM_TOKEN_KEY`: CREDENTIAL_SOURCES のキー名を指定。`credentials[OCR_LLM_TOKEN_KEY]` の値が `--env=OCR_LLM_TOKEN=...` に注入される。

### CLI オプション

`ai-env` は以下のオプションを受け付ける。

| オプション | 説明 |
| --- | --- |
| `--bash` | pi を起動せず bash シェルのみ起動。 |
| `--new` | 新しいセッションで pi を起動(デフォルトは `pi -c` で前回セッションを続行)。`--session` とは排他。 |
| `--session <id>` | `pi` の `--session` に渡すセッション ID(部分 ID 可)。`--new` とは排他。`--bash` 時は `PI_SESSION` 環境変数として export。 |
| `--provider <p>` | `pi` の `--provider` を上書き。`--bash` 時は `PI_PROVIDER` 環境変数として export。 |
| `--model <m>` | `pi` の `--model` を上書き(`model:thinkingLevel` 形式可)。`--bash` 時は `PI_MODEL` 環境変数として export。 |
| `--api-key-env <envName>` | `pi` の `--api-key` で参照するコンテナ内環境変数名を上書き。`--bash` 時は `PI_API_KEY_ENV` 環境変数として export。 |

値の優先順位は **CLI > Project > Profile**。

* `ai-env` (デフォルト起動) は `pi -c` でそのプロジェクトの前回セッションを続行する(セッションがなければ pi が新規作成)。`ai-env --new` は新しいセッションで起動する。
* `provider` / `model` / `apiKeyEnv` は CLI > Project > Profile の順で解決され、`pi` のフラグとして渡される。
* `ai-env --session <id>` は `--session <id>` フラグとして pi に渡し、特定セッションを 1 回だけ再開する。
* プロジェクト未マッチ時 (`projects` に存在しないプロジェクト) は CLI > プロファイル の順でフォールバック。CLI 未指定ならプロファイルデフォルト、それも未指定ならフラグを出さない。
* `ai-env --bash --provider X --model Y --session <id>` でコンテナに入り、`pi --provider "$PI_PROVIDER" --model "$PI_MODEL" --session "$PI_SESSION"` のように env 変数を参照して pi を起動できる。

### プロファイルの自動判別

`ai-env` 実行時のカレントディレクトリに、いずれかのプロファイル名(例: `pi-private`, `pi-work`)が含まれていれば、該当プロファイルが自動選択される。含まれない場合はエラー(利用可能なプロファイル名一覧を案内)。

例:
* `cd ~/work/pi-work && ai-env` → `pi-work` プロファイルが選択
* `cd ~/private/pi-private && ai-env` → `pi-private` プロファイルが選択

設定ファイルパスは環境変数 `AI_ENV_PI_PROJECTS` で上書き可能。
