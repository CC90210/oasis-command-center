import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "pipeline-delete-lead-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "pipeline-delete-lead-test-secret-that-is-long-enough-0001";

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
const headersPath = require.resolve("next/headers");
require.cache[headersPath] = {
  id: headersPath,
  filename: headersPath,
  path: dirname(headersPath),
  loaded: true,
  children: [],
  paths: [],
  exports: {
    cookies: async () => ({
      get: (name: string) =>
        name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined,
      getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
      has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
      set: () => undefined,
    }),
    headers: async () => new Headers(),
    draftMode: async () => ({ isEnabled: false }),
  },
} as unknown as NodeModule;

const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OTHER_TENANT = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const GRANTED_ADMIN = "33333333-3333-4333-8333-333333333333";
const DRY = "40000000-0000-4000-8000-000000000001";
const JUNK = "40000000-0000-4000-8000-000000000002";
const APPOINTMENT = "40000000-0000-4000-8000-000000000003";
const DEAL = "40000000-0000-4000-8000-000000000004";
const RECEIPT = "40000000-0000-4000-8000-000000000005";
const WON = "40000000-0000-4000-8000-000000000006";
const DOCUMENT = "40000000-0000-4000-8000-000000000007";
const OTHER_LEAD = "40000000-0000-4000-8000-000000000008";
const ROUTE_LEAD = "40000000-0000-4000-8000-000000000009";

const TABLES = [
  "tenant_records",
  "call_appointments",
  "lead_documents",
  "website_deals",
  "website_sales_payment_receipts",
  "form_submissions",
  "form_views",
  "offer_funnel_visit_leads",
  "offer_funnel_events",
  "drip_runs",
  "lead_interactions",
  "consent_events",
  "tenant_audit_log",
] as const;

function pass(name: string): void {
  console.log(`  ok  ${name}`);
}

async function state(db: Client): Promise<Record<string, unknown[]>> {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    const result = await db.execute(`SELECT * FROM ${table} ORDER BY 1`);
    snapshot[table] = result.rows.map((row) => {
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(row).sort()) normalized[key] = row[key];
      return normalized;
    });
  }
  return snapshot;
}

async function count(db: Client, table: string, where: string, args: string[]): Promise<number> {
  const result = await db.execute({ sql: `SELECT count(*) AS n FROM ${table} WHERE ${where}`, args });
  return Number(result.rows[0].n);
}

