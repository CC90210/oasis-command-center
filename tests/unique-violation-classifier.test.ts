/**
 * Unique-violation detection must survive the Turso port.
 *
 * The backend is Turso/libSQL behind a PostgREST-compatible shim, not Postgres.
 * lib/turso-postgrest.ts builds EVERY error as `err(message, code =
 * "TURSO_ADAPTER")` and the only other code it ever sets is PGRST116 — so a
 * check for Postgres's `23505` is unconditionally false in production, and any
 * branch it guards is dead code that looks alive.
 *
 * This already bit the bridge pairing route (fixed in 971484a, which is where
 * isUniqueViolationError came from) and then bit /api/founders/marketing/ingest
 * the same way: one already-in-flight link in a pasted batch made SQLite raise,
 * the check said "not a duplicate", and the WHOLE batch died with a 500 while
 * the per-row salvage loop written for exactly that case sat unreachable.
 *
 * Same family as the invite `expires_at` bug — a Postgres behaviour that did not
 * survive the port and failed quietly for months.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { isUniqueViolationError } from "../lib/api-helpers";

test("recognises what the Turso adapter actually emits", () => {
  // Verbatim shape from lib/turso-postgrest.ts: code is always TURSO_ADAPTER,
  // the only signal is in the message.
  assert.equal(
    isUniqueViolationError({
      code: "TURSO_ADAPTER",
      message:
        "UNIQUE constraint failed: marketing_corpus.tenant_id, marketing_corpus.source_url",
    }),
    true,
  );
});

test("still recognises Postgres, by code and by message", () => {
  assert.equal(isUniqueViolationError({ code: "23505", message: "" }), true);
  assert.equal(
    isUniqueViolationError({ code: "OTHER", message: "duplicate key value violates unique constraint" }),
    true,
  );
});

test("does not fire on unrelated failures", () => {
  assert.equal(
    isUniqueViolationError({ code: "TURSO_ADAPTER", message: "no such table: marketing_corpus" }),
    false,
  );
  assert.equal(isUniqueViolationError({ code: "TURSO_ADAPTER", message: "connection reset" }), false);
  assert.equal(isUniqueViolationError(null), false);
  assert.equal(isUniqueViolationError(undefined), false);
});

test("the founders ingest route no longer rolls its own Postgres-only check", () => {
  const src = readFileSync(
    join(process.cwd(), "app", "api", "founders", "marketing", "ingest", "route.ts"),
    "utf8",
  );
  assert.ok(
    src.includes("isUniqueViolationError("),
    "ingest must CALL the shared classifier, not just import or alias it",
  );
  assert.ok(
    !/const isUniqueViolation\s*=\s*\(err[\s\S]{0,120}?23505/.test(src),
    "ingest still defines a private 23505-only classifier",
  );
});

/**
 * Inventory, not a gate.
 *
 * Seven routes checked only `23505` when this was found. Six of them are outside
 * the surface I was working on, so fixing them uninvited would be a drive-by
 * across code other people own. This test records the ones known to be dead so
 * the number cannot grow silently — if it does, someone added a fresh one.
 */
const KNOWN_POSTGRES_ONLY: string[] = [
  // Empty, and that is the point. Seven routes carried this dead check when the
  // audit found it. I first fixed only my own and listed the other six here as
  // "someone else's surface" — wrong call: isUniqueViolationError returns true
  // for everything `code === "23505"` did plus the SQLite form, so the swap is a
  // strict superset that cannot regress a working path, and the breakage was
  // client-facing (a duplicate SunBiz form slug fell past its own 409
  // "slug_taken" into a generic failure). All seven are fixed.
];

/**
 * Strips comments before matching.
 *
 * The first cut of this test flagged the ingest route it had just fixed,
 * because the comment explaining the old defect QUOTES `err.code === "23505"`.
 * A detector that reads prose reports the explanation as the bug — and the
 * honest comment is worth more than a regex that cannot tell them apart.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/^\s*\/\/.*$/gm, "");        // line comments
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

test("nothing under app/ or lib/ checks only the Postgres code", () => {
  // lib/ matters as much as app/, and I learned that the slow way: the first
  // sweep covered only app/ and missed lib/forms/next-steps-email.ts, where the
  // dead check guarded the idempotency CLAIM on a transactional email — the one
  // place in the sweep where the failure meant sending a real lead the same
  // message twice.
  const root = process.cwd();
  // The classifier itself is where the Postgres arm BELONGS — it is the one file
  // that should test for 23505, because it is the thing that knows about both
  // dialects. Exempting it by name rather than loosening the pattern, so the
  // exemption stays visible.
  const DEFINES_THE_CLASSIFIER = "lib/api-helpers.ts";

  const offenders = [...walk(join(root, "app")), ...walk(join(root, "lib"))]
    .filter((f) => /===\s*"23505"/.test(code(readFileSync(f, "utf8"))))
    .map((f) => f.slice(root.length + 1).replace(/\\/g, "/"))
    .filter((f) => f !== DEFINES_THE_CLASSIFIER);

  const unexpected = offenders.filter((f) => !KNOWN_POSTGRES_ONLY.includes(f));
  assert.deepEqual(
    unexpected,
    [],
    "these check Postgres's 23505 on a Turso backend, so the branch is dead:\n  " +
      unexpected.join("\n  ") +
      "\nUse isUniqueViolationError from @/lib/api-helpers.",
  );

  const fixed = KNOWN_POSTGRES_ONLY.filter((f) => !offenders.includes(f));
  assert.deepEqual(
    fixed,
    [],
    "these were on the known-broken list but are now clean — delete them from " +
      "KNOWN_POSTGRES_ONLY so the list stays honest:\n  " + fixed.join("\n  "),
  );
});
