import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveUserEnabledAgentSlugs } from "../lib/manifest/agent-roster";

const tenantAgents = [
  { slug: "bravo", enabled: true, core: true },
  { slug: "atlas", enabled: true, core: true },
  { slug: "maven", enabled: true, core: true },
  { slug: "aura", enabled: true, core: true },
  { slug: "hermes", enabled: true },
  { slug: "lex", enabled: true },
  { slug: "solara", enabled: true },
  { slug: "helios", enabled: true },
];

for (const role of ["opener", "manager", "builder"]) {
  assert.deepEqual(
    resolveUserEnabledAgentSlugs({
      manifestAgents: tenantAgents,
      profileAgents: ["bravo"],
    }),
    ["bravo"],
    `${role}'s Bravo-only profile must deny founder, legal, commerce, and SunBiz agents`,
  );
}

assert.deepEqual(
  resolveUserEnabledAgentSlugs({
    manifestAgents: tenantAgents,
    profileAgents: ["bravo", "atlas", "maven", "aura"],
  }),
  ["bravo", "atlas", "maven", "aura"],
  "an owner/admin profile keeps its intended four-agent roster",
);

assert.deepEqual(
  resolveUserEnabledAgentSlugs({
    manifestAgents: tenantAgents,
    profileAgents: ["BRAVO", "sunbiz", "lex", "hermes"],
  }),
  ["bravo", "hermes", "lex", "solara"],
  "profile entries are normalized, but still intersected with the tenant manifest",
);

assert.deepEqual(
  resolveUserEnabledAgentSlugs({
    manifestAgents: tenantAgents,
    profileAgents: [],
  }),
  [],
  "an empty per-user allowlist fails closed even when the tenant has agents",
);

assert.deepEqual(
  resolveUserEnabledAgentSlugs({
    manifestAgents: null,
    profileAgents: ["BRAVO", "bravo", "sunbiz"],
  }),
  ["bravo", "solara"],
  "legacy tenants without a manifest remain restricted to the normalized profile roster",
);

assert.deepEqual(
  resolveUserEnabledAgentSlugs({
    manifestAgents: tenantAgents,
    profileAgents: ["bravo"],
    operatorBypassAgents: ["bravo", "atlas", "maven", "aura", "hermes", "lex", "solara", "helios"],
  }),
  ["bravo", "atlas", "maven", "aura", "hermes", "lex", "solara", "helios"],
  "the explicit operator bypass may use the global conversational fleet",
);

const root = process.cwd();
const tenantScope = readFileSync(join(root, "lib", "manifest", "tenant-scope.ts"), "utf8");
assert.match(
  tenantScope,
  /export async function isUserTenantChatAgent/,
  "direct APIs need one user-aware authorization gate",
);
assert.ok(
  !tenantScope.includes("new Set([...manifestAgents, ...empireAgents])"),
  "tenant-scope must not union every employee with the global fleet",
);

const chatAuth = readFileSync(join(root, "lib", "chat-auth.ts"), "utf8");
assert.ok(
  chatAuth.includes("isUserTenantChatAgent"),
  "chat authorization must reject a disallowed agent before dispatch",
);
assert.match(
  chatAuth,
  /select\("tenant_id, agents_enabled"\)/,
  "chat authorization must read the employee's own agent allowlist",
);

for (const file of [
  join(root, "app", "api", "chat", "sessions", "route.ts"),
  join(root, "app", "api", "agent-config", "route.ts"),
  join(root, "app", "api", "agent-config", "bulk-provider", "route.ts"),
  join(root, "app", "api", "bridge", "chat", "route.ts"),
  join(root, "app", "api", "cron-jobs", "route.ts"),
]) {
  const source = readFileSync(file, "utf8");
  assert.ok(
    source.includes("isUserTenantChatAgent") || source.includes("getUserTenantChatAgentKeys"),
    `${file} must apply the per-user allowlist to direct requests`,
  );
}

const profileRoute = readFileSync(join(root, "app", "api", "profile", "route.ts"), "utf8");
assert.ok(
  profileRoute.includes('if ("agents_enabled" in body)'),
  "a user must not be able to grant themselves another agent through PATCH /api/profile",
);
assert.ok(
  profileRoute.includes("agent_roster_managed_by_workspace"),
  "self-service roster escalation must fail explicitly",
);

const agentActions = readFileSync(join(root, "lib", "agent-actions.ts"), "utf8");
assert.ok(
  agentActions.includes('error: "agent roster is managed by workspace provisioning"'),
  "the legacy chat marker must not mutate agents_enabled",
);
assert.ok(
  !agentActions.includes('.update({ agents_enabled:'),
  "no chat action may write the employee agent allowlist",
);

const shell = readFileSync(join(root, "lib", "chat-shell-props.ts"), "utf8");
assert.ok(
  shell.includes("resolveUserEnabledAgentSlugs"),
  "the persistent chat picker must use the same per-user intersection",
);

console.log("per-user-agent-authorization ok");
