// 交通費スクショ精算 — 画像処理・読み取り・検算のコア（ブラウザ／Node 共通、DOM に依存しない）
//
// 画像は { width, height, data: Uint8ClampedArray(RGBA) } で扱う。
// OCR は呼び出し側から ocr(grayImage, field) として渡す（field: "date" | "balance" | "amount"）。

export const KIND = {
  TRANSIT: "交通",
  CHARGE: "チャージ",
  OTHER: "その他",
  UNREAD: "読めません",
};

export const WHITELIST = {
  date: "0123456789/",
  balance: "0123456789,",
  amount: "0123456789,-",
};

// ---------- 画像の基本操作 ----------

export function makeImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function crop(img, y0, y1, x0 = 0, x1 = img.width) {
  y0 = Math.max(0, y0); y1 = Math.min(img.height, y1);
  x0 = Math.max(0, x0); x1 = Math.min(img.width, x1);
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
  const out = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    out.data.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return out;
}

export function vstack(images) {
  const width = images[0].width;
  const height = images.reduce((sum, im) => sum + im.height, 0);
  const out = makeImage(width, height);
  let offset = 0;
  for (const im of images) {
    if (im.width !== width) throw new Error("幅の違う画像は縦に連結できません");
    out.data.set(im.data, offset);
    offset += im.data.length;
  }
  return out;
}

/** OpenCV の cvtColor(BGR2GRAY) と同じ固定小数点の式 */
export function toGray(img) {
  const n = img.width * img.height;
  const g = new Uint8Array(n);
  const d = img.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    g[i] = (d[p] * 4899 + d[p + 1] * 9617 + d[p + 2] * 1868 + 8192) >> 14;
  }
  return g;
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------- 行の検出 ----------

/** 表の横罫線から取引行の境界を検出（iPhone 形式：暗い横線） */
export function findRowBoundaries(img) {
  const g = toGray(img);
  const { width, height } = img;
  const boundaries = [];
  for (let y = 0; y < height; y++) {
    let dark = 0;
    for (let x = 0, i = y * width; x < width; x++, i++) if (g[i] < 210) dark++;
    if (dark > width * 0.75) {
      if (!boundaries.length || y - boundaries[boundaries.length - 1] > 2) boundaries.push(y);
      else boundaries[boundaries.length - 1] = Math.floor((boundaries[boundaries.length - 1] + y) / 2);
    }
  }
  return boundaries;
}

/**
 * Android 版モバイルSuica 形式の行境界を検出（白背景・一様な灰色の区切り帯）
 * 全ピクセルが [190, 248] の行を区切り線とみなす（白=255 でも暗い文字でもない）
 */
export function findRowBoundariesAndroid(img) {
  const g = toGray(img);
  const { width, height } = img;
  const boundaries = [];
  for (let y = 0; y < height; y++) {
    let inRange = 0;
    for (let x = 0, i = y * width; x < width; x++, i++) {
      const v = g[i];
      if (v >= 190 && v <= 248) inRange++;
    }
    if (inRange === width) {
      if (!boundaries.length || y - boundaries[boundaries.length - 1] > 2) boundaries.push(y);
      else boundaries[boundaries.length - 1] = Math.floor((boundaries[boundaries.length - 1] + y) / 2);
    }
  }
  return boundaries;
}

/** 緑色の列見出しがある画面か */
export function hasTableHeader(img, first, second) {
  const y0 = first + 5, y1 = second - 5;
  if (y1 <= y0) return false;
  const d = img.data;
  let green = 0, total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = (y * img.width + x) * 4;
      const r = d[p], gg = d[p + 1], b = d[p + 2];
      if (gg > 100 && gg > r * 1.2 && gg > b * 1.2) green++;
      total++;
    }
  }
  return green / total > 0.05;
}

