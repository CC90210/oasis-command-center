import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bridgeProxyModeForHostname } from "../lib/bridge-client-routing";
import { deriveDropdownState } from "../lib/bridge-dropdown-state";
import {
  bridgeHostOSFromPlatform,
  bridgeInstallCommands,
  bridgeRecoveryGuidance,
  bridgeRestartCommand,
  bridgeSupervisorLabel,
} from "../lib/bridge-install-guidance";

const ROOT = process.cwd();

for (const loopback of ["localhost", "127.0.0.1", "::1"]) {
  assert.equal(
    bridgeProxyModeForHostname(loopback),
    false,
    `${loopback} may call the local bridge directly`,
  );
}
for (const hosted of ["oasisai.work"]) {
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
  // O1: the card also takes isAgentsOwner (lib/agents-owner.ts) — the
  // heartbeat prop itself is unchanged, which is what this pins.
  settings.includes("<LocalCliProvidersCard serverBridgeOnline={bridgeOnline} isAgentsOwner={agentsOwner} />"),
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
// One read since 2026-09-29: the pairing-owner lookup went with its only
// consumer (getTenantBridgeOwner, which nothing called). Every .from( in the
// block must still carry the tenant filter.
assert.equal(
  bridgeStatusBlock.match(/\.from\(/g)?.length,
  bridgeStatusBlock.match(/\.eq\("tenant_id", tenantId\)/g)?.length,
  "every read in getTenantBridgeStatus must remain tenant-scoped",
);

// ── The viewer's OWN daemons and CLIs are reached through the server ───────
//
// 2026-09-03: the worker Start/Stop/Restart buttons and the CLI diagnostics
// panel each read NEXT_PUBLIC_BRIDGE_CHAT_BASE for the local bridge, which the
// deployed bundle had inlined as http://localhost:3000. They moved to the
// loopback bridge. 2026-09-30: since the bridge bearer went on (BEA 38139ede,
// 09-29) the bridge answers 401 to any call without the token, loopback
// included, and the token must never reach a browser. So neither surface calls
// the bridge from the browser any more: worker control POSTs the server's
// control route, which holds the bearer, and the CLI panel reads the inventory
// the bridge pushes with its heartbeat.
for (const rel of [
  join("lib", "automations", "worker-control.ts"),
  join("components", "BridgeCliPanel.tsx"),
  join("components", "WarmPoolPanel.tsx"),
]) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  assert.ok(
    !src.includes("process.env.NEXT_PUBLIC_BRIDGE_CHAT_BASE") && !/\bBRIDGE_CHAT_BASE\b/.test(src),
    `${rel} must not read the hosted-bridge override`,
  );
  assert.ok(
    !src.includes("LOCAL_BRIDGE_DEFAULT") && !src.includes("127.0.0.1:9100") && !src.includes("localhost:9100"),
    `${rel} must not call the bridge from the browser; it answers 401 without the bearer`,
  );
}
const workerControl = readFileSync(join(ROOT, "lib", "automations", "worker-control.ts"), "utf8");
assert.ok(
  workerControl.includes('export const WORKER_CONTROL_ROUTE = "/api/automations/background-workers/control"') &&
    workerControl.includes("await fetch(WORKER_CONTROL_ROUTE, {"),
  "worker control must always POST the server's control route",
);
assert.ok(
  workerControl.includes('"the bridge refused the request (token)"'),
  "a 401 from the bridge must read as the token, never as offline",
);
const cliPanel = readFileSync(join(ROOT, "components", "BridgeCliPanel.tsx"), "utf8");
assert.ok(
  cliPanel.includes('export const CLI_STATUS_ROUTE = "/api/bridge/cli-status"') && cliPanel.includes("fetch(CLI_STATUS_ROUTE"),
  "the CLI panel must read the server's inventory route",
);
const warmPanel = readFileSync(join(ROOT, "components", "WarmPoolPanel.tsx"), "utf8");
assert.ok(
  warmPanel.includes('export const WARM_STATUS_ROUTE = "/api/bridge/warm-status"') && warmPanel.includes("fetch(WARM_STATUS_ROUTE"),
  "the warm-pool panel must read the server's warm-status route",
);

// Windows retired PM2 as the operator-machine supervisor on 2026-08-27. Every
// generic recovery surface must remain portable: the hosted dashboard serves
// Windows, macOS, and Linux bridge hosts, and the same source still ships on
// both the legacy Vercel and current Cloudflare deployments.
const recoverySurfaces = [
  join("app", "agents", "page.tsx"),
  join("components", "BridgeCliPanel.tsx"),
  join("components", "ChatWidget.tsx"),
  join("app", "api", "chat", "route.ts"),
  join("app", "api", "bridge", "health", "route.ts"),
  join("lib", "cloud-tool-runner.ts"),
  join("components", "settings", "InstallBridgeModal.tsx"),
  join("app", "settings", "devices", "install", "InstallBridgeWizard.tsx"),
  join("lib", "prompts-library.ts"),
];
for (const rel of recoverySurfaces) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  assert.doesNotMatch(src, /pm2 (?:start|restart|logs) (?:bravo-autonomous|claude-bridge(?:-ping)?)/i, `${rel} still gives retired PM2 recovery guidance`);
  assert.doesNotMatch(src, /Vercel function logs|on Vercel|through the dashboard's \/api\/chat path on Vercel/i, `${rel} still points operators at the retired dashboard runtime`);
}
for (const rel of recoverySurfaces.slice(0, 6)) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  assert.doesNotMatch(src, /fleet_watchdog\.py/i, `${rel} still gives a repo-relative Windows-only recovery command`);
}

