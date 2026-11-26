// 画面の制御。処理の中身は core.js（Node のテストと共通）
import { processScreenshots, buildResult, parseStatement, buildStatementResult, inPeriod, parseIsoDate, parseDate, rowKind, vstack, KIND, WHITELIST } from "./core.js";
import { readStatementPdf } from "./statement.js";

const $ = (id) => document.getElementById(id);

// ── アクセス合言葉ロック ──────────────────────────────────────
// パスワード本文はソースに入れない。SHA-256ハッシュのみ保持。
const PW_HASH = "487321421700b2665bdef037221c0c78e80f3d8269e77f454a4e237c4b7fcd6b";

async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function tryUnlock() {
  const val = $("lockInput").value;
  if ((await sha256hex(val)) === PW_HASH) {
    $("lockScreen").remove();
    $("mainContent").removeAttribute("hidden");
  } else {
    $("lockError").removeAttribute("hidden");
    $("lockInput").value = "";
    $("lockInput").focus();
  }
}

$("lockButton").addEventListener("click", tryUnlock);
$("lockInput").addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
// ─────────────────────────────────────────────────────────────
// mode: "image"（スクショを読み取る）／ "pdf"（明細PDFの文字を解析する）
const state = { mode: "image", files: [], images: [], pages: [], order: [], header: null, rows: [], gaps: [], ocr: null };

/** pdf.js は PDF を選んだときだけ読み込む（自前のファイルから） */
async function loadPdfjs() {
  const pdfjs = await import("./vendor/pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("vendor/pdfjs/pdf.worker.min.mjs", location.href).href;
  return pdfjs;
}

/** 判定の数値はこの横幅で調整しているので、どの機種のスクショもこの幅にそろえる */
const BASE_WIDTH = 750;

// ---------- 画像の読み込み ----------

async function decodeFile(file) {
  // 色空間の変換をさせず、スクショの画素値をそのまま使う（判定の閾値がずれないように）
  const bitmap = await createImageBitmap(file, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const canvas = document.createElement("canvas");
  canvas.width = BASE_WIDTH;
  canvas.height = Math.round((bitmap.height * BASE_WIDTH) / bitmap.width);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data };
}

function toCanvas(img) {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext("2d").putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return canvas;
}

function grayToCanvas({ width, height, gray }) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gray.length; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = gray[i];
    rgba[i * 4 + 3] = 255;
  }
  return toCanvas({ width, height, data: rgba });
}

// ---------- 読み取り（Tesseract.js、すべて自前のファイルから読み込む） ----------

async function getOcr() {
  if (state.ocr) return state.ocr;
  const base = new URL("vendor/", location.href).href;
  const perField = (navigator.hardwareConcurrency || 4) >= 8 ? 2 : 1;
  const schedulers = {};
  for (const [field, whitelist] of Object.entries(WHITELIST)) {
    const scheduler = Tesseract.createScheduler();
    for (let i = 0; i < perField; i++) {
      const worker = await Tesseract.createWorker("eng", 1, {
        workerPath: base + "worker.min.js",
        corePath: base + "core",
        langPath: base + "lang",
        gzip: true,
        workerBlobURL: false,
        cacheMethod: "none",
      });
      await worker.setParameters({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: whitelist });
      scheduler.addWorker(worker);
    }
    schedulers[field] = scheduler;
  }
  state.ocr = async (prepared, field) => {
    const result = await schedulers[field].addJob("recognize", grayToCanvas(prepared));
    return result.data.text.trim();
  };
  return state.ocr;
}

// ---------- ファイル選択 ----------

const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const isImage = (f) => /^image\/(png|jpeg)$/.test(f.type);

