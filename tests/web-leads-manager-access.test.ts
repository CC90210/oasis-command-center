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
assert.match(browserSource, /teamView \? "Team leads" : "My leads"/);
assert.match(browserSource, /canMutate && !\(teamView && mine\)/);
const pageSource = readFileSync(join(root, "app/web-leads/page.tsx"), "utf8");
assert.match(
  pageSource,
  /if \(teamView && !rawParams\.view\)[\s\S]*?params\.set\("view", "mine"\)/,
  "managers land on the roster-scoped Team leads queue unless they explicitly choose the pool",
);
const dataSource = readFileSync(join(root, "lib/web-leads/data.ts"), "utf8");
assert.match(
  dataSource,
  /viewer\.teamRole\.trim\(\)\.toLowerCase\(\) === "manager"[\s\S]*?canViewerRead/,
  "the manager's team-book list must use the same roster-scoped predicate as detail reads",
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
