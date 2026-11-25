// モバイルSuica「残高ご利用明細」PDF から、文字を行単位で取り出す（ブラウザ／Node 共通）。
// pdf.js 本体は呼び出し側から渡す（ブラウザは vendor/pdfjs、Node は pdfjs-dist/legacy）。
import { groupTextLines } from "./core.js";

/**
 * @param pdfjs pdf.js のモジュール
 * @param {Uint8Array} data PDF のバイト列
 * @returns {Promise<Array<Array<{str: string, x: number}>>>} ページごとに上から順の行（行は左から順の文字片）
 */
export async function readStatementPdf(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items = content.items
        .filter((it) => typeof it.str === "string")
        .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));
      pages.push(groupTextLines(items));
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}