function setFiles(fileList) {
  const key = (f) => `${f.name}\u0000${f.size}\u0000${f.lastModified}`;
  const seen = new Set(state.files.map(key));
  const added = [...fileList].filter((f) => (isPdf(f) || isImage(f)) && !seen.has(key(f)));
  const all = [...state.files, ...added];
  const pdfs = all.filter(isPdf);
  if (pdfs.length && pdfs.length !== all.length) {
    $("status").textContent = "明細のPDFとスクショは一緒に選べません。どちらか一方を選んでください。";
    return;
  }
  state.mode = pdfs.length ? "pdf" : "image";
  state.files = all.sort((a, b) => a.name.localeCompare(b.name, "ja", { numeric: true }));
  $("fileList").innerHTML = "";
  for (const f of state.files) {
    const li = document.createElement("li");
    li.textContent = f.name;
    $("fileList").append(li);
  }
  $("readButton").disabled = state.files.length === 0;
  $("status").textContent = !state.files.length ? ""
    : state.mode === "pdf" ? `明細のPDFを ${state.files.length} 件選びました。`
    : `${state.files.length} 枚を選びました。並び順は読み取った内容から自動で決めます。`;
}

$("files").addEventListener("change", (e) => { setFiles(e.target.files); e.target.value = ""; });
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  setFiles(e.dataTransfer.files);
});

// ---------- 期間 ----------

const period = () => [parseIsoDate($("periodStart").value), parseIsoDate($("periodEnd").value)];

function onPeriodChange() {
  let [start, end] = period();
  if (start && end && start.y * 10000 + start.m * 100 + start.d > end.y * 10000 + end.m * 100 + end.d) {
    [$("periodStart").value, $("periodEnd").value] = [$("periodEnd").value, $("periodStart").value];
  }
  applyDefaultChecks();
}
$("periodStart").addEventListener("change", onPeriodChange);
$("periodEnd").addEventListener("change", onPeriodChange);
$("clearPeriod").addEventListener("click", () => {
  $("periodStart").value = $("periodEnd").value = "";
  applyDefaultChecks();
});

/** ファイル名・画像用の期間（MMDD）。未選択の側は ☑ の行の日付で補う */
function periodMMDD() {
  const [start, end] = period();
  const dates = state.rows.filter((r) => r.checked && r.date).map((r) => r.date);
  const mmdd = (md) => md.split("/").map((x) => x.padStart(2, "0")).join("");
  const pad = (n) => String(n).padStart(2, "0");
  return [
    start ? pad(start.m) + pad(start.d) : dates.length ? mmdd(dates[dates.length - 1]) : "",
    end ? pad(end.m) + pad(end.d) : dates.length ? mmdd(dates[0]) : "",
  ];
}

// ---------- 読み取りの実行 ----------

$("readButton").addEventListener("click", async () => {
  const button = $("readButton");
  button.disabled = true;
  $("resultCard").hidden = true;
  $("progress").hidden = false;
  $("progressBar").style.width = "0";
  try {
    if (state.mode === "pdf") {
      await readStatements();
      return;
    }
    $("status").textContent = "読み取りの準備をしています…（初回は数秒かかります）";
    const ocr = await getOcr();
    $("status").textContent = "画像を読み込んでいます…";
    const images = await Promise.all(state.files.map(decodeFile));
    const started = performance.now();
    const { pages, order, header, rows, gaps } = await processScreenshots(images, ocr, (message) => {
      $("status").textContent = message;
      const m = /(\d+)\/(\d+)/.exec(message);
      if (m) $("progressBar").style.width = `${(100 * m[1]) / m[2]}%`;
    });
    Object.assign(state, { images, pages, order, header, rows, gaps });
    $("orderSection").hidden = false;
    renderOrder();
    applyDefaultChecks();
    $("resultCard").hidden = false;
    $("status").textContent = `読み取り完了（${((performance.now() - started) / 1000).toFixed(1)}秒）。一覧を確認して保存してください。`;
  } catch (error) {
    console.error(error);
    $("status").textContent = `エラー: ${error.message}`;
  } finally {
    $("progress").hidden = true;
    button.disabled = false;
  }
});

