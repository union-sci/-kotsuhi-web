// Python 版（BUS/app_gui.py）の結果と、core.js の結果を照合する。
// 使い方: node test/compare.mjs <スクショのフォルダの親> <baseline.json>
// ※ 実スクショ・baseline.json は個人の利用履歴なので、このリポジトリには入れない。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { createWorker, createScheduler } from "tesseract.js";
import { processScreenshots, WHITELIST } from "../public/core.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [dataDir, baselinePath, ...only] = process.argv.slice(2);
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

// 模擬：左右に白い余白を足して列の位置をずらす（PAD_LEFT, PAD_RIGHT 環境変数）
function pad(img) {
  const l = Number(process.env.PAD_LEFT || 0), r = Number(process.env.PAD_RIGHT || 0);
  if (!l && !r) return img;
  const w = img.width + l + r, out = new Uint8ClampedArray(w * img.height * 4).fill(255);
  for (let y = 0; y < img.height; y++) out.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), (y * w + l) * 4);
  return { width: w, height: img.height, data: out };
}

function decode(file) {
  return pad(decodeRaw(file));
}

function decodeRaw(file) {
  const buf = fs.readFileSync(file);
  if (/\.png$/i.test(file)) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
  }
  const jpg = jpeg.decode(buf, { useTArray: true });
  return { width: jpg.width, height: jpg.height, data: new Uint8ClampedArray(jpg.data) };
}

function grayToPng({ width, height, gray }) {
  const png = new PNG({ width, height });
  for (let i = 0; i < gray.length; i++) {
    png.data[i * 4] = png.data[i * 4 + 1] = png.data[i * 4 + 2] = gray[i];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function makeOcr(workersPerField = 2) {
  const schedulers = {};
  for (const [field, whitelist] of Object.entries(WHITELIST)) {
    const scheduler = createScheduler();
    for (let i = 0; i < workersPerField; i++) {
      const worker = await createWorker("eng", 1, {
        langPath: path.join(root, "node_modules/@tesseract.js-data/eng/4.0.0_best_int"),
        cacheMethod: "none",
        gzip: true,
      });
      await worker.setParameters({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: whitelist });
      scheduler.addWorker(worker);
    }
    schedulers[field] = scheduler;
  }
  const ocr = async (prepared, field) => (await schedulers[field].addJob("recognize", grayToPng(prepared))).data.text.trim();
  ocr.terminate = () => Promise.all(Object.values(schedulers).map((s) => s.terminate()));
  return ocr;
}

const show = (r) => `${r.date ?? "?"} ${r.kind} ${r.amount ?? "?"} ${r.balance ?? "?"}`;

const ocr = await makeOcr();
let allOk = true;
for (const folder of Object.keys(baseline)) {
  if (only.length && !only.includes(folder)) continue;
  const files = fs.readdirSync(path.join(dataDir, folder)).filter((f) => /^IMG_/i.test(f)).sort();
  // わざと順番を崩して渡し、中身から正しい順に並べ直せるかも確かめる
  const perm = process.env.ORDER || 'mix';
  const ids = files.map((_, i) => i);
  const shuffled = perm === 'reverse' ? ids.reverse() : perm === 'rotate' ? ids.map((i) => (i + 2) % files.length) : ids.sort((x, y) => ((x * 7 + 3) % files.length) - ((y * 7 + 3) % files.length));
  const shuffledImages = shuffled.map((i) => decode(path.join(dataDir, folder, files[i])));
  const started = Date.now();
  const { header, rows, gaps, order } = await processScreenshots(shuffledImages, ocr);
  const restored = order.map((k) => shuffled[k]);
  const orderOk = restored.every((v, i) => v === i);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const expected = baseline[folder];

  const diffs = [];
  if (!orderOk) diffs.push(`  並び順: 渡した順 [${shuffled}] → 並べ直し [${restored}]（正解は 0,1,2,…）`);
  if (header.height !== expected.header_h) diffs.push(`見出しの高さ ${header.height} ≠ ${expected.header_h}`);
  const len = Math.max(rows.length, expected.rows.length);
  for (let i = 0; i < len; i++) {
    const a = rows[i], e = expected.rows[i];
    const same = a && e && a.date === e.date && a.kind === e.kind && a.amount === e.amount && a.balance === e.balance && a.image.height === e.h;
    if (!same) diffs.push(`  行${i}: JS[${a ? show(a) + " h=" + a.image.height : "なし"}]  Py[${e ? show(e) + " h=" + e.h : "なし"}]`);
  }
  const gj = gaps.map((g) => `${g.newer.balance}:${g.amount}:${g.notice}`).join(",");
  const gp = expected.gaps.map((g) => `${g.after_balance}:${g.amount}:${g.notice}`).join(",");
  if (gj !== gp) diffs.push(`  残高不一致 JS[${gj}] Py[${gp}]`);

  console.log(`===== ${folder}: ${rows.length}行 (Python ${expected.rows.length}行)  ${seconds}秒  ${diffs.length ? "差分あり" : "一致"}`);
  diffs.forEach((d) => console.log(d));
  if (diffs.length) allOk = false;
}
await ocr.terminate();
console.log(allOk ? "\n全件一致" : "\n差分あり");
process.exit(allOk ? 0 : 1);