// Every active operator-facing bridge surface must use the installed OASIS
// launcher. The old Bravo package entry point is an implementation detail and
// is not guaranteed to be on PATH on a paired machine.
const installedLauncherSurfaces = [
  ...recoverySurfaces,
  join("app", "playbook", "client-deploy", "page.tsx"),
  join("components", "integrations", "KeyPasteModal.tsx"),
  join("components", "settings", "AgentConfigEditor.tsx"),
  join("components", "settings", "DevicesEditor.tsx"),
  "README.md",
];
for (const rel of installedLauncherSurfaces) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  assert.doesNotMatch(
    src,
    /\bbravo bridge\b/i,
    `${rel} still exposes the retired Bravo bridge command`,
  );
}

const keyPasteModal = readFileSync(
  join(ROOT, "components", "integrations", "KeyPasteModal.tsx"),
  "utf8",
);
assert.match(keyPasteModal, /Settings[^\n]*Devices/i);
assert.match(keyPasteModal, /oasis bridge status/i);
assert.match(keyPasteModal, /oasis bridge restart/i);
assert.doesNotMatch(
  keyPasteModal,
  /paste[^\n]*\.env\.agents[^\n]*manually|copyManual/i,
  "an offline bridge must fail closed instead of instructing direct secret-file edits",
);
const bridgePanel = readFileSync(join(ROOT, "components", "BridgeCliPanel.tsx"), "utf8");
assert.match(bridgePanel, /bridgeRecoveryGuidance/, "client recovery must use the OS-aware installed launcher helper");
const bridgeHealth = readFileSync(join(ROOT, "app", "api", "bridge", "health", "route.ts"), "utf8");
assert.match(bridgeHealth, /deploymentRuntimeLabel/, "hosted bridge diagnostics must derive their runtime label centrally");
assert.match(bridgeHealth, /Settings[^\n]*Devices|oasis bridge/i, "generic diagnostics must give a portable recovery path");

const prompts = readFileSync(join(ROOT, "lib", "prompts-library.ts"), "utf8");
assert.doesNotMatch(
  prompts,
  /\bpm2\b/i,
  "active Command Center prompts must not resurrect the retired PM2 supervisor",
);
assert.doesNotMatch(
  prompts,
  /Vercel-watched|on Vercel/i,
  "active Command Center prompts must not route operators to the retired host",
);

assert.equal(
  bridgeRestartCommand("windows"),
  '& "$HOME\\.oasis\\bin\\oasis.cmd" bridge restart',
  "Windows recovery must be independent of the current working directory",
);
for (const os of ["macos", "linux"] as const) {
  assert.equal(
    bridgeRestartCommand(os),
    '"$HOME/.oasis/bin/oasis" bridge restart',
    `${os} recovery must use the installed OASIS launcher`,
  );
}
assert.match(bridgeSupervisorLabel("windows"), /Task Scheduler|Startup/i);
assert.match(bridgeSupervisorLabel("macos"), /launchd/i);
assert.match(bridgeSupervisorLabel("linux"), /systemd/i);
assert.equal(bridgeHostOSFromPlatform("Win32"), "windows");
assert.equal(bridgeHostOSFromPlatform("MacIntel"), "macos");
assert.equal(bridgeHostOSFromPlatform("Linux x86_64"), "linux");
assert.equal(bridgeHostOSFromPlatform("iPhone"), null);
for (const os of ["windows", "macos", "linux"] as const) {
  const commands = bridgeInstallCommands(os);
  assert.match(commands, /bridge install/);
  assert.match(commands, /bridge restart/);
  assert.match(commands, /bridge status/);
  assert.doesNotMatch(commands, /fleet_watchdog|pm2/i);
  const recovery = bridgeRecoveryGuidance(os);
  assert.match(recovery, /bridge status/);
  assert.match(recovery, /bridge restart/);
  assert.doesNotMatch(recovery, /fleet_watchdog|pm2/i);
}
assert.match(bridgeRecoveryGuidance(null), /Settings[^.]*Devices/i);
assert.match(bridgeRecoveryGuidance(null), /oasis bridge (?:status|restart)/i);

const installWizard = readFileSync(
  join(ROOT, "app", "settings", "devices", "install", "InstallBridgeWizard.tsx"),
  "utf8",
);
assert.match(installWizard, /bridgeInstallCommands\(os\)/);
assert.match(installWizard, /bridgeSupervisorLabel\(os\)/);
assert.doesNotMatch(installWizard, /install-task/);

console.log("settings-bridge-consistency.test.ts: OK");