/** 明細PDFは文字をそのまま解析する（読み取りは使わないので誤読がない） */
async function readStatements() {
  $("status").textContent = "明細を読み込んでいます…";
  const started = performance.now();
  const pdfjs = await loadPdfjs();
  const statements = [];
  for (const file of state.files) {
    const pages = await readStatementPdf(pdfjs, new Uint8Array(await file.arrayBuffer()));
    const items = parseStatement(pages);
    if (!items.some((it) => it.date)) throw new Error(`${file.name} から明細の行が見つかりませんでした。モバイルSuicaの「残高ご利用明細」のPDFか確認してください。`);
    statements.push(items);
  }
  const { header, rows, gaps } = buildStatementResult(statements);
  Object.assign(state, { images: [], pages: [], order: [], header, rows, gaps });
  $("orderSection").hidden = true;
  applyDefaultChecks();
  $("resultCard").hidden = false;
  $("status").textContent = `明細を読み込みました（${rows.length} 行、${((performance.now() - started) / 1000).toFixed(1)}秒）。一覧を確認して保存してください。`;
}

// ---------- 並び順 ----------

function thumbnail(img) {
  const canvas = toCanvas(img);
  const thumb = document.createElement("canvas");
  thumb.width = 90;
  thumb.height = Math.round((img.height * 90) / img.width);
  thumb.getContext("2d").drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return thumb;
}

function renderOrder() {
  const list = $("orderList");
  list.innerHTML = "";
  state.order.forEach((index, position) => {
    const li = document.createElement("li");
    li.append(thumbnail(state.images[index]));
    const label = document.createElement("span");
    label.textContent = `${position + 1}. ${state.files[index].name}`;
    const buttons = document.createElement("div");
    for (const [text, delta, name] of [["◀", -1, "前へ"], ["▶", 1, "後ろへ"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ghost";
      b.textContent = text;
      b.setAttribute("aria-label", `${state.files[index].name} を${name}`);
      b.disabled = position + delta < 0 || position + delta >= state.order.length;
      b.addEventListener("click", () => moveImage(position, delta));
      buttons.append(b);
    }
    li.append(label, buttons);
    list.append(li);
  });
}

/** 並び順を手で入れ替えたら、読み取りはやり直さずに組み直す */
function moveImage(position, delta) {
  const order = [...state.order];
  [order[position], order[position + delta]] = [order[position + delta], order[position]];
  state.order = order;
  Object.assign(state, buildResult(state.pages, order));
  renderOrder();
  applyDefaultChecks();
}

// ---------- 一覧 ----------

function applyDefaultChecks() {
  const [start, end] = period();
  for (const row of state.rows) row.checked = row.kind === KIND.TRANSIT && row.amount !== 0 && inPeriod(row.date, start, end);
  render();
}

const yen = (v) => (v === null || v === undefined ? "?" : v.toLocaleString("ja-JP"));

function render() {
  const tbody = $("resultTable").querySelector("tbody");
  tbody.innerHTML = "";
  const [start, end] = period();
  const gapByRow = new Map(state.gaps.map((g) => [g.newer, g]));

  state.rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.className = row.kind === KIND.UNREAD ? "unread" : row.checked ? "" : "off";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = row.checked;
    check.disabled = row.amount === null;
    check.setAttribute("aria-label", "合計に含める");
    check.addEventListener("change", () => { row.checked = check.checked; render(); });

    const notes = [...row.notes];
    if (row.date && !inPeriod(row.date, start, end)) notes.unshift("期間外");
    const kindText = row.kindLabel && row.kindLabel !== row.kind ? `${row.kind}（${row.kindLabel}）` : row.kind;
    const cells = [check, row.date ?? "?", kindText, row.place ?? "", yen(row.amount), yen(row.balance), notes.join(" / ")];
    cells.forEach((value, i) => {
      const td = document.createElement("td");
      if (i === 4 || i === 5) td.className = "num";
      if (i === 3) td.className = "place";
      if (i === 6) td.className = "note";
      td.append(value);
      // PDF の明細は値が正確なので「修正」は出さない
      if (i === 6 && state.mode !== "pdf") {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "link";
        edit.textContent = "修正";
        edit.addEventListener("click", () => editRow(row));
        td.append(notes.length ? " " : "", edit);
      }
      tr.append(td);
    });
    tbody.append(tr);

    const gap = gapByRow.get(row);
    if (gap) {
      const reason = gap.notice ? "ICカード側で「一部が表示できません」" : "スクショの撮り漏れか、表示されていない取引";
      const gtr = document.createElement("tr");
      gtr.className = "gap";
      gtr.innerHTML = `<td>⚠</td><td></td><td>残高不一致</td><td></td><td class="num">${yen(gap.amount)}</td><td></td>`;
      const td = document.createElement("td");
      td.className = "note";
      td.textContent = `ここに見えていない取引があります（差し引き ${yen(gap.amount)}円）: ${reason}`;
      gtr.append(td);
      tbody.append(gtr);
    }
  });
  updateTotal();
}

