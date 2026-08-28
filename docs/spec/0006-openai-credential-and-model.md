# 仕様: OpenAIクレデンシャルとGPT-5.6 Lunaの利用

## 背景・目的

ai-envからOpenAI APIを利用できるようにする。対象はOpenAIの組み込みプロバイダーと
`gpt-5.6-luna`であり、ai-env側でモデルカタログを複製したり、既存のデフォルトモデルを
変更したりしない。

この変更では、OpenAIの認証情報をmacOS Keychainから取得し、Profileの
**Credential Allowlist**に従って必要なサンドボックスだけへ渡す。Z.AIおよび
`ZAI_API_KEY`は対象外とする。

用語の定義は [CONTEXT.md](../../CONTEXT.md) に従う。

## 対象範囲

### 対象

- `OPENAI_API_KEY`をCredential Keyとして登録する
- 同名のmacOS Keychainサービスから値を取得する
- Profile必須の`credentialKeys`で取得・注入対象を制限する
- Profile / Project / CLIの`apiKeyEnv`を許可リストと照合する
- `provider: "openai"`、`model: "gpt-5.6-luna"`をProfileまたはProjectで指定できるようにする
- 設定例、README、ADR、テストを更新する

### 非対象

- `ZAI_API_KEY`およびGLM-5.3 Flash
- OpenAIモデルの自動フォールバックやルーティング
- `gpt-5.6-luna`をProfileやProjectのデフォルトへ強制設定すること
- ai-env独自の`models.json`生成
- `WORK_API_KEY`の取得元を実装すること

## クレデンシャル仕様

### Credential Keyの登録

`CREDENTIAL_SOURCES`へ次のエントリを追加する。

| Credential Key | 取得元 | Keychainサービス名 |
| --- | --- | --- |
| `OPENAI_API_KEY` | macOS Keychain | `OPENAI_API_KEY` |

`ZAI_API_KEY`は登録しない。

`CREDENTIAL_NAMES`は、Keychainサービス名、コンテナ内環境変数名、Profileの
`credentialKeys`で共通して使う登録済み名前の一覧とする。

### Profileの許可リスト

すべてのProfileに、1つ以上の登録済みCredential Keyを含む
`credentialKeys`を必須とする。

```json
{
  "profiles": {
    "pi-private": {
      "credentialKeys": [
        "BRAVE_SEARCH_API_KEY",
        "DEEPSEEK_API_KEY",
        "GH_TOKEN",
        "JINA_API_KEY",
        "LLM_API_KEY",
        "OPENAI_API_KEY",
        "OPENCODE_API_KEY",
        "OPENROUTER_API_KEY",
        "QWEN_TOKEN_PLAN_API_KEY",
        "XIAOMI_TOKEN_PLAN_SGP_API_KEY"
      ],
      "OCR_LLM_TOKEN_KEY": "OPENCODE_API_KEY",
      "OCR_USE_ANTHROPIC": "false",
      "OCR_LLM_URL": "https://opencode.ai/zen/go/v1",
      "OCR_LLM_MODEL": "mimo-v2.5-pro"
    }
  }
}
```

ルール:

- `credentialKeys`がない、空、または重複を含むProfileは設定エラーとする
- 登録されていない名前（例: `ZAI_API_KEY`、`WORK_API_KEY`）は指定できない
- `OCR_LLM_TOKEN_KEY`は`credentialKeys`に含まれていなければならない
- Profileの`apiKeyEnv`は`credentialKeys`に含まれていなければならない
- Projectの`apiKeyEnv`も、選択されたProfileの`credentialKeys`に含まれていなければならない
- CLIの`--api-key-env`も許可リストを迂回できない
- 許可されていないCredential KeyはKeychainから取得せず、コンテナにも渡さない

既存の設定ファイルに`credentialKeys`がない場合、全クレデンシャルへのフォールバックは
行わず、追加すべきフィールドを示して起動を中止する。