/** 種別欄の文字の形から、バス利用または入出場の行かを推定 */
export function looksTransit(row, layout = defaultLayout(row.width)) {
  const { width, height } = row;
  let left = layout.typeLeft, right = layout.typeRight;
  if (layout.isAndroid) { left = Math.floor(width * 0.08); right = Math.floor(width * 0.33); }
  const top = 10, bottom = height - 10;
  if (bottom <= top) return false;
  const g = toGray(row);
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      if (g[y * width + x] < 120) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return false;
  const isBus = maxX - minX + 1 >= layout.busMinWidth;
  const isTrain = maxY - minY + 1 >= Math.floor(height * 0.4);
  return isBus || isTrain;
}

/**
 * 列の位置。月日｜種別｜利用場所｜残高・差額 の4列で、
 *   dateRight: 月日欄の右端　typeLeft/typeRight: 種別欄　valueLeft/valueRight: 残高・差額欄
 */
export function defaultLayout(width) {
  // 罫線が見つからないときの決め打ち（横幅750pxのiPhoneの画面に合わせた割合）
  return {
    dateRight: Math.floor(width * 0.24),
    typeLeft: Math.floor(width * 0.25) + 10,
    typeRight: Math.floor(width * 0.5) - 10,
    valueLeft: Math.floor(width * 0.76),
    valueRight: width - 6,
    busMinWidth: Math.floor(width * 0.08),
    detected: false,
  };
}

/**
 * 縦の罫線から列の位置を割り出す。罫線は「行の大半で、上から下まで線が通っている縦の位置」。
 * 注意書きの行など罫線のない行が混ざってもよいように、行ごとの多数決にする。
 * 罫線が3本見つからなければ決め打ちに戻す。
 */
export function findLayout(rows, width) {
  const full = median(rows.map((r) => r.height));
  const target = rows.filter((r) => r.height >= full * 0.75 && r.width === width);
  if (target.length < 2) return defaultLayout(width);
  const votes = new Uint16Array(width);
  for (const row of target) {
    const g = toGray(row);
    const top = 5, bottom = row.height - 5;
    for (let x = 0; x < width; x++) {
      let dark = 0;
      for (let y = top; y < bottom; y++) if (g[y * width + x] < 210) dark++;
      if (dark >= (bottom - top) * 0.9) votes[x]++;
    }
  }
  const lines = [];
  for (let x = 0; x < width; x++) {
    if (votes[x] < target.length * 0.6) continue;
    const last = lines[lines.length - 1];
    if (last && x === last.end + 1) last.end = x;
    else lines.push({ start: x, end: x });
  }
  // 画面の端に張り付いた線（枠線など）は列の区切りではないので除く
  const inner = lines.filter((l) => l.start > width * 0.05 && l.end < width * 0.95);
  if (inner.length !== 3) return defaultLayout(width);
  const [l1, l2, l3] = inner;
  // 切り出し位置は、横幅750pxのiPhoneで従来の割合と1px単位で一致するように罫線からの距離で決める
  const typeLeft = l1.end + 10, typeRight = l2.start - 9;
  return {
    dateRight: l1.start - 6,
    typeLeft,
    typeRight,
    valueLeft: l3.end + 7,
    valueRight: width - 6,
    // バス行の「ﾊﾞｽ等」の文字幅の基準。750pxの画面では種別欄168pxに対して60px
    busMinWidth: Math.round(((typeRight - typeLeft) * 60) / 168),
    detected: true,
  };
}

/** 赤字の注意書き（「一部が表示（印字）できません。」）の行か */
export function isNoticeRow(row) {
  const d = row.data;
  let red = 0;
  const n = row.width * row.height;
  for (let p = 0; p < n * 4; p += 4) {
    if (d[p] > 150 && d[p + 1] < 120 && d[p + 2] < 120) red++;
  }
  return red / n > 0.002;
}

