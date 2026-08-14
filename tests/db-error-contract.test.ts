/**
 * A driver error must not cross a function boundary as a bare object.
 * Run: node --conditions=react-server --import tsx tests/db-error-contract.test.ts
 *
 * WHY. Every team invite failed for months and the screen said only
 * `invite_create_failed`. The database had reported the cause precisely —
 * "NOT NULL constraint failed: tenant_invites.expires_at" — and lib/team.ts threw
 * it with `throw error ?? new Error(...)`. A PostgREST / libSQL error is a PLAIN
 * OBJECT, so the route's `err instanceof Error ? err.message : "..."` narrowed to
 * false and printed the fallback. The diagnosis existed and was unreachable.
 *
 * This is not a style rule. Every generic handler in this codebase narrows on
 * `instanceof Error`, so throwing a non-Error guarantees the reason is lost at
 * the first boundary it crosses. `dbError()` in lib/db-error.ts wraps it.
 *
 * KNOWN_BARE_THROWS is the same device as KNOWN_BOUNDARY_DEBT in
 * tests/portal-boundaries.test.ts: the sites that predate the rule are listed,
 * not hidden, so no NEW ones appear and the existing ones stay countable. The
 * list must only ever shrink.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dbError, isDbError } from "../lib/db-error";
import { repoRelative as rel, sourceTree } from "./_tree";

// ── the helper does what the callers need ────────────────────────────
{
  const e = dbError("invite.create", {
    message: "NOT NULL constraint failed: tenant_invites.expires_at",
    code: "23502",
  });
  assert.ok(e instanceof Error, "must be a real Error or every instanceof narrow drops it");
  assert.ok(isDbError(e), "and identifiable without string matching");
  assert.match(e.message, /NOT NULL constraint failed/, "the driver's reason survives");
  assert.match(e.message, /invite\.create/, "and says where it happened");
  assert.match(e.message, /\[23502\]/, "and keeps the code");

  // The `data && !error` case — a query that returned nothing without saying why.
  const empty = dbError("invite.create", null);
  assert.ok(empty instanceof Error);
  assert.match(empty.message, /no row and no error/, "the silent case still explains itself");

  // What the API routes actually do with it.
  const narrowed = empty instanceof Error ? empty.message : "invite_create_failed";
  assert.notEqual(
    narrowed,
    "invite_create_failed",
    "the whole point: a route narrowing on instanceof Error must now get the real message",
  );

  // And the bare-object case this replaces, to show the failure is real.
  const bare = { message: "NOT NULL constraint failed", code: "23502" } as unknown;
  const bareNarrowed = bare instanceof Error ? (bare as Error).message : "invite_create_failed";
  assert.equal(
    bareNarrowed,
    "invite_create_failed",
    "a bare driver object narrows to the fallback string — this is the bug, pinned",
  );
}

// ── no NEW bare throws ───────────────────────────────────────────────
// Sites that predate the rule. Every entry is a real throw of a driver error
// object; each needs converting to dbError() when its file is next touched.
// This list may only shrink — the test fails if an entry no longer exists.
const KNOWN_BARE_THROWS: readonly string[] = [
  "app/api/conversations/threads/[key]/route.ts",
  "app/api/leads/[id]/timeline/route.ts",
  "lib/agent-resolver.ts",
  "lib/client-provisioning.ts",
  "lib/drips/executor.ts",
  "lib/drips/reconcile-email-telemetry.ts",
  "lib/lead-interactions-queries.ts",
  "lib/queries/merchant-summary.ts",
];

// `throw <something>.error` or `throw error;` — the driver-object shapes.
const BARE_THROW = /throw\s+(?:\w+\.)?error(?:s)?\s*;|throw\s+\w+Res(?:ult)?\.error\s*;/g;

const files = sourceTree("app", "lib", "components");
assert.ok(files.length > 200, `only ${files.length} files walked — the scan is broken`);

const offenders = new Map<string, number>();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const hits = [...src.matchAll(BARE_THROW)].length;
  if (hits) offenders.set(rel(f), hits);
}

const unexpected = [...offenders.keys()].filter((f) => !KNOWN_BARE_THROWS.includes(f));
assert.deepEqual(
  unexpected,
  [],
  `New bare driver-error throw(s):\n${unexpected.map((f) => `  ${f}`).join("\n")}\n\n` +
    `A PostgREST/libSQL error is a plain object. Thrown raw, every handler that\n` +
    `narrows on \`instanceof Error\` silently replaces it with a generic string —\n` +
    `that is how "invite_create_failed" hid a NOT NULL violation for months.\n` +
    `Use dbError("<label>", error) from lib/db-error.ts.`,
);

// The debt list must not rot: a fixed entry has to be deleted, or the list
// quietly re-permits the pattern years later.
for (const known of KNOWN_BARE_THROWS) {
  assert.ok(
    offenders.has(known),
    `KNOWN_BARE_THROWS lists ${known}, but it has no bare throw any more.\n` +
      `It was fixed — delete the entry so the rule is enforced there again.`,
  );
}

// ── the path that was actually broken stays fixed ────────────────────
{
  const team = readFileSync(require.resolve("../lib/team.ts"), "utf8");
  assert.ok(team.includes('dbError("invite_create_failed"'), "createInvite must wrap its error");
  assert.ok(
    !/throw error \?\? new Error/.test(team),
    "the original bare-throw form must not come back",
  );
}

console.log(
  `db-error-contract: OK — ${files.length} files scanned, ` +
    `${offenders.size} file(s) with bare throws, all declared (${KNOWN_BARE_THROWS.length} known)`,
);
