/**
 * tests/pg-bridge-operators.test.ts — the /api/pg parser must accept every
 * operator the adapter behind it implements.
 *
 * WHY THIS EXISTS
 * ---------------
 * The bridge refuses unknown PostgREST features with a 501 rather than silently
 * dropping the filter. That is the right call — a dropped filter returns the
 * WRONG ROWS, which is worse than an error. But it means the parser's operator
 * list is load-bearing: anything missing from it is a hard outage for every
 * caller that uses it.
 *
 * On 2026-08-12 exactly one operator was missing: `like`.
 * scripts/drip-watchdog.mjs filters `agent_source=like.sequence:*`, so it had
 * been failing with http_501 since 2026-07-11 — 32 days — and nothing noticed,
 * because the watchdog recorded its own error as "checked_nothing_to_do". The
 * job that watches for duplicate merchant sends and volume spikes was itself
 * dark the entire time.
 *
 * The parser and the adapter drifting apart is invisible in review: both files
 * look correct on their own. This test is what couples them.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROUTE = readFileSync("app/api/pg/rest/v1/[...path]/route.ts", "utf8");
const ADAPTER = readFileSync("lib/turso-postgrest.ts", "utf8");

// ── Every operator the parser accepts must exist on the adapter ────────────
const declared = (ROUTE.match(/type FilterOp\s*=\s*([^;]+);/)?.[1] || "")
  .split("|")
  .map((s) => s.trim().replace(/"/g, ""))
  .filter(Boolean);

assert.ok(declared.length >= 8, `expected the FilterOp union to parse, got ${declared.length}`);

for (const op of declared) {
  // The adapter defines filters as methods: `like(c: string, v: string) {`
  const re = new RegExp(`\\b${op}\\s*\\(`);
  assert.ok(
    re.test(ADAPTER),
    `route.ts accepts "${op}" but lib/turso-postgrest.ts has no such method — ` +
      `the parser would hand the adapter an operator it cannot honour`,
  );
}

// ── THE regression: `like` must be accepted ────────────────────────────────
assert.ok(
  declared.includes("like"),
  "the parser must accept `like`. drip-watchdog filters agent_source=like.sequence:* " +
    "and a 501 there means the duplicate-send watchdog is blind",
);
assert.ok(
  /PATTERN_OPS[\s\S]{0,200}"like"/.test(ROUTE),
  "`like` must be registered in PATTERN_OPS so it is accepted by the parser",
);

// ── Pattern operands must NOT be coerced ───────────────────────────────────
// coerce() turns "true"/"false"/"null" into their JS values. A LIKE operand is
// a string by definition, so coercing one silently changes the query.
assert.ok(
  /PATTERN_OPS\.has\(f\.op\)\s*\?\s*\(f\.value as string\)/.test(ROUTE),
  "pattern operands must bypass coerce() — a pattern of `true` is four characters, not a boolean",
);

// ── The 501 must stay for genuinely unknown operators ──────────────────────
// Widening the parser must not turn into accepting everything. An operator the
// adapter cannot honour has to keep failing loudly.
assert.ok(
  /return \{ ok: false, reason: `operator "\$\{op\}" on "\$\{key\}"` \}/.test(ROUTE),
  "an unrecognised operator must still be refused, not passed through",
);
assert.ok(
  /bad\(501, `unsupported PostgREST feature/.test(ROUTE),
  "unsupported features must still 501 rather than silently returning wrong rows",
);

// ── The adapter translates PostgREST's `*` wildcard ────────────────────────
assert.ok(
  /op === "like" \|\| op === "ilike"[\s\S]{0,120}replace\(\/\\\*\/g, "%"\)/.test(ADAPTER),
  "the adapter must translate PostgREST's * wildcard to SQL % for like/ilike",
);

console.log(
  `pg-bridge-operators.test.ts — ${declared.length} operators declared, all backed by the adapter, ` +
    `like/ilike accepted and uncoerced, unknown operators still 501 ✓`,
);
