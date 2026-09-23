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

// ── Surfaces that control the viewer's OWN daemons must target loopback ────
//
// 2026-09-03: the worker Start/Stop/Restart buttons and the CLI diagnostics
// panel each read NEXT_PUBLIC_BRIDGE_CHAT_BASE for the local bridge. That var
// is the hosted-VPS override for SunBiz employees, and the deployed bundle had
// it inlined as http://localhost:3000 — a dev-server port. Every Restart click
// on the operator's own machine POSTed there and failed with
// `Unexpected token '<', "<!DOCTYPE"`. The proxy is not a substitute (it fails
// closed for a tenant with no bridge_url, and a Worker cannot reach a laptop),
// so the ONLY correct target for a local daemon is the viewer's loopback.
for (const rel of [
  join("lib", "automations", "worker-control.ts"),
  join("components", "BridgeCliPanel.tsx"),
]) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  // The READ is the defect, not the name: both files explain in a comment why
  // they no longer read it, so this pins `process.env.` access specifically.
  assert.ok(
    !src.includes("process.env.NEXT_PUBLIC_BRIDGE_CHAT_BASE"),
    `${rel} must not read the hosted-bridge override for a LOCAL daemon`,
  );
  assert.ok(
    src.includes('import { LOCAL_BRIDGE_DEFAULT } from "@/lib/bridge-client-routing"'),
    `${rel} must take the loopback bridge from the one routing module`,
  );
}
const workerControl = readFileSync(join(ROOT, "lib", "automations", "worker-control.ts"), "utf8");
assert.ok(
  workerControl.includes("fetch(`${LOCAL_BRIDGE_DEFAULT}/exec-tool`"),
  "the local worker-control path must POST to the loopback bridge's /exec-tool",
);
assert.ok(
  workerControl.includes("is the local bridge running on this machine?"),
  "a non-JSON answer must be named as 'no bridge here', not surfaced as a JSON parse error",
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
for (const rel of recoverySurfaces) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  assert.doesNotMatch(src, /fleet_watchdog\.py/i, `${rel} still gives a repo-relative Windows-only recovery command`);
}
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
assert.doesNotMatch(
  prompts,
  /\b(?:Cloudflare|Vercel)-deployed\b/i,
  "active Command Center prompts must not hardcode a deployment provider",
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
