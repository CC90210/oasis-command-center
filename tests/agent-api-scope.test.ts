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
import { isSelfScopedRole } from "../lib/team-roles";
import { OASIS_SALES_ROLE_OPTIONS } from "../lib/team-roles";

const ROUTE = "app/api/manifest/[slug]/records/[entity]/route.ts";
const src = readFileSync(ROUTE, "utf8");

// The guard function exists with the same signature. Still a source match:
// it is module-private to the route and cannot be imported.
assert.match(
  src,
  /function mustScopeRegardlessOfFlag\(\s*teamRole: string,\s*isAdmin: boolean\s*\)/,
  "mustScopeRegardlessOfFlag must exist with (teamRole, isAdmin)",
);
// It must delegate the role question to the SHARED set, not re-decide it here.
// Two doors onto tenant_records deciding "is this person scoped" independently
// is how the first leak happened; the shared predicate is what stops them
// drifting apart again.
assert.match(
  src,
  /return !isAdmin && isSelfScopedRole\(teamRole\);/,
  "the gate must delegate to the shared isSelfScopedRole predicate",
);
assert.match(
  src,
  /import \{ isSelfScopedRole \} from "@\/lib\/team-roles";/,
  "the route must import the shared predicate rather than copy the list",
);

// ── The behavioural half: WHO is scoped. ────────────────────────────────────
// `agent` is legacy but still live on real rows, so dropping it would unscope
// every rep working today.
for (const role of ["agent", "opener", "closer", "builder"]) {
  assert.equal(
    isSelfScopedRole(role),
    true,
    `${role} must be scoped to its own book — an unscoped one reads all ~31K leads`,
  );
}
// Roles that legitimately see the tenant must NOT be swept in. Widening this to
// every non-admin would empty SunBiz's boards, which is what the staging flag
// was protecting against in the first place.
for (const role of ["owner", "admin", "manager", "read_only", "loan_officer", "processor"]) {
  assert.equal(
    isSelfScopedRole(role),
    false,
    `${role} must not be force-scoped — that empties established SunBiz boards`,
  );
}
// Fails closed on junk: an unrecognised value is not a free pass.
assert.equal(isSelfScopedRole(undefined), false, "undefined is not a role");
assert.equal(isSelfScopedRole(""), false, "empty string is not a role");
assert.equal(isSelfScopedRole("AGENT"), true, "role matching must be case-insensitive");

// ── The drift guard, and the reason this file is worth keeping. ─────────────
// The 2026-08-21 change added job titles to the invite menu and did not carry
// them into the scoping gate. Nothing failed; a new title simply meant a rep
// who could read everything. This asserts the two lists cannot separate again:
// every OASIS sales title the invite menu OFFERS must be a decided question
// here, either self-scoped or explicitly trusted with the tenant.
const TENANT_WIDE_BY_DESIGN = new Set(["manager", "marketing"]);
for (const { value } of OASIS_SALES_ROLE_OPTIONS) {
  const decided = isSelfScopedRole(value) || TENANT_WIDE_BY_DESIGN.has(value);
  assert.equal(
    decided,
    true,
    `invite menu offers "${value}" but no scoping decision exists for it — ` +
      `add it to SELF_SCOPED_ROLES, or to TENANT_WIDE_BY_DESIGN here if it is ` +
      `genuinely meant to read the whole tenant`,
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
