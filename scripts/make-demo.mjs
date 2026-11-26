// 架空のモバイルSuica履歴スクショ（デモ用PNG）を生成する。
// 使い方: node scripts/make-demo.mjs [出力フォルダ]  デフォルト: demo/
// 事前に npm install が必要（playwright-core・Edge が使える環境で実行）。

import { chromium } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.resolve(process.argv[2] ?? path.join(root, "demo"));
fs.mkdirSync(outDir, { recursive: true });

// ── 架空の利用履歴（新しい順）────────────────────────────────
// 残高は一貫して整合するように設定。8回の電車＋1回チャージ＝交通費 1,712円。
// 11/22 の「渋谷→品川」行が IMG_001・IMG_002 両方に登場 → 重複除去のテストになる。
const ALL_ROWS = [
  { date: "11/25", type: "電車", place: "渋谷　→　品川", amount: -214, balance: 2502 },
  { date: "11/25", type: "電車", place: "品川　→　渋谷", amount: -214, balance: 2716 },
  { date: "11/24", type: "電車", place: "渋谷　→　品川", amount: -214, balance: 2930 },
  { date: "11/24", type: "電車", place: "品川　→　渋谷", amount: -214, balance: 3144 },
  { date: "11/22", type: "電車", place: "渋谷　→　品川", amount: -214, balance: 3358 }, // ← 重複行
  { date: "11/22", type: "電車", place: "品川　→　渋谷", amount: -214, balance: 3572 },
  { date: "11/20", type: "電車", place: "渋谷　→　品川", amount: -214, balance: 3786 },
  { date: "11/20", type: "電車", place: "品川　→　渋谷", amount: -214, balance: 4000 },
  { date: "11/18", type: "チャージ", place: "", amount:  2000, balance: 4214 },
];

// iPhone版スクショ: 行0–4 / 行4–8（行4が重複）
const IPHONE_SHOTS = [
  { name: "IMG_001.png", rows: ALL_ROWS.slice(0, 5) },
  { name: "IMG_002.png", rows: ALL_ROWS.slice(4) },
];

// Android版スクショ: 同じデータ
const ANDROID_SHOTS = [
  { name: "IMG_001_android.png", rows: ALL_ROWS.slice(0, 5) },
  { name: "IMG_002_android.png", rows: ALL_ROWS.slice(4) },
];

