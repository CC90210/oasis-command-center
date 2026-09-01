/**
 * The records API must never hand an outside sales contractor the whole tenant.
 *
 * `LEAD_SCOPING_ENABLED` defaults OFF and the unscoped branch of
 * app/api/manifest/[slug]/records/[entity]/route.ts calls listRecords with no
 * assigned-scope filter at all. That flag exists to stage scoping for SunBiz's
 * established roles, but `agent` is the commission-only OUTSIDE contractor role
 * added for website sales — one GET against that route would have returned every
 * lead in the tenant (including 31k raw prospects and every other rep's leads),
 * defeating all of the page-level persona work through a single URL.
 *
 * This test reads the route source and asserts the gate keeps both halves: the
 * flag for legacy roles, and an unconditional scope for self-scoped reps.
 *
 * ── UPDATED 2026-08-24, and the update is the point ─────────────────────────
 * This test FAILED on the branch that widened the gate, which is exactly what a
 * guard on a security-relevant line is for. It was pinning the literal source
 * text `teamRole === "agent"`. That line was correct when `agent` was the only
 * contractor role; it stopped being correct on 2026-08-21 when `opener`,
 * `closer` and `builder` were added and the invite menu began offering them
 * INSTEAD of `agent`. A rep invited under a new title was not scoped and could
 * read the whole tenant — the PR #237 leak, reopened by the roles that replaced
 * the one it named.
 *
 * So the assertion is re-aimed rather than relaxed, and the shape changed:
 * the role membership question is now a pure exported function, so it is
 * asserted BEHAVIOURALLY (call it, check the answer) instead of by grepping for
 * a string. Source matching is kept only for the wiring that cannot be
 * imported — `mustScopeRegardlessOfFlag` is module-private to the route.
 *
 * A source-text assertion cannot tell "the implementation was refactored" from
 * "the protection was removed". A behavioural one can, and it is the reason a
 * future role added to the invite menu but forgotten in SELF_SCOPED_ROLES makes
 * this file go red instead of silently widening what a contractor can read.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveAssignedScope } from "../lib/lead-scope";
import { isSelfScopedRole, mustSeeOwnRecordsOnly } from "../lib/team-roles";
import { OASIS_SALES_ROLE_OPTIONS, TENANT_WIDE_ROLES, SELF_SCOPED_ROLES } from "../lib/team-roles";

const ROUTE = "app/api/manifest/[slug]/records/[entity]/route.ts";
const src = readFileSync(ROUTE, "utf8");
const catchAll = readFileSync("app/t/[slug]/[...path]/page.tsx", "utf8");

// The guard function exists with the same signature. Still a source match:
// it is module-private to the route and cannot be imported.
assert.match(
  src,
  /function mustScopeRegardlessOfFlag\(\s*teamRole: string,\s*isAdmin: boolean\s*\)/,
  "mustScopeRegardlessOfFlag must exist with (teamRole, isAdmin)",
);
// It must delegate the role question to the SHARED predicate, not re-decide it
// here. Two doors onto tenant_records answering "is this person scoped"
// independently is how the first leak happened.
assert.match(
  src,
  /return !isAdmin && mustSeeOwnRecordsOnly\(teamRole\);/,
  "the gate must delegate to the shared fail-closed predicate",
);
assert.match(
  src,
  /import \{ mustSeeOwnRecordsOnly \} from "@\/lib\/team-roles";/,
  "the route must import the shared predicate rather than copy the list",
);

// ── The behavioural half: WHO is confined. ──────────────────────────────────
// `agent` is legacy but is the role every current rep carries, so dropping it
// would unscope everyone working today.
for (const role of ["agent", "manager", "opener", "closer", "builder"]) {
  assert.equal(
    mustSeeOwnRecordsOnly(role),
    true,
    `${role} must be confined to its own book — an unconfined one reads all ~31K leads`,
  );
}
// Roles that legitimately see the tenant must NOT be swept in. Confining every
// non-admin would empty SunBiz's established boards, which is exactly what the
// staging flag was protecting against.
for (const role of ["owner", "admin", "read_only", "member", "loan_officer", "processor"]) {
  assert.equal(
    mustSeeOwnRecordsOnly(role),
    false,
    `${role} must not be force-confined — that empties established SunBiz boards`,
  );
}

// ── Fail-closed on anything unrecognised. ───────────────────────────────────
// Caught by independent review 2026-08-24: the predicate this replaced was a
// SET-MEMBERSHIP test, so an unknown role answered "not self-scoped" = false.
// mustScopeRegardlessOfFlag then returned false, the route's
// `leadScopingEnabled() || mustScope...` collapsed to false because the flag
// defaults OFF, and the request was served the ENTIRE tenant. `false` there was
// the permissive answer, not the safe one. Deny-by-default must be an allowlist
// of who may see everything.
assert.equal(mustSeeOwnRecordsOnly("some_new_role"), true, "an unknown role must be confined");
assert.equal(mustSeeOwnRecordsOnly(undefined), true, "a missing role must be confined");
assert.equal(mustSeeOwnRecordsOnly(null), true, "a null role must be confined");
assert.equal(mustSeeOwnRecordsOnly(""), true, "an empty role must be confined");
assert.equal(mustSeeOwnRecordsOnly(42), true, "a non-string role must be confined");
assert.equal(mustSeeOwnRecordsOnly("  AGENT  "), true, "matching must trim and lowercase");
assert.equal(mustSeeOwnRecordsOnly("ADMIN"), false, "matching must trim and lowercase both ways");

// The narrower membership helper is still correct for its own question, and is
// still used where "is this a known sales seat" is what is being asked.
assert.equal(isSelfScopedRole("opener"), true);
assert.equal(isSelfScopedRole("manager"), true);
assert.equal(isSelfScopedRole("some_new_role"), false);

assert.ok(
  catchAll.includes("const oasisDirectRole") &&
    catchAll.includes("const isOasisLeadSurface") &&
    catchAll.includes('"manager",') &&
    catchAll.includes('"closer",') &&
    catchAll.includes('"opener",') &&
    catchAll.includes('"builder",') &&
    catchAll.includes('"marketing",') &&
    catchAll.includes('"agent"') &&
    catchAll.includes("redirect(`/pipeline/${recordDetailId}`)") &&
    catchAll.includes("redirect(`/pipeline${target.size"),
  "generic OASIS job-role lead URLs must redirect to the exact-scope canonical pipeline",
);

// ── The drift guard, and the reason this file is worth keeping. ─────────────
// The 2026-08-21 change added job titles to the invite menu and did not carry
// them into the scoping gate. Nothing failed; a new title simply meant a rep who
// could read everything. That is now impossible in two directions.
//
// 1. Every role the invite menu OFFERS must be a deliberate decision. Being
//    confined is the default, so a forgotten role is merely over-scoped rather
//    than leaking — but silently over-scoping empties someone's board, so it
//    still has to be a decision somebody made on purpose.
for (const { value } of OASIS_SALES_ROLE_OPTIONS) {
  const confined = SELF_SCOPED_ROLES.has(value);
  const tenantWide = TENANT_WIDE_ROLES.has(value);
  assert.equal(
    confined !== tenantWide,
    true,
    `invite menu offers "${value}" but it is in ${confined && tenantWide ? "BOTH" : "NEITHER"} ` +
      `SELF_SCOPED_ROLES nor/and TENANT_WIDE_ROLES — classify it in exactly one`,
  );
}
// 2. The two sets must never overlap. An overlap is not a compile error and
//    would make the answer depend on which predicate a given door happened to
//    call, which is the drift this whole module exists to prevent.
for (const role of SELF_SCOPED_ROLES) {
  assert.equal(
    TENANT_WIDE_ROLES.has(role),
    false,
    `"${role}" is in BOTH role sets — the two doors would disagree about it`,
  );
}
// 3. Consistency between the two predicates on every KNOWN role: anything on
//    the self-scoped list must also be confined by the fail-closed predicate.
//    They answer different questions and may differ on UNKNOWN input by design,
//    but they must never contradict each other on a role we recognise.
for (const role of SELF_SCOPED_ROLES) {
  assert.equal(
    mustSeeOwnRecordsOnly(role),
    true,
    `"${role}" is self-scoped but the fail-closed predicate would let it read the tenant`,
  );
}

// The GET list branch consults it alongside the flag.
assert.match(
  src,
  /SCOPED_ENTITIES\.has\(entityName\) &&\s*\(leadScopingEnabled\(\) \|\| mustScopeRegardlessOfFlag\(r\.team_role, r\.is_admin\)\)/,
  "GET must scope when EITHER the flag is on OR the viewer is an agent",
);

// resolveContext has to actually carry the role, or the gate reads undefined
// and silently never fires — the failure mode this test exists to catch.
assert.match(src, /team_role: profile\.team_role \|\| "read_only"/,
  "resolveContext must return team_role, defaulting closed");
assert.match(src, /ok: true; tenant_id: string; is_admin: boolean; team_role: string/,
  "the resolveContext success type must include team_role");

// Behaviour of the scope resolver the gate routes agents into: an agent is
// pinned to their own id, and a missing identity fails closed rather than open.
assert.equal(
  resolveAssignedScope({ isAdmin: false, userId: "ABC-123" }, undefined, true),
  "abc-123",
  "a non-admin must be locked to their own user id",
);
assert.notEqual(
  resolveAssignedScope({ isAdmin: false, userId: "" }, undefined, true),
  undefined,
  "a non-admin with no identity must NOT resolve to the see-everything scope",
);
// An admin may still narrow to a specific rep's board or the unassigned pile.
assert.equal(resolveAssignedScope({ isAdmin: true, userId: "x" }, { unassigned: true }, true), null);
assert.equal(
  resolveAssignedScope({ isAdmin: true, userId: "x" }, { agent: "REP-9" }, true),
  "rep-9",
);

console.log("agent-api-scope ok — contractor cannot list the tenant via the records API");
