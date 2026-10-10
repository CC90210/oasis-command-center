import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CLI_STATE_LABEL,
  cliStatusState,
  normalizeCliSnapshot,
  type CliInventoryMetadata,
} from "../lib/bridge-cli-status";

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

const localCliCard = readFileSync(
  join(ROOT, "components", "settings", "LocalCliProvidersCard.tsx"),
  "utf8",
);
assert.ok(
  localCliCard.includes('fetch("/api/bridge/cli-status"'),
  "Settings must read the pairing-authenticated outbound CLI snapshot",
);
assert.ok(
  !localCliCard.includes('localMachineBridgeUrl("health")'),
  "hosted Settings must not depend on browser permission to reach loopback",
);
assert.ok(
  !localCliCard.includes('bridgeClientUrl("exec-tool")') ||
    localCliCard.match(/bridgeClientUrl\("exec-tool"\)/g)?.length === 1,
  "only explicit install/auth actions may use the inbound bridge proxy; status must not",
);
const localActionGuard = localCliCard.indexOf("if (!localActionsAvailable)");
const execToolFetch = localCliCard.indexOf('fetch(bridgeClientUrl("exec-tool")');
assert.ok(
  localActionGuard >= 0 && execToolFetch > localActionGuard,
  "hosted Settings must fail closed before any install/auth request can target an unrelated tenant daemon",
);
assert.ok(
  localCliCard.includes("setLocalActionsAvailable(!isProxyModeRuntime())"),
  "interactive CLI mutations must only be enabled on the loopback dashboard",
);
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
  pingRoute.includes('.eq("tenant_id", pairing.data.tenant_id)'),
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
assert.ok(localCliCard.includes('cs === "unsupported"'), "the paired-computer card shows the refused state with its reason");
assert.ok(
  localCliCard.includes('cs !== "ready" && cs !== "unsupported"'),
  "a refused app is not offered Connect (signing in again cannot help)",
);

console.log("local-cli-heartbeat-status.test.ts: OK");