### 未取得時の挙動

- 許可リストにあるが利用されていないCredential Keyの取得失敗:
  - 警告を出す
  - コンテナへの`--env`注入を省略する
  - 起動は継続する
- `OCR_LLM_TOKEN_KEY`の取得失敗:
  - エラーとして起動を中止する
- 起動時に選択された`apiKeyEnv`の取得失敗:
  - エラーとして起動を中止する
- 空の`--env=KEY=`は生成しない

## モデル設定仕様

### OpenAIを選択する設定

デフォルトは変更せず、利用者がProfileまたはProjectで明示した場合だけOpenAIを選択する。

```json
{
  "provider": "openai",
  "model": "gpt-5.6-luna",
  "apiKeyEnv": "OPENAI_API_KEY"
}
```

`apiKeyEnv`を省略した場合は`--api-key`フラグを生成せず、Piの標準環境変数解決に任せる。
`credentialKeys`に`OPENAI_API_KEY`が含まれていない場合、Piからキーは見えない。

モデルはPiの組み込みカタログを使う。ai-envは`models.json`を生成しない。
Pi側でモデルが認識できない場合は、Piまたはサンドボックスイメージのモデルカタログを更新する。

### 優先順位

`provider`、`model`、`apiKeyEnv`の優先順位は既存どおりとする。

**CLI > Project > Profile**

CLIで指定した`--api-key-env`がProfileの許可リスト外なら、Piを起動せずエラーとする。

## Profile例の扱い

`pi-projects.example.json`で実際に読み込まれるProfileは、登録済みCredential Keyだけを
使う`pi-private`を中心にする。

`WORK_API_KEY`を使う`pi-work`は、現在の`CREDENTIAL_SOURCES`に登録されていないため、
実際の`profiles`ブロックには置かない。READMEまたはJSONコメント内の非アクティブな例として
残し、仕事用の取得元を追加した後に有効化できる構成例とする。

## 実装方針

### `pi-types.ts`

- `CREDENTIAL_NAMES`と`CredentialName`を追加する
- `ProfileConfig.credentialKeys`を必須化する

### `pi-config.ts` / `pi-validation.ts`

- `credentialKeys`の配列、登録名、重複を検証する
- `OCR_LLM_TOKEN_KEY`とProfileの`apiKeyEnv`を許可リストと照合する
- 不足した`credentialKeys`を旧仕様へフォールバックさせない

### `index-helpers.ts`

- `OPENAI_API_KEY`のKeychain取得定義を追加する
- Profile確定後に許可されたCredential Keyだけを取得する
- 許可された値だけをコンテナ環境変数として注入する
- `container`のargvには秘密値を埋め込まず、`--env=KEY`で子プロセス環境から継承させる
- 未取得の任意キーの空環境変数を生成しない
- 起動時に選択されたAPIキーの存在を検証する

### ドキュメント

- READMEにKeychain名、`credentialKeys`、GPT-5.6 Luna設定例を追加する
- [ADR 0010](../adr/0010-profile-credential-allowlist.md)にProfileを秘密情報境界とする理由を記録する
- `CONTEXT.md`にCredential Key / Credential Allowlistを記録する

## テスト要件

- `OPENAI_API_KEY`がKeychainソースとして定義される
- `ZAI_API_KEY`が定義されない
- 許可リスト外のCredential KeyをKeychainから取得しない
- 許可リスト外のCredential Keyをコンテナへ注入しない
- `credentialKeys`がないProfileを拒否する
- 未登録名、重複、空配列を拒否する
- OCRトークンと`apiKeyEnv`の許可リスト不整合を拒否する
- CLIの`--api-key-env`で許可リストを迂回できない
- 任意キーの取得失敗では警告して注入を省略する
- 選択中のAPIキーの取得失敗ではエラーにする
- ProfileまたはProjectで`gpt-5.6-luna`を指定できる
- 既存のCLI > Project > Profileの優先順位を維持する
