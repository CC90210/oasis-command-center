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
// Codex on #669: in-flight sends, booking history beyond "future", the atomic
// parent delete, and finishing an interrupted delete.
const INFLIGHT = "40000000-0000-4000-8000-000000000010";
const OVERDUE_CALL = "40000000-0000-4000-8000-000000000011";
const COMPLETED_CALL = "40000000-0000-4000-8000-000000000012";
const CANCELLED_CALL = "40000000-0000-4000-8000-000000000013";
const GUARDED = "40000000-0000-4000-8000-000000000014";
const HALF_DONE = "40000000-0000-4000-8000-000000000015";
// Codex on #669, second pass: direct-email states, a late deal after step 2.
const DIRECT_ATTEMPT = "40000000-0000-4000-8000-000000000016";
const LATE_DEAL = "40000000-0000-4000-8000-000000000017";

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
  "agent_events",
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
    -- The live shape that matters here: no tenant_id column, the tenant in the payload.
    CREATE TABLE agent_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), event_type TEXT NOT NULL,
      publisher_agent TEXT, severity TEXT, target_agent TEXT, payload TEXT, correlation_id TEXT
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
    lead(INFLIGHT),
    lead(OVERDUE_CALL),
    lead(COMPLETED_CALL),
    lead(CANCELLED_CALL),
    lead(GUARDED),
    lead(DIRECT_ATTEMPT),
    lead(LATE_DEAL),
    {
      sql: "INSERT INTO lead_interactions (id, tenant_id, lead_id, metadata) VALUES ('direct-attempting', ?, ?, ?)",
      args: [TENANT, DIRECT_ATTEMPT, JSON.stringify({ status: "direct_attempting" })],
    },
    { sql: "INSERT INTO drip_runs VALUES ('late-drip', ?, ?, 'scheduled')", args: [TENANT, LATE_DEAL] },
    { sql: "INSERT INTO drip_runs VALUES ('inflight-sending', ?, ?, 'sending')", args: [TENANT, INFLIGHT] },
    {
      sql: "INSERT INTO call_appointments VALUES ('overdue-call', ?, ?, 'scheduled', 'active', ?)",
      args: [TENANT, OVERDUE_CALL, "2020-01-02T15:00:00.000Z"],
    },
    {
      sql: "INSERT INTO call_appointments VALUES ('completed-call', ?, ?, 'completed', 'active', ?)",
      args: [TENANT, COMPLETED_CALL, "2020-01-02T15:00:00.000Z"],
    },
    {
      sql: "INSERT INTO call_appointments VALUES ('cancelled-call', ?, ?, 'cancelled', 'cancelled', ?)",
      args: [TENANT, CANCELLED_CALL, "2099-01-02T15:00:00.000Z"],
    },
    { sql: "INSERT INTO form_submissions VALUES ('half-form', ?, ?)", args: [TENANT, HALF_DONE] },
    { sql: "INSERT INTO form_views VALUES ('half-view', ?, ?)", args: [TENANT, HALF_DONE] },
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
    // A stage change copies the whole record into the event (lib/manifest/events.ts).
    ...[
      ["ev-dry", "BRAVO_RECORD_STATUS_CHANGED", { entity: "lead", record_id: DRY, field: "stage", from: null, to: "assigned", data: { email: "dry@lead.test" }, tenant_id: TENANT }],
      ["ev-junk-stage", "BRAVO_RECORD_STATUS_CHANGED", { entity: "lead", record_id: JUNK, field: "stage", from: null, to: "assigned", data: { name: "Junk Lead", email: "junk@lead.test", phone: "+15145550142" }, tenant_id: TENANT }],
      ["ev-junk-audit", "OASIS_AI_AUDIT_STARTED", { lead_id: JUNK, form_id: "f-1", tenant_id: TENANT }],
      ["ev-junk-foreign", "BRAVO_RECORD_STATUS_CHANGED", { entity: "lead", record_id: JUNK, data: { email: "theirs@other.test" }, tenant_id: OTHER_TENANT }],
      // A dashboard email that was queued (and is cancelled by the delete) vs one that went out.
      ["ev-junk-queued-email", "BRAVO_OUTBOUND_QUEUED_FROM_DASHBOARD", { lead_id: JUNK, to_email: "junk@lead.test", subject: "Hi", tenant_id: TENANT }],
      ["ev-junk-sent-email", "BRAVO_DASHBOARD_EMAIL_SENT", { lead_id: JUNK, to_email: "junk@lead.test", sent_as: "cc@oasis.test", tenant_id: TENANT }],
    ].map(([id, type, payload]) => ({
      sql: "INSERT INTO agent_events (id, event_type, publisher_agent, payload, correlation_id) VALUES (?, ?, 'manifest-data', ?, ?)",
      args: [id as string, type as string, JSON.stringify(payload), String((payload as { tenant_id: string }).tenant_id)],
    })),
    { sql: "INSERT INTO drip_runs VALUES ('junk-scheduled', ?, ?, 'scheduled')", args: [TENANT, JUNK] },
    { sql: "INSERT INTO drip_runs VALUES ('junk-sent', ?, ?, 'sent')", args: [TENANT, JUNK] },
    {
      sql: "INSERT INTO lead_interactions (id, tenant_id, lead_id, metadata) VALUES ('junk-queued', ?, ?, ?)",
      args: [TENANT, JUNK, JSON.stringify({ status: "queued", campaign: "spring", attempt: 2 })],
    },
    {
      sql: "INSERT INTO lead_interactions (id, tenant_id, lead_id, metadata) VALUES ('junk-sent', ?, ?, ?)",
      args: [TENANT, JUNK, JSON.stringify({ status: "sent", campaign: "spring" })],
    },
    {
      sql: "INSERT INTO lead_interactions (id, tenant_id, lead_id, metadata) VALUES ('junk-reserved', ?, ?, ?)",
      args: [TENANT, JUNK, JSON.stringify({ status: "direct_reserved" })],
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
  assert.equal(dryResult.plan.delete.agent_event_copies, 1, "the dry run does not say the event copy goes");
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
  await assertBlocked(INFLIGHT, /being sent right now/i);
  await assertBlocked(OVERDUE_CALL, /booked call.*cancel the call first/i);
  await assertBlocked(COMPLETED_CALL, /call history/i);
  await assertBlocked(DIRECT_ATTEMPT, /being sent right now/i);
  pass("every destructive-history blocker refuses with a readable reason and no writes");

  // Codex on #669, second pass: outside the Turso backend nothing is attempted.
  {
    const before = await state(seed);
    process.env.EMPIRE_DATA_BACKEND = "supabase_cloud";
    const refused = await remove(JUNK);
    process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.code, "unavailable");
    assert.deepEqual(await state(seed), before, "a non-Turso backend wrote something");
  }
  pass("outside the Turso backend a delete changes nothing");

  // A deal that appears after step 2 (simulated by a trigger on the drip cancel):
  // the lead and the deal stay, and the owner is told the queued message is gone.
  await seed.execute(`CREATE TRIGGER late_deal AFTER UPDATE OF status ON drip_runs
    WHEN NEW.lead_id = '${LATE_DEAL}' AND NEW.status = 'cancelled'
    BEGIN INSERT INTO website_deals VALUES ('late-deal', NEW.tenant_id, NEW.lead_id); END`);
  const late = await remove(LATE_DEAL);
  assert.equal(late.ok, false);
  if (late.ok || late.code !== "blocked") throw new Error("a late deal did not stop the delete");
  assert.ok(late.blockers.some((m) => /website deal/i.test(m)), JSON.stringify(late.blockers));
  assert.ok(late.blockers.some((m) => /1 queued message was already cancelled/i.test(m)), JSON.stringify(late.blockers));
  assert.equal(await count(seed, "tenant_records", "id = ?", [LATE_DEAL]), 1, "the lead was deleted with a deal on it");
  assert.equal(await count(seed, "website_deals", "id = 'late-deal'", []), 1, "the late deal was cascaded away");
  assert.equal(await count(seed, "tenant_audit_log", "target_id = ? AND action_type = 'pipeline_lead_delete_stopped'", [LATE_DEAL]), 1);
  pass("a deal that appears mid-delete keeps the lead, and the cancelled message is said out loud");

  // A cancelled booking is not booking history: the lead goes.
  const cancelledCall = await remove(CANCELLED_CALL);
  assert.equal(cancelledCall.ok, true, JSON.stringify(cancelledCall));
  assert.equal(await count(seed, "tenant_records", "id = ?", [CANCELLED_CALL]), 0);
  pass("a lead whose only booking was cancelled can be deleted");

  // The parent delete is one guarded statement: with a deal present it deletes
  // nothing, whatever the earlier checks saw (a deal created in between).
  const { guardedDeleteLead } = await import("../lib/pipeline/delete-lead");
  await seed.execute({ sql: "INSERT INTO website_deals VALUES ('race-deal', ?, ?)", args: [TENANT, GUARDED] });
  assert.equal(await guardedDeleteLead(TENANT, GUARDED), false, "the guarded delete removed a lead with a deal");
  assert.equal(await count(seed, "tenant_records", "id = ?", [GUARDED]), 1);
  assert.equal(await count(seed, "website_deals", "id = 'race-deal'", []), 1, "the deal was cascaded away");
  await seed.execute({ sql: "DELETE FROM website_deals WHERE id = 'race-deal'", args: [] });
  assert.equal(await guardedDeleteLead(TENANT, GUARDED), true, "control: with nothing guarded it deletes");
  pass("the parent delete re-checks every cascading row in the same statement");

  // A delete that stopped after the lead row went: the next run finishes it.
  assert.deepEqual(await remove(HALF_DONE), { ok: false, code: "not_found" });
  assert.equal(await count(seed, "form_submissions", "lead_id = ?", [HALF_DONE]), 0, "leftover form data was kept");
  assert.equal(await count(seed, "form_views", "lead_id = ?", [HALF_DONE]), 0);
  pass("a re-run finishes an interrupted delete");

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
    ["junk-sent", "sent"],
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
  // A queued transactional SMS is work still to send, like a queued email
  // (Codex on #669, second pass); so is the direct route's reservation.
  assert.equal(sms.status, "cancelled", "a queued SMS to the deleted lead is still queued");
  const reserved = JSON.parse(String(interactions.rows.find((row) => row.id === "junk-reserved")?.metadata));
  assert.equal(reserved.status, "cancelled", "a direct_reserved email survives the delete");
  assert.equal(await count(seed, "consent_events", "lead_id = ?", [JUNK]), 1);
  assert.equal(await count(seed, "tenant_audit_log", "target_id = ? AND actor_user_id = ?", [JUNK, OWNER]), 1);
  // The copy of the lead's details in its stage event goes; the event stays
  // (live E2E of #669: name, email and phone outlived the lead).
  const payloadOf = async (id: string) =>
    JSON.parse(String((await seed.execute({ sql: "SELECT payload FROM agent_events WHERE id = ?", args: [id] })).rows[0]?.payload)) as Record<string, unknown>;
  assert.equal(junkResult.plan.delete.agent_event_copies, 2);
  const stage = await payloadOf("ev-junk-stage");
  assert.equal("data" in stage, false, "the lead's name, email and phone outlived it in agent_events");
  assert.equal(stage.details_removed, "lead_deleted");
  // Codex on #674: a queued (now cancelled) email is not sent history; a sent one is.
  const queuedEmail = await payloadOf("ev-junk-queued-email");
  assert.equal("to_email" in queuedEmail, false, "a cancelled email's address outlived the lead");
  assert.equal(queuedEmail.subject, "Hi", "the queued event itself was damaged");
  assert.deepEqual(
    await payloadOf("ev-junk-sent-email"),
    { lead_id: JUNK, to_email: "junk@lead.test", sent_as: "cc@oasis.test", tenant_id: TENANT },
    "the record of a message that went out was rewritten",
  );
  assert.deepEqual([stage.entity, stage.record_id, stage.to, stage.tenant_id], ["lead", JUNK, "assigned", TENANT], "the event itself was damaged");
  assert.deepEqual(await payloadOf("ev-junk-audit"), { lead_id: JUNK, form_id: "f-1", tenant_id: TENANT }, "an event with no copy was rewritten");
  assert.deepEqual((await payloadOf("ev-junk-foreign")).data, { email: "theirs@other.test" }, "another workspace's event was touched");
  assert.deepEqual((await payloadOf("ev-dry")).data, { email: "dry@lead.test" }, "another lead's event was touched");
  const deletedState = await state(seed);
  assert.deepEqual(await remove(JUNK), { ok: false, code: "not_found" });
  assert.deepEqual(await state(seed), deletedState, "re-running a completed delete wrote again");
  // A stage change racing the delete writes its event after the cleanup ran
  // (Codex on #674): the publisher removes the copy itself once the row is gone.
  const { publishStatusChange } = await import("../lib/manifest/events");
  await publishStatusChange({ tenantId: TENANT, entity: "lead", recordId: JUNK, field: "stage", from: "assigned", to: "lost", data: { email: "late@lead.test" } });
  await publishStatusChange({ tenantId: TENANT, entity: "lead", recordId: DRY, field: "stage", from: "assigned", to: "qualified", data: { email: "dry@lead.test" } });
  const racing = await seed.execute({ sql: "SELECT payload FROM agent_events WHERE json_extract(payload, '$.to') IN ('lost', 'qualified') ORDER BY json_extract(payload, '$.to')", args: [] });
  const [lostEvent, liveEvent] = racing.rows.map((r) => JSON.parse(String(r.payload)) as Record<string, unknown>);
  assert.equal(lostEvent?.to, "lost", "the racing event was not written at all");
  assert.equal("data" in lostEvent, false, "an event written after the delete kept the deleted lead's details");
  assert.deepEqual(liveEvent?.data, { email: "dry@lead.test" }, "a live lead's event lost the copy its drips read");
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

  // Codex on #669: the bulk delete takes the single delete's same-origin and
  // JSON-only guards; a sibling origin or a text/plain POST deletes nothing.
  const bulkRequest = (origin: string, contentType: string) =>
    new NextRequest("http://localhost/api/leads/bulk", {
      method: "POST",
      headers: { host: "localhost", origin, "content-type": contentType },
      body: JSON.stringify({ op: "delete", ids: [DEAL, DRY], confirm: "delete" }),
    });
  for (const [origin, type] of [["http://evil.example", "application/json"], ["http://localhost", "text/plain"]]) {
    const refused = await bulk.POST(bulkRequest(origin, type));
    assert.equal(refused.status, 403, `${origin} ${type} was not refused`);
    assert.equal(await count(seed, "tenant_records", "id = ?", [DRY]), 1, `${origin} ${type} deleted a lead`);
  }
  const bulkResponse = await bulk.POST(bulkRequest("http://localhost", "application/json"));
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