---
title: "設定ファイル不在時のデフォルト設定が全 Credential Key をサンドボックスへ注入している"
status: TODO
created: 2026-08-30T09:20:00+09:00
---

# 設定ファイル不在時のデフォルト設定が全 Credential Key をサンドボックスへ注入している

## 背景・前提条件 (Context)

ai-env は ADR 0010 で **Profile を秘密情報のセキュリティ境界**にした。「`credentialKeys` 未指定の Profile は全クレデンシャルへフォールバックさせず、設定不備は起動エラーにする」という決定である（ADR 0010、docs/spec/0006）。

しかし **設定ファイル自体が存在しない場合**の `getDefaultConfig()` だけが、この規則の例外として全 `CREDENTIAL_NAMES` を許可した Profile を返す。Z.AI 対応（docs/spec/0007、2026-08-30 当時）で Credential Key が 11 件になり、私人用の従量課金キー `ZAI_PLATFORM_API_KEY` までこの経路で無条件に許可対象へ加わったことが、この課題を可視化させた。

### 期待される挙動 vs 実際の挙動

- **期待**: 設定ファイル不在時も、Profile が明示的に許可した Credential Key だけをコンテナへ注入する。少なくとも「何も決めていないのに全キーが渡る」状態は ADR 0010 の趣旨に反するため発生させない（起動を促すエラーでも、最小セットでもよい。方針は未決定）。
- **実際**: `~/.config/ai-env/pi-projects.json` が無いだけで、登録済み **11 件の Credential Key すべて**を許可した `pi-private` プロファイルが構成され、`buildEnvArgs` が 11 件の `--env=...` を生成する。利用者は opt-in していない。

なお注入される Profile 名は `pi-private` に固定される（デフォルト設定に `pi-work` が無いため、`detectProfileName` がホスト cwd から `pi-work` を見つけられず起動エラーになる）。つまり本課題は「仕事用へ私人用キーが漏れる」形ではなく、**「未設定のホストで全キーが私人用サンドボックスに入る／Profile 境界が 1 度も宣言されない」**形で現れる。

### エラーログ / スタックトレース

エラーは出ない（無警告で全注入される点が問題）。再現時の stderr は以下の逐語どおり。

```
pi-projects.json が見つからないため、デフォルト設定で起動します。
後ほど pi-projects.example.json を参考に設定ファイルを作成してください。
```

### 再現手順

いずれもリポジトリ直下（`/workspace/ai-env`）で実行。存在しないパスを `AI_ENV_PI_PROJECTS` に指定して「設定ファイル不在」を再現する。

1. デフォルト Profile が全キーを許可していること:

```bash
AI_ENV_PI_PROJECTS=/tmp/definitely-missing-pi-projects.json npx tsx -e "
import { loadAiEnvConfig } from './pi-projects.ts';
const c = loadAiEnvConfig();
console.log(c.profiles['pi-private'].credentialKeys.join('\n'));
"
```

期待どおりの実際の出力（11 件、`ZAI_PLATFORM_API_KEY` を含む）:

```
BRAVE_SEARCH_API_KEY
DEEPSEEK_API_KEY
GH_TOKEN
JINA_API_KEY
LLM_API_KEY
OPENAI_API_KEY
OPENCODE_API_KEY
OPENROUTER_API_KEY
QWEN_TOKEN_PLAN_API_KEY
XIAOMI_TOKEN_PLAN_SGP_API_KEY
ZAI_PLATFORM_API_KEY
```

2. 実際にコンテナへ渡る `--env` 引数（Keychain に全キーがあると仮定したモック）:

```bash
AI_ENV_PI_PROJECTS=/tmp/definitely-missing-pi-projects.json npx tsx -e "
import { loadAiEnvConfig } from './pi-projects.ts';
import { buildEnvArgs } from './index-helpers.ts';
const c = loadAiEnvConfig();
const profile = c.profiles['pi-private'];
const creds = {};
for (const k of profile.credentialKeys) creds[k] = 'fake-' + k;
const args = buildEnvArgs({ credentials: creds, herdrPaneId: 'p1', hostIp: '10.0.0.1', profile, profileName: 'pi-private' });
console.log(args.filter((a) => /^--env=[A-Z0-9_]+$/.test(a)).join('\n'));
console.log('合計 --env 引数:', args.filter((a)=>a.startsWith('--env=')).length);
"
```