/** 結合画像を見出し部分と全行に分ける（罫線のすき間の細切れは除く） */
export function splitRows(img) {
  const boundaries = findRowBoundaries(img);
  if (boundaries.length >= 2) {
    // iPhone 形式：暗い横線が行の境界
    // 緑の見出し行が途中で区切れて見えることがある（画面の幅による）ので、緑が続く間は見出しに含める
    // （高さ20px未満の細い切れ目は緑か判定できないので、行ではないものとして見出しに含める）
    let bodyIndex = 0;
    while (bodyIndex + 1 < boundaries.length
      && (boundaries[bodyIndex + 1] - boundaries[bodyIndex] < 20 || hasTableHeader(img, boundaries[bodyIndex], boundaries[bodyIndex + 1]))) {
      bodyIndex++;
    }
    const bodyStart = boundaries[bodyIndex];
    const rowBoundaries = boundaries.slice(bodyIndex + 1);
    if (!rowBoundaries.length || rowBoundaries[rowBoundaries.length - 1] < img.height - 2) rowBoundaries.push(img.height);
    const rows = [];
    let top = bodyStart;
    for (const bottom of rowBoundaries) {
      if (bottom - top >= 40) rows.push(crop(img, top, bottom));
      top = bottom;
    }
    return { header: crop(img, 0, bodyStart), rows };
  }

  // Android 形式：白背景の行の間に一様な灰色の区切り帯がある
  // 最初の区切りをヘッダー末尾とし、以降の区切りが各行の境界
  const androidBounds = findRowBoundariesAndroid(img);
  if (androidBounds.length < 1) throw new Error("表の行を検出できませんでした");
  const headerEnd = androidBounds[0];
  const rowBoundaries = androidBounds.slice(1);
  if (!rowBoundaries.length || rowBoundaries[rowBoundaries.length - 1] < img.height - 2) rowBoundaries.push(img.height);
  const rows = [];
  let top = headerEnd;
  for (const bottom of rowBoundaries) {
    if (bottom - top >= 40) rows.push(crop(img, top, bottom));
    top = bottom;
  }
  return { header: crop(img, 0, headerEnd), rows, isAndroid: true };
}


// ---------- 読み取り ----------

/** OpenCV の resize(INTER_CUBIC) 相当の拡大（グレー画像） */
function resizeCubic(src, sw, sh, scale) {
  const dw = sw * scale, dh = sh * scale;
  const A = -0.75;
  const weights = (t) => {
    const w0 = ((A * (t + 1) - 5 * A) * (t + 1) + 8 * A) * (t + 1) - 4 * A;
    const w1 = ((A + 2) * t - (A + 3)) * t * t + 1;
    const w2 = ((A + 2) * (1 - t) - (A + 3)) * (1 - t) * (1 - t) + 1;
    return [w0, w1, w2, 1 - w0 - w1 - w2];
  };
  const prep = (dn, sn) => Array.from({ length: dn }, (_, d) => {
    const f = (d + 0.5) / scale - 0.5;
    const i = Math.floor(f);
    const w = weights(f - i);
    const idx = [i - 1, i, i + 1, i + 2].map((k) => Math.min(sn - 1, Math.max(0, k)));
    return { idx, w };
  });
  const xs = prep(dw, sw), ys = prep(dh, sh);
  const tmp = new Float64Array(dw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < dw; x++) {
      const { idx, w } = xs[x];
      const r = y * sw;
      tmp[y * dw + x] = src[r + idx[0]] * w[0] + src[r + idx[1]] * w[1] + src[r + idx[2]] * w[2] + src[r + idx[3]] * w[3];
    }
  }
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const { idx, w } = ys[y];
    for (let x = 0; x < dw; x++) {
      const v = tmp[idx[0] * dw + x] * w[0] + tmp[idx[1] * dw + x] * w[1] + tmp[idx[2] * dw + x] * w[2] + tmp[idx[3] * dw + x] * w[3];
      out[y * dw + x] = Math.min(255, Math.max(0, Math.round(v)));
    }
  }
  return { width: dw, height: dh, gray: out };
}

