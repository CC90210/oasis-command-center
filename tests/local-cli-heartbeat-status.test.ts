import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLI_STATE_LABEL,
  cliStatusState,
  normalizeCliSnapshot,
  type CliInventoryMetadata,
} from "../lib/bridge-cli-status";
import { describeRuntime, type EngineDevice } from "../components/settings/agent-engine-client";

const ROOT = process.cwd();
const NOW = Date.parse("2026-08-25T16:30:00.000Z");

const metadata: CliInventoryMetadata = {
  providers: {
    claude: {
      installed: true,
      authenticated: true,
      version: "2.1.215 (Claude Code)",
    },
    codex: {
      installed: true,
      authenticated: true,
      version: "codex-cli 0.146.0",
    },
    gemini: {
      installed: true,
      authenticated: true,
      version: "0.42.0",
    },
  },
};

const fresh = normalizeCliSnapshot(metadata, "2026-08-25T16:29:00.000Z", NOW);
assert.equal(fresh.ok, true);
if (fresh.ok) {
  assert.equal(fresh.data.claude.authenticated, true);
  assert.equal(fresh.data.codex.version, "codex-cli 0.146.0");
  assert.equal(fresh.data.gemini.installed, true);
}

assert.deepEqual(
  normalizeCliSnapshot(metadata, "2026-08-25T16:20:00.000Z", NOW),
  { ok: false, reason: "stale" },
  "an old bridge snapshot must not masquerade as current CLI state",
);
assert.deepEqual(
  normalizeCliSnapshot({ providers: {} }, "2026-08-25T16:29:00.000Z", NOW),
  { ok: false, reason: "invalid_inventory" },
  "missing provider records must fail closed",
);

const enginePanel = readFileSync(join(ROOT, "components", "settings", "AgentEnginePanel.tsx"), "utf8");
const engineRoute = readFileSync(join(ROOT, "app", "api", "ai", "engine", "route.ts"), "utf8");
const localCliCard = readFileSync(join(ROOT, "components", "settings", "LocalCliProvidersCard.tsx"), "utf8");
assert.ok(engineRoute.includes("CLI_INVENTORY_SERVICE") && engineRoute.includes("normalizeCliMachines"), "AI Brain must read the connector's outbound CLI inventory");
assert.ok(engineRoute.includes("claim_runtime_state"), "AI Brain must combine inventory with per-runtime execution state from the selected pairing");
assert.ok(enginePanel.includes("describeRuntime(selectedDevice, provider)"), "the unified panel must label each runtime from one exact device snapshot");
assert.ok(enginePanel.includes("startCliSignIn(provider, selectedDevice.pairingId)"), "Connect must stay bound to the computer whose status is shown");
assert.ok(!enginePanel.includes('localMachineBridgeUrl("health")') && !enginePanel.includes('bridgeClientUrl("exec-tool")'), "hosted Settings must never reach a browser-local daemon");
assert.match(localCliCard, /export function LocalCliProvidersCard\([^)]*\)\s*\{\s*return null;/s, "the old inventory card must not publish a second source of truth");
assert.deepEqual(
  normalizeCliSnapshot(metadata, "2026-08-25T16:31:00.000Z", NOW),
  { ok: false, reason: "stale" },
  "a future-dated heartbeat is not current installation proof",
);

const route = readFileSync(
  join(ROOT, "app", "api", "bridge", "cli-status", "route.ts"),
  "utf8",
);
assert.ok(
  route.includes("getActiveProfile"),
  "CLI status must use the same active-workspace resolver as Settings and its activity log",
);
assert.ok(route.includes('.eq("tenant_id", tenantId)'));
assert.ok(
  route.includes('.eq("profile_id", profileId)'),
  "CLI inventory must stay bound to the signed-in user's paired machine",
);
assert.ok(route.includes('.eq("service", CLI_INVENTORY_SERVICE)'));
assert.ok(route.includes('order("last_ping_at", { ascending: false })'));

