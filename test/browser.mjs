// 実ブラウザ（インストール済みの Edge）で画面を操作して確認する。
// 使い方: node test/browser.mjs <スクショのフォルダ> <期間開始 YYYY-MM-DD> <期間終了> <出力フォルダ>
// 事前に npm run serve でサーバーを起動しておく。外部への通信が1件でもあれば失敗にする。
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const [folder, start, end, outDir] = process.argv.slice(2);
const url = "http://127.0.0.1:8080/";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1000, height: 900 } });

const external = [];
const errors = [];
page.on("request", (req) => { if (!req.url().startsWith(url) && !/^(blob|data):/.test(req.url())) external.push(req.url()); });
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
page.on("pageerror", (err) => errors.push(err.message));

await page.goto(url);
const files = fs.readdirSync(folder).filter((f) => /^IMG_/i.test(f)).map((f) => path.join(folder, f));
await page.setInputFiles("#files", files);
await page.click("#readButton");
await page.waitForSelector("#resultCard:not([hidden])", { timeout: 300_000 });
console.log("読み取り:", await page.textContent("#status"));
console.log("期間なし:", await page.textContent("#total"));
console.log("警告:", (await page.textContent("#warning")) || "なし");

if (start) {
  await page.fill("#periodStart", start);
  await page.dispatchEvent("#periodStart", "change");
  await page.fill("#periodEnd", end);
  await page.dispatchEvent("#periodEnd", "change");
  console.log("期間あり:", await page.textContent("#total"));
}

const rows = await page.$$eval("#resultTable tbody tr", (trs) => trs.map((tr) => [...tr.cells].map((td) => {
  const cb = td.querySelector("input"); return cb ? (cb.checked ? "☑" : "☐") : td.textContent.trim();
}).join(" | ")));
fs.writeFileSync(path.join(outDir, "browser_rows.txt"), rows.join("\n"));

await page.screenshot({ path: path.join(outDir, "browser.png"), fullPage: false });
page.once("dialog", (d) => d.accept());
const [download] = await Promise.all([page.waitForEvent("download"), page.click("#saveButton")]);
const saved = path.join(outDir, download.suggestedFilename());
await download.saveAs(saved);
console.log("保存ファイル名:", download.suggestedFilename());

console.log("外部への通信:", external.length ? external : "0件");
console.log("エラー:", errors.length ? errors : "なし");
await browser.close();