/** OCR に渡す前処理：グレー化 → 2倍拡大 → 白い余白10px */
export function prepareForOcr(img) {
  if (img.width <= 0 || img.height <= 0) return null;
  const big = resizeCubic(toGray(img), img.width, img.height, 2);
  const pad = 10;
  const width = big.width + pad * 2, height = big.height + pad * 2;
  const gray = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < big.height; y++) gray.set(big.gray.subarray(y * big.width, (y + 1) * big.width), (y + pad) * width + pad);
  return { width, height, gray };
}

export function parseDate(text) {
  const m = /(\d{1,2})\s*\/\s*(\d{1,2})/.exec(text || "");
  if (!m) return null;
  const month = Number(m[1]), day = Number(m[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? `${month}/${day}` : null;
}

/** 「1,234」「1234」「-438」の形だけを数値として受け付ける（「,47」「2,4」のように途中で切れた数字は捨てる）
 *  Tesseract.js はカンマを読み落とすことがあるため、カンマなしも許す */
export function parseYen(text, allowSign) {
  text = (text || "").replace(/\s/g, "");
  const pattern = allowSign ? /^-?(\d{1,3}(,\d{3})*|\d{1,6})$/ : /^(\d{1,3}(,\d{3})*|\d{1,6})$/;
  return pattern.test(text) ? Number(text.replace(/,/g, "")) : null;
}

export function rowKind(row) {
  if (row.fixedKind) return row.fixedKind; // PDF の明細は種別が書いてあるので推定しない
  if (row.amount === null) return KIND.UNREAD;
  if (row.amount > 0) return KIND.CHARGE;
  return row.looksTransit ? KIND.TRANSIT : KIND.OTHER;
}

async function readRow(row, ocr, layout) {
  const { height } = row.image;
  const half = Math.floor(height / 2);
  // Android: 右列上半分は「残高¥X,XXX」（右詰め）。「残高¥」が whitelistの数字に誤読される
  // ため、列幅の55%付近から始めてプレフィックスをスキップする（55%でほぼ数字の開始位置と一致）
  const balLeft = layout.isAndroid
    ? Math.round(layout.valueLeft + (layout.valueRight - layout.valueLeft) * 0.55)
    : layout.valueLeft;
  // Android では種別欄が 0.08 〜 0.33 に来るので、日付欄はその手前まで
  const dateRight = layout.isAndroid
    ? Math.floor(row.image.width * 0.07)
    : layout.dateRight;
  const regions = {
    date: crop(row.image, 8, height - 8, 0, dateRight),
    balance: crop(row.image, 8, half, balLeft, layout.valueRight),
    amount: crop(row.image, half, height - 8, layout.valueLeft, layout.valueRight),
  };
  const [date, balance, amount] = await Promise.all(
    ["date", "balance", "amount"].map((field) => {
      let prepared = prepareForOcr(regions[field]);
      if (!prepared) return Promise.resolve("");
      // Android の入/出行では日付テキストが薄いグレーで印字されることがあり OCR が失敗しやすい
      // 閾値200で二値化してコントラストを強制的に上げる
      if (layout.isAndroid && field === "date") {
        const { width, height, gray: g } = prepared;
        const gray = new Uint8Array(g.length);
        for (let i = 0; i < g.length; i++) gray[i] = g[i] < 200 ? 0 : 255;
        prepared = { width, height, gray };
      }
      return ocr(prepared, field);
    }),
  );
  row.looksTransit = looksTransit(row.image, layout);
  row.date = parseDate(date);
  row.balance = parseYen(balance.trim(), false);
  row.amount = parseYen(amount.trim(), true);
}

// ---------- 重複の除去 ----------

function isSameRowImage(a, b, threshold = 0.8) {
  if (a.width !== b.width) return false;
  const height = Math.min(a.height, b.height);
  if (height < 40) return false;
  const ga = toGray(a), gb = toGray(b), w = a.width;
  const diff = (offA, offB) => {
    let sum = 0;
    for (let i = 0; i < height * w; i++) sum += Math.abs(ga[offA * w + i] - gb[offB * w + i]);
    return sum / (height * w);
  };
  const top = diff(0, 0);
  const bottom = diff(a.height - height, b.height - height);
  return Math.min(top, bottom) < threshold;
}

/** 日付と残高が同じ行、または（残高が読めない行は）画像が同じ行を重複とみなす */
export function removeDuplicates(rows) {
  const kept = [];
  for (const row of rows) {
    let twin = null;
    for (const other of kept) {
      if (row.balance !== null && other.balance !== null) {
        // 両方の残高が読めていれば残高で判断する（同額チャージの連続は画像がほぼ同じため）
        if (row.date === other.date && row.balance === other.balance) { twin = other; break; }
      } else if (isSameRowImage(row.image, other.image)) { twin = other; break; }
    }
    if (!twin) kept.push(row);
    else if (row.image.height > twin.image.height) {
      row.noticeBelow = row.noticeBelow || twin.noticeBelow;
      kept[kept.indexOf(twin)] = row;
    } else twin.noticeBelow = twin.noticeBelow || row.noticeBelow;
  }
  return kept;
}

// ---------- 残高の検算 ----------

const matches = (newer, older, amount) => Math.abs(newer - older) === Math.abs(amount);
const known = (...values) => values.every((v) => v !== null && v !== undefined);

/** 上が新しい順の行で残高をつなげて検算し、読めない値を補い、合わない箇所を返す */
export function verifyBalances(rows, { exact = false } = {}) {
  // exact: PDF の明細のように値が正確なときは、補正・補完をせず検算だけする
  const n = rows.length;
  const fixBalance = (row, candidate) => {
    row.notes.push(`残高を補正（読み取り ${row.balance.toLocaleString()} → ${candidate.toLocaleString()}）`);
    row.balance = candidate;
  };

  if (!exact) {
  // 1. 前後の行と両方合わない残高は誤読とみなして補正
  for (let i = 1; i < n - 1; i++) {
    const prev = rows[i - 1], row = rows[i], next = rows[i + 1];
    if (!known(prev.balance, prev.amount, row.balance, row.amount, next.balance)) continue;
    if (matches(row.balance, next.balance, row.amount) || matches(prev.balance, row.balance, prev.amount)) continue;
    for (const c of [next.balance + row.amount, next.balance - Math.abs(row.amount)]) {
      if (c >= 0 && matches(prev.balance, c, prev.amount)) { fixBalance(row, c); break; }
    }
  }

  // 1b. 1つ古い行から計算した残高と1桁だけ違うなら、その1桁の誤読とみなして補正
  for (let i = 0; i < n - 1; i++) {
    const row = rows[i], older = rows[i + 1];
    if (!known(row.balance, row.amount, older.balance)) continue;
    if (matches(row.balance, older.balance, row.amount)) continue;
    for (const c of [older.balance + row.amount, older.balance - Math.abs(row.amount)]) {
      const a = String(c), b = String(row.balance);
      if (c >= 0 && a.length === b.length && [...a].filter((ch, k) => ch !== b[k]).length === 1) { fixBalance(row, c); break; }
    }
  }

  // 2. 古い行から順に、欠けている差額・残高を前後から補う
  for (let i = n - 2; i >= 0; i--) {
    const row = rows[i], older = rows[i + 1];
    if (older.balance === null) continue;
    if (row.amount === null && row.balance !== null) {
      row.amount = row.balance - older.balance;
      row.notes.push("差額を残高から算出");
    } else if (row.balance === null && row.amount !== null) {
      row.balance = older.balance + row.amount;
      row.notes.push("残高を差額から算出");
    }
  }

  // 2b. 新しい行から順に、欠けている残高を差額で補う（上の2.で埋まらなかった古い行を対象）
  for (let i = 0; i < n - 1; i++) {
    const row = rows[i], older = rows[i + 1];
    if (!known(row.balance, row.amount)) continue;
    if (older.balance === null) {
      older.balance = row.balance - row.amount;
      older.notes.push("残高を差額から算出");
    }
  }

  }

  // 3. 検算。符号の読み落としを直し、合わない箇所を記録
  const gaps = [];
  for (let i = 0; i < n - 1; i++) {
    const row = rows[i], older = rows[i + 1];
    if (!known(row.balance, row.amount, older.balance)) continue;
    const diff = row.balance - older.balance;
    if (diff === row.amount) continue;
    if (!exact && diff === -row.amount) { row.amount = diff; continue; }
    gaps.push({ newer: row, older, amount: row.balance - row.amount - older.balance, notice: row.noticeBelow });
  }
  return gaps;
}

// ---------- 全体の流れ ----------

//
// 画像の見た目どうしを重ねて結合するのではなく、1枚ずつ行に分けて読み取り、
// 「同じ行（日付と残高が一致）」を手がかりに並べてつなぐ。
// スクロール量が大きく重なりが少ない撮り方や、ほぼ同じ範囲を撮った画像があっても崩れない。

/**
 * 1枚ずつ行に分けて全行を読み取る（時間がかかるのはここだけ）
 * @returns {Promise<Array<{header, items}>>} items は上から順の行（注意書きは { notice: true }）
 */
export async function readScreenshots(images, ocr, log = () => {}) {
  const split = images.map((image) => splitRows(image));
  const total = split.reduce((sum, s) => sum + s.rows.length, 0);
  const fullHeight = median(split.flatMap((s) => s.rows.map((r) => r.height)));
  let done = 0;
  // 読み取りは並列に投げる（OCR 側のワーカー数で実際の同時実行数が決まる）
  return Promise.all(split.map(async ({ header, rows, isAndroid }, index) => {
    const layout = findLayout(rows, images[index].width);
    if (isAndroid) layout.isAndroid = true;
    const read = await Promise.all(rows.map(async (image) => {
      const row = { image, date: null, balance: null, amount: null, looksTransit: false };
      await readRow(row, ocr, layout);
      log(`読み取り中… ${++done}/${total}`);
      return row;
    }));
    const items = [];
    for (const row of read) {
      // 画面の上下で切れた行の切れ端で、日付も読めないものは捨てる
      if (row.image.height < fullHeight * 0.75 && row.date === null) continue;
      if (row.date === null && row.balance === null && row.amount === null && isNoticeRow(row.image)) {
        items.push({ notice: true });
        continue;
      }
      items.push(row);
    }
    return { header, items, layout };
  }));
}

const rowKey = (row) => (row.date && row.balance !== null ? `${row.date}|${row.balance}` : null);

/** 年をまたぐ（10〜12月と1〜3月が混ざる）ときは1〜3月を翌年として比べるための並べ替えキー */
function dateSortKey(dates) {
  const months = dates.filter(Boolean).map((d) => Number(d.split("/")[0]));
  const wraps = months.some((m) => m >= 10) && months.some((m) => m <= 3);
  return (date) => {
    if (!date) return -Infinity;
    const [m, d] = date.split("/").map(Number);
    return (wraps && m <= 3 ? m + 12 : m) * 32 + d;
  };
}

/**
 * 読み取った行の中身から、スクショの並び順（上が新しい履歴）を決める
 * @returns {number[]} 並べた後の元のインデックス
 */
export function autoOrder(pages) {
  const n = pages.length;
  const rowsOf = pages.map((p) => p.items.filter((it) => !it.notice));
  const keyIndex = rowsOf.map((rows) => {
    const map = new Map();
    rows.forEach((r, i) => { const k = rowKey(r); if (k && !map.has(k)) map.set(k, i); });
    return map;
  });

  // 同じ行を含む2枚から「j の先頭行は i の何行目にあたるか」を求める（一番多いずれを採用）
  const offsets = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const votes = new Map();
      for (const [k, ii] of keyIndex[i]) {
        if (keyIndex[j].has(k)) { const d = ii - keyIndex[j].get(k); votes.set(d, (votes.get(d) || 0) + 1); }
      }
      if (votes.size) offsets.push({ i, j, d: [...votes].sort((x, y) => y[1] - x[1])[0][0] });
    }
  }

  // 同じ行でつながる画像をかたまりにし、かたまりの中で位置を決める
  const pos = new Array(n).fill(null);
  const groups = [];
  for (let start = 0; start < n; start++) {
    if (pos[start] !== null) continue;
    pos[start] = 0;
    const members = [start];
    for (let k = 0; k < members.length; k++) {
      const a = members[k];
      for (const { i, j, d } of offsets) {
        if (i === a && pos[j] === null) { pos[j] = pos[i] + d; members.push(j); }
        if (j === a && pos[i] === null) { pos[i] = pos[j] - d; members.push(i); }
      }
    }
    members.sort((x, y) => pos[x] - pos[y] || x - y);
    const firstDate = members.flatMap((m) => rowsOf[m]).find((r) => r.date)?.date ?? null;
    groups.push({ members, firstDate, index: start });
  }

  // つながらないかたまりどうし（撮り漏れ等）は、先頭の日付の新しい順
  const key = dateSortKey(groups.map((g) => g.firstDate));
  groups.sort((x, y) => key(y.firstDate) - key(x.firstDate) || x.index - y.index);
  return groups.flatMap((g) => g.members);
}