const pingRoute = readFileSync(
  join(ROOT, "app", "api", "bridge", "ping", "route.ts"),
  "utf8",
);
assert.ok(
  // O3a: the pairing comes from the shared resolver (lib/bridge/pairing-auth.ts)
  // as `pairing.tenantId`; the rule is unchanged.
  pingRoute.includes('.eq("tenant_id", pairing.tenantId)'),
  "heartbeat profile resolution must stay inside the pairing tenant so another workspace cannot receive its CLI inventory",
);
assert.ok(
  pingRoute.includes('error: "bridge_profile_unresolved"') &&
    pingRoute.includes("{ status: 409 }"),
  "a heartbeat without a profile owner must fail instead of creating false online state",
);
assert.ok(
  pingRoute.includes('error: "cli_inventory_persist_failed"') &&
    pingRoute.includes("{ status: 503 }"),
  "a failed CLI snapshot write must produce a non-success heartbeat",
);

// Google ended Gemini CLI on a personal sign-in: the bridge sends probe "unsupported".
// It is a FINISHED check with its own state: never Ready, never Needs sign-in
// (signing in again does not help), never "Sign-in not confirmed".
const refused = normalizeCliSnapshot(
  { providers: { ...metadata.providers, gemini: { installed: true, authenticated: false, version: null, probe: "unsupported" } } },
  "2026-08-25T16:29:00.000Z",
  NOW,
);
assert.equal(refused.ok, true);
if (refused.ok) {
  const state = cliStatusState(refused.data.gemini);
  assert.equal(state, "unsupported");
  assert.equal(CLI_STATE_LABEL[state], "Not supported on this sign-in");
  assert.equal(refused.data.gemini.checked, true);
  assert.equal(cliStatusState(refused.data.claude), "ready");
}
// The same shape without the probe still reads "not confirmed": only the bridge's verdict makes it final.
const unversioned = normalizeCliSnapshot(
  { providers: { ...metadata.providers, gemini: { installed: true, authenticated: false, version: null } } },
  "2026-08-25T16:29:00.000Z",
  NOW,
);
assert.equal(unversioned.ok && cliStatusState(unversioned.data.gemini), "unknown");

const deviceFromHeartbeat = (executionReady: boolean): EngineDevice => ({
  pairingId: "pair-ccpc",
  label: "CCPC (Windows)",
  ownerName: "CC",
  ownedByViewer: true,
  os: "windows",
  lastSeenAt: "2026-08-25T16:29:00.000Z",
  approved: true,
  online: true,
  busy: false,
  protocols: ["department_task_v2", "runtime_action_v1"],
  runtimes: {
    claude: { installed: true, signedIn: true, executionReady, unsupported: false, version: "2.1.215", lastTestedAt: null, code: null },
    codex: { installed: true, signedIn: true, executionReady: false, unsupported: false, version: "0.146.0", lastTestedAt: null, code: null },
    gemini: { installed: true, signedIn: false, executionReady: false, unsupported: true, version: "0.42.0", lastTestedAt: null, code: "unsupported_personal_sign_in" },
  },
  localModels: [],
});

assert.deepEqual(describeRuntime(deviceFromHeartbeat(false), "claude"), {
  label: "Needs test",
  verified: false,
  repair: "Test Claude Code on CCPC (Windows) before using it for agents.",
}, "installed and signed in from a heartbeat is not agent-ready without a real probe");
assert.deepEqual(describeRuntime(deviceFromHeartbeat(true), "claude"), {
  label: "Ready for agents",
  verified: true,
  repair: null,
}, "the same pairing becomes ready only after execution evidence says so");
assert.equal(describeRuntime(deviceFromHeartbeat(false), "gemini").label, "Unsupported");
assert.match(describeRuntime(deviceFromHeartbeat(false), "gemini").repair ?? "", /Google API key/);
assert.equal(describeRuntime({ ...deviceFromHeartbeat(true), online: false }, "claude").label, "Offline", "a stale/offline pairing overrides an old successful probe");

console.log("local-cli-heartbeat-status.test.ts: OK");
