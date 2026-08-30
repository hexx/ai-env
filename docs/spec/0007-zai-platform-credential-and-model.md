# 仕様: Z.AI Platform API（`zai-platform`）と `ZAI_PLATFORM_API_KEY` の対応

## 背景・目的

ホストの pi は `~/.pi/agent/models.json` が宣言するカスタム provider `zai-platform`（Z.AI Platform API、従量課金）と
モデル `glm-5.3-flash` を通常に利用できている。一方、サンドボックスでは同じモデルを選べない。原因は provider 定義では
なく**鍵**にある。`~/.pi` はマウント済みで宣言はコンテナに届いているが、`ZAI_PLATFORM_API_KEY` が ai-env の
Credential Key として登録されていないため、Profile の Credential Allowlist に入れられず、コンテナの環境変数として
注入されない。pi の認証解決（CLI `--api-key` > `auth.json` > 環境変数 > `models.json` の `apiKey`）がすべて空振りし、
モデルはロードされるが `/model` で unavailable のままになる。

本仕様は、この**鍵の欠落だけを埋める**。Provider Catalog の所有、デフォルトモデル、models.json の生成方針は変更しない。

用語の定義は [CONTEXT.md](../../CONTEXT.md) の Provider Access 節に従う。

### [docs/spec/0006](./0006-openai-credential-and-model.md) の非対象を一部撤回する

0006 は非対象に「`ZAI_API_KEY` および GLM-5.3 Flash」を挙げていた。本仕様で **GLM-5.3 Flash（Z.AI Platform API 経由）は
対象に変わる**。0006 はその時点の判断記録として書き換えず、ここを上書き範囲として記録する。
`ZAI_API_KEY`（Z.AI Coding Plan）は引き続き非対象。

## 用語

- **Provider Catalog**: pi がモデルの選択肢として読む一覧の正本。pi 組み込みカタログと `~/.pi/agent/models.json` の
  カスタム provider 宣言からなる。所有は pi 側。
- **Z.AI Platform API**: 従量課金エンドポイント（`api.z.ai/api/paas/v4`）。pi 上の provider 名は `zai-platform`、
  Credential Key は `ZAI_PLATFORM_API_KEY`。
- **Z.AI Coding Plan**: 定額購読向けの経路。pi 組み込みの `zai` / `zai-coding-cn`（`ZAI_API_KEY` / `ZAI_CODING_CN_API_KEY`）。
  本仕様の対象外。

## スコープ

### 対象

- `ZAI_PLATFORM_API_KEY` を Credential Key として登録する
- 同名の macOS Keychain サービスから値を取得する
- Profile の `credentialKeys` で許可対象にする（`pi-private` の例に追加）
- `provider: "zai-platform"` / `model: "glm-5.3-flash"` / `apiKeyEnv: "ZAI_PLATFORM_API_KEY"` を Profile / Project で
  指定できることを設定例・README・テストで担保する
- 前提条件（ホスト側の Keychain 登録と `~/.config/ai-env/pi-projects.json` の編集）を docs に書く

### 非対象

- `ZAI_API_KEY`（Z.AI Coding Plan）および `zai-coding-cn` の登録
- ai-env による `models.json` の生成・更新・存在検証（ADR 0006）
- `zai-platform` を Profile / Project の**デフォルト**へ設定すること
- OpenAI / GPT-5.6 Luna の設定変更（0006 で確定済み）
- OCR（open-code-review）の既定トークン・モデルの変更。`ZAI_PLATFORM_API_KEY` を `OCR_LLM_TOKEN_KEY` に
  割り当てる設計は行わない
- `--api-key` の argv 露出（後述の既知の挙動）対策
- `getDefaultConfig()` が全 Credential Key を許可する既存挙動の是正（ADR 0010 の再議論。別 issue へ譲る）

## クレデンシャル仕様

### Credential Key の登録

| Credential Key | 取得元 | Keychain サービス名 |
| --- | --- | --- |
| `ZAI_PLATFORM_API_KEY` | macOS Keychain | `ZAI_PLATFORM_API_KEY` |

- 既存 10 キーと同じ流儀で、Credential Key 名と Keychain サービス名を一致させる
- `ZAI_API_KEY` は登録しない。混線すると定額のはずが従量へ流れる（課金経路の分離）
- `CREDENTIAL_NAMES`（`pi-types.ts`）と `CREDENTIAL_SOURCES`（`index-helpers.ts`）は 1:1 に対応する

### 許可リスト

