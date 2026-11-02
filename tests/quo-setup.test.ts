/** Real SQLite/encryption, intercepted provider boundary, no live registrations or messages. */
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const file = join(mkdtempSync(join(tmpdir(), "quo-setup-")), "db.sqlite");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = file;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "quo-setup-offline-fixture-encryption";
for (const name of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "QUO_API_KEY", "QUO_FROM_E164"]) delete process.env[name];
const tenant = "a1000000-0000-4000-8000-000000000001";
const other = "b1000000-0000-4000-8000-000000000002";
const origin = "https://oasisai.work";
const apiKey = "fixture-private-quo-api-key";
const signingKey = `whsec_${Buffer.alloc(32, 19).toString("base64")}`;
const phoneId = "PNfixture";
const number = "+14165550100";
const owner = { ok: true as const, userId: "owner-auth", profileId: "owner-profile", tenantId: tenant, email: null, teamRole: "owner", isAdmin: true, isTrueAdmin: true, adminAccess: false };
let passed = 0;
async function check(name: string, work: () => Promise<void>) { await work(); passed++; console.log(`ok ${name}`); }

async function main() {
  const db = createClient({ url: `file:${file}` });
  await db.executeMultiple(`
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY,auth_user_id TEXT,tenant_id TEXT,is_owner INTEGER,team_role TEXT,deactivated_at TEXT);
    CREATE TABLE tenant_integration_credentials (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),tenant_id TEXT,service TEXT,field_key TEXT,encrypted_value TEXT,created_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,last_tested_at TEXT,last_test_ok INTEGER,last_test_error TEXT,UNIQUE(tenant_id,service,field_key));
  `);
  await db.execute({ sql: "INSERT INTO user_profiles (id,auth_user_id,tenant_id,is_owner,team_role) VALUES (?,?,?,1,'owner'),('admin-profile','admin-auth',?,0,'admin'),('other-profile','other-auth',?,1,'owner')", args: [owner.profileId, owner.userId, tenant, tenant, other] });
  const { encryptField, decryptField } = await import("../lib/field-encryption");
  const { handleQuoSetup } = await import("../lib/integrations/quo-setup-route");
  const { quoWebhookReadiness } = await import("../lib/integrations/quo-webhook");
  const put = async (key: string, value: string, who = tenant) => db.execute({ sql: "INSERT INTO tenant_integration_credentials (tenant_id,service,field_key,encrypted_value) VALUES (?,'quo',?,?) ON CONFLICT(tenant_id,service,field_key) DO UPDATE SET encrypted_value=excluded.encrypted_value", args: [who, key, encryptField(value)] });
  const rows = async (who = tenant) => (await db.execute({ sql: "SELECT service,field_key,encrypted_value FROM tenant_integration_credentials WHERE tenant_id=? ORDER BY service,field_key", args: [who] })).rows;
  const reset = async () => { await db.execute("DELETE FROM tenant_integration_credentials"); await put("api_key", apiKey); };
  const posted: Array<Record<string, unknown>> = [];
  let calls = 0;
  let override: ((url: URL, init: RequestInit) => Promise<Response | null>) | null = null;
  const fetcher: typeof fetch = async (input, supplied) => {
    calls++;
    const url = new URL(String(input)); const init = supplied ?? {};
    assert.equal(url.origin, "https://api.quo.com"); assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("Authorization"), apiKey);
    assert.equal(new Headers(init.headers).get("Quo-Api-Version"), "2026-03-30");
    assert.ok(["GET", "POST"].includes(init.method!));
    if (init.method === "POST") {
      assert.equal(url.pathname, "/webhooks", "never sends SMS/test deliveries/deletes/rotations");
      posted.push(JSON.parse(String(init.body)));
    }
    const response = await override?.(url, init); if (response) return response;
    if (url.pathname === "/phone-numbers") {
      assert.equal(init.method, "GET"); assert.equal(url.searchParams.get("include"), "restrictions");
      return Response.json({ data: [{ id: phoneId, phoneNumber: number, name: "OASIS fixture", restrictions: { messaging: { CA: "unrestricted", US: "restricted" } }, private_extra: "must not escape" }], nextCursor: null });
    }
    if (url.pathname === "/webhooks" && init.method === "GET") return Response.json({ data: [] });
    const body = JSON.parse(String(init.body));
    return Response.json({ data: { ...body, id: "12345", orgId: "ORfixture", key: signingKey, apiVersion: "2026-03-30" } }, { status: 201 });
  };
  const request = (body?: unknown, headers: Record<string, string> = {}) => new Request(`${origin}/api/integrations/quo/setup`, {
    method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const run = async (req: Request, session = owner, changedDb = db) => {
    const result = await handleQuoSetup(req, { session: async () => session, db: () => changedDb, origin: () => origin, fetcher });
    const body = await result.json();
    const output = JSON.stringify(body);
    assert.ok(!output.includes(apiKey) && !output.includes(signingKey) && !output.includes("must not escape"), "secrets/raw provider fields never escape");
    return { status: result.status, body };
  };
  await check("owner gate rejects admins, spoofed tenant/profile and cross-origin writes before provider calls", async () => {
    await reset(); const before = calls;
    assert.equal((await run(request(), { ...owner, profileId: "admin-profile", userId: "admin-auth", teamRole: "admin" })).status, 403);
    assert.equal((await run(request(), { ...owner, tenantId: other })).status, 403);
    assert.equal((await run(request({ phoneNumberId: phoneId }, { origin: "https://attacker.example" }))).status, 403);
    assert.equal((await run(request({ phoneNumberId: phoneId, tenantId: other }))).status, 422);
    assert.equal((await run(request("x".repeat(1025)))).status, 413);
    assert.equal(calls, before); assert.equal((await rows()).length, 1);
  });
  await check("a deactivated owner's existing session cannot read numbers or configure the provider", async () => {
    await reset(); const before = calls;
    await db.execute({ sql: "UPDATE user_profiles SET deactivated_at='2026-11-01T00:00:00Z' WHERE id=? AND tenant_id=?", args: [owner.profileId, tenant] });
    try {
      assert.equal((await run(request())).status, 403);
      assert.equal((await run(request({ phoneNumberId: phoneId }))).status, 403);
      assert.equal(calls, before); assert.equal((await rows()).length, 1);
    } finally {
      await db.execute({ sql: "UPDATE user_profiles SET deactivated_at=NULL WHERE id=? AND tenant_id=?", args: [owner.profileId, tenant] });
    }
  });
  await check("versioned discovery paginates and returns only authorized sender metadata", async () => {
    override = async (url) => url.pathname === "/phone-numbers" && !url.searchParams.has("after") ? Response.json({ data: [], nextCursor: "fixture-page-2" }) : null;
    const result = await run(request(undefined, { "x-tenant-id": other }));
    assert.equal(result.status, 200); assert.equal(result.body.state, "idle");
    assert.deepEqual(result.body.numbers, [{ id: phoneId, number, name: "OASIS fixture", messaging: { CA: "allowed", US: "restricted", Intl: "unknown" } }]);
    override = null;
  });
  await check("unauthorized number and incomplete discovery fail closed without registration or claim", async () => {
    const before = posted.length;
    assert.equal((await run(request({ phoneNumberId: "PNnotyours" }))).status, 422);
    override = async url => url.pathname === "/phone-numbers" ? Response.json({ data: [] }) : null;
    assert.equal((await run(request())).body.error, "provider_response_invalid");
    override = null; assert.equal(posted.length, before); assert.equal((await rows()).length, 1);
  });
  await check("registration saves encrypted bundle once; retries never recreate and signed delivery remains required", async () => {
    const before = posted.length;
    const result = await run(request({ phoneNumberId: phoneId }));
    assert.equal(result.status, 200); assert.equal(result.body.ready, false);
    assert.equal(posted.length, before + 1);
    assert.deepEqual(posted.at(-1), { url: `${origin}/api/webhooks/quo/${tenant}`, events: ["message.received"], resourceIds: [phoneId], status: "enabled", label: "OASIS incoming texts" });
    const persisted = await rows(); assert.equal(persisted.length, 7);
    assert.ok(!JSON.stringify(persisted).includes(apiKey) && !JSON.stringify(persisted).includes(signingKey));
    const values = Object.fromEntries(persisted.filter(r => r.service === "quo").map(r => [String(r.field_key), decryptField(String(r.encrypted_value))]));
    assert.equal(values.webhook_key, signingKey); assert.equal(values.from_number, number);
    assert.equal((await quoWebhookReadiness(tenant, origin, false)).reason, "awaiting_signed_delivery");
    assert.equal((await run(request({ phoneNumberId: phoneId }))).status, 200);
    assert.equal(posted.length, before + 1);
    assert.equal((await run(request({ phoneNumberId: "PNdifferent" }))).body.error, "setup_selection_locked");
    assert.equal((await rows(other)).length, 0);
  });
  await check("concurrent clicks have one durable tenant claim and one provider registration", async () => {
    await reset(); const before = posted.length;
    let release!: () => void; let started!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const seen = new Promise<void>(resolve => { started = resolve; });
    override = async (_url, init) => { if (init.method === "POST") { started(); await waiting; } return null; };
    const first = run(request({ phoneNumberId: phoneId })); await seen;
    const second = await run(request({ phoneNumberId: phoneId }));
    assert.equal(second.status, 409); assert.equal(second.body.error, "registration_uncertain");
    release(); assert.equal((await first).status, 200); override = null;
    assert.equal(posted.length, before + 1);
  });
  await check("timeout after provider POST never expires or retries an uncertain registration", async () => {
    await reset(); const before = posted.length;
    override = async (_url, init) => { if (init.method === "POST") throw new Error(`private ${apiKey}`); return null; };
    assert.equal((await run(request({ phoneNumberId: phoneId }))).body.error, "registration_uncertain");
    override = null;
    assert.equal((await run(request({ phoneNumberId: phoneId }))).body.error, "registration_uncertain");
    assert.equal(posted.length, before + 1); assert.equal((await rows()).filter(r => r.service === "quo").length, 1);
  });
  await check("final DB failure rolls back all credentials; encrypted candidate resumes without provider mutation", async () => {
    await reset(); const before = posted.length;
    await db.executeMultiple("CREATE TRIGGER fail_bundle BEFORE INSERT ON tenant_integration_credentials WHEN NEW.service='quo' AND NEW.field_key='webhook_id' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
    assert.equal((await run(request({ phoneNumberId: phoneId }))).status, 503);
    assert.equal((await rows()).filter(r => r.service === "quo").length, 1, "no partial From/key bundle");
    await db.execute("DROP TRIGGER fail_bundle");
    const beforeRecovery = calls;
    override = async () => { throw new Error("provider unavailable during recovery"); };
    const recoverable = await run(request());
    assert.equal(recoverable.status, 200, "stored recovery does not depend on live discovery");
    assert.equal(recoverable.body.state, "registered");
    assert.deepEqual(recoverable.body.selection, { id: phoneId, number });
    assert.deepEqual(recoverable.body.numbers, []);
    assert.equal((await run(request({ phoneNumberId: phoneId }))).status, 200);
    assert.equal(calls, beforeRecovery, "both exposing and finishing the candidate work without the provider");
    override = null;
    assert.equal(posted.length, before + 1);
  });
  await check("candidate persistence failure retains non-expiring uncertainty and blocks a second registration", async () => {
    await reset(); const before = posted.length;
    await db.executeMultiple("CREATE TRIGGER fail_candidate BEFORE UPDATE ON tenant_integration_credentials WHEN NEW.service='quo_setup_operation' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
    assert.equal((await run(request({ phoneNumberId: phoneId }))).body.error, "registration_uncertain");
    await db.execute("DROP TRIGGER fail_candidate");
    assert.equal((await run(request({ phoneNumberId: phoneId }))).body.error, "registration_uncertain");
    assert.equal(posted.length, before + 1);
  });
  await check("concurrent settings edits are preserved and never overwritten by delayed registration", async () => {
    await reset();
    override = async (_url, init) => { if (init.method === "POST") await put("from_number", "+14165550999"); return null; };
    const result = await run(request({ phoneNumberId: phoneId })); override = null;
    assert.equal(result.status, 409); assert.equal(result.body.error, "configuration_changed");
    const saved = (await rows()).find(r => r.service === "quo" && r.field_key === "from_number")!;
    assert.equal(decryptField(String(saved.encrypted_value)), "+14165550999");
    assert.equal((await rows()).filter(r => r.service === "quo").length, 2);
  });
  await check("a settings edit during discovery aborts before registration without leaving a permanent claim", async () => {
    await reset(); const before = posted.length;
    override = async (url, init) => {
      if (url.pathname === "/webhooks" && init.method === "GET") await put("from_number", "+14165550999");
      return null;
    };
    const changed = await run(request({ phoneNumberId: phoneId }));
    override = null;
    assert.equal(changed.status, 409); assert.equal(changed.body.error, "configuration_changed");
    assert.equal(posted.length, before, "the provider registration never started");
    assert.equal((await rows()).filter(r => r.service === "quo_setup_operation").length, 0,
      "a pre-registration abort leaves nothing falsely uncertain");
    assert.equal((await run(request({ phoneNumberId: phoneId }))).status, 200);
    assert.equal(posted.length, before + 1, "a fresh owner retry can register exactly once");
  });
  await check("key changes during credential resolution are caught before provider calls", async () => {
    await reset(); const before = calls;
    const result = await handleQuoSetup(request({ phoneNumberId: phoneId }), { session: async () => owner, db: () => db, origin: () => origin, fetcher,
      credentials: async who => { await put("api_key", "fixture-new-key"); return { tenantId: who, apiKey, fromNumber: null }; } });
    assert.equal(result.status, 409); assert.equal((await result.json()).error, "configuration_changed");
    assert.equal(calls, before); assert.equal((await rows()).length, 1);
  });
  await check("saved configuration drift is visible and uncertain setup status survives provider outage", async () => {
    await reset(); assert.equal((await run(request({ phoneNumberId: phoneId }))).status, 200);
    await put("from_number", "+14165550999");
    override = async () => { throw new Error("provider should not be called"); };
    assert.equal((await run(request())).body.state, "needs_review"); override = null;
    await reset();
    override = async (_url, init) => { if (init.method === "POST") throw new Error("timeout"); return null; };
    await run(request({ phoneNumberId: phoneId }));
    override = async () => { throw new Error("provider should not be called"); };
    assert.equal((await run(request())).body.state, "creating"); override = null;
  });
  await check("existing provider callback and partial manual setup never create duplicates", async () => {
    await reset(); const before = posted.length;
    override = async (url, init) => url.pathname === "/webhooks" && init.method === "GET" ? Response.json({ data: [{ url: `${origin}/api/webhooks/quo/${tenant}` }] }) : null;
    assert.equal((await run(request({ phoneNumberId: phoneId }))).body.error, "existing_setup_requires_review");
    override = null; await put("webhook_id", "999");
    assert.equal((await run(request({ phoneNumberId: phoneId }))).body.error, "existing_setup_requires_review");
    assert.equal(posted.length, before);
  });
  await check("provider read failures are errors, not empty number lists or fake readiness", async () => {
    await reset(); const before = posted.length;
    override = async () => new Response("private provider message", { status: 503 });
    const result = await run(request()); override = null;
    assert.equal(result.status, 503); assert.equal(result.body.error, "provider_unavailable");
    assert.equal(result.body.numbers, undefined); assert.equal(posted.length, before);
    assert.equal((await rows()).length, 1);
  });
  await check("route/UI expose owner setup and separate signed-delivery check", async () => {
    const route = readFileSync("app/api/integrations/quo/setup/route.ts", "utf8");
    assert.match(route, /handleQuoSetup\(req\)/);
    const drawer = readFileSync("components/os/connections/ConnectorDrawer.tsx", "utf8");
    assert.ok(drawer.includes("<QuoSetupPanel") && drawer.includes("<QuoWebhooksPanel"));
    const panel = readFileSync("components/os/connections/QuoSetupPanel.tsx", "utf8");
    assert.ok(panel.includes("Finish saving setup") && panel.includes("Automated texts remain blocked"));
    assert.ok(!panel.includes("webhook_key") && !panel.includes("api_key"));
  });
  db.close(); console.log(`quo-setup: ${passed} passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
