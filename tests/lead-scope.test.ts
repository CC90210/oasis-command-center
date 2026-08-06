import assert from "node:assert/strict";
import {
  NO_LEADS,
  resolveAssignedScope,
  assignedWhere,
  canViewLead,
  filterRowsByScope,
  normalizeCollaborators,
  recordMatchesViewer,
  isAdminProfile,
  leadScopingMode,
  leadFiltersEnabled,
} from "../lib/lead-scope";

// Per-agent lead scoping (Adon Batch 2). These lock the fail-closed contract:
// an agent is ALWAYS scoped to their own leads; an unresolved identity gets
// zero rows, never the full pool.

const AGENT = { isAdmin: false, userId: "9dfee2b3-6a19-447d-9ad0-751d2a0c90c1" };
const ADMIN = { isAdmin: true, userId: "11111111-1111-1111-1111-111111111111" };

// --- resolveAssignedScope ---
// Agent → always their own id (lowercased), ignoring any requested filter.
assert.equal(resolveAssignedScope(AGENT), AGENT.userId);
assert.equal(
  resolveAssignedScope(AGENT, { agent: "someone-else", unassigned: true }),
  AGENT.userId,
  "an agent cannot widen their own scope via filter params",
);
// Agent with no identity → fail closed (NO_LEADS), never undefined (= all).
assert.equal(resolveAssignedScope({ isAdmin: false, userId: null }), NO_LEADS);

// Admin → all by default, or the requested narrowing.
assert.equal(resolveAssignedScope(ADMIN), undefined, "admin default = all leads");
assert.equal(leadFiltersEnabled(ADMIN, false), true, "admins keep agent-filter tabs when scoping rollout is off");
assert.equal(leadFiltersEnabled(AGENT, false), false, "ordinary agents do not gain tenant-wide filter tabs");
assert.equal(resolveAssignedScope(ADMIN, { unassigned: true }), null, "admin unassigned bucket");
assert.equal(
  resolveAssignedScope(ADMIN, { agent: "ABC-123" }),
  "abc-123",
  "admin agent filter is lowercased to match stored assigned_to",
);

// --- assignedWhere ---
assert.equal(assignedWhere(undefined), undefined, "undefined scope = no where filter");
assert.deepEqual(assignedWhere(AGENT.userId), { assigned_to: AGENT.userId });
assert.deepEqual(assignedWhere(null), { assigned_to: null }, "unassigned → IS NULL filter");
assert.deepEqual(assignedWhere(NO_LEADS), { assigned_to: NO_LEADS }, "fail-closed → matches nothing");

// --- canViewLead ---
assert.equal(canViewLead(ADMIN, { assigned_to: "anyone" }), true, "admin sees any lead");
assert.equal(canViewLead(AGENT, { assigned_to: AGENT.userId }), true, "agent sees own lead");
assert.equal(
  canViewLead(AGENT, { assigned_to: AGENT.userId.toUpperCase() }),
  true,
  "owner match is case-insensitive",
);
assert.equal(canViewLead(AGENT, { assigned_to: "other-agent" }), false, "agent denied other's lead");
assert.equal(canViewLead(AGENT, {}), false, "agent denied an unassigned lead");
assert.equal(
  canViewLead({ isAdmin: false, userId: null }, { assigned_to: "x" }),
  false,
  "no identity → denied",
);

// --- filterRowsByScope (in-memory guard for lists not run through where) ---
const rows = [
  { data: { assigned_to: AGENT.userId } },
  { data: { assigned_to: "other" } },
  { data: {} },
];
assert.equal(filterRowsByScope(rows, undefined).length, 3, "undefined = pass everything");
assert.equal(filterRowsByScope(rows, AGENT.userId).length, 1, "own only");
assert.equal(filterRowsByScope(rows, null).length, 1, "unassigned only");
assert.equal(filterRowsByScope(rows, NO_LEADS).length, 0, "fail-closed = nothing");

// --- normalizeCollaborators ---
assert.deepEqual(normalizeCollaborators({}), [], "absent → []");
assert.deepEqual(normalizeCollaborators({ collaborators: "x" }), [], "non-array → []");
assert.deepEqual(
  normalizeCollaborators({ collaborators: ["A-B", "a-b", "  C  ", 5, null] }),
  ["a-b", "c"],
  "lowercased, trimmed, deduped, junk dropped",
);