`pi-private` の `credentialKeys` へ `ZAI_PLATFORM_API_KEY` を追加する。`pi-work` は `WORK_API_KEY` と同じく
非アクティブな例のままとして追加しない（私人契約の従量キーを仕事用サンドボックスへ渡さない）。

既存の許可リスト規則は変更しない。

- `credentialKeys` に含まれない Credential Key は Keychain から取得せず、コンテナへ注入もしない
- `OCR_LLM_TOKEN_KEY` と Profile / Project / CLI の `apiKeyEnv` は `credentialKeys` に含まれていなければならない
- CLI の `--api-key-env` も許可リストを迂回できない

### auth.json を迂回経路にしない

`~/.pi` は rw マウントされているため、`/login` で `~/.pi/agent/auth.json` に鍵を保存すれば ai-env のコード変更なしに
サンドボックスへ鍵を届けられる。**この経路は使わない**（[ADR 0011](../adr/0011-credential-allowlist-only-route.md)）。
`auth.json` は全 Profile 共通の 1 ファイルであり、そこへ置いた鍵は Profile 境界を越えてしまう。

### 未取得時の挙動（既存規則の踏襲）

- `apiKeyEnv` として**選択している** Credential Key が未取得: エラーとして起動を中止する
- 許可しているだけの Credential Key が未取得: 警告を出し、`--env` 注入を省略して起動は継続する
  （この場合 `zai-platform` は `/model` で unavailable になる）
- 空の `--env=KEY=` は生成しない

## モデル設定仕様

```json
{
  "provider": "zai-platform",
  "model": "glm-5.3-flash",
  "apiKeyEnv": "ZAI_PLATFORM_API_KEY"
}
```

- 優先順位は既存どおり **CLI > Project > Profile**
- `apiKeyEnv` を書く（省略も可能だが、書くと「選択中のキー」として未取得時に起動中止が発動し、pi 側の解決順が確定する）
- 設定例は `pi-projects.example.json` の `pi-private` 配下で**コメントアウト**して追加する。アクティブな既定値は変えない
- `model` は素の `glm-5.3-flash` を使う。`model:thinkingLevel` 形式（`SAFE_MODEL_PATTERN` はコロンを許容）は
  README の既存説明と pi の `modelThinkingLevels` に委ね、設定例には出さない
- コンテキストウィンドウ、価格、`thinkingLevelMap` などのモデル特性はすべて Provider Catalog 側の宣言が正本で、
  ai-env は持たない

## 前提条件と有効化（ホスト側の作業）

ai-env の実装スコープはリポジトリ側の変更までとし、以下は利用者の手作業として docs に記載する
（`~/.config/ai-env/pi-projects.json` と Keychain はサンドボックスから見えない）。

1. macOS Keychain へ `ZAI_PLATFORM_API_KEY` を登録する（サービス名は Credential Key と同名）
2. `~/.pi/agent/models.json` に `zai-platform` の provider 宣言があることを確認する
3. 使用中の `~/.config/ai-env/pi-projects.json` の Profile の `credentialKeys` へ `ZAI_PLATFORM_API_KEY` を追加する
4. 利用する Profile または Project へ `provider` / `model` / `apiKeyEnv` を指定する

## 既知の挙動（変更しない）

- **Provider Catalog を検証しない**: `zai-platform` / `glm-5.3-flash` の実在を ai-env は照合しない。宣言が無い場合は
  ai-env は正常起動し、失敗は pi 側として表面化する。これは意図的な非対称で、ai-env に pi の設定形式への検証を持たせない
  判断の帰結（ADR 0006）
- **`apiKeyEnv` が効く経路と効かない経路**: `--api-key "$ENV"` は Project case でしか生成されない。`--bash`（CLI
  オプションのみ `PI_API_KEY_ENV` として export）、`pi-resume`、未マッチプロジェクトでは `apiKeyEnv` を渡さない。
  zai-platform は `models.json` の環境変数解決でも鍵を取れるため、経路によらず結局使える
- **argv 露出**: `--api-key "$ENV"` の展開はコンテナ内の bash で行われるため、秘密値はコンテナ内の pi プロセス argv に
  載る。ホスト側の `container` argv には載らない（`--env=KEY` はキー名のみ、値は子プロセス環境から継承）。
  `redactSecrets` は `--env=` をマスクする（`CREDENTIAL_SOURCES` 登録だけで自動で対象になる）
- **設定ファイル不在時のデフォルト**: `getDefaultConfig()` は全 `CREDENTIAL_NAMES` を許可するため、`ZAI_PLATFORM_API_KEY`
  も既定で許可される（既存 10 キーと同じ扱い。非対象に是正议题として記録）

## 実装方針

### `pi-types.ts`

