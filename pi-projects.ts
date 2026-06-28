// pi-projects.ts
// pi セッション再開用の設定(JSON)を読み込み、コンテナ用 pi-resume シェル関数と
// 初期化スクリプトを生成する責務を集約したモジュール。
// v2: profiles(OCR 全体設定)+ projects(pi セッション)の二層構造に拡張。
//
// 内部実装は責務ごとに以下のモジュールへ分割:
//   pi-types.ts      - 型定義とバリデーション用定数
//   pi-validation.ts - バリデーション関数と CLI オプション検証
//   pi-config.ts     - 設定ファイル読み込み・パース
//   pi-script.ts     - シェルスクリプト生成

export { type AiEnvConfig, type ProfileConfig, type ProjectConfig } from "./pi-types";
export { buildInitScript } from "./pi-script";
export { loadAiEnvConfig } from "./pi-config";
export { validateCliOverrides } from "./pi-validation";
