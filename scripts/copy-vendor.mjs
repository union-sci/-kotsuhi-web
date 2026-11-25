// node_modules から、ブラウザで使う Tesseract.js 一式を public/vendor にコピーする。
// 外部の配信サイト（CDN）に頼らず、すべて自前で配るため。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nm = (...p) => path.join(root, "node_modules", ...p);
const out = (...p) => path.join(root, "public", "vendor", ...p);

const files = [
  [nm("tesseract.js", "dist", "tesseract.min.js"), out("tesseract.min.js")],
  [nm("tesseract.js", "dist", "worker.min.js"), out("worker.min.js")],
  // OEM 1（LSTM のみ）で使う core。SIMD 対応ブラウザは simd 版が選ばれる
  [nm("tesseract.js-core", "tesseract-core-lstm.wasm.js"), out("core", "tesseract-core-lstm.wasm.js")],
  [nm("tesseract.js-core", "tesseract-core-simd-lstm.wasm.js"), out("core", "tesseract-core-simd-lstm.wasm.js")],
  [nm("@tesseract.js-data", "eng", "4.0.0_best_int", "eng.traineddata.gz"), out("lang", "eng.traineddata.gz")],
  // 明細PDFの文字の取り出し（pdf.js）
  [nm("pdfjs-dist", "build", "pdf.min.mjs"), out("pdfjs", "pdf.min.mjs")],
  [nm("pdfjs-dist", "build", "pdf.worker.min.mjs"), out("pdfjs", "pdf.worker.min.mjs")],
];

for (const [from, to] of files) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`${path.relative(root, to)}  ${(fs.statSync(to).size / 1024 / 1024).toFixed(1)}MB`);
}
