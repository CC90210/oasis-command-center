import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionContext } from "../lib/api-auth";
import { resolveWebLeadViewer } from "../lib/web-leads/viewer";

type ResolvedSession = Extract<SessionContext, { ok: true }>;

async function main() {
const manager: ResolvedSession = {
  ok: true,
  userId: "manager-1",
  profileId: "profile-manager",
  tenantId: "tenant-oasis",
  email: "manager@example.com",
  teamRole: "manager",
  isAdmin: false,
  isTrueAdmin: false,
  adminAccess: false,
};

let slugReads = 0;
let rosterReads = 0;
const managerViewer = await resolveWebLeadViewer(manager, {
  resolveTenantSlug: async (tenantId) => {
    slugReads += 1;
    assert.equal(tenantId, manager.tenantId);
    return "OASIS-AI-CC";
  },
  listSalesRoster: async (tenantId) => {
    rosterReads += 1;
    assert.equal(tenantId, manager.tenantId);
    return [
      { auth_user_id: " REP-1 " },
      { auth_user_id: "rep-1" },
      { auth_user_id: "Rep-2" },
      { auth_user_id: "" },
      { auth_user_id: null },
      {},
    ];
  },
});
assert.equal(slugReads, 1, "a manager resolves the tenant slug once");
assert.equal(rosterReads, 1, "an authorized OASIS manager resolves the roster once");
assert.deepEqual(
  managerViewer,
  {
    userId: manager.userId,
    teamRole: manager.teamRole,
    isAdmin: false,
    readableAssigneeIds: ["rep-1", "rep-2"],
  },
  "the read expansion is normalized, de-duplicated, and contains no empty identities",
);

rosterReads = 0;
const foreignManagerViewer = await resolveWebLeadViewer(manager, {
  resolveTenantSlug: async () => "sun-business-finance",
  listSalesRoster: async () => {
    rosterReads += 1;
    return [{ auth_user_id: "rep-1" }];
  },
});
assert.equal(rosterReads, 0, "a manager outside an OASIS surface never reads the roster");
assert.equal(
  "readableAssigneeIds" in foreignManagerViewer,
  false,
  "a manager title alone cannot widen another tenant's lead access",
);

await assert.rejects(
  () =>
    resolveWebLeadViewer(manager, {
      resolveTenantSlug: async () => null,
      listSalesRoster: async () => [{ auth_user_id: "rep-1" }],
    }),
  /web_lead_viewer_tenant_slug_unavailable/,
  "an unresolved manager tenant fails loudly instead of collapsing to an empty own book",
);

const opener: ResolvedSession = {
  ...manager,
  userId: "opener-1",
  profileId: "profile-opener",
  teamRole: "opener",
};
slugReads = 0;
rosterReads = 0;
const openerViewer = await resolveWebLeadViewer(opener, {
  resolveTenantSlug: async () => {
    slugReads += 1;
    return "oasis-ai-cc";
  },
  listSalesRoster: async () => {
    rosterReads += 1;
    return [{ auth_user_id: "rep-2" }];
  },
});
assert.equal(slugReads, 0, "a non-manager does not pay for a tenant-slug read");
assert.equal(rosterReads, 0, "a non-manager can never consume the manager roster");
assert.equal("readableAssigneeIds" in openerViewer, false);

const admin: ResolvedSession = {
  ...manager,
  userId: "admin-1",
  profileId: "profile-admin",
  teamRole: "admin",
  isAdmin: true,
  isTrueAdmin: true,
};
slugReads = 0;
rosterReads = 0;
const adminViewer = await resolveWebLeadViewer(admin, {
  resolveTenantSlug: async () => {
    slugReads += 1;
    return "oasis-ai-cc";
  },
  listSalesRoster: async () => {
    rosterReads += 1;
    return [{ auth_user_id: "rep-1" }];
  },
});
assert.deepEqual(adminViewer, {
  userId: admin.userId,
  teamRole: admin.teamRole,
  isAdmin: true,
});
assert.equal(slugReads, 0, "admin behavior does not depend on tenant-slug lookup");
assert.equal(rosterReads, 0, "admin behavior does not depend on a sales roster");

const toggledManager: ResolvedSession = {
  ...manager,
  isAdmin: true,
  adminAccess: true,
};
const toggledViewer = await resolveWebLeadViewer(toggledManager, {
  resolveTenantSlug: async () => {
    throw new Error("admin manager should not resolve a tenant slug");
  },
  listSalesRoster: async () => {
    throw new Error("admin manager should not resolve a roster");
  },
});
assert.equal(toggledViewer.isAdmin, true, "the admin_access grant remains fully additive");
assert.equal("readableAssigneeIds" in toggledViewer, false);

await assert.rejects(
  () =>
    resolveWebLeadViewer(manager, {
      resolveTenantSlug: async () => "oasis-ai-cc",
      listSalesRoster: async () => {
        throw new Error("roster unavailable");
      },
    }),
  /roster unavailable/,
  "a broken roster fails loudly instead of rendering a plausible empty team view",
);

const root = process.cwd();
for (const route of [
  "app/api/web-leads/route.ts",
  "app/api/web-leads/facets/route.ts",
  "app/api/web-leads/[id]/route.ts",
  "app/api/web-leads/[id]/audit/route.ts",
  "app/api/web-leads/[id]/battlecard/route.ts",
]) {
  const source = readFileSync(join(root, route), "utf8");
  assert.match(
    source,
    /resolveWebLeadViewer\(session\)/,
    `${route} must use the canonical read-only viewer resolver`,
  );
  assert.doesNotMatch(
    source,
    /getOasisSalesRepRoster|const viewer:\s*Viewer\s*=/,
    `${route} must not reimplement the manager boundary`,
  );
}

const browserSource = readFileSync(
  join(root, "components/web-leads/WebLeadsBrowser.tsx"),
  "utf8",
);
// RE-AIMED 2026-09-02, NOT RELAXED. `teamView` was renamed to `team` and the
// header gained a third case ("Leads" for the shared pool); the landing
// redirect now sends managers to view=team rather than view=mine. These
// assertions pinned the OLD identifiers by exact text, so the rename turned
// them red on `main` while the manager boundary itself never changed. Each
// assertion below still pins the same BEHAVIOUR at its new spelling.
assert.match(
  browserSource,
  /team \? "Team leads" : mine \? "My leads" : "Leads"/,
  "the header must name the queue a manager is actually looking at -- a manager who thinks they are in their own book while reading the roster is the whole risk here",
);
assert.match(
  browserSource,
  /const canOperateCurrentView = canMutate && !team/,
  "the Team view is READ-ONLY: a manager coaches the roster, they do not mutate another rep's lead from it",
);
const pageSource = readFileSync(join(root, "app/web-leads/page.tsx"), "utf8");
assert.match(
  pageSource,
  /if \(isManager && !rawParams\.view\)[\s\S]*?params\.set\("view", "team"\)/,
  "managers land on the roster-scoped Team leads queue unless they explicitly choose the pool",
);
const dataSource = readFileSync(join(root, "lib/web-leads/data.ts"), "utf8");
// RE-AIMED 2026-09-02, NOT RELAXED. This matched "manager check … then
// canViewerRead" as ONE ordered run of file text. The manager check has since
// moved INSIDE canViewerRead, so the only appearance of that order is now
// reversed (the list calls canViewerRead ~200 lines above the definition) and
// the guard could never match again. Same property, asserted at both ends:
// the list routes the team scope through canViewerRead, and canViewerRead is
// where the roster predicate lives — so list and detail cannot drift apart.
assert.match(
  dataSource,
  /scope === "team"\s*\?\s*canViewerRead\(/,
  "the manager's team-book LIST must go through canViewerRead -- the same predicate detail reads use, or the list and the detail page disagree about what a manager may see",
);
assert.match(
  dataSource,
  /export function canViewerRead\([\s\S]*?viewer\.teamRole\.trim\(\)\.toLowerCase\(\) === "manager"[\s\S]*?managerCanReadAssignment\(facts\.assignedTo, viewer\)/,
  "canViewerRead must be where the manager roster predicate lives -- if it moves out, the team list stops being roster-scoped without any caller changing",
);
assert.match(
  dataSource,
  /\.in\("data->>assigned_to", normalized\)/,
  "team/rep queues must be narrowed by their server-resolved assignees before the read leaves the database",
);

console.log("web-leads-manager-access: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
