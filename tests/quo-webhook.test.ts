/** Real SQLite/encryption/STOP ledger; HTTP providers are entirely intercepted. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const file = join(mkdtempSync(join(tmpdir(), "quo-ingress-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = file;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "quo-webhook-fixture-encryption-key";
process.env.LIVE_SEND_QUO = "1";
process.env.PROVIDER_QUO_ENABLED = "1";
for (const name of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "QUO_API_KEY", "QUO_FROM_E164", "BRAVO_FORCE_DRY_RUN"]) delete process.env[name];
const tenant = "a1000000-0000-4000-8000-000000000001";
const other = "b1000000-0000-4000-8000-000000000002";
const now = new Date("2026-11-01T12:00:00Z");
const origin = "https://oasisai.work";
const key = `whsec_${Buffer.alloc(32, 17).toString("base64")}`;
const config = { tenantId: tenant, apiKey: "fixture-quo-key", signingKey: key, orgId: "ORfixture", phoneNumberId: "PNfixture", fromNumber: "+14165550100", webhookId: "1234" };
const from = "+19055550123";
const event = (text = "STOP") => ({ id: "EVfixture", apiVersion: "2026-03-30", type: "message.received", createdAt: now.toISOString(),
  data: { resource: { id: "ACfixture", direction: "incoming", text }, context: { orgId: config.orgId, phoneNumberId: config.phoneNumberId,
    senderIdentifier: from, recipientIdentifiers: [config.fromNumber] } } });
function request(body: unknown = event(), id = "delivery-1", timestamp = Math.floor(now.getTime() / 1000), signingKey = key) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signature = createHmac("sha256", Buffer.from(signingKey.slice(6), "base64")).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return new Request(`${origin}/api/webhooks/quo/${tenant}`, { method: "POST", body: raw,
    headers: { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${signature}`, "content-type": "application/json" } });
}
let passed = 0;
async function check(label: string, work: () => Promise<void>) { await work(); passed++; console.log(`ok ${label}`); }
async function main() {
  const db = createClient({ url: `file:${file}` });
  await db.executeMultiple(`
    CREATE TABLE tenant_integration_credentials (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),tenant_id TEXT NOT NULL,service TEXT NOT NULL,field_key TEXT NOT NULL,encrypted_value TEXT NOT NULL,last_tested_at TEXT,last_test_ok INTEGER,last_test_error TEXT,created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(tenant_id,service,field_key));
    CREATE TABLE agent_events (id TEXT PRIMARY KEY,event_type TEXT,publisher_agent TEXT,target_agent TEXT,severity TEXT,payload TEXT,correlation_id TEXT,published_at TEXT,created_at TEXT,source_agent TEXT,idempotency_key TEXT UNIQUE,status TEXT,retry_count INTEGER);
    CREATE TABLE sunbiz_phone_suppressions (tenant_id TEXT,phone_last10 TEXT,reason TEXT,source TEXT,updated_at TEXT,PRIMARY KEY(tenant_id,phone_last10));
    CREATE TABLE website_sales_meeting_notifications (id TEXT PRIMARY KEY,tenant_id TEXT,channel TEXT,recipient TEXT,status TEXT,claimed_at TEXT,last_error TEXT,updated_at TEXT);
    CREATE TABLE lead_interactions (id TEXT,tenant_id TEXT,direction TEXT,metadata TEXT,from_phone TEXT);
    CREATE TABLE _realtime_nudges (scope TEXT PRIMARY KEY,bumped_at TEXT);
  `);
  const webhook = await import("../lib/integrations/quo-webhook");
  const store = await import("../lib/tenant-integration-store");
  const save = async (values: Record<string,string>, who = tenant) => {
    const result = await store.setTenantIntegrationBundle({ tenantId: who, service: "quo", bundle: values });
    assert.equal(result.ok, true, !result.ok ? result.error : undefined);
  };
  await save({ api_key: config.apiKey, from_number: config.fromNumber, webhook_key: key, webhook_org_id: config.orgId, webhook_phone_number_id: config.phoneNumberId, webhook_id: config.webhookId });
  const deps = { db, now };
  const handle = (req: Request, who = tenant) => webhook.handleQuoInbound(req, who, deps);
  const count = async (table: string) => Number((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
  let providerCalls = 0; let providerStatus = 200; let mismatch = false;
  let providerUpdatedAt: string | undefined = "2026-10-31T12:00:00Z";
  let pendingDeliveryStatus: string | null = null; let malformedDeliveries = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    providerCalls++;
    const target = new URL(String(url)); assert.equal(target.origin, "https://api.quo.com");
    assert.equal(init?.method, "GET", "provider API is read-only"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), config.apiKey);
    assert.equal(new Headers(init?.headers).get("Quo-Api-Version"), "2026-03-30");
    if (providerStatus !== 200) return new Response("provider error must not escape", { status: providerStatus });
    if (target.pathname.endsWith("/events")) {
      assert.equal(target.searchParams.get("eventType"), "message.received"); assert.equal(target.searchParams.get("limit"), "1");
      assert.ok(["pending", "sending", "failed"].includes(target.searchParams.get("status")!));
      return Response.json({ data: malformedDeliveries ? {} : pendingDeliveryStatus === target.searchParams.get("status") ? [{ id: "unresolved-delivery" }] : [] });
    }
    if (target.pathname.startsWith("/webhooks/")) return Response.json({ data: { id: config.webhookId, orgId: config.orgId, status: mismatch ? "disabled" : "enabled",
      apiVersion: "2026-03-30", url: webhook.quoWebhookUrl(origin, tenant), events: ["message.received"], resourceIds: [config.phoneNumberId], updatedAt: providerUpdatedAt } });
    if (target.pathname.startsWith("/phone-numbers/")) return Response.json({ data: { id: config.phoneNumberId, phoneNumber: config.fromNumber } });
    throw new Error("Unexpected provider URL");
  };
  try {
    await check("configuration is encrypted, tenant-bound, and alone never ready", async () => {
      assert.deepEqual(await webhook.loadQuoWebhookConfig(tenant), config);
      assert.equal(await webhook.loadQuoWebhookConfig(other), null);
      const saved = JSON.stringify((await db.execute("SELECT encrypted_value FROM tenant_integration_credentials")).rows);
      assert.ok(!saved.includes(key) && !saved.includes(config.apiKey));
      assert.equal((await webhook.quoWebhookReadiness(tenant, origin, true)).reason, "awaiting_signed_delivery"); assert.equal(providerCalls, 0);
    });
    await check("bad/missing/tampered/stale signatures fail before parsing or writes", async () => {
      const bad = request("not json"); bad.headers.set("webhook-signature", "v1,bad");
      assert.equal((await handle(bad)).status, 401);
      const tampered = request(); const body = await tampered.text();
      assert.equal((await handle(new Request(tampered.url, { method: "POST", headers: tampered.headers, body: `${body} ` }))).status, 401);
      assert.equal((await handle(request(event(), "old", now.getTime()/1000 - 301))).status, 401);
      assert.equal((await handle(request(event(), "future", now.getTime()/1000 + 301))).status, 401);
      const missing = request(); missing.headers.delete("webhook-id"); assert.equal((await handle(missing)).status, 401);
      assert.equal((await handle(request("not json"))).status, 400); assert.equal(await count("agent_events"), 0);
    });
    await check("request bytes and signed account/number binding are enforced", async () => {
      assert.equal((await handle(request("x".repeat(65537)))).status, 413);
      for (const mutate of [
        (e: ReturnType<typeof event>) => { e.data.context.orgId = "ORother"; },
        (e: ReturnType<typeof event>) => { e.data.context.phoneNumberId = "PNother"; },
        (e: ReturnType<typeof event>) => { e.data.context.recipientIdentifiers = ["+14165550999"]; },
        (e: ReturnType<typeof event>) => { e.data.context.senderIdentifier = "internal-user"; },
        (e: ReturnType<typeof event>) => { e.data.resource.direction = "outgoing"; },
      ]) { const value = event(); mutate(value); assert.equal((await handle(request(value))).status, 422); }
      await save({ api_key: "other-key", from_number: config.fromNumber, webhook_key: `whsec_${Buffer.alloc(32, 22).toString("base64")}`, webhook_org_id: config.orgId, webhook_phone_number_id: config.phoneNumberId, webhook_id: config.webhookId }, other);
      assert.equal((await handle(request(), other)).status, 401);
      assert.equal(await count("sunbiz_phone_suppressions"), 0);
    });
    await check("a picture message and a group thread to this number are accepted, never 422", async () => {
      // A 422 makes Quo mark the delivery failed, and any failed delivery blocks
      // automated texts at readiness. Both of these are real deliveries to this number.
      const mms = event(); delete (mms.data.resource as { text?: string }).text;
      const mmsResponse = await handle(request(mms, "delivery-mms"));
      assert.equal(mmsResponse.status, 200, "a text-less picture message is a delivery, not a mismatch");
      const group = event("STOP"); group.data.context.recipientIdentifiers = ["+14165550999", config.fromNumber];
      const groupResponse = await handle(request(group, "delivery-group"));
      assert.equal(groupResponse.status, 200, "a group thread including this number is a delivery");
      assert.equal(await count("sunbiz_phone_suppressions"), 1, "a STOP in a group thread still suppresses the sender");
      // Clean up so the checks below see the ledger they expect.
      await db.execute("DELETE FROM sunbiz_phone_suppressions");
      await db.execute("DELETE FROM agent_events");
      await db.execute("DELETE FROM tenant_integration_credentials WHERE service <> 'quo'");
      const bad = event(); (bad.data.resource as { text?: unknown }).text = 42;
      assert.equal((await handle(request(bad, "delivery-bad-text"))).status, 422, "a non-text body is still refused");
    });
    await check("signed STOP atomically suppresses, cancels this tenant only, and blocks resend", async () => {
      for (const who of [tenant, other]) await db.execute({ sql: "INSERT INTO website_sales_meeting_notifications VALUES (?,?, 'sms',?,'pending',NULL,NULL,NULL)", args: [who,who,from] });
      assert.equal((await handle(request())).status, 200);
      assert.equal(await count("sunbiz_phone_suppressions"), 1); assert.equal(await count("agent_events"), 1);
      const rows = (await db.execute("SELECT tenant_id,status FROM website_sales_meeting_notifications ORDER BY tenant_id")).rows;
      assert.deepEqual(rows.map(r => r.status), ["cancelled", "pending"]);
      const { sendQuoSms } = await import("../lib/integrations/quo");
      const result = await sendQuoSms({ tenantId: tenant, apiKey: config.apiKey, fromNumber: config.fromNumber }, { to: from, text: "Must never leave" });
      assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "recipient_opted_out");
      assert.equal(providerCalls, 0, "STOP and blocked resend never call a provider");
      assert.equal((await webhook.quoWebhookReadiness(tenant, origin, true)).ready, true);
      const receipt = JSON.stringify((await db.execute("SELECT payload FROM agent_events")).rows);
      assert.ok(!receipt.includes(from) && !receipt.includes(key) && !receipt.includes('"text"'));
    });
    await check("duplicate delivery is idempotent; changed payload under its ID is refused", async () => {
      const response = await handle(request()); assert.equal(response.status, 200); assert.equal((await response.json()).duplicate, true);
      assert.equal((await handle(request(event("hello")))).status, 409); assert.equal(await count("agent_events"), 1);
      assert.equal((await handle(request(event("START"), "start"))).status, 200);
      assert.equal(await count("sunbiz_phone_suppressions"), 1, "START never silently restores consent");
    });
    await check("failed cancellation rolls back receipt and suppression; retry completes", async () => {
      await db.execute("CREATE TRIGGER fail_cancel BEFORE UPDATE ON website_sales_meeting_notifications BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
      const value = event(); value.data.context.senderIdentifier = "+19055550124";
      await db.execute({ sql: "INSERT INTO website_sales_meeting_notifications VALUES ('rollback',?,'sms',?,'pending',NULL,NULL,NULL)", args: [tenant,value.data.context.senderIdentifier] });
      const before = await count("agent_events");
      assert.equal((await handle(request(value, "rollback"))).status, 503);
      assert.equal(await count("agent_events"), before); assert.equal(await count("sunbiz_phone_suppressions"), 1);
      await db.execute("DROP TRIGGER fail_cancel");
      assert.equal((await handle(request(value, "rollback"))).status, 200); assert.equal(await count("sunbiz_phone_suppressions"), 2);
    });
    await check("current provider failure/mismatch or configuration changes never enable texting", async () => {
      assert.equal((await webhook.quoWebhookReadiness(tenant, origin, true, { apiKey: config.apiKey, fromNumber: "+14165550999" })).reason, "sender_configuration_changed");
      assert.equal((await webhook.quoWebhookReadiness(tenant, origin, true, { apiKey: "old-key", fromNumber: config.fromNumber })).ready, false);
      mismatch = true; assert.equal((await webhook.quoWebhookReadiness(tenant, origin, true)).ready, false); mismatch = false;
      providerStatus = 503; await assert.rejects(webhook.quoWebhookReadiness(tenant, origin, true), /provider_unavailable/); providerStatus = 200;
      await save({ webhook_id: "5678" }); assert.equal((await webhook.quoWebhookReadiness(tenant, origin, true)).ready, false); await save({ webhook_id: config.webhookId });
      assert.equal((await webhook.quoWebhookReadiness(tenant, origin, false)).ready, false, "saved proof alone does not assert current provider health");
    });
    await check("receipt write failure rolls back STOP, and concurrent retries preserve one receipt", async () => {
      const value = event(); value.data.context.senderIdentifier = "+19055550125";
      await db.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON agent_events BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END");
      const before = await count("sunbiz_phone_suppressions");
      assert.equal((await handle(request(value, "concurrent"))).status, 503);
      assert.equal(await count("sunbiz_phone_suppressions"), before);
      await db.execute("DROP TRIGGER fail_receipt");
      const beforeReceipts = await count("agent_events");
      // Independent connections model separate requests. Embedded SQLite cannot
      // multiplex concurrent write transactions on one native connection.
      const clients = [createClient({ url: `file:${file}` }), createClient({ url: `file:${file}` })];
      let replies: Response[];
      try { replies = await Promise.all(clients.map(client => webhook.handleQuoInbound(request(value, "concurrent"), tenant, { db: client, now }))); }
      finally { clients.forEach(client => client.close()); }
      assert.ok(replies.every(r => r.status === 200 || r.status === 503), "a busy local transaction may request provider retry");
      assert.equal((await handle(request(value, "concurrent"))).status, 200);
      assert.equal(await count("agent_events"), beforeReceipts + 1);
      assert.equal(await count("sunbiz_phone_suppressions"), before + 1);
    });
    await check("provider revision or unresolved incoming deliveries invalidate old signing-key proof", async () => {
      const beforeCalls = providerCalls;
      assert.equal((await webhook.quoWebhookReadiness(tenant, origin, true)).ready, true);
      assert.equal(providerCalls - beforeCalls, 5, "bounded metadata GETs, independent of delivery volume");
      for (const revision of [undefined, "invalid", "2026-11-01T12:00:01Z"]) {
        providerUpdatedAt = revision;
        assert.equal((await webhook.quoWebhookReadiness(tenant, origin, true)).reason, "provider_revision_changed");
      }
      providerUpdatedAt = "2026-10-31T12:00:00Z";
      // Rotation is not guaranteed to update provider metadata. A STOP signed with
      // its new key is rejected locally and its unresolved provider delivery blocks SMS.
      const rotated = `whsec_${Buffer.alloc(32, 23).toString("base64")}`;
      assert.equal((await handle(request(event(), "after-rotation", now.getTime() / 1000, rotated))).status, 401);
      for (const status of ["pending", "sending", "failed"]) {
        pendingDeliveryStatus = status;
        assert.equal((await webhook.quoWebhookReadiness(tenant, origin, true)).reason, status === "failed" ? "provider_deliveries_failed" : "provider_delivery_backlog");
      }
      pendingDeliveryStatus = null; malformedDeliveries = true;
      await assert.rejects(webhook.quoWebhookReadiness(tenant, origin, true), /provider_unavailable/);
      malformedDeliveries = false;
      await save({ webhook_key: rotated });
      assert.equal((await webhook.quoWebhookReadiness(tenant, origin, true)).reason, "awaiting_signed_delivery");
      assert.equal((await handle(request(event("hello"), "new-key-proof", now.getTime() / 1000, rotated))).status, 200);
      assert.equal((await webhook.quoWebhookReadiness(tenant, origin, true)).ready, true);
      await save({ webhook_key: key });
    });
    await check("operator route ignores request tenant spoofing and respects auth denial", async () => {
      const { NextResponse } = await import("next/server"); let allowed = true; let askedTenant = "";
      const helpers = require.resolve("../lib/connections/route-helpers");
      require.cache[helpers] = { id: helpers, filename: helpers, loaded: true, exports: { resolveConnectionsActor: async () => allowed ? { ok: true, actor: { tenantId: tenant } } : { ok: false, response: NextResponse.json({ ok: false }, { status: 403 }) } } } as NodeModule;
      const moduleId = require.resolve("../lib/integrations/quo-webhook");
      require.cache[moduleId]!.exports = { ...webhook, quoWebhookReadiness: async (who: string) => { askedTenant = who; return { ready: false, configured: false, reason: "configuration_missing", receivedAt: null }; } };
      const route = await import("../app/api/integrations/quo/webhooks/route");
      const call = route.POST as (req?: Request) => Promise<Response>;
      assert.equal((await call(new Request(`${origin}/api/integrations/quo/webhooks?tenantId=${other}`, { method: "POST", headers: { "x-tenant-id": other }, body: JSON.stringify({ tenantId: other }) }))).status, 200);
      assert.equal(askedTenant, tenant); allowed = false; askedTenant = "";
      assert.equal((await route.POST()).status, 403); assert.equal(askedTenant, "");
    });
  } finally { globalThis.fetch = originalFetch; db.close(); }
  console.log(`quo-webhook: ${passed} checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
