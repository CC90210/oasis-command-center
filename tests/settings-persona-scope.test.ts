import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideProfileEdit } from "../lib/profile-edit-policy";
import {
  chooseActiveProfile,
  type ActiveUserProfile,
} from "../lib/active-profile-resolver";

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const page = read("app/settings/page.tsx");
assert.ok(
  page.includes("if (!surface.ok || !surface.capabilities.canSeePersonalSettings) notFound();"),
  "an unknown/unauthenticated Settings surface must fail closed before rendering personal data",
);

const settings = read("components/settings/SettingsContent.tsx");
const personalBranch = settings.indexOf("if (profile && !canManageTenant)");
const integrationHealthRead = settings.indexOf('safe("settings.integrations_health"');
assert.ok(personalBranch >= 0, "non-admins need an explicit personal-only Settings branch");
assert.ok(
  integrationHealthRead > personalBranch,
  "the personal-only branch must return before system integration/provider/device data is queried",
);
assert.ok(settings.includes("showTeamPerformance={canSeeTeamPerformance && oasisSalesWorkspace}"));
assert.ok(
  read("app/settings/page.tsx").includes("degraded: surface.degraded") &&
    settings.includes("Team access status unavailable") &&
    settings.includes("team performance is temporarily hidden"),
  "a tenant-slug lookup failure must be disclosed instead of silently removing manager tools",
);
assert.equal(
  settings.match(/<ProfileEditor profile=\{profile\} tenantAgents=\{\[\]\} personalOnly \/>/g)?.length,
  2,
  "both direct personal Settings and tenant-preview Settings must hide business/agent fields",
);

const activity = read("lib/audit/activity-feed.ts");
assert.ok(activity.includes('scope?: "workspace" | "sales_team"'));
assert.ok(activity.includes('query.in("actor_user_id", [...allowedSalesIds])'));
assert.ok(
  activity.match(/if \(!salesTeamScope\) try/g)?.length === 4,
  "manager mode must skip audit, agent-event, chat, and cron sources",
);

const managerPanel = read("components/settings/SalesTeamOperationsPanel.tsx");
for (const forbidden of ["tenant_cron_jobs", "agent_events", "chat_sessions", "/automations", "/sequences"]) {
  assert.equal(
    managerPanel.includes(forbidden),
    false,
    `manager scorecard must not receive ${forbidden}`,
  );
}

const salesPerformance = read("lib/audit/sales-performance.ts");
assert.ok(
  salesPerformance.includes("getOasisSalesRepRoster(tenantId)"),
  "the scorecard must use the same canonical roster as the manager pipeline",
);
assert.equal(
  salesPerformance.includes("OASIS_SALES_ROLES"),
  false,
  "the scorecard must not define a second role population that can admit owner/admin books",
);

const personalStatus = read("app/api/integrations/personal/status/route.ts");
assert.ok(personalStatus.includes('availability: "unavailable"'));
assert.ok(personalStatus.includes("{ status: 503 }"));

const profileApi = read("app/api/profile/route.ts");
assert.ok(
  profileApi.includes("decideProfileEdit(body") &&
    profileApi.includes('.eq("id", currentProfile.id)'),
  "the profile API must authorize and update only the canonical profile row",
);
for (const teamRole of ["manager", "closer", "opener", "builder", "marketing", "agent"]) {
  assert.deepEqual(
    decideProfileEdit({ brand: "forged" }, { teamRole, isOwner: false, adminAccess: false }),
    { ok: false, status: 403, error: "workspace settings require admin access" },
    `${teamRole} must receive the policy's HTTP 403 decision for business settings`,
  );
}
for (const actor of [
  { teamRole: "owner", isOwner: true, adminAccess: false },
  { teamRole: "admin", isOwner: false, adminAccess: false },
  { teamRole: "closer", isOwner: false, adminAccess: true },
]) {
  assert.deepEqual(decideProfileEdit({ brand: "OASIS" }, actor), {
    ok: true,
    update: { brand: "OASIS" },
  });
}
assert.deepEqual(
  decideProfileEdit({ full_name: "Ethan" }, { teamRole: "manager", isOwner: false, adminAccess: false }),
  { ok: true, update: { full_name: "Ethan" } },
  "a manager still owns personal profile fields",
);

const duplicateRows = [
  {
    id: "stale",
    email: "ethan@oasisai.work",
    is_owner: false,
    onboarding_completed_at: null,
  },
  {
    id: "active",
    email: "ethan@oasisai.work",
    is_owner: false,
    onboarding_completed_at: "2026-08-31T00:00:00.000Z",
  },
] as ActiveUserProfile[];
assert.equal(
  chooseActiveProfile(duplicateRows, "ethan@oasisai.work").id,
  "active",
  "legacy duplicate profiles must resolve deterministically instead of making Settings 404",
);
const staleAdmin = {
  ...duplicateRows[1],
  id: "stale-admin",
  team_role: "admin",
  updated_at: "2026-08-01T00:00:00.000Z",
};
const currentManager = {
  ...duplicateRows[1],
  id: "current-manager",
  team_role: "manager",
  updated_at: "2026-08-31T00:00:00.000Z",
};
assert.equal(
  chooseActiveProfile([staleAdmin, currentManager] as ActiveUserProfile[], "ethan@oasisai.work").id,
  "current-manager",
  "a stale admin duplicate must not elevate a more recently updated manager profile",
);
assert.equal(
  chooseActiveProfile(
    [
      { ...currentManager, id: "z-profile", updated_at: "2026-08-31T00:00:00.000Z" },
      { ...currentManager, id: "a-profile", updated_at: "2026-08-31T00:00:00.000Z" },
    ] as ActiveUserProfile[],
    "ethan@oasisai.work",
  ).id,
  "a-profile",
  "equal duplicate rows need a stable primary-key tiebreaker",
);
for (const consumer of ["lib/api-auth.ts", "lib/queries.ts", "app/api/profile/route.ts"]) {
  assert.ok(
    read(consumer).includes("resolveActiveProfileForUser"),
    `${consumer} must use the shared duplicate-safe profile resolver`,
  );
}

console.log("settings-persona-scope.test.ts: OK");
