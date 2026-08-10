# HERDR_AGENT による Agent Presence の確立

herdr 0.8.0 で pi 統合（`pane.report_agent`）が「Agent Presence（ペインで pi が起動中とサーバーが認識している状態）の確立」を前提とするよう変更され、サンドボックス（Docker 内で pi を実行する構成）ではサイドバーに pi の状態が一切表示されなくなった。0.7.2 まではこのガードがなく正常に動作していた（host の 0.7.2 → 0.8.0 更新で回帰）。原因は、ペインのフォアグラウンドプロセスが `container` CLI であり、herdr の Agent Presence 検出経路（①プロセスバイナリ名 ②プロセス環境変数 `HERDR_AGENT=<agent>`）のどちらにも該当しないため、pi の状態報告が全て保留（pending）になり適用されなかったこと。

対策として、ai-env が `container` CLI を起動する際に環境変数 `HERDR_AGENT=pi` を設定し、herdr の公式検出メカニズム（`parse_agent_env_hint`、テスト付き）経由で Agent Presence を確立させる。`--bash` モードでは設定しない（コンテナ内で別のエージェントを動かす自由を維持し、誤検出による競合を避ける）。

意図的に採用・棄却した判断:

- **環境変数ヒント（採用）**: herdr 0.8.0 のソースコードで確認した公式経路。`kern_procargs2`（macOS）/ `/proc/<pid>/environ`（Linux）でフォアグラウンドジョブ全プロセスの environ を検査する。バージョン更新で壊れる可能性はあるが、0.7.2 へのダウングレードより持続的。
- **ホスト herdr の 0.7.2 ダウングレード（棄却）**: 次回アップデートで再発する。0.8.0 の修正（リモートセッション維持、キーボード系修正など）を失う。
- **拡張機能の custom source 化（棄却）**: `herdr-agent-state.ts` は herdr が管理・上書きするファイル。セッション再開などの公式セマンティクスも失う。
- **手動 `HERDR_AGENT=pi ai-env`（応急処置としてのみ）**: 恒久化しない。実機での受け入れ検証には使用する。