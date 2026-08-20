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
 * flag for legacy roles, and an unconditional scope for agents.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveAssignedScope } from "../lib/lead-scope";

const ROUTE = "app/api/manifest/[slug]/records/[entity]/route.ts";
const src = readFileSync(ROUTE, "utf8");

// The guard function exists and is keyed on the agent role, not on "not admin"
// alone — widening it to every non-admin would empty SunBiz boards, which is
// exactly what the staging flag was protecting against.
assert.match(
  src,
  /function mustScopeRegardlessOfFlag\(\s*teamRole: string,\s*isAdmin: boolean\s*\)/,
  "mustScopeRegardlessOfFlag must exist with (teamRole, isAdmin)",
);
assert.match(
  src,
  /return !isAdmin && teamRole === "agent";/,
  "the unconditional scope must apply to the agent role specifically",
);

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
