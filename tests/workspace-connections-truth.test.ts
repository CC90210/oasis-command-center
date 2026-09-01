import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  classifyWorkspaceConnection,
  isWorkspaceHeartbeatFresh,
  WORKSPACE_HEALTH_MAX_AGE_MS,
} from "../lib/integrations/workspace-connection-status";
import {
  TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS,
  findTenantManuallyEditableIntegrationSchema,
} from "../lib/tenant-integration-schemas";

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
const availability = readFileSync(
  join(root, "lib", "routing", "provider-availability.ts"),
  "utf8",
);
const settings = readFileSync(
  join(root, "components", "settings", "SettingsContent.tsx"),
  "utf8",
);
const personal = readFileSync(
  join(root, "components", "settings", "PersonalIntegrationsPanel.tsx"),
  "utf8",
);
const keysPanel = readFileSync(
  join(root, "components", "settings", "IntegrationKeysPanel.tsx"),
  "utf8",
);
const keysRoute = readFileSync(
  join(root, "app", "api", "integrations", "keys", "route.ts"),
  "utf8",
);
const testRoute = readFileSync(
  join(root, "app", "api", "integrations", "keys", "test", "route.ts"),
  "utf8",
);

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
  summary.includes('.order("last_ping_at", { ascending: false, nullsFirst: false })'),
  "a null health timestamp must not hide the newest real workspace heartbeat",
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
  store.includes("TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS") &&
    store.includes('source: "environment"'),
  "the Credentials API must synthesize value-free rows for deployment-backed configuration",
);
assert.ok(
  store.includes('from_address: "GMAIL_USER"') &&
    availability.includes("process.env.GMAIL_APP_PASSWORD && process.env.GMAIL_USER"),
  "Google app-password readiness must require the real SMTP login plus its App Password",
);
assert.equal(
  store.includes('from_address: "GMAIL_FROM_ADDRESS"'),
  false,
  "a display From address alone must not make the Google SMTP login look configured",
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

const tenantEditableServices = TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS.map(
  (schema) => schema.service,
);
assert.ok(tenantEditableServices.includes("gws"));
assert.ok(tenantEditableServices.includes("telegram"));
assert.equal(tenantEditableServices.includes("gmail_oauth"), false);
assert.equal(tenantEditableServices.includes("constant_contact"), false);
assert.equal(findTenantManuallyEditableIntegrationSchema("gmail_oauth"), null);
assert.equal(findTenantManuallyEditableIntegrationSchema("constant_contact"), null);
assert.ok(
  findTenantManuallyEditableIntegrationSchema("telegram")?.fields.some(
    (field) => field.key === "chat_id",
  ),
  "the shared Telegram setup must expose the destination required by its status contract",
);
assert.ok(
  keysPanel.includes("TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS") &&
    !keysPanel.includes("{INTEGRATION_SCHEMAS.filter"),
  "the tenant editor must render only shared, manually provisioned integrations",
);
assert.ok(
  (keysRoute.match(/findTenantManuallyEditableIntegrationSchema/g) || []).length >= 3,
  "POST and DELETE must both enforce the tenant-manual schema boundary",
);
assert.ok(
  testRoute.includes("findTenantManuallyEditableIntegrationSchema") &&
    testRoute.includes("service_not_tenant_editable"),
  "the provider test API must reject personal and OAuth-managed services too",
);

assert.equal(
  settings.includes("WorkspaceConnectionsSummary"),
  false,
  "Settings must not render the redundant shared connection summary",
);
assert.equal(
  settings.includes("QuickInviteCard"),
  false,
  "Settings must route team management to /team instead of mounting a second invite form",
);
assert.ok(
  settings.includes("Manage team & invites") && settings.includes('href="/team"'),
  "Settings must retain one clear Team management CTA",
);
assert.ok(
  settings.includes('title="Credentials"') &&
    settings.includes("<PersonalIntegrationsPanel") &&
    settings.includes("<TelegramConnectCard"),
  "personal Google and Telegram controls must live inside the consolidated Credentials sections",
);
assert.equal(
  personal.includes("Your account connections"),
  false,
  "the personal controls must not create a second titled connection surface inside Credentials",
);
assert.ok(
    keysPanel.includes('"Email-only"') &&
    keysPanel.includes("twilioVerified") &&
    testRoute.includes("missing_sender") &&
    testRoute.includes('j.status !== "active"') &&
    testRoute.includes("sender verified"),
  "Twilio must remain visibly email-only until its account and sender pass Test",
);
assert.ok(
  keysPanel.includes("configured in deployment") &&
    keysPanel.includes("Connection test passed.") &&
    testRoute.includes("await transport.verify()"),
  "deployment-backed Google Workspace must render configured and support a side-effect-free SMTP auth test",
);
assert.ok(
  testRoute.includes("/getChat?chat_id=") && testRoute.includes("missing_chat_id"),
  "Telegram Test must verify the configured destination as well as the bot token",
);

console.log("workspace-connections-truth.test.ts: OK");
