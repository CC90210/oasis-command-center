import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveEnabledAgentSlugs } from "../lib/manifest/agent-roster";
import { OASIS_SEED } from "../lib/manifest/seeds";

const ROOT = process.cwd();

assert.deepEqual(
  resolveEnabledAgentSlugs({
    manifestAgents: [
      { slug: "bravo", enabled: true, core: true },
      { slug: "atlas", enabled: true, core: true },
      { slug: "lex", enabled: false },
    ],
    legacyProfileAgents: ["bravo", "atlas", "lex"],
  }),
  ["bravo", "atlas"],
  "a stale per-user profile must not re-enable a manifest-disabled agent",
);

assert.deepEqual(
  resolveEnabledAgentSlugs({
    manifestAgents: [],
    legacyProfileAgents: ["bravo"],
  }),
  [],
  "an intentionally empty manifest remains authoritative",
);

assert.deepEqual(
  resolveEnabledAgentSlugs({
    manifestAgents: null,
    legacyProfileAgents: ["BRAVO", "bravo", "sunbiz"],
  }),
  ["bravo", "solara"],
  "legacy profiles are normalized and deduplicated only when no manifest exists",
);

assert.deepEqual(
  resolveEnabledAgentSlugs({
    manifestAgents: [{ slug: "bravo", enabled: false, core: true }],
  }),
  ["bravo"],
  "a corrupt false flag cannot hide a core always-on agent",
);

const oasisEnabled = resolveEnabledAgentSlugs({ manifestAgents: OASIS_SEED.agents });
assert.deepEqual(
  oasisEnabled,
  ["bravo", "sdr", "maven", "customer-support", "atlas"],
  "the shipped OASIS roster is its five department leads (W4a)",
);
for (const slug of ["aura", "lex", "hermes", "life-preservation"]) {
  assert.ok(
    !OASIS_SEED.agents.some((agent) => agent.slug === slug),
    `${slug} is CC's own agent: it lives in Admin > Fleet, not in OASIS's workspace roster (decision 21)`,
  );
}

const profileEditor = readFileSync(
  join(ROOT, "components", "settings", "ProfileEditor.tsx"),
  "utf8",
);
assert.ok(
  !profileEditor.includes("agents_enabled:"),
  "ProfileEditor must not write a competing per-user enabled-agent roster",
);
assert.ok(
  profileEditor.includes("This list comes from Workspace agents below"),
  "the primary-agent picker must name its canonical source",
);

const settings = readFileSync(
  join(ROOT, "components", "settings", "SettingsContent.tsx"),
  "utf8",
);
// The picker lists the workspace's roster teammates (W4a review R1), and a
// workspace mutation must remount it with the new roster.
assert.ok(
  settings.includes('key={rosterAgentKeys.join(":")}') && settings.includes("tenantAgents={rosterAgentKeys}"),
  "a workspace mutation must remount the profile picker with the new roster",
);

const marketplace = readFileSync(
  join(ROOT, "components", "settings", "AgentMarketplaceCard.tsx"),
  "utf8",
);
assert.ok(
  marketplace.includes("router.refresh()"),
  "Workspace agents must refresh every server-rendered roster consumer",
);
assert.ok(
  !marketplace.includes("Ask Matt"),
  "workspace controls must not name a person from a different tenant",
);

const kixie = readFileSync(
  join(ROOT, "components", "settings", "KixieWebhookSyncCard.tsx"),
  "utf8",
);
assert.ok(
  !kixie.includes("Ask Matt"),
  "integration controls must use the signed-in workspace role, not a hardcoded SunBiz owner",
);

assert.ok(
  settings.includes('manifestSlug === "sun" && <TelegramLinkCard />'),
  "the SunBiz application-alert bot must never mount in OASIS Settings",
);

const chatShell = readFileSync(join(ROOT, "lib", "chat-shell-props.ts"), "utf8");
assert.ok(
  chatShell.includes("enabled.includes(requestedPrimary)"),
  "chat must reject a stale primary agent outside the canonical roster",
);

// P1 instant-load (2026-09-01): the layout's inline resolveEnabledAgentSlugs
// call moved into lib/shell-status.ts resolvePrimaryAgent, shared with
// /api/shell/status so the two cannot drift. The guarantee is unchanged —
// pinned link by link: layout → resolvePrimaryAgent → resolveEnabledAgentSlugs.
assert.ok(
  readFileSync(join(ROOT, "app", "layout.tsx"), "utf8").includes("resolvePrimaryAgent"),
  "app/layout.tsx must resolve the primary agent via the shared manifest-first guard",
);
assert.ok(
  readFileSync(join(ROOT, "lib", "shell-status.ts"), "utf8").includes("resolveEnabledAgentSlugs"),
  "lib/shell-status.ts must resolve the same manifest-first roster",
);
// The AI Team page and Settings > AI brain list ONE roster (W4a): both load it
// through components/os/aiteam/roster.ts, built on lib/os/teammates.ts, whose
// "on" is agent-roster.ts's own rule (isBindingOn, which resolveEnabledAgentSlugs uses).
assert.ok(
  readFileSync(join(ROOT, "app", "agents", "page.tsx"), "utf8").includes("loadAiTeam(viewer)"),
  "app/agents/page.tsx must load the workspace roster",
);
assert.ok(settings.includes("loadWorkspaceRoster("), "Settings > AI brain must load the same roster as the AI Team");
assert.ok(
  readFileSync(join(ROOT, "components", "os", "department", "config.ts"), "utf8").includes("isBindingOn"),
  "the department channels must use the roster's own on/off rule",
);
assert.ok(
  readFileSync(join(ROOT, "lib", "manifest", "agent-roster.ts"), "utf8").includes(".filter(isBindingOn)"),
  "resolveEnabledAgentSlugs must use the shared on/off rule",
);

console.log("settings-agent-roster.test.ts: OK");