async function main(): Promise<void> {
  console.log("pipeline-delete-lead:");
  const seed = createClient({ url: `file:${dbFile}` });
  await seed.executeMultiple(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "_supabase_auth_users" (
      id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT
    );
    CREATE TABLE user_profiles (
      id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, updated_at TEXT
    );
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_manifests (
      id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL,
      data TEXT, created_by TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE call_appointments (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL,
      status TEXT NOT NULL, workflow_status TEXT, scheduled_for TEXT
    );
    CREATE TABLE lead_documents (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL, metadata TEXT
    );
    CREATE TABLE website_deals (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL
    );
    CREATE TABLE website_sales_payment_receipts (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL
    );
    -- The live blocker tables lib/pipeline/delete-lead.ts requires (a missing
    -- one fails the delete closed); empty here unless a check seeds them.
    CREATE TABLE website_onboarding (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL);
    CREATE TABLE website_sales_commissions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, deal_id TEXT NOT NULL);
    CREATE TABLE customers (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, source_lead_id TEXT);
    CREATE TABLE delivery_projects (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT);
    CREATE TABLE client_automation_profiles (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT);
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT NOT NULL,
      executed_at TEXT, payload_json TEXT
    );
    CREATE TABLE form_submissions (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL
    );
    CREATE TABLE form_views (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL
    );
    CREATE TABLE offer_funnel_visit_leads (
      tenant_id TEXT NOT NULL, visit_id TEXT NOT NULL, lead_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, visit_id)
    );
    CREATE TABLE offer_funnel_events (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT
    );
    CREATE TABLE drip_runs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE lead_interactions (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'email', metadata TEXT
    );
    CREATE TABLE consent_events (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL, decision TEXT
    );
    CREATE TRIGGER consent_events_no_delete BEFORE DELETE ON consent_events
      BEGIN SELECT RAISE(ABORT, 'consent_events is insert-only'); END;
    CREATE TABLE tenant_audit_log (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL,
      actor_email TEXT, actor_user_id TEXT, action_type TEXT, target_table TEXT,
      target_id TEXT, after TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const lead = (id: string, tenantId = TENANT, stage = "assigned") => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, tenantId, JSON.stringify({ name: `Lead ${id.slice(-2)}`, stage })],
  });
  await seed.batch([
    {
      sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'oasis-ai-cc', 'OASIS AI', '{}')",
      args: [TENANT],
    },
    {
      sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'other', 'Other', '{}')",
      args: [OTHER_TENANT],
    },
    {
      sql: "INSERT INTO _supabase_auth_users (id, email) VALUES (?, 'owner@oasis.test')",
      args: [OWNER],
    },
    {
      sql: "INSERT INTO _supabase_auth_users (id, email) VALUES (?, 'grant@oasis.test')",
      args: [GRANTED_ADMIN],
    },
    {
      sql: `INSERT INTO user_profiles
        (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access, onboarding_completed_at, updated_at)
        VALUES ('profile-owner', ?, 'owner@oasis.test', ?, 'owner', 1, 0, '2026-01-01', '2026-01-01')`,
      args: [OWNER, TENANT],
    },
    {
      sql: `INSERT INTO user_profiles
        (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access, onboarding_completed_at, updated_at)
        VALUES ('profile-grant', ?, 'grant@oasis.test', ?, 'member', 0, 1, '2026-01-01', '2026-01-01')`,
      args: [GRANTED_ADMIN, TENANT],
    },
    lead(DRY),
    lead(JUNK),
    lead(APPOINTMENT),
    lead(DEAL),
    lead(RECEIPT),
    lead(WON, TENANT, "won"),
    lead(DOCUMENT),
    lead(OTHER_LEAD, OTHER_TENANT),
    lead(ROUTE_LEAD),
    { sql: "INSERT INTO form_submissions VALUES ('dry-form', ?, ?)", args: [TENANT, DRY] },
    { sql: "INSERT INTO form_views VALUES ('dry-view', ?, ?)", args: [TENANT, DRY] },
    { sql: "INSERT INTO offer_funnel_visit_leads VALUES (?, 'dry-visit', ?)", args: [TENANT, DRY] },
    { sql: "INSERT INTO offer_funnel_events VALUES ('dry-event', ?, ?)", args: [TENANT, DRY] },
    { sql: "INSERT INTO drip_runs VALUES ('dry-drip', ?, ?, 'scheduled')", args: [TENANT, DRY] },
    {
      sql: "INSERT INTO lead_interactions (id, tenant_id, lead_id, metadata) VALUES ('dry-interaction', ?, ?, ?)",
      args: [TENANT, DRY, JSON.stringify({ status: "queued", campaign: "dry" })],
    },
    { sql: "INSERT INTO consent_events VALUES ('dry-consent', ?, ?, 'granted')", args: [TENANT, DRY] },
    { sql: "INSERT INTO form_submissions VALUES ('junk-form', ?, ?)", args: [TENANT, JUNK] },
    { sql: "INSERT INTO form_views VALUES ('junk-view', ?, ?)", args: [TENANT, JUNK] },
    { sql: "INSERT INTO offer_funnel_visit_leads VALUES (?, 'junk-visit', ?)", args: [TENANT, JUNK] },
    { sql: "INSERT INTO offer_funnel_events VALUES ('junk-event', ?, ?)", args: [TENANT, JUNK] },
    { sql: "INSERT INTO drip_runs VALUES ('junk-scheduled', ?, ?, 'scheduled')", args: [TENANT, JUNK] },
    { sql: "INSERT INTO drip_runs VALUES ('junk-sending', ?, ?, 'sending')", args: [TENANT, JUNK] },
    {
      sql: "INSERT INTO lead_interactions (id, tenant_id, lead_id, metadata) VALUES ('junk-queued', ?, ?, ?)",
      args: [TENANT, JUNK, JSON.stringify({ status: "queued", campaign: "spring", attempt: 2 })],
    },
    {
      sql: "INSERT INTO lead_interactions (id, tenant_id, lead_id, metadata) VALUES ('junk-sent', ?, ?, ?)",
      args: [TENANT, JUNK, JSON.stringify({ status: "sent", campaign: "spring" })],
    },    {
      sql: "INSERT INTO lead_interactions (id, tenant_id, lead_id, channel, metadata) VALUES ('junk-sms', ?, ?, 'sms', ?)",
      args: [TENANT, JUNK, JSON.stringify({ status: "queued", campaign: "sms" })],
    },
    { sql: "INSERT INTO consent_events VALUES ('junk-consent', ?, ?, 'granted')", args: [TENANT, JUNK] },
    {
      sql: "INSERT INTO call_appointments VALUES ('future-call', ?, ?, 'scheduled', 'active', ?)",
      args: [TENANT, APPOINTMENT, "2099-01-02T15:00:00.000Z"],
    },
    { sql: "INSERT INTO website_deals VALUES ('protected-deal', ?, ?)", args: [TENANT, DEAL] },
    {
      sql: "INSERT INTO website_sales_payment_receipts VALUES ('protected-receipt', ?, ?)",
      args: [TENANT, RECEIPT],
    },
    {
      sql: "INSERT INTO lead_documents VALUES ('protected-document', ?, ?, '{}')",
      args: [TENANT, DOCUMENT],
    },
    ...[APPOINTMENT, DEAL, RECEIPT, WON, DOCUMENT].map((id) => ({
      sql: "INSERT INTO drip_runs (id, tenant_id, lead_id, status) VALUES (?, ?, ?, 'scheduled')",
      args: [`block-${id.slice(-2)}`, TENANT, id],
    })),
  ], "write");

  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { deletePipelineLead } = await import("../lib/pipeline/delete-lead");
  const db = getServiceSupabase();
  const remove = (leadId: string, dryRun = false) =>
    deletePipelineLead(db, { tenantId: TENANT, leadId, actorUserId: OWNER, dryRun });

  const dryBefore = await state(seed);
  const dryResult = await remove(DRY, true);
  assert.equal(dryResult.ok, true);
  if (!dryResult.ok) throw new Error("dry run failed");
  assert.equal(dryResult.dryRun, true);
  assert.equal(dryResult.plan.cancel.drip_runs, 1);
  assert.equal(dryResult.plan.cancel.lead_interactions, 1);
  assert.equal(dryResult.plan.unlink.offer_funnel_events, 1);
  assert.equal(dryResult.plan.delete.form_submissions, 1);
  assert.equal(dryResult.plan.delete.form_views, 1);
  assert.equal(dryResult.plan.delete.offer_funnel_visit_leads, 1);
  assert.deepEqual(await state(seed), dryBefore, "dry run changed the database");
  pass("dry run returns exact counts and writes nothing");

  const assertBlocked = async (leadId: string, reason: RegExp) => {
    const before = await state(seed);
    const result = await remove(leadId);
    assert.equal(result.ok, false);
    if (result.ok || result.code !== "blocked") throw new Error(`expected ${leadId} to be blocked`);
    assert.ok(result.blockers.some((message) => reason.test(message)), JSON.stringify(result.blockers));
    assert.deepEqual(await state(seed), before, `${leadId} wrote before returning blocked`);
  };
  await assertBlocked(APPOINTMENT, /booked call.*cancel the call first/i);
  await assertBlocked(DEAL, /website deal/i);
  await assertBlocked(RECEIPT, /payment receipt/i);
  await assertBlocked(WON, /won stage/i);
  await assertBlocked(DOCUMENT, /documents/i);
  pass("every destructive-history blocker refuses with a readable reason and no writes");

  const junkResult = await remove(JUNK);
  assert.equal(junkResult.ok, true);
  if (!junkResult.ok) throw new Error("junk lead deletion failed");
  assert.equal(junkResult.dryRun, false);
  assert.equal(await count(seed, "tenant_records", "tenant_id = ? AND id = ?", [TENANT, JUNK]), 0);
  assert.equal(await count(seed, "form_submissions", "lead_id = ?", [JUNK]), 0);
  assert.equal(await count(seed, "form_views", "lead_id = ?", [JUNK]), 0);
  assert.equal(await count(seed, "offer_funnel_visit_leads", "lead_id = ?", [JUNK]), 0);
  const event = await seed.execute({ sql: "SELECT lead_id FROM offer_funnel_events WHERE id = 'junk-event'", args: [] });
  assert.equal(event.rows[0].lead_id, null);
  const drips = await seed.execute({ sql: "SELECT id, status FROM drip_runs WHERE lead_id = ? ORDER BY id", args: [JUNK] });
  assert.deepEqual(drips.rows.map((row) => [row.id, row.status]), [
    ["junk-scheduled", "cancelled"],
    ["junk-sending", "sending"],
  ]);
  const interactions = await seed.execute({
    sql: "SELECT id, metadata FROM lead_interactions WHERE lead_id = ? ORDER BY id",
    args: [JUNK],
  });
  const queued = JSON.parse(String(interactions.rows.find((row) => row.id === "junk-queued")?.metadata));
  const sent = JSON.parse(String(interactions.rows.find((row) => row.id === "junk-sent")?.metadata));
  const sms = JSON.parse(String(interactions.rows.find((row) => row.id === "junk-sms")?.metadata));
  assert.deepEqual(queued, {
    status: "cancelled",
    campaign: "spring",
    attempt: 2,
    cancelled_reason: "lead_deleted",
  });
  assert.equal(sent.status, "sent");
  assert.equal(sms.status, "queued");
  assert.equal(await count(seed, "consent_events", "lead_id = ?", [JUNK]), 1);
  assert.equal(await count(seed, "tenant_audit_log", "target_id = ? AND actor_user_id = ?", [JUNK, OWNER]), 1);
  const deletedState = await state(seed);
  assert.deepEqual(await remove(JUNK), { ok: false, code: "not_found" });
  assert.deepEqual(await state(seed), deletedState, "re-running a completed delete wrote again");
  pass("junk deletion cancels queued work, preserves history, unlinks funnel events, and audits last");

  const foreignResult = await remove(OTHER_LEAD);
  assert.deepEqual(foreignResult, { ok: false, code: "not_found" });
  assert.equal(await count(seed, "tenant_records", "tenant_id = ? AND id = ?", [OTHER_TENANT, OTHER_LEAD]), 1);
  pass("tenant scope makes another tenant's lead invisible and untouched");

  const { signSession, SESSION_COOKIE } = await import("../lib/turso-auth");
  assert.equal(SESSION_COOKIE, SESSION_COOKIE_NAME);
  const { NextRequest } = await import("next/server");
  const route = await import("../app/api/pipeline/[id]/delete/route");
  const bulk = await import("../app/api/leads/bulk/route");
  const records = await import("../app/api/manifest/[slug]/records/[entity]/route");
  const login = (userId: string, email: string) => {
    sessionCookie = signSession({ sub: userId, email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  };
  const request = (body: Record<string, unknown>) =>
    new NextRequest(`http://localhost/api/pipeline/${ROUTE_LEAD}/delete`, {
      method: "POST",
      headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  login(GRANTED_ADMIN, "grant@oasis.test");
  const denied = await route.POST(request({ confirm: "delete" }), { params: Promise.resolve({ id: ROUTE_LEAD }) });
  assert.equal(denied.status, 403);
  assert.equal(await count(seed, "tenant_records", "id = ?", [ROUTE_LEAD]), 1);

  login(OWNER, "owner@oasis.test");
  const unconfirmed = await route.POST(request({}), { params: Promise.resolve({ id: ROUTE_LEAD }) });
  assert.equal(unconfirmed.status, 400);
  assert.equal(await count(seed, "tenant_records", "id = ?", [ROUTE_LEAD]), 1);
  pass("pipeline delete route requires a true admin and exact confirmation");

  const bulkResponse = await bulk.POST(new NextRequest("http://localhost/api/leads/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "delete", ids: [DEAL, DRY], confirm: "delete" }),
  }));
  assert.equal(bulkResponse.status, 200);
  const bulkBody = await bulkResponse.json() as {
    results: Array<{ id: string; ok: boolean; code?: string; blockers?: string[] }>;
  };
  assert.equal(bulkBody.results[0].id, DEAL);
  assert.equal(bulkBody.results[0].code, "blocked");
  assert.ok((bulkBody.results[0].blockers || []).some((message) => /website deal/i.test(message)));
  assert.deepEqual(bulkBody.results[1], { id: DRY, ok: true });
  assert.equal(await count(seed, "tenant_records", "id = ?", [DEAL]), 1);
  assert.equal(await count(seed, "tenant_records", "id = ?", [DRY]), 0);
  pass("bulk delete keeps processing after a blocked lead");
  const manifestRequest = new NextRequest(
    `http://localhost/api/manifest/oasis-ai-cc/records/lead?id=${ROUTE_LEAD}`,
    { method: "DELETE" },
  );
  const refused = await records.DELETE(manifestRequest, {
    params: Promise.resolve({ slug: "oasis-ai-cc", entity: "lead" }),
  });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "use_pipeline_delete" });
  assert.equal(await count(seed, "tenant_records", "id = ?", [ROUTE_LEAD]), 1);
  pass("generic manifest DELETE redirects OASIS leads to the safe pipeline path");

  seed.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});