実際の出力（12 個の `--env=KEY` + 6 個の非秘密 = 計 18）:

```
--env=OCR_LLM_TOKEN
--env=BRAVE_SEARCH_API_KEY
--env=DEEPSEEK_API_KEY
--env=GH_TOKEN
--env=JINA_API_KEY
--env=LLM_API_KEY
--env=OPENAI_API_KEY
--env=OPENCODE_API_KEY
--env=OPENROUTER_API_KEY
--env=QWEN_TOKEN_PLAN_API_KEY
--env=XIAOMI_TOKEN_PLAN_SGP_API_KEY
--env=ZAI_PLATFORM_API_KEY
合計 --env 引数: 18
```

3. 実コンテナ起動での確認（要 macOS / apple container / Keychain 登録）: **未実施**。`security` CLI も `container` CLI も開発サンドボックス（Linux）には存在しない。

### 環境情報

- OS: リポジトリ開発環境は Linux コンテナ（`/workspace/ai-env`）。実運用ホストは macOS（`security` / Keychain / apple container が前提）。
- 言語/ランタイム: Node.js v24.17.0（開発環境）。CI は ubuntu-latest / Node 22.x。
- 起動方法: `npm test`（node:test）、`npx oxlint`、`npx tsx index.ts ...`。CI ジョブは `npm ci` → `npx oxlint` → `npm test` のみで、コンテナを実行する検証は存在しない。

### 関連ファイル / コード

- `pi-config.ts`（問題箇所。`loadAiEnvConfig` の ENOENT 節がこの関数を呼ぶ）

```ts
// pi-config.ts:233-252
export const getDefaultConfig = (): AiEnvConfig => {
  console.error(
    "pi-projects.json が見つからないため、デフォルト設定で起動します。\n" +
      "後ほど pi-projects.example.json を参考に設定ファイルを作成してください。",
  );
  return {
    profiles: {
      "pi-private": {
        credentialKeys: [...CREDENTIAL_NAMES],   // ← 登録済み全キーを無条件に許可
        OCR_LLM_MODEL: "mimo-v2.5-pro",
        OCR_LLM_TOKEN_KEY: "OPENCODE_API_KEY",
        OCR_LLM_URL: "https://opencode.ai/zen/go/v1",
        OCR_USE_ANTHROPIC: "false",
      },
    },
    projects: {
      "pi-private": {},
    },
  };
};
```

```ts
// pi-config.ts:266-280  loadAiEnvConfig の ENOENT 分岐
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return getDefaultConfig();
    }
    throw error;
```

- `pi-types.ts`（`CREDENTIAL_NAMES` が登録一覧の正本。ここが増えるたびに default の許可範囲も自動で増える）
- `index-helpers.ts`（`buildEnvArgs` / `loadCredentials` / `buildCredentialProcessEnv` はいずれも `profile.credentialKeys` を信頼する。default の広さを抑止する層はない）
- `pi-validation.ts`（`parseCredentialKeys` は**ファイルがある場合**のみ検証する。ENOENT 経路は検証を素通りする）
- 仕様・決定の記録: `docs/adr/0010-profile-credential-allowlist.md`、`docs/adr/0011-credential-allowlist-only-route.md`、`docs/spec/0006-openai-credential-and-model.md`（「未指定時に旧来の全体注入へフォールバックすると…設定不備は起動エラーとして扱う」）、`docs/spec/0007-zai-platform-credential-and-model.md`（本件を「非対象／既知の挙動」として記録）
- README の該当記述: `## pi セッション再開設定` 節の「未指定のProfileは、全クレデンシャルへフォールバックせず起動エラーになります」

### 試したが駄目だったこと

- なし（本 issue は記録目的で、修正は未着手）。
- 試していないこと: 実 macOS での未設定時のコンテナ環境変数確認、`credentialKeys` を空配列にした場合の `parseCredentialKeys` の挙動（仕様上「空配列は設定エラー」だが default 経由では検証されない）。

## 解決すべきゴール (Goal)

**まず方針を決める必要がある。以下は候補であり、決定は未定（UNKNOWN）。採用する方針はプロジェクト所有者との合意の上で ADR に残す。**