/** 指定の順に行をつなぎ、重複除去・検算する（読み取りはやり直さない） */
export function buildResult(pages, order) {
  let rows = [];
  for (const index of order) {
    for (const item of pages[index].items) {
      if (item.notice) {
        if (rows.length) rows[rows.length - 1].noticeBelow = true;
        continue;
      }
      // 検算で値を書き換えるので、読み取り結果は複製して使う
      rows.push({ ...item, notes: [], checked: false, noticeBelow: false });
    }
  }
  rows = removeDuplicates(rows);
  const gaps = verifyBalances(rows);
  for (const row of rows) row.kind = rowKind(row);
  return { header: pages[order[0]].header, rows, gaps };
}

/**
 * 読み取り → 並び順の決定 → つなぐ → 重複除去 → 検算
 * @param {Array} images RGBA 画像（順不同でよい）
 * @param {(prepared, field) => Promise<string>} ocr
 * @param {(message: string) => void} log
 */
export async function processScreenshots(images, ocr, log = () => {}) {
  const pages = await readScreenshots(images, ocr, log);
  const order = autoOrder(pages);
  return { pages, order, ...buildResult(pages, order) };
}

// ---------- PDF の明細（モバイルSuica「残高ご利用明細」） ----------
//
// 文字の入った PDF なので読み取り（OCR）は使わない。種別も書いてあるので推定しない。
// 明細は古い順（上が古い）に並んでいる。

