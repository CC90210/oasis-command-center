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
  ["bravo", "atlas", "maven", "aura"],
  "the shipped OASIS roster is the four enabled core agents",
);
assert.equal(
  OASIS_SEED.agents.find((agent) => agent.slug === "lex")?.enabled,
  false,
  "Lex remains available but opt-in",
);

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
assert.ok(
  settings.includes('key={manifestAgentKeys.join(":")}'),
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

for (const file of [join(ROOT, "app", "layout.tsx"), join(ROOT, "app", "agents", "page.tsx")]) {
  assert.ok(
    readFileSync(file, "utf8").includes("resolveEnabledAgentSlugs"),
    `${file} must resolve the same manifest-first roster`,
  );
}

console.log("settings-agent-roster.test.ts: OK");
