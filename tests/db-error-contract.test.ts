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
// COUNTS, not just paths. CodeRabbit on this PR: a path-only allowlist lets a
// listed file add new bare throws and stay green — the debt could grow silently
// inside the very files it was meant to freeze. Exact counts make it a ratchet:
// add one and the test fails, remove one and the test fails until the number
// comes down with it. The only way it moves is deliberately, and downward.
const KNOWN_BARE_THROWS: Readonly<Record<string, number>> = {
  "app/api/conversations/threads/[key]/route.ts": 2,
  "app/api/leads/[id]/timeline/route.ts": 5,
  "lib/agent-resolver.ts": 2,
  "lib/client-provisioning.ts": 4,
  "lib/drips/executor.ts": 2,
  "lib/drips/reconcile-email-telemetry.ts": 4,
  "lib/lead-interactions-queries.ts": 3,
  "lib/queries/merchant-summary.ts": 2,
};

// `throw <result>.error;` — a driver result's error property. Never anything else.
const PROPERTY_THROW = /throw\s+\w+\.error(?:s)?\s*;/g;
// A bare `throw error;`. Ambiguous on its own — see DESTRUCTURED_ERROR below.
const BARE_THROW = /throw\s+(error(?:s)?)\s*;/g;

/**
 * Does this file bind that identifier from a query RESULT?
 *
 * A bare `throw error;` has two completely different meanings and the scan
 * cannot tell them apart from the throw alone:
 *
 *   const { data, error } = await db...;  if (error) throw error;   ← THE BUG
 *   } catch (error) { ...; throw error; }                           ← correct
 *
 * The first sends a plain driver object across a boundary. The second re-raises
 * whatever was already caught, which is the only correct thing to do when you
 * cannot handle it — and lib/integrations/google-calendar.ts grew exactly that
 * form in #324 (`if (!system) throw error;`, re-raising a
 * GoogleCalendarIntegrationError when no workspace calendar is configured to
 * fall back to). It was reported as new undeclared debt, which is how main went
 * red. Adding it to KNOWN_BARE_THROWS would have been worse than the red: it
 * would record a debt that does not exist, and set that file's ratchet to 1 so
 * a genuine bare throw appearing there later would pass unnoticed.
 *
 * A driver error only ever enters scope by being destructured off an awaited
 * result, so that binding is what distinguishes the two. Deliberately
 * conservative: a file that destructures `error` anywhere still has ALL its
 * bare throws counted, so the ambiguous case resolves toward reporting.
 * Verified against the eight declared files above — every one destructures
 * `error`, so none of their counts move; google-calendar.ts never does, and
 * binds `error` only in `catch`.
 */
const bindsDestructuredError = (src: string, id: string): boolean =>
  new RegExp(String.raw`(?:const|let|var)\s*\{[^}]*\b${id}\b[^}]*\}\s*=`).test(src);

const files = sourceTree("app", "lib", "components");
assert.ok(files.length > 200, `only ${files.length} files walked — the scan is broken`);

const offenders = new Map<string, number>();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  let hits = [...src.matchAll(PROPERTY_THROW)].length;
  for (const [, id] of src.matchAll(BARE_THROW)) {
    if (bindsDestructuredError(src, id)) hits += 1;
  }
  if (hits) offenders.set(rel(f), hits);
}

const problems: string[] = [];

// A file with bare throws that is not declared at all.
for (const [file, count] of offenders) {
  if (!(file in KNOWN_BARE_THROWS)) {
    problems.push(`  ${file} — ${count} bare throw(s), not declared`);
  }
}

// A declared file whose count went UP: new debt hiding inside old debt.
for (const [file, allowed] of Object.entries(KNOWN_BARE_THROWS)) {
  const actual = offenders.get(file) ?? 0;
  if (actual > allowed) {
    problems.push(
      `  ${file} — ${actual} bare throw(s), ${allowed} declared. New ones were added to a file ` +
        `that was already on the list; convert them with dbError() rather than raising the number.`,
    );
  }
}

// A declared file whose count went DOWN, or is fixed entirely: good news, but
// the list has to follow or it silently re-permits what was just fixed.
for (const [file, allowed] of Object.entries(KNOWN_BARE_THROWS)) {
  const actual = offenders.get(file) ?? 0;
  if (actual < allowed) {
    problems.push(
      `  ${file} — down to ${actual} from ${allowed}. Fixed some: ` +
        (actual === 0
          ? `delete the entry so the rule is enforced there again.`
          : `lower the number to ${actual} so the ratchet cannot slip back.`),
    );
  }
}

assert.deepEqual(
  problems,
  [],
  `Bare driver-error throw contract violated:\n${problems.join("\n")}\n\n` +
    `A PostgREST/libSQL error is a plain object. Thrown raw, every handler that\n` +
    `narrows on \`instanceof Error\` silently replaces it with a generic string —\n` +
    `that is how "invite_create_failed" hid a NOT NULL violation for months.\n` +
    `Use dbError("<label>", error) from lib/db-error.ts.`,
);

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
    `${offenders.size} file(s) with bare throws, ` +
    `${Object.values(KNOWN_BARE_THROWS).reduce((a, b) => a + b, 0)} declared occurrence(s), no drift`,
);