/** pdf.js の文字片（x, y 付き）を、上から順の行・左から順の文字片にまとめる */
export function groupTextLines(items) {
  const lines = [];
  for (const it of items) {
    const str = it.str.trim();
    if (!str) continue;
    let line = lines.find((l) => Math.abs(l.y - it.y) < 2);
    if (!line) { line = { y: it.y, tokens: [] }; lines.push(line); }
    line.tokens.push({ str, x: it.x });
  }
  lines.sort((a, b) => b.y - a.y); // PDF の座標は下から上
  return lines.map((l) => l.tokens.sort((a, b) => a.x - b.x));
}

const yenToken = /^[\\¥￥]-?[\d,]+$/;
const amountToken = /^[+-]?[\d,]+$/;
const toInt = (s) => Number(s.replace(/[\\¥￥,+]/g, ""));

/**
 * 明細の行を解析する
 * @param pages readStatementPdf の結果（ページごとの行）
 * @returns 古い順の項目。取引の行のほか、{ notice: true }（一部が表示できません）、{ carry: true }（繰越）
 */
export function parseStatement(pages) {
  const items = [];
  for (const lines of pages) {
    for (const tokens of lines) {
      const text = tokens.map((t) => t.str).join(" ");
      if (/一部が表示/.test(text)) { items.push({ notice: true }); continue; }
      const [m, d] = tokens.map((t) => t.str);
      if (!/^\d{1,2}$/.test(m || "") || !/^\d{1,2}$/.test(d || "")) continue; // 見出し・注記など
      const month = Number(m), day = Number(d);
      if (month < 1 || month > 12 || day < 1 || day > 31) continue;
      const balanceIndex = tokens.findIndex((t) => yenToken.test(t.str));
      if (balanceIndex < 0) continue;
      const balance = toInt(tokens[balanceIndex].str);
      const amountText = tokens.slice(balanceIndex + 1).map((t) => t.str).find((s) => amountToken.test(s));
      const amount = amountText === undefined ? null : (amountText.startsWith("-") ? -1 : 1) * toInt(amountText.replace("-", ""));
      const middle = tokens.slice(2, balanceIndex).map((t) => t.str);
      const kindText = (middle[0] || "").normalize("NFKC");

      if (kindText === "繰") { items.push({ carry: true, balance }); continue; }

      let place = middle.slice(1).join(" ");
      if (kindText === "入") {
        const exit = middle.findIndex((s, i) => i > 0 && /出$/.test(s));
        if (exit > 0) place = `${middle.slice(1, exit).join(" ")} → ${middle.slice(exit + 1).join(" ")}`;
      }
      const transit = kindText.startsWith("バス") || kindText === "入";
      const fixedKind = transit ? KIND.TRANSIT : amount !== null && amount > 0 ? KIND.CHARGE : KIND.OTHER;
      items.push({
        image: null,
        date: `${month}/${day}`,
        balance,
        amount,
        looksTransit: transit,
        fixedKind,
        kindLabel: kindText === "入" ? "電車" : kindText,
        place: place.replace(/\s+/g, " ").trim(),
      });
    }
  }
  return items;
}

