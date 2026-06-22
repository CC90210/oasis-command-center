import assert from "node:assert/strict";
import {
  NO_LEADS,
  resolveAssignedScope,
  assignedWhere,
  canViewLead,
  filterRowsByScope,
  normalizeCollaborators,
  recordMatchesViewer,
  filterRowsByViewer,
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

// --- filterRowsByViewer (in-memory, owner OR collaborator) ---
const vrows = [
  { data: { assigned_to: AGENT.userId } }, // owned by AGENT
  { data: { assigned_to: "other", collaborators: [COLLAB.userId] } }, // shared with COLLAB
  { data: { assigned_to: "other" } }, // neither
];
assert.equal(filterRowsByViewer(vrows, ADMIN).length, 3, "admin sees all");
assert.equal(filterRowsByViewer(vrows, AGENT).length, 1, "agent sees own only");
assert.equal(filterRowsByViewer(vrows, COLLAB).length, 1, "collaborator sees shared only");
assert.equal(filterRowsByViewer(vrows, AGENT, false).length, 3, "flag off → all");

console.log("lead-scope tests passed");