- `CREDENTIAL_NAMES` へ `ZAI_PLATFORM_API_KEY` を追加する（アルファベット順で `XIAOMI_TOKEN_PLAN_SGP_API_KEY` の後）

### `index-helpers.ts`

- `CREDENTIAL_SOURCES` へ Keychain 取得定義を追加する（`security find-generic-password -s ZAI_PLATFORM_API_KEY -w`）
- `SECRET_ENV_PATTERN` は `CREDENTIAL_SOURCES` 由来で自動拡張されるため変更しない

### `pi-projects.example.json`

- `pi-private.credentialKeys` へ `ZAI_PLATFORM_API_KEY` を追加する
- 「`ZAI_API_KEY` は対象外」コメントを、Platform API を追加済み／Coding Plan は対象外（課金経路が別物）と読み違え
  防止の文言へ書き替える
- `pi-private` 配下へ zai-platform のコメントアウト例（3 フィールド）を追加する

### ドキュメント

- README: クレデンシャル表へ 1 行、設定ファイル構造例、`#### Z.AI Platform API(zai-platform)を使う場合`（前提条件と
  切り分けを含む）、デフォルト不変の表現更新
- [ADR 0006](../adr/0006-provider-model-in-ai-env.md): Provider Catalog の所有は pi 側、の節を追記（済み）
- [ADR 0011](../adr/0011-credential-allowlist-only-route.md): Credential Allowlist を唯一の正規ルートにする（済み）
- [CONTEXT.md](../../CONTEXT.md): Provider Access 節（Provider Catalog / Z.AI Platform API / Z.AI Coding Plan）（済み）

## テスト要件

1. `CREDENTIAL_NAMES` に `ZAI_PLATFORM_API_KEY` が入り、`ZAI_API_KEY` は入らない
2. `CREDENTIAL_SOURCES` に Keychain 定義（`security find-generic-password -s ZAI_PLATFORM_API_KEY -w`）が存在する
3. `credentialKeys` に含む Profile で `--env=ZAI_PLATFORM_API_KEY` が生成され、秘密値が argv へ露出しない
4. `credentialKeys` に**含まない** Profile では Keychain から取得せず、注入もしない
5. `profile` / `project` で `provider: "zai-platform"` / `model: "glm-5.3-flash"` / `apiKeyEnv: "ZAI_PLATFORM_API_KEY"` が
   受理される
6. 選択中の `apiKeyEnv` が未取得なら起動を中止する（警告で継続しない）
7. CLI の `--api-key-env` で許可リストを迂回できない（既存テストで担保）
8. `redactSecrets` が `ZAI_PLATFORM_API_KEY` の値をマスクする（登録だけで自動カバーされることの回帰）
9. 未登録クレデンシャル拒否テストの fixture を汎用名 `NOT_A_CREDENTIAL_KEY` へ変更する（`ZAI_API_KEY` を例に使うと、
   将来 Coding Plan を登録した瞬間に「未登録の例」ではなくなる）

## 検証手順

### 自動（CI: ubuntu / `container` 無し）

```bash
npx oxlint
npm test
```

### 手動（ホスト）

1. Keychain に `ZAI_PLATFORM_API_KEY` が登録済みであることを `security find-generic-password -s ZAI_PLATFORM_API_KEY` で確認する
2. 対象 Profile の `credentialKeys` に追加した `ai-env` を起動する
3. コンテナ内で `pi` を起動し、`/model` に `zai-platform / glm-5.3-flash` が**表示される**ことを確認する
4. 1 往復応答して従量課金側で請求が伸びることを確認する
5. `credentialKeys` から外して起動し、警告は出るが起動は継続し、モデルが unavailable になることを確認する
6. `apiKeyEnv` に指定した状態で Keychain の登録を外し、起動中止メッセージが出ることを確認する
7. `ai-env --bash` に入り、`env | grep ZAI_PLATFORM` と pi 側の `/model` で鍵が届いていることを確認する

## 成果物

| 種類 | 内容 |
| --- | --- |
| `pi-types.ts` | Credential Key 登録 |
| `index-helpers.ts` | Keychain 取得定義 |
| `pi-projects.example.json` | `pi-private` の許可リスト、コメント文言、zai-platform 例 |
| `README.md` | クレデンシャル表、構造例、`zai-platform` を使う場合、切り分け |
| `index.test.ts` / `pi-config.test.ts` | テスト要件 1〜9 |
| `docs/adr/0011` | Allowlist 唯一の正規ルート |
| `docs/adr/0006` | Provider Catalog の所有を追記 |
| `CONTEXT.md` | Provider Access 節 |