function updateTotal() {
  // 内容が変わったら、前に作った画像の「写真に保存」は使わせない
  $("shareButton").hidden = true;
  const checked = state.rows.filter((r) => r.checked);
  const total = checked.reduce((sum, r) => sum + (r.amount !== null && r.amount < 0 ? -r.amount : 0), 0);
  $("total").textContent = `合計交通費: ${total.toLocaleString("ja-JP")}円（${checked.length}件）`;
  const warnings = [];
  const unread = state.rows.filter((r) => r.kind === KIND.UNREAD).length;
  if (unread) warnings.push(`読めない行が ${unread} 件あります（合計に入っていません。「修正」で入力できます）`);
  if (state.gaps.length) warnings.push(`残高が合わない箇所が ${state.gaps.length} か所あります（黄色の行）`);
  $("warning").textContent = warnings.length ? "⚠ " + warnings.join("　") : "";
  return total;
}

function editRow(row) {
  const date = prompt("日付（例: 8/17）", row.date ?? "");
  if (date === null) return;
  const parsedDate = parseDate(date);
  if (!parsedDate) { alert("日付は「8/17」の形で入力してください。"); return; }
  const amount = prompt("利用額（円）。チャージはマイナスで入力", row.amount === null ? "" : String(Math.abs(row.amount)));
  if (amount === null) return;
  const value = Number(amount.replace(/[,\s円]/g, ""));
  if (!Number.isInteger(value)) { alert("金額は数字で入力してください。"); return; }
  row.date = parsedDate;
  row.amount = -value;
  row.looksTransit = true;
  delete row.fixedKind;
  row.kind = rowKind(row);
  if (!row.notes.includes("手入力")) row.notes.push("手入力");
  render();
}

// ---------- 保存 ----------

const FONT = `"Hiragino Sans", "Yu Gothic UI", Meiryo, sans-serif`;

/** スクショ：☑ の行の画像を縦に並べ、上に合計を書く */
function renderScreenshotImage(checked, total, periodText) {
  const body = vstack([state.header, ...checked.map((r) => r.image)]);
  const band = 90;
  const canvas = document.createElement("canvas");
  canvas.width = body.width;
  canvas.height = body.height + band;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(235,248,235)";
  ctx.fillRect(0, 0, canvas.width, band);
  ctx.putImageData(new ImageData(body.data, body.width, body.height), 0, band);
  ctx.fillStyle = "rgb(20,80,20)";
  ctx.font = `36px ${FONT}`;
  ctx.textBaseline = "top";
  ctx.fillText(`合計交通費: ${total.toLocaleString("ja-JP")}円${periodText}`, 20, 24);
  return canvas;
}