// ── HTML テンプレート ──────────────────────────────────────────
// 幅750px固定。列境界（x=185, 373, 562）はborderとして描画し findLayout に検出させる。
// 行高100px: "電車"(48px) の縦幅が row.height×0.4=40px を超え looksTransit=true になる。
// 右列は上半分=残高・下半分=差額 として crop され OCR される。
function makeHtml(rows) {
  const fmtBalance = (n) => n.toLocaleString("en-US");   // "4,214"
  const fmtAmount  = (n) => n < 0
    ? "-" + Math.abs(n).toLocaleString("en-US")           // "-214"
    : Math.abs(n).toLocaleString("en-US");                 // "2,000"（+なし）

  const rowsHtml = rows.map((r) => `
  <div class="row">
    <div class="cell date">${r.date}</div>
    <div class="cell type">${r.type}</div>
    <div class="cell place">${r.place}</div>
    <div class="cell value">
      <div class="balance">${fmtBalance(r.balance)}</div>
      <div class="amount">${fmtAmount(r.amount)}</div>
    </div>
  </div>`).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#fff; }
.screen {
  width: 750px;
  font-family: "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif;
  color: #111;
}
/* ヘッダー: 緑背景（g>100 && g>r*1.2 && g>b*1.2 を満たす） */
.header {
  display: grid;
  grid-template-columns: 186px 188px 189px 187px;
  background: rgb(0, 160, 80);
  color: #fff;
  height: 50px;
  border-bottom: 2px solid #888;
}
/* 行: border-bottom 2px #888 → 灰色(136<210)が幅全体に並ぶ → findRowBoundaries に検出される */
.row {
  display: grid;
  grid-template-columns: 186px 188px 189px 187px;
  height: 100px;
  border-bottom: 2px solid #888;
  background: #fff;
}
.cell {
  display: flex;
  align-items: center;
  /* border-right → 縦線を findLayout に検出させる（x≈185, 373, 562） */
  border-right: 1px solid #888;
  padding: 0 6px;
}
.cell:last-child { border-right: none; }
.date  { justify-content: center; font-size: 22px; }
/* type は大きく描いて looksTransit の縦幅判定(≥40px)を通す */
.type  { justify-content: center; font-size: 48px; }
.place { font-size: 15px; }
/* value: 上半分=残高・下半分=差額（crop で分割して OCR） */
.value { flex-direction: column; padding: 0; }
.balance, .amount {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-right: 6px;
  font-size: 22px;
}
</style>
</head>
<body>
<div class="screen">
  <div class="header">
    <div class="cell date" style="color:#fff;font-size:14px;">月日</div>
    <div class="cell" style="color:#fff;font-size:14px;">種別</div>
    <div class="cell" style="color:#fff;font-size:14px;">利用場所</div>
    <div class="cell" style="color:#fff;font-size:14px;">差額/残高</div>
  </div>
  ${rowsHtml}
</div>
</body></html>`;
}

// ── Android用 HTML テンプレート ───────────────────────────────
// 行の区切り: 全ピクセルがグレー[190,248]の帯 → findRowBoundariesAndroid に検出される
//   rgb(215,215,215) → gray=(215×16384+8192)>>14=215 ∈ [190,248] ✓
// 縦罫線なし → findLayout は使われず hardcoded 比率で列位置が決まる:
//   date:  0–width*0.07=52px
//   type:  width*0.08–width*0.33=60–247px（looksTransit の判定範囲）
//   value: width*0.76–(width-6)=570–744px
//   balOCR開始: valueLeft+(valueRight-valueLeft)*0.55=570+95=665px（「残高¥」プレフィックスをスキップ）
// 日付テキスト: 薄いグレー(#999, gray=153<200) → コード内で閾値200で二値化して補正される
// 残高表示: 「残高¥X,XXX」形式で右揃え。OCRは65px右側(665px〜)の数値部分だけ読む
function makeAndroidHtml(rows) {
  const fmtBalance = (n) => n.toLocaleString("en-US");
  const fmtAmount  = (n) => n < 0
    ? "-" + Math.abs(n).toLocaleString("en-US")
    : Math.abs(n).toLocaleString("en-US");

  // ヘッダー＋行をsepで区切る構造
  // ・最初のsep = headerEnd（ヘッダー末尾）
  // ・以降のsep = 行の区切り
  const rowsHtml = rows.map((r) => `
  <div class="row">
    <div class="cell date">${r.date}</div>
    <div class="cell type">${r.type}</div>
    <div class="cell place">${r.place}</div>
    <div class="cell value">
      <div class="balance">残高¥${fmtBalance(r.balance)}</div>
      <div class="amount">${fmtAmount(r.amount)}</div>
    </div>
  </div>
  <div class="sep"></div>`).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#fff; }
.screen { width:750px; font-family:"Hiragino Sans","Yu Gothic UI","Meiryo",sans-serif; }
/* ヘッダー領域（コードは内容を使わない） */
.app-header {
  height: 50px; background: #fff;
  display: flex; align-items: center; padding-left: 16px;
  font-size: 18px; color: #333; border-bottom: none;
}
/* 区切り帯: 全px が gray∈[190,248] → findRowBoundariesAndroid に検出される */
.sep { height: 4px; background: rgb(215,215,215); width: 750px; }
/* 行: 白背景・縦罫線なし */
.row {
  display: grid;
  grid-template-columns: 62px 188px 320px 180px;
  height: 100px;
  background: #fff;
}
.cell { display:flex; align-items:center; padding:0 6px; }
/* 日付: 薄グレー → コードが閾値200で二値化して補正 */
.date  { justify-content:center; font-size:20px; color:#999; }
/* type: 48px で縦幅≥40px(=100×0.4) を確保 → looksTransit=true */
.type  { justify-content:center; font-size:48px; color:#111; }
.place { font-size:14px; color:#333; }
/* value: 上半分=残高(「残高¥」+数字)・下半分=差額 */
.value { flex-direction:column; padding:0; }
.balance, .amount {
  flex:1; display:flex; align-items:center;
  justify-content:flex-end; padding-right:6px; font-size:19px; color:#111;
}
</style>
</head>
<body>
<div class="screen">
  <div class="app-header">ご利用履歴</div>
  <div class="sep"></div>
  ${rowsHtml}
</div>
</body></html>`;
}

// ── Playwright でスクリーンショット撮影 ───────────────────────
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 750, height: 800 } });

console.log("── iPhone 形式 ──");
for (const { name, rows } of IPHONE_SHOTS) {
  await page.setContent(makeHtml(rows), { waitUntil: "networkidle" });
  const h = await page.evaluate(() => document.querySelector(".screen").offsetHeight);
  await page.setViewportSize({ width: 750, height: h });
  const out = path.join(outDir, name);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 750, height: h } });
  console.log(`✓ ${name}  (${rows.length}行, ${h}px)`);
}

console.log("── Android 形式 ──");
for (const { name, rows } of ANDROID_SHOTS) {
  await page.setContent(makeAndroidHtml(rows), { waitUntil: "networkidle" });
  const h = await page.evaluate(() => document.querySelector(".screen").offsetHeight);
  await page.setViewportSize({ width: 750, height: h });
  const out = path.join(outDir, name);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 750, height: h } });
  console.log(`✓ ${name}  (${rows.length}行, ${h}px)`);
}

await browser.close();
console.log(`\nデモ画像を ${outDir} に保存しました。`);
console.log("iPhone:  IMG_001.png + IMG_002.png");
console.log("Android: IMG_001_android.png + IMG_002_android.png");
console.log("各ペアを sample-apps-515906.web.app で読み込むと合計1,712円・9行になれば成功。");