- 候補 A: 設定ファイル不在時は**起動を中止**し、`pi-projects.example.json` を基に作成する案内を出す（ADR 0010 の「設定不備は起動エラー」に最も忠実）
- 候補 B: default の `credentialKeys` を**最小セット**（`OCR_LLM_TOKEN_KEY` の `OPENCODE_API_KEY` と、`BRAVE_SEARCH_API_KEY` / `GH_TOKEN` / `JINA_API_KEY` 程度の基盤系）へ縮小し、従量・私人用キー（`ZAI_PLATFORM_API_KEY`, `OPENAI_API_KEY`, `XIAOMI_*`, `QWEN_*`, `DEEPSEEK_*`, `LLM_API_KEY`, `OPENROUTER_API_KEY`）は含めない
- 候補 C: default を廃し、`getDefaultConfig()` が返す Profile に `credentialKeys: []` を持たせる（その場合、空配列をエラーとする現行検証との整合をどうするかを決める必要がある）

- [ ] 上記 A/B/C のいずれか（または別案）を所有者と決めて ADR に記録する
- [ ] 実装を修正し、「Credential Key を新規登録したとき、default 設定の許可範囲が変わらない（変わるとすれば意図的な編集が必要）」構造にする。具体的には `credentialKeys: [...CREDENTIAL_NAMES]` という派生を排除する
- [ ] 新規クレデンシャル追加時のチェックリストへ「default 設定への影響を確認する」を追加する（`docs/spec/` もしくは README の実装方針節）
- [ ] `docs/spec/0007-zai-platform-credential-and-model.md` の「非対象」「既知の挙動（設定ファイル不在時のデフォルト）」記述を、本 issue の解決結果に合わせて更新する
- [ ] README の「未指定のProfileは、全クレデンシャルへフォールバックせず起動エラーになります」の記述と、実際の挙動を一致させる
- [ ] CONTEXT.md の **Credential Allowlist** 定義に、未設定時を含めた境界の言い切りを追記する（実装詳細は書かない）
- [ ] 既存の挙動依存を確認する: 設定ファイル不在時に動くことを前提にしたスクリプト・docs・CI が無いことを grep で確認する

### 完了条件（検証方法）

```bash
cd /workspace/ai-env
npx oxlint                      # exit 0
npm test                        # 全パス（現状 146 件。追加テストで件数は増える）
```

- [ ] `npx oxlint` が exit 0
- [ ] `npm test` が緑（既存テストを壊さない）
- [ ] 次の再現手順 1 を再実行した結果が、採用方針どおりになることをテストで担保する
  - 方針 A なら: `ENOENT` で起動エラーメッセージが出ることを `node:test` で検証（`loadAiEnvConfig()` が throw する）
  - 方針 B なら: 返る `credentialKeys` に `ZAI_PLATFORM_API_KEY` / `OPENAI_API_KEY` などの私人用・従量系が含まれないことを検証し、`buildEnvArgs` の `--env=KEY` 個数が最小セットになることを検証
  - いずれの場合も: `CREDENTIAL_NAMES` へ将来キーを追加しても default の許可範囲が変わらないことを示すテスト（例: 配列長に依存しないアサーション）
- [ ] 採用方針が ADR として `docs/adr/` に存在し、`docs/adr/0010` または `0011` からの相互リンクがある
- [ ] `git grep -n "CREDENTIAL_NAMES"` で、`getDefaultConfig` 由来の全許可派生が消えている

## 補足（任意）

- 2026-08-30 の Z.AI Platform API 対応（docs/spec/0007）で、`CREDENTIAL_NAMES` への 1 キー追加が default 設定の許可範囲へ自動で波及することを確認した。当時の判断として「既存 10 キーでも同じ挙動であり、デフォルト設定の設計変更は今回のスコープと直交する」ため対象外にし、本 issue に分離している。
- 本件は秘密情報の**漏洩が確定している障害**ではなく、ADR 0010 で引いた境界が設定ファイル不在の経路では宣言されない（＝未設定のホストでは opt-in が機能しない）という設計上の穴の記録である。`~/.pi` が rw マウントされているため、コンテナ内から host の `auth.json` / `models.json` を変更できる既存性質（ADR 0011 で論じた境界）と重ねて見ると、Profile 境界の実効性をどこまで厳格にするかの議論になる。
- 検証手順 3（実 macOS での確認）は、この issue を実行するエージェントが Linux サンドボックスに居る場合は `UNKNOWN` のままになる。その場合はユニットテストでの担保までを完了とし、ホスト実機確認は所有者へ引き渡すこと。