/** 明細PDF：☑ の行だけの一覧表と合計を描く（元のPDFは別に添付してもらう前提） */
function renderStatementTable(checked, total, periodText) {
  const width = 750, pad = 32, rowH = 40, headH = 44, titleH = 120, footH = 110;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = titleH + headH + rowH * checked.length + footH;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "middle";

  // 上部：合計と期間
  ctx.fillStyle = "rgb(235,248,235)";
  ctx.fillRect(0, 0, width, titleH);
  ctx.fillStyle = "rgb(20,80,20)";
  ctx.font = `bold 34px ${FONT}`;
  ctx.fillText(`合計交通費: ${total.toLocaleString("ja-JP")}円`, pad, 46);
  ctx.font = `20px ${FONT}`;
  ctx.fillText(`${periodText.replace(/[（）]/g, "") || "全期間"}　${checked.length}件`, pad, 90);

  // 表
  const cols = [
    { title: "日付", x: pad, align: "left" },
    { title: "種類", x: pad + 90, align: "left" },
    { title: "利用場所", x: pad + 190, align: "left" },
    { title: "金額", x: width - pad, align: "right" },
  ];
  let y = titleH;
  ctx.fillStyle = "#f1f4f2";
  ctx.fillRect(0, y, width, headH);
  ctx.fillStyle = "#5f6b64";
  ctx.font = `bold 18px ${FONT}`;
  for (const c of cols) { ctx.textAlign = c.align; ctx.fillText(c.title, c.x, y + headH / 2); }
  y += headH;

  ctx.font = `20px ${FONT}`;
  ctx.strokeStyle = "#dfe5e1";
  for (const row of checked) {
    const values = [row.date, row.kindLabel || row.kind, row.place || "", `${(-row.amount).toLocaleString("ja-JP")}円`];
    ctx.fillStyle = "#1d2420";
    values.forEach((v, i) => {
      ctx.textAlign = cols[i].align;
      const maxWidth = i === 2 ? width - pad - 120 - cols[2].x : undefined;
      ctx.fillText(v, cols[i].x, y + rowH / 2, maxWidth);
    });
    ctx.beginPath(); ctx.moveTo(pad, y + rowH); ctx.lineTo(width - pad, y + rowH); ctx.stroke();
    y += rowH;
  }

  // 合計と出典
  ctx.fillStyle = "#1d2420";
  ctx.textAlign = "right";
  ctx.font = `bold 22px ${FONT}`;
  ctx.fillText(`合計 ${total.toLocaleString("ja-JP")}円`, width - pad, y + 34);
  ctx.textAlign = "left";
  ctx.fillStyle = "#5f6b64";
  ctx.font = `15px ${FONT}`;
  ctx.fillText("出典：モバイルSuica 残高ご利用明細（PDF）から作成。原本のPDFを添付してください。", pad, y + 80);
  return canvas;
}

/** iPhone・iPad（iPadOS は Mac を名乗るのでタッチ対応で見分ける）で、画像の共有ができるか */
function prefersShare(file) {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return ios && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
}

/** 共有メニューを開く。開けたら true、利用者が閉じただけでも true（保存しないことを選んだため） */
async function shareFile(file) {
  try {
    await navigator.share({ files: [file] });
    $("status").textContent = `共有メニューで「画像を保存」を選ぶと写真アプリに入ります（${file.name}）`;
    return true;
  } catch (error) {
    if (error.name === "AbortError") return true;
    return false;
  }
}

$("saveButton").addEventListener("click", async () => {
  const checked = state.rows.filter((r) => r.checked);
  if (!checked.length) { alert("☑ の行がありません。"); return; }
  if ((state.gaps.length || state.rows.some((r) => r.kind === KIND.UNREAD))
      && !confirm("残高が合わない箇所か、読めない行が残っています。このまま保存しますか？")) return;

  const total = updateTotal();
  const [s, e] = periodMMDD();
  const fmt = (mmdd) => (mmdd ? `${Number(mmdd.slice(0, 2))}/${Number(mmdd.slice(2))}` : "");
  const periodText = s || e ? `（${fmt(s)}〜${fmt(e)}）` : "";
  const canvas = state.mode === "pdf"
    ? renderStatementTable(checked, total, periodText)
    : renderScreenshotImage(checked, total, periodText);

  const name = `明細履歴_${[s, e].filter(Boolean).join("_")}.png`;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));

  // iPhone・iPad はダウンロードだと「ファイル」アプリに入って見失いやすいので、
  // 共有メニュー（「画像を保存」で写真アプリへ）を使う
  const file = new File([blob], name, { type: "image/png" });
  if (prefersShare(file)) {
    if (await shareFile(file)) return;
    // ボタンを押してから時間が空くと Safari が共有を許さないので、もう一度押してもらう
    const button = $("shareButton");
    button.hidden = false;
    button.onclick = async () => { if (await shareFile(file)) button.hidden = true; };
    $("status").textContent = "「📤 写真に保存」を押してください。";
    return;
  }

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  $("status").textContent = `保存しました: ${name}`;
});
