import assert from "node:assert/strict";
import {
  canViewerRead,
  visibleToViewer,
  isScopedContractor,
  type Viewer,
} from "../lib/web-leads/data";

// Web Leads contractor scoping (fix for the branch that reopened #237,
// 26ecc31a). `agent` is the commission-only OUTSIDE CONTRACTOR role added
// for website sales -- it lives INSIDE the Web Studio tenant, so a tenant
// check alone (session.tenantId === WEBDEV_TENANT_ID) is not proof a caller
// may see every lead in it. These pin the pure scoping predicate the data
// layer and all three routes rely on.

const ADMIN: Viewer = { userId: "11111111-1111-1111-1111-111111111111", teamRole: "member", isAdmin: true };
const MEMBER: Viewer = { userId: "22222222-2222-2222-2222-222222222222", teamRole: "member", isAdmin: false };
const AGENT: Viewer = { userId: "9dfee2b3-6a19-447d-9ad0-751d2a0c90c1", teamRole: "agent", isAdmin: false };
const ADMIN_AGENT: Viewer = { userId: "33333333-3333-3333-3333-333333333333", teamRole: "agent", isAdmin: true };
const MANAGER: Viewer = {
  userId: "manager-1",
  teamRole: "manager",
  isAdmin: false,
  readableAssigneeIds: ["manager-1", "rep-1", "rep-2"],
};

// --- isScopedContractor ---
assert.equal(isScopedContractor(ADMIN), false, "an admin is never scoped, regardless of teamRole");
assert.equal(isScopedContractor(MEMBER), false, "an established non-agent role is unrestricted");
assert.equal(isScopedContractor(AGENT), true, "the outside-contractor role is always scoped");
assert.equal(
  isScopedContractor(ADMIN_AGENT),
  false,
  "admin status overrides an agent teamRole -- mirrors #237's mustScopeRegardlessOfFlag(teamRole, isAdmin)",
);

// --- visibleToViewer: admin sees all ---
assert.equal(visibleToViewer(null, ADMIN), true, "admin sees an unassigned lead");
assert.equal(visibleToViewer("someone-else", ADMIN), true, "admin sees a lead assigned to anyone else");
assert.equal(visibleToViewer(ADMIN.userId, ADMIN), true, "admin sees a lead assigned to themself");

// --- visibleToViewer: a non-admin non-agent (established SunBiz role) sees all ---
assert.equal(visibleToViewer(null, MEMBER), true, "non-agent sees an unassigned lead");
assert.equal(visibleToViewer("someone-else", MEMBER), true, "non-agent sees a lead assigned to anyone else -- SunBiz's staged rollout is untouched by this fix");

// --- visibleToViewer: an agent sees only their own ---
assert.equal(visibleToViewer(AGENT.userId, AGENT), true, "agent sees a lead assigned to themself");
assert.equal(visibleToViewer("someone-else", AGENT), false, "agent must NOT see a lead assigned to someone else");

// --- visibleToViewer: an agent with nothing assigned sees zero ---
assert.equal(
  visibleToViewer(null, AGENT),
  false,
  "nothing assigns web-leads territories yet -- a fresh contractor must see zero leads, not everything (fail closed)",
);

// --- visibleToViewer: casing differences still match ---
assert.equal(
  visibleToViewer(AGENT.userId.toUpperCase(), AGENT),
  true,
  "assigned_to compares case-insensitively, same convention as lib/lead-scope.ts",
);
assert.equal(
  visibleToViewer(AGENT.userId, { ...AGENT, userId: AGENT.userId.toUpperCase() }),
  true,
  "the viewer's own userId casing must not defeat the match either",
);
assert.equal(
  visibleToViewer("  " + AGENT.userId + "  ", AGENT),
  true,
  "surrounding whitespace on the stored assigned_to must not defeat the match",
);

// --- manager: server roster widens assigned READ only ---
assert.equal(
  visibleToViewer("REP-2", MANAGER),
  true,
  "a manager may read a lead assigned to a server-resolved sales rep",
);
assert.equal(
  visibleToViewer("founder-1", MANAGER),
  false,
  "a manager roster cannot expose founder/admin/system assignments",
);
assert.equal(
  visibleToViewer(null, MANAGER),
  false,
  "the roster expansion itself never authorizes unassigned leads",
);
assert.equal(
  visibleToViewer("rep-2", { ...AGENT, readableAssigneeIds: ["rep-2"] }),
  false,
  "supplying readable ids cannot widen a non-manager role",
);
assert.equal(
  canViewerRead(
    { assigned_to: "rep-2", stage: "assigned", claimed_at: "2026-08-31T12:00:00.000Z" },
    MANAGER,
    Date.parse("2026-08-31T12:01:00.000Z"),
  ),
  true,
  "the by-id battlecard door honors the same roster-scoped manager read",
);
assert.equal(
  canViewerRead(
    { assigned_to: null, stage: "researched" },
    MANAGER,
    Date.parse("2026-08-31T12:01:00.000Z"),
  ),
  false,
  "a manager cannot bypass the roster by opening an unassigned claimable lead by id",
);
assert.equal(
  canViewerRead(
    { assigned_to: MANAGER.userId, stage: "assigned" },
    { ...MANAGER, readableAssigneeIds: [] },
    Date.parse("2026-08-31T12:01:00.000Z"),
  ),
  true,
  "a manager retains their own assigned lead even if the roster lookup omits their seat",
);

console.log("web-leads-scope ok");
