# Discord AI Bot (Python)

## 1. ローカル起動

1. Python 3.11 以降をインストール
2. このフォルダでターミナルを開く
3. 依存ライブラリをインストール

```bash
python -m pip install -r requirements.txt
```

4. `.env.example` を `.env` にコピー
5. `.env` の `DISCORD_TOKEN` と `GEMINI_API_KEY` を設定
6. Discord Developer Portal の Bot 設定で **Message Content Intent** を有効化
7. 起動

```bash
python main.py
```

## 2. Render

- Runtime: Python
- Build Command: `pip install -r requirements.txt`
- Start Command: `python main.py`

Environment Variables に `.env.example` の各値を登録してください。
`DISCORD_TOKEN`、`CLIENT_ID`、`GEMINI_API_KEY` は必須です。

`GUILD_ID` を設定すると、そのサーバー向けにスラッシュコマンドを同期します。
設定しない場合はグローバル同期になります。ギルド同期は反映が速い一方、
指定したサーバー内でのみコマンドが使えます。

## 3. コマンド

- `/set channel:#チャンネル` : AI会話を有効にするチャンネルを指定
- `/unset` : AI会話を無効化
- `/personality prompt:...` : サーバー固有の追加人格設定
- `/reset` : そのサーバーの会話履歴を削除

会話履歴はサーバーごとにSQLiteへ保存し、最新20件を維持します。

## 4. 既存データについて

このPython版は元のJavaScript版と同じ `data/bot.sqlite` のテーブル構成を使います。
既存の `bot.sqlite` を `DATA_DIR` で指定したフォルダへ移せば、互換性のある設定と履歴を引き継げます。

アップロードされた `memory.json` は旧形式のデータで、現在のJavaScript版 `index.js` はSQLiteを使用しているため、
この移植版でも自動読込はしていません。必要なら別途インポートできます。

## 5. 注意

- Discord Developer Portal で Message Content Intent を有効にしてください。
- Render Free のローカルファイルは再デプロイ等で失われる可能性があります。
  SQLiteの永続化が必要なら、Renderの永続ディスク等を利用してください。
- `GEMINI_MODEL` は利用可能なGeminiモデル名に合わせてください。
