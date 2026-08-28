# Profileをクレデンシャルのセキュリティ境界にする

ai-envは、これまで`CREDENTIAL_SOURCES`に登録されたクレデンシャルを全Profileのサンドボックスへ注入していた。今後は各Profileに必須の`credentialKeys`を持たせ、許可されたキーだけをKeychainから取得してコンテナへ渡す。未指定時に旧来の全体注入へフォールバックすると、`pi-private`と`pi-work`を分離する意図がCLI上書きで迂回できるため、設定不備は起動エラーとして扱う。

この判断により既存の`pi-projects.json`は移行が必要になるが、個人用APIキーを仕事用サンドボックスへ誤って公開するリスクを優先して受け入れる。`apiKeyEnv`は利用するキーの選択であり、`credentialKeys`が実際のアクセス許可を決める。CLIの`--api-key-env`も許可リストを迂回できない。
