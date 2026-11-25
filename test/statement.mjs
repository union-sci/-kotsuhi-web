// 明細PDFの解析を確かめる。スクショの照合結果（baseline.json）とも突き合わせ、OCR の正しさも確かめる。
// 使い方: node test/statement.mjs <明細PDF> [baseline.json]
// ※ PDF・baseline.json は個人の利用履歴なので、このリポジトリには入れない。
import fs from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readStatementPdf } from "../public/statement.js";
import { parseStatement, buildStatementResult, KIND } from "../public/core.js";

const [pdfPath, baselinePath] = process.argv.slice(2);
const pages = await readStatementPdf(pdfjs, new Uint8Array(fs.readFileSync(pdfPath)));
const items = parseStatement(pages);
const { rows, gaps } = buildStatementResult([items]);

const count = (k) => rows.filter((r) => r.kind === k).length;
console.log(`取引 ${rows.length} 行（交通 ${count(KIND.TRANSIT)}・チャージ ${count(KIND.CHARGE)}・その他 ${count(KIND.OTHER)}）`);
console.log(`繰越 ${items.filter((i) => i.carry).length} 行、注意書き ${items.filter((i) => i.notice).length} か所`);
console.log("最新:", JSON.stringify(rows[0], ["date", "kindLabel", "place", "amount", "balance"]));
console.log("最古:", JSON.stringify(rows[rows.length - 1], ["date", "kindLabel", "place", "amount", "balance"]));
console.log("電車の例:", rows.filter((r) => r.kindLabel === "電車").slice(0, 3).map((r) => `${r.date} ${r.place} ${r.amount}`).join(" / "));
console.log("残高不一致:", gaps.length ? gaps.map((g) => `${g.newer.date}の下 差し引き${g.amount} 注意書き=${g.notice}`).join(", ") : "なし");

if (baselinePath) {
  // スクショからの読み取り結果が、正式な明細と一致するか（日付・差額・残高）
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const official = new Set(rows.map((r) => `${r.date}|${r.amount}|${r.balance}`));
  const first = rows[rows.length - 1].date;
  for (const [folder, data] of Object.entries(baseline)) {
    const readable = data.rows.filter((r) => r.date && r.amount !== null && r.balance !== null);
    const covered = readable.filter((r) => official.has(`${r.date}|${r.amount}|${r.balance}`));
    console.log(`  スクショ ${folder}: 読めた ${readable.length} 行中、明細と一致 ${covered.length} 行`
      + (folder === "7-8" || folder === "8-9" ? `（明細は ${first} 以降のみ）` : ""));
  }
}
