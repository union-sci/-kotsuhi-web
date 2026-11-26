// 引数なしで動く最小テスト。core.js と statement.js が正常に読み込めるか確認する。
import { parseYen, parseStatement, buildStatementResult, KIND, WHITELIST } from "../public/core.js";
import { readStatementPdf } from "../public/statement.js";

let ok = 0, ng = 0;
function assert(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); ok++; }
  else       { console.error(`  ✗ ${label}`); ng++; }
}

// parseYen
assert("parseYen('1,234') === 1234",   parseYen("1,234") === 1234);
assert("parseYen('-500') === null（符号なし）", parseYen("-500") === null);
assert("parseYen('-500', true) === -500",  parseYen("-500", true) === -500);
assert("parseYen('abc') === null",      parseYen("abc") === null);

// KIND / WHITELIST が存在する
assert("KIND.TRANSIT が存在",  typeof KIND.TRANSIT === "string");
assert("KIND.CHARGE が存在",   typeof KIND.CHARGE  === "string");
assert("WHITELIST が存在",      typeof WHITELIST    === "object" && WHITELIST !== null);

// parseStatement / buildStatementResult が関数
assert("parseStatement は関数",       typeof parseStatement       === "function");
assert("buildStatementResult は関数", typeof buildStatementResult === "function");

// readStatementPdf が関数
assert("readStatementPdf は関数", typeof readStatementPdf === "function");

console.log(`\n${ok} passed, ${ng} failed`);
if (ng > 0) process.exit(1);
