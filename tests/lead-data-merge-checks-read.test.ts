/**
 * A form submission never rewrites a lead's data from a failed read.
 *
 * WHY. app/api/forms/submit/route.ts reads a lead's `data`, merges new fields
 * into it and writes the whole object back, in several places. maybeSingle()
 * resolves `{ data: null, error }` on a database blip instead of throwing, so
 * a block that skips the error check reads "no existing data" and REPLACES the
 * lead's whole record with just the new fields: name, stage, source and notes
 * gone. The consent-receipt and OASIS-enrich blocks were fixed for this; the
 * owner-map block was not (2026-10-19 audit).
 *
 * The rule, checked over every read of `data` in the route: the variable the
 * read lands in has its `.error` looked at before the next write.
 *
 * Run: node --conditions=react-server --import tsx tests/lead-data-merge-checks-read.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "app/api/forms/submit/route.ts";
const src = readFileSync(join(__dirname, "..", FILE), "utf8");

// `const <name> = await <db>\n .from("tenant_records")\n .select("data")` ... up to the next .update(
const READ = /const (\w+) = await \w+\s*\.from\("tenant_records"\)\s*\.select\("data"\)/g;

const reads: Array<{ name: string; line: number; checked: boolean }> = [];
for (const m of src.matchAll(READ)) {
  const name = m[1];
  const start = m.index ?? 0;
  const nextWrite = src.indexOf(".update(", start);
  const between = src.slice(start, nextWrite === -1 ? undefined : nextWrite);
  reads.push({
    name,
    line: src.slice(0, start).split("\n").length,
    // Any look at the read's error counts: `if (cur.error) throw` and
    // `if (!after.error && afterData)` both refuse to act on a failed read.
    checked: new RegExp(`\\b${name}\\.error\\b`).test(between),
  });
}

console.log("lead-data-merge-checks-read:");
assert.ok(reads.length >= 3, `found only ${reads.length} reads of tenant_records.data: the scan is broken`);
const unchecked = reads.filter((r) => !r.checked).map((r) => `${FILE}:${r.line} (${r.name})`);
assert.deepEqual(unchecked, [], "these reads merge into a write without checking the read's error");
console.log(`  ok    all ${reads.length} reads of a lead's data check the read's error before writing`);
console.log("lead-data-merge-checks-read: all passed");
