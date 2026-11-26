# 交通費スクショ精算（WEB版）

モバイル交通系ICの利用履歴のスクショを結合し、交通費の合計を出すWEBアプリ。
BUS（`Work/BUS/app_gui.py`）のブラウザ移植版。

- 画像はブラウザ内だけで処理し、外部に送信しない（CSPで自分自身以外への通信を禁止）
- 読み取りは Tesseract.js。本体・学習データとも `public/vendor/` に置いて自前で配る（CDN不使用）
- LLM・有料APIは使わない

## 構成

| パス | 内容 |
|---|---|
| `public/core.js` | 結合・行の検出・読み取り・重複除去・残高の検算（DOMに依存しない。Nodeのテストと共通） |
| `public/app.js` | 画面の制御（ファイル選択・期間・一覧・保存） |
| `public/index.html`, `style.css` | 画面 |
| `public/statement.js` | 明細PDFのテキスト抽出（pdf.js を使用） |
| `public/vendor/` | Tesseract.js 一式（`npm run vendor` で生成。Git管理外） |
| `public/vendor/pdfjs/` | pdf.js 一式（`npm run vendor` で生成。Git管理外） |
| `test/compare.mjs` | Python版の結果（baseline.json）と1行ずつ照合 |
| `test/browser.mjs` | インストール済みのEdgeで画面を操作し、外部通信が0件かも確認 |
| `test/statement.mjs` | 明細PDFの解析結果を確認し、スクショ照合結果との一致も検証 |

## 使い方

```
cd kotsuhi-web
npm install             # 初回のみ
npm run vendor          # 初回のみ。Tesseract.js 一式を public/vendor にコピー
npm run serve           # http://127.0.0.1:8080/ を開く。終了は Ctrl + C
```

## 照合テスト

```
node test/compare.mjs <BUSのフォルダ> <baseline.json>
node test/browser.mjs <スクショのフォルダ> [開始 YYYY-MM-DD] [終了] <出力フォルダ>   # 要 npm run serve
```

**実スクショ・baseline.json は個人の利用履歴なので、このフォルダ・リポジトリには絶対に入れない。**
デモ用には架空の履歴画像を別に用意する。

`compare.mjs` は環境変数で模擬もできる：`ORDER=reverse|rotate`（渡す順を崩す）、`PAD_LEFT=60 PAD_RIGHT=0`（左右に余白を足して列の位置をずらす）。

## 現状

- 4か月分の実スクショで、Python版と全行一致（行・種類・差額・残高・残高不一致の箇所）
- 並び順はファイル名に頼らず、1枚ずつ読み取った「日付＋残高が同じ行」から決める（手で ◀▶ 直しも可）
- 列の位置は縦の罫線から割り出す（見つからなければ750px画面の決め打ち）。列を左右に最大100pxずらしても一致
- 確認済みの環境：PC（Edge）・Android（DIGNO）・iPhone（Safari、保存は共有メニュー→写真）
- **明細PDFに対応（推奨の入力）**：モバイルSuica会員メニューの「残高ご利用明細」を印刷→PDF保存したもの。文字入りPDFなのでOCR不要・誤読なし・機種に依存しない。pdf.js（`public/vendor/pdfjs/`、自前配信）で文字を取り出し、`core.js` の `parseStatement` で解析。保存は☑の行だけの一覧表＋合計の画像（原本PDFは別添の前提）。テストは `node test/statement.mjs <PDF> [baseline.json]`
- スクショの読み取り結果は、正式な明細PDFと全件一致した（10-11 は39行すべて、9-10 は明細期間内の23行すべて）
- ダークモード：iPhoneでもモバイルSuicaの履歴画面は白背景のまま変わらない（2026-11-25 実機で確認）ので対応不要
- Android版モバイルSuicaの画面：拾い画像で動作確認済み（実機スクショでの照合は未実施）