// --- recordMatchesViewer (owner OR collaborator; admin = all) ---
const COLLAB = { isAdmin: false, userId: "22222222-2222-2222-2222-222222222222" };
const sharedDeal = { assigned_to: AGENT.userId, collaborators: [COLLAB.userId] };
assert.equal(recordMatchesViewer(sharedDeal, AGENT), true, "owner sees shared deal");
assert.equal(recordMatchesViewer(sharedDeal, COLLAB), true, "collaborator sees shared deal");
assert.equal(
  recordMatchesViewer(sharedDeal, { isAdmin: false, userId: "33333333-3333-3333-3333-333333333333" }),
  false,
  "non-owner non-collaborator agent denied",
);
assert.equal(recordMatchesViewer(sharedDeal, ADMIN), true, "admin sees shared deal");
assert.equal(
  recordMatchesViewer({ assigned_to: "x", collaborators: [COLLAB.userId.toUpperCase()] }, COLLAB),
  true,
  "collaborator match is case-insensitive",
);
assert.equal(recordMatchesViewer(sharedDeal, COLLAB, false), true, "flag off → everyone sees");
assert.equal(
  recordMatchesViewer(sharedDeal, { isAdmin: false, userId: null }),
  false,
  "no identity → denied even if listed nowhere",
);

// canViewLead now honors collaborators (delegates to recordMatchesViewer)
assert.equal(canViewLead(COLLAB, sharedDeal), true, "collaborator may open the record");

// --- isAdminProfile (single source of truth for admin detection) ---
assert.equal(isAdminProfile({ is_owner: true, team_role: "member" }), true, "owner is admin");
assert.equal(isAdminProfile({ is_owner: false, team_role: "admin" }), true, "admin role is admin");
assert.equal(isAdminProfile({ is_owner: false, team_role: "owner" }), true, "owner role is admin");
assert.equal(isAdminProfile({ is_owner: false, team_role: "member" }), false, "member is not admin");
assert.equal(isAdminProfile({ is_owner: null, team_role: null }), false, "nulls → not admin");
assert.equal(isAdminProfile(null), false, "missing profile → not admin");

// --- filter mode (Adon 2026-06-24): board scoped, but VIEW/open any lead global ---
// Action gates pass mode:"isolate" explicitly, so the strict path must still work.
const OTHER = { assigned_to: "someone-else" };
assert.equal(recordMatchesViewer(OTHER, AGENT, true, "isolate"), false, "isolate: agent denied other's lead");
assert.equal(canViewLead(AGENT, OTHER, true, "isolate"), false, "isolate: agent can't open other's lead");
// filter: any RESOLVED member may view ANY lead
assert.equal(recordMatchesViewer(OTHER, AGENT, true, "filter"), true, "filter: agent may VIEW any lead");
assert.equal(canViewLead(AGENT, OTHER, true, "filter"), true, "filter: agent may OPEN any lead");
// filter still fails closed on an unresolved identity (no fail-open)
assert.equal(
  recordMatchesViewer(OTHER, { isAdmin: false, userId: null }, true, "filter"),
  false,
  "filter: unresolved identity still denied (fail-closed)",
);
// filter still honors the rollout flag being off + admins unaffected by mode
assert.equal(recordMatchesViewer(OTHER, AGENT, false, "filter"), true, "flag off → everyone sees regardless of mode");
assert.equal(canViewLead(ADMIN, OTHER, true, "filter"), true, "admin sees all in filter mode");
assert.equal(canViewLead(ADMIN, OTHER, true, "isolate"), true, "admin sees all in isolate mode");

// --- leadScopingMode env parsing (reset env after; keep default-mode tests above pure) ---
const _savedMode = process.env.LEAD_SCOPING_MODE;
delete process.env.LEAD_SCOPING_MODE;
assert.equal(leadScopingMode(), "isolate", "default mode is isolate");
process.env.LEAD_SCOPING_MODE = "filter";
assert.equal(leadScopingMode(), "filter", "LEAD_SCOPING_MODE=filter → filter");
process.env.LEAD_SCOPING_MODE = "FILTER";
assert.equal(leadScopingMode(), "filter", "case-insensitive");
process.env.LEAD_SCOPING_MODE = "nonsense";
assert.equal(leadScopingMode(), "isolate", "unknown value → isolate (safe default)");
if (_savedMode === undefined) delete process.env.LEAD_SCOPING_MODE;
else process.env.LEAD_SCOPING_MODE = _savedMode;

console.log("lead-scope tests passed");
