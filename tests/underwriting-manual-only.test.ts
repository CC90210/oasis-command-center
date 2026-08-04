import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * UNDERWRITING MUST STAY MANUAL. This test is the enforcement, not a comment.
 *
 * Adon, 2026-08-04: old files that were never underwritten must not get queued
 * and re-run, "because that's just a waste of credit" — underwriting happens
 * when a human presses the button on an individual lead, and not otherwise.
 *
 * Every run spends model credit on a full bank-statement read. The intake
 * auto-run paid for that on documents nobody had asked about yet, and kept
 * paying through the 33 days the parser was returning nothing at all, so the
 * spend bought no answer either. The queue it built is the backlog the new
 * service must never drain.
 *
 * WHY A TEST AND NOT A COMMENT. `lib/underwriting/run.ts` reached the VPS with
 * `resolveBridgeTarget()` + `callBridgeExecTool()` and NO session, and the
 * function that did it (`autoRunUnderwritingForLead`) was one import away from
 * any route in the tree. A comment cannot fail a build. This is the same shape,
 * and the same reasoning, as tests/clair-manual-only.test.ts.
 *
 * It is deliberately a STATIC test over the source. The property being defended
 * ("no automated caller exists anywhere") is a property of the whole tree and
 * cannot be established by exercising one function.
 */

const ROOT = join(__dirname, "..");

/** The one route permitted to enqueue a run. Session-authed, human-pressed. */
const THE_ONE_ROUTE = ["app", "api", "applications", "[id]", "underwriting", "run", "route.ts"].join(sep);
/** The shared enqueue itself. */
const THE_LIB = ["lib", "underwriting", "run.ts"].join(sep);

const SOURCE_DIRS = ["app", "lib", "components", "scripts"];
const SOURCE_EXT = /\.(ts|tsx|js|mjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__pycache__"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // an optional dir (scripts/) may not exist
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}

const files = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d)));
assert.ok(files.length > 200, "the walker found the source tree");

// ── 1. Only the operator route may enqueue ───────────────────────────
const enqueueCallers: string[] = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  if (rel === THE_LIB) continue; // the definition
  const src = readFileSync(f, "utf8");
  if (/\benqueueUnderwritingRun\b/.test(src)) enqueueCallers.push(rel);
}
assert.deepEqual(
  enqueueCallers,
  [THE_ONE_ROUTE],
  `only the session-authed operator route may enqueue an underwriting run.\n` +
    `Found: ${enqueueCallers.join(", ")}\n` +
    `If you are adding an automated caller, you are re-introducing the spend this was removed to stop.`,
);

// ── 2. The removed auto-trigger must not come back ───────────────────
// Named explicitly: it is the exact function that used to fire on form intake,
// and re-adding it under the same name is the most likely regression.
for (const f of files) {
  const rel = relative(ROOT, f);
  if (rel === THE_LIB) continue; // its tombstone comment names it on purpose
  const src = readFileSync(f, "utf8");
  assert.ok(
    !/\bautoRunUnderwritingForLead\b/.test(src),
    `${rel} references autoRunUnderwritingForLead. Underwriting is operator-initiated only; ` +
      `there is no automatic path and this function was deleted rather than left importable.`,
  );
}

// ── 3. Nothing may drive the underwriting bridge tool but that route ─
// `callBridgeExecTool` with tool_name "underwriting_run" is how a run is
// executed without a session. Only the operator route and the shared lib's
// kick may name it.
const bridgeCallers: string[] = [];
for (const f of files) {
  const rel = relative(ROOT, f);
  const src = readFileSync(f, "utf8");
  if (/["']underwriting_run["']/.test(src)) bridgeCallers.push(rel);
}
assert.deepEqual(
  bridgeCallers.sort(),
  [THE_ONE_ROUTE, THE_LIB].sort(),
  `only the operator route and lib/underwriting/run.ts may name the underwriting_run bridge tool.\n` +
    `Found: ${bridgeCallers.join(", ")}`,
);

// ── 4. The enqueue must fail closed without a named operator ─────────
{
  const src = readFileSync(join(ROOT, THE_LIB), "utf8");
  assert.ok(
    /not_operator_initiated/.test(src),
    "lib/underwriting/run.ts must refuse an enqueue that carries no operator id",
  );
  assert.ok(
    /triggeredByUserId:\s*string\b/.test(src),
    "triggeredByUserId must be REQUIRED (not optional/nullable) — an optional one lets a server-to-server caller through",
  );
  assert.ok(
    !/export type TriggeredBy = [^;]*"automatic"/.test(src),
    '"automatic" must not be an accepted trigger. It survives only as a value on historical rows.',
  );
}

// ── 5. No scheduled surface may WRITE a run row ──────────────────────
// A cron route or a Vercel schedule that inserts into application_underwriting
// is the shape that would rebuild the backlog quietly.
//
// Keyed on the TABLE, not on the word "underwriting". The first cut matched any
// cron-pathed file containing both "underwriting" and a write verb, and fired on
// lib/cron-descriptions.ts — which is operator-facing prose, not a writer. That
// was a useful false positive (the copy still promised automatic underwriting
// and has been rewritten), but the rule it came from would have cried wolf
// forever. A row can only appear via an insert on the table; test for that.
const scheduled = files.filter((f) => /(^|[\\/])(cron|scheduled|jobs?)[\\/]/i.test(relative(ROOT, f)));
for (const f of scheduled) {
  const src = readFileSync(f, "utf8");
  const writesRunRow =
    /application_underwriting/.test(src) && /\.(insert|upsert)\s*\(/.test(src);
  assert.ok(
    !writesRunRow && !/\benqueueUnderwritingRun\b/.test(src),
    `${relative(ROOT, f)} is a scheduled surface that writes an underwriting run. ` +
      `Underwriting is operator-initiated only.`,
  );
}

console.log(
  `underwriting-manual-only: OK — 1 enqueue caller (the operator route), ` +
    `no auto-trigger, ${scheduled.length} scheduled surfaces clean, ${files.length} files scanned`,
);
