/**
 * or-value-guard.test.ts — no runtime VALUE is spliced into a JSON-path
 * comparison inside an .or() string.
 *
 * The .or() string is a grammar, and the Turso adapter types its literals
 * (lib/turso-postgrest.ts grammarLiteral): an all-digit value becomes a NUMBER,
 * json_extract returns the stored field as TEXT, and SQLite never equals TEXT
 * to an INTEGER. So `.or(\`data->>phone.eq.${phone}\`)` compiles, runs, and
 * matches nothing. That killed phone matching in findExistingLead and in the
 * Live Subs approval from the Turso move until 2026-09-11. Bind the value with
 * .eq("data->>phone", v) / .filter(...) instead.
 *
 * Source scan, because the failure is silent at runtime: a wrong query here
 * returns zero rows, which looks exactly like "no such lead".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["app", "lib", "components", "scripts"];
const SKIP = new Set(["node_modules", ".next", "tmp", "__tests__"]);
// `data->>stage.eq.${LEADS_BOARD_EXEMPT_STAGE}` interpolates the constant
// "uw_sheet", never a caller's value.
const ALLOW = new Set(["lib/leads/board-visibility.ts"]);
// `\s*` and a whole-file scan: a template literal can break a line, or put a
// space, between `.eq.` and `${`, and it is the same splice. (CodeRabbit, #430.)
const VALUE_INTO_JSON_PATH = /->>[\w$]+\.(?:not\.)?(?:eq|neq|gt|gte|lt|lte)\.\s*\$\{/g;

const hits: string[] = [];
function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(ts|tsx|mjs|js)$/.test(name)) continue;
    const rel = p.replace(/\\/g, "/");
    if (ALLOW.has(rel)) continue;
    const src = readFileSync(p, "utf8");
    const lines = src.split("\n");
    for (const m of src.matchAll(VALUE_INTO_JSON_PATH)) {
      const i = src.slice(0, m.index).split("\n").length - 1;
      hits.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
    }
  }
}
for (const root of ROOTS) walk(root);

if (hits.length > 0) {
  console.error(`or-value-guard: ${hits.length} value(s) spliced into a JSON-path .or() comparison:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log("or-value-guard: OK");
