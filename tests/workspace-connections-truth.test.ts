import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  classifyWorkspaceConnection,
  isWorkspaceHeartbeatFresh,
  WORKSPACE_HEALTH_MAX_AGE_MS,
} from "../lib/integrations/workspace-connection-status";

assert.equal(
  classifyWorkspaceConnection({ lookupAvailable: true, configured: true, healthStatus: null, healthFresh: false }),
  "configured",
  "credentials without a heartbeat must not look disconnected",
);
assert.equal(
  classifyWorkspaceConnection({ lookupAvailable: true, configured: false, healthStatus: "healthy", healthFresh: true }),
  "connected",
  "a healthy tenant heartbeat is direct connection proof",
);
assert.equal(
  classifyWorkspaceConnection({ lookupAvailable: true, configured: true, healthStatus: "down", healthFresh: true }),
  "attention",
  "an explicit failed health check overrides credential presence",
);
assert.equal(
  classifyWorkspaceConnection({ lookupAvailable: true, configured: false, healthStatus: null, healthFresh: false }),
  "not_configured",
  "not configured requires successful lookups with neither truth source present",
);
assert.equal(
  classifyWorkspaceConnection({ lookupAvailable: false, configured: false, healthStatus: null, healthFresh: false }),
  "unavailable",
  "a lookup failure must remain unknown",
);
assert.equal(
  classifyWorkspaceConnection({ lookupAvailable: true, configured: true, healthStatus: "healthy", healthFresh: false }),
  "configured",
  "an old healthy row proves historical setup, not a current connection",
);
assert.equal(
  classifyWorkspaceConnection({ lookupAvailable: true, configured: false, healthStatus: "healthy", healthFresh: false }),
  "not_configured",
  "stale health cannot override a successful credential lookup",
);
const now = Date.parse("2026-09-01T12:00:00.000Z");
assert.equal(isWorkspaceHeartbeatFresh("not-a-date", now), false);
assert.equal(isWorkspaceHeartbeatFresh(new Date(now + 1_000).toISOString(), now), false);
assert.equal(
  isWorkspaceHeartbeatFresh(new Date(now - WORKSPACE_HEALTH_MAX_AGE_MS).toISOString(), now),
  true,
);
assert.equal(
  isWorkspaceHeartbeatFresh(new Date(now - WORKSPACE_HEALTH_MAX_AGE_MS - 1).toISOString(), now),
  false,
);

const root = process.cwd();
const summary = readFileSync(
  join(root, "components", "settings", "WorkspaceConnectionsSummary.tsx"),
  "utf8",
);
const store = readFileSync(join(root, "lib", "tenant-integration-store.ts"), "utf8");

assert.ok(
  summary.includes('["app_password", "from_address"]') &&
    summary.includes('["bot_token", "chat_id"]'),
  "GWS and Telegram must use their required shared credential sets",
);
assert.ok(
  summary.includes("getTenantIntegrationPresenceForStatus"),
  "workspace status must combine heartbeat and strict credential presence",
);
assert.ok(
  summary.includes("isWorkspaceHeartbeatFresh(row?.last_ping_at || null)"),
  "a historical heartbeat must be freshness-checked before Settings says Connected",
);
assert.ok(
  store.includes("if (result.error)") &&
    store.includes("tenant_integration_status_decrypt_failed"),
  "credential lookup/decryption errors must fail closed instead of returning absent",
);
assert.ok(
  store.includes("envKeysFor(service, fieldKey)") &&
    store.includes("process.env[envKey]"),
  "credential presence must include the canonical env fallback without exposing its value",
);
assert.ok(
  store.includes('bot_token: ["OASIS_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN"]'),
  "workspace Telegram status must use the same OASIS operator-lane token order as delivery",
);
assert.ok(
  store.includes('chat_id: ["OASIS_TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID"]'),
  "Telegram notifications need the same operator-lane destination used by delivery",
);
assert.equal(
  store.includes("SUNBIZ_OPS_TELEGRAM_BOT_TOKEN"),
  false,
  "OASIS workspace status must never borrow a Telegram credential from the SunBiz lane",
);
assert.equal(
  /presence\[fieldKey\]\s*=\s*decryptField/.test(store),
  false,
  "status presence must never return decrypted credential values",
);

console.log("workspace-connections-truth.test.ts: OK");
