import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bridgeProxyModeForHostname } from "../lib/bridge-client-routing";
import { deriveDropdownState } from "../lib/bridge-dropdown-state";

const ROOT = process.cwd();

for (const loopback of ["localhost", "127.0.0.1", "::1"]) {
  assert.equal(
    bridgeProxyModeForHostname(loopback),
    false,
    `${loopback} may call the local bridge directly`,
  );
}
for (const hosted of ["oasisai.work", "agent-dashboard-cc90210.vercel.app"]) {
  assert.equal(
    bridgeProxyModeForHostname(hosted),
    true,
    `${hosted} must use the authenticated same-origin bridge proxy`,
  );
}

assert.equal(
  deriveDropdownState(false, true),
  "degraded",
  "a failed browser probe plus a fresh tenant heartbeat is not offline",
);
assert.equal(
  deriveDropdownState(false, false),
  "offline",
  "offline requires both the browser probe and tenant heartbeat to be down",
);

const localCliCard = readFileSync(
  join(ROOT, "components", "settings", "LocalCliProvidersCard.tsx"),
  "utf8",
);
assert.ok(localCliCard.includes('fetch("/api/bridge/cli-status"'));
assert.ok(localCliCard.includes('bridgeClientUrl("exec-tool")'));
assert.ok(localCliCard.includes("serverBridgeOnline"));
assert.ok(localCliCard.includes("Bridge online · CLI inventory syncing"));
assert.ok(
  !localCliCard.includes("Local bridge offline"),
  "Settings must not contradict a fresh sidebar heartbeat",
);

const settings = readFileSync(
  join(ROOT, "components", "settings", "SettingsContent.tsx"),
  "utf8",
);
assert.ok(
  settings.includes("<LocalCliProvidersCard serverBridgeOnline={bridgeOnline} />"),
  "Settings must pass the same tenant-scoped heartbeat used by its other bridge indicators",
);

const chatWidget = readFileSync(join(ROOT, "components", "ChatWidget.tsx"), "utf8");
assert.ok(
  chatWidget.includes('import { isProxyModeRuntime } from "@/lib/bridge-client-routing"'),
  "chat must retain authenticated hosted-vs-local bridge routing",
);
assert.ok(
  !chatWidget.includes("function isProxyModeRuntime()"),
  "ChatWidget must not carry a second routing implementation",
);

const queries = readFileSync(join(ROOT, "lib", "queries.ts"), "utf8");
const bridgeStatusBlock = queries.slice(
  queries.indexOf("export async function getTenantBridgeStatus"),
  queries.indexOf("export async function getBridgeOnline"),
);
assert.ok(bridgeStatusBlock.includes('.eq("tenant_id", tenantId)'));
assert.ok(
  bridgeStatusBlock.match(/\.eq\("tenant_id", tenantId\)/g)?.length === 2,
  "both the pairing and pairing-owner reads must remain tenant-scoped",
);

console.log("settings-bridge-consistency.test.ts: OK");
