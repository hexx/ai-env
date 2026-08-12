# 仕様: `ai-env --session <id>` による明示セッションの再開

## 背景・目的

コンテナ内 cwd をプロジェクトごとに分ける設計（[ADR 0005](../adr/0005-session-per-project-cwd.md)）により、
セッション再開は `pi -c`（前回セッションの続行）と `/resume`（プロジェクト内ピッカー）が担う。
ただし、それらは「そのプロジェクトの最新 / 一覧」から選ぶ方式であり、別プロジェクトのセッションや
過去のセッションを特定して再開するには、セッション ID を直接指定する必要がある。

`ai-env --session <id>` は、pi の `--session` フラグへセッション ID をそのまま渡し、
既存セッションを **1 回だけ** 再開できるようにする。

## 用語

用語の定義は [CONTEXT.md](../../CONTEXT.md) の Sessions セクションに従う。

- **Session**: pi の会話の単位。UUID で識別され（部分一致可）、`~/.pi/agent/sessions/` に保存
- **Explicit Session**: CLI の `--session <id>` で直接指定したセッション。1 回だけ再開される
- **Resume**: 既存セッションに接続して pi を起動する操作。経路は `pi -c`（最新セッションの続行）、`/resume`（ピッカー）、`--session`（明示セッション）

## CLI 仕様

### フラグ

```
ai-env --session <id>
```

- 値は pi の `--session` フラグにそのまま渡す
- **部分 ID（プレフィックス一致）を許容する**（pi 側が対応。`SAFE_SHELL_PATTERN` はそれを妨げない）
- セッションが存在しない場合、コンテナ内の pi が "No session found" を報告する（ホスト側の存在チェックはしない）

### 排他ルール

| 組み合わせ | 挙動 |
| --- | --- |
| `--session` + `--new` | **エラー**。`--new` は新規セッションでの起動を指定するため。「`ai-env --session <id>` でセッションを再開できます」と案内 |
| `--session` + `--attach` | **エラー**（`--attach` は pi を起動しないため、セッション指定は無意味） |
| `--session` + `--bash` | **許可**。`PI_SESSION` 環境変数として export（`PI_PROVIDER` 等と同じパターン） |

### バリデーション

- `validateCliOverrides` で `session` を **`SAFE_SHELL_PATTERN`**（英数字・`._-`）で検証
- pi 自身のセッション ID 検証（`[A-Za-z0-9._-]` のみ）と同一文字セット
- ファイルパスは不許可（スラッシュを含むため `SAFE_SHELL_PATTERN` が弾く。pi の `--session` が本来許すパス指定は ai-env では通さない）

### 優先順位

- provider / model / apiKeyEnv は既存どおり **CLI > Project > Profile** で解決
- `--session` はセッションのみを指定する（他の値の優先順位には影響しない）

## 動作仕様

### 起動モードとの関係

| コマンド | 挙動 |
| --- | --- |
| `ai-env` | `pi -c` で前回セッションを続行（なければ新規作成） |
| `ai-env --new` | 新しいセッションで pi 起動 |
| `ai-env --session <id>` | 明示セッションで再開 |
| `ai-env --bash --session <id>` | bash のみ + `PI_SESSION` export |
| `ai-env --attach --session <id>` | エラー（排他） |

### セッション解決（case 解決に `cliSession` を追加）

- **マッチしたプロジェクト**: `provider/model/apiKeyEnv = CLI > Project > Profile`、`session = CLI 指定`
- **未知プロジェクト**（`projects` 未定義）: `provider/model = CLI > Profile`（apiKeyEnv なし）、`session = CLI 指定`
- `--session` 未指定時は `--session` フラグを付けない（`pi -c` または新規起動の挙動に従う）
- コンテナ内 `pi-resume` 関数は projects 設定のまま（**ワンショット上書き**。関数への焼き込みはしない）

### bash モード

- `--session <id>` 指定時のみ `export PI_SESSION="<id>"` を追加
- コンテナ内で `pi --session "$PI_SESSION"` のように参照できる
- CLI 未指定なら export しない（既存の `PI_PROVIDER` / `PI_MODEL` / `PI_API_KEY_ENV` と同じ挙動）

## 実装方針

### index.ts

- `CliOptions` に `session?: string` を追加
- `--session <id>` オプションを定義（`--bash` 同様の値付きフラグ）
- 排他検証は `validateFlagCombination`（index-helpers.ts）を呼び出し、エラーメッセージを stderr に出力して exit 1
- `validateCliOverrides` に `session` を渡す

### pi-validation.ts

- `validateCliOverrides` の引数・戻り値に `session` を含め、`SAFE_SHELL_PATTERN` で検証
- エラー時の fieldName は `session`、key は `--session`

### index-helpers.ts

- `RunContext` に `session: string | undefined` を追加
- `prepareEnvironment` の引数・戻り値に `session` を追加
- `runContainerCommand` で `buildInitScript({ ..., cliSession: ctx.session })` に渡す
- `validateFlagCombination` で `--new` × `--session`、`--attach` × `--bash` / `--new` / `--session` の排他を検証し、違反時はエラーメッセージ文字列、問題なければ undefined を返す

### pi-script.ts

- `buildInitScript` に `cliSession?: string` を追加
- `generateCaseBody` に `cliSession?: string` を追加し、`buildPiFlags` の sessionId を `cliSession` に解決
- 未知プロジェクト（`warnOnUnknown: false`）のフォールバックにも `sessionId: cliSession` を追加
- bash モード: `cliSession` 指定時のみ `export PI_SESSION="<id>"` 行を追加

### テスト

- `pi-validation.test.ts`: `--session` の正常系（部分 ID 含む）・不正文字系（`SAFE_SHELL_PATTERN` 違反・空文字）
- `pi-script.test.ts`:
  - デフォルトモード + `cliSession` で case に `--session <id>` が含まれる（provider/model/apiKeyEnv は CLI > Project > Profile）
  - 未知プロジェクトのフォールバックに `--session <id>` が含まれる
  - `cliSession` なしのデフォルトモードは `--session` を含まず `-c` を含む
  - bash モードで `PI_SESSION` export 行が生成される / `cliSession` なしでは生成されない
- `index.test.ts`: `validateFlagCombination` の単独フラグ許可・`--new` × `--session` 排他・`--attach` × 各モード排他

## 非スコープ

- セッション ID の設定ファイル保存（`--save` 等）は行わない（`pi -c` / `/resume` がセッション再開を担う。過去に試みた保存記録方式は ADR 0004 → 0005 で廃止）
- pi の `--session-id`（正確一致・無ければ作成）の透過はしない。`ai-env --session` は常に pi の `--session`（再開）に渡す
- ホスト側でのセッション存在チェックはしない（pi 任せ。`~/.pi/agent/sessions/` の構造への結合を避ける）

## ドキュメント更新

- README: CLI オプション表の `--session <id>` の説明を更新（`--resume` 廃止、`--new` との排他）
- README の「セッションを引き継ぐ」等の表記を「再開する」に統一（CONTEXT.md の Resume 定義と整合）