/**
 * 明細（複数のPDFでもよい）から一覧を作る。上が新しい順にそろえ、重複を除き、残高で検算する。
 * @param statements parseStatement の結果の配列（PDFごと）
 */
export function buildStatementResult(statements) {
  // PDF どうしは、最初の取引の日付が古い順につなぐ
  const firstDate = (items) => items.find((it) => it.date)?.date ?? null;
  const key = dateSortKey(statements.map(firstDate));
  const ordered = [...statements].sort((a, b) => key(firstDate(a)) - key(firstDate(b)));

  const chronological = [];
  let noticePending = false;
  for (const items of ordered) {
    for (const it of items) {
      if (it.notice) { noticePending = true; continue; }
      if (it.carry) continue;
      // 新しい順に並べ替えたとき、注意書きの「上」にくる行に印を付ける
      chronological.push({ ...it, notes: [], checked: false, noticeBelow: noticePending });
      noticePending = false;
    }
  }

  const seen = new Set();
  const rows = [];
  for (const row of chronological.reverse()) {
    const k = `${row.date}|${row.balance}|${row.amount}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push(row);
  }
  const gaps = verifyBalances(rows, { exact: true });
  for (const row of rows) row.kind = rowKind(row);
  return { header: null, rows, gaps };
}

// ---------- 期間 ----------

/** "YYYY-MM-DD" → {y, m, d} */
export function parseIsoDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || "");
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

const dateKey = (y, m, d) => y * 10000 + m * 100 + d;

/** 履歴の「M/D」が期間内か。履歴には年がないので期間の年を当てはめる（年またぎ可） */
export function inPeriod(md, start, end) {
  if (!start && !end) return true;
  if (!md) return false;
  const [month, day] = md.split("/").map(Number);
  const years = new Set([start, end].filter(Boolean).map((b) => b.y));
  for (const y of years) {
    const probe = new Date(y, month - 1, day);
    if (probe.getMonth() !== month - 1) continue; // 2/29 などの存在しない日
    const k = dateKey(y, month, day);
    if ((!start || k >= dateKey(start.y, start.m, start.d)) && (!end || k <= dateKey(end.y, end.m, end.d))) return true;
  }
  return false;
}
