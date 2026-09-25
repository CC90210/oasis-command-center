/**
 * website-sales-reschedule-host-deactivated.test.ts — the operator's
 * deal_outcome=reschedule on a founder meeting hosted by a deactivated rep is
 * refused with a code the lifecycle UI explains, and nothing moves.
 *
 * PATCH /api/website-sales/[leadId] runs for real against a local libSQL file
 * database — session, tenant and profile reads, the opener lookup, and the REAL
 * rescheduleVerifiedFounderMeeting with its default lib/team standing read over
 * call_appointments from migrations 167/169. Both refusals happen before the
 * service reaches Google, so no calendar stand-in is needed: a regression that
 * let either through would fail on the (unconfigured) Google boundary instead
 * of returning these codes. Stand-ins: next/headers' cookie jar and the stage
 * hooks (emails), which a refused reschedule never reaches.
 *
 * Run: node --conditions=react-server --import tsx tests/website-sales-reschedule-host-deactivated.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "website-sales-host-deactivated-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "website-sales-host-deactivated-secret-long-enough-01";
// Never let a test reach Google, a bridge, Stripe or Telegram, whatever the
// developer's shell holds.
for (const key of Object.keys(process.env)) {
  if (/^(GOOGLE_|BRIDGE_|STRIPE_|TELEGRAM_|SUNBIZ_TELEGRAM)/.test(key)) delete process.env[key];
}

function stubModule(path: string, exports: Record<string, unknown>) {
  require.cache[path] = {
    id: path,
    filename: path,
    path: dirname(path),
    loaded: true,
    children: [],
    paths: [],
    exports,
  } as unknown as NodeModule;
}

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
stubModule(require.resolve("next/headers"), {
  cookies: async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined,
    getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
    has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stubModule(require.resolve("../lib/portals/stage-hooks"), {
  runStageTransitionHooks: async () => undefined,
});

const CC = "8b8b8b8b-0000-4000-8000-000000000001";
const ETHAN = "8b8b8b8b-0000-4000-8000-000000000002";
const LEAD_RETIRED_HOST = "9c9c9c9c-0000-4000-8000-000000000001";
const LEAD_READ_ERROR = "9c9c9c9c-0000-4000-8000-000000000002";
const APPT_RETIRED_HOST = "9c9c9c9c-0000-4000-8000-00000000000a";
const APPT_READ_ERROR = "9c9c9c9c-0000-4000-8000-00000000000b";
const RETIRED_AT = "2026-09-24T12:00:00Z";

type ApiBody = { ok?: boolean; error?: string };

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(error);
  }
}

async function main() {
  console.log("website-sales-reschedule-host-deactivated:");
  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
  const { OASIS_WEBSITE_SALES_PROGRAM, OASIS_COLD_OUTBOUND_MOTION } = await import(
    "../lib/leads/canonical-lead-fields"
  );
  const TENANT = WEBDEV_TENANT_ID;

  const seed = createClient({ url: `file:${dbFile}` });
  const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  await seed.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (
      id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT
    );
    CREATE TABLE user_profiles (
      id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT,
      invited_by TEXT, manager_user_id TEXT, joined_at TEXT, updated_at TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT
    );
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_manifests (
      id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL, data TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE lead_interactions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT, direction TEXT,
      agent_source TEXT, actor_user_id TEXT, subject TEXT, content TEXT,
      content_preview TEXT, metadata TEXT, created_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE _realtime_nudges (scope TEXT PRIMARY KEY, bumped_at TEXT);
    CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT, applied_at TEXT, statements INTEGER);
    CREATE TABLE call_appointments (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'lead', scheduled_for TEXT NOT NULL, assigned_to TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled', pre_call_note TEXT, outcome_note TEXT,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
    );
    ${readFileSync("database/turso/167_founder_meeting_closed_loop.turso.sql", "utf8")}
    ${readFileSync("database/turso/169_founder_meeting_reminder_tiers.turso.sql", "utf8")}
  `);

  const bookedFor = new Date(Date.now() + 864e5).toISOString();
  const profile = (id: string, authId: string, email: string, role: string, name: string, deactivatedAt: string | null) => ({
    sql: `INSERT INTO user_profiles
            (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at,
             joined_at, updated_at, deactivated_at, deactivation_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z',
                  '2026-09-01T00:00:00Z', ?, ?)`,
    args: [id, authId, email, TENANT, role, role === "owner" ? 1 : 0, name,
      deactivatedAt, deactivatedAt ? "Sales team retired" : null],
  });
  const lead = (id: string, appointmentId: string) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, TENANT, JSON.stringify({
      name: "Client Owner",
      company: "Client Co",
      email: "owner@client.test",
      phone: "+15145550100",
      sales_program: OASIS_WEBSITE_SALES_PROGRAM,
      sales_motion: OASIS_COLD_OUTBOUND_MOTION,
      // Kept hot: CC holds the lead; the audit is still on the host's calendar.
      stage: "founder_meeting_booked",
      assigned_to: CC,
      attributed_rep_user_id: ETHAN,
      audit_host_user_id: CC,
      audit_host_email: "conaugh@oasisai.work",
      audit_host_role: "owner",
      calendar_appointment_id: appointmentId,
      founder_meeting_status: "booked",
      collaborators: [],
    })],
  });
  const appointment = (id: string, leadId: string, host: string, organizer: string) => ({
    sql: `INSERT INTO call_appointments (
      id, tenant_id, lead_id, scheduled_for, assigned_to, status, created_by, meeting_kind,
      duration_minutes, timezone, client_name_snapshot, company_snapshot, client_email_snapshot,
      client_phone_snapshot, website_snapshot, client_agenda, handoff_note, google_calendar_id,
      google_event_id, google_event_html_link, google_meet_link, google_ical_uid, calendar_status,
      organizer_email_snapshot, booking_request_id, revision, workflow_status, sms_consent
    ) VALUES (?,?,?,?,?,'scheduled',?,'founder_audit',15,'America/Toronto','Client Owner','Client Co',
      'owner@client.test','+15145550100','https://client.test','Review the site.','Qualified handoff.',
      'primary',?,'https://calendar.google.com/calendar/event?eid=test',
      'https://meet.google.com/abc-defg-hij','ical-1','verified',?,?,1,'active',0)`,
    args: [id, TENANT, leadId, bookedFor, host, host, `event-${id.slice(-4)}`, organizer, `booking-${id}`],
  });
  await seed.batch([
    { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [CC, "conaugh@oasisai.work"] },
    { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [ETHAN, "ethan@oasisai.work"] },
    profile("p-cc", CC, "conaugh@oasisai.work", "owner", "Conaugh", null),
    profile("p-ethan", ETHAN, "ethan@oasisai.work", "closer", "Ethan", RETIRED_AT),
    { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-webdev', 'OASIS AI')", args: [TENANT] },
    lead(LEAD_RETIRED_HOST, APPT_RETIRED_HOST),
    lead(LEAD_READ_ERROR, APPT_READ_ERROR),
    appointment(APPT_RETIRED_HOST, LEAD_RETIRED_HOST, ETHAN, "ethan@oasisai.work"),
    appointment(APPT_READ_ERROR, LEAD_READ_ERROR, CC, "conaugh@oasisai.work"),
  ], "write");

  const { signSession, SESSION_COOKIE } = await import("../lib/turso-auth");
  assert.equal(SESSION_COOKIE, SESSION_COOKIE_NAME, "the cookie-jar stand-in reads the wrong cookie name");
  const { NextRequest } = await import("next/server");
  const route = await import("../app/api/website-sales/[leadId]/route");
  sessionCookie = signSession({
    sub: CC,
    email: "conaugh@oasisai.work",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ver: 0,
  });
  const reschedule = async (leadId: string) => {
    const req = new NextRequest(`http://localhost/api/website-sales/${leadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "deal_outcome",
        outcome: "reschedule",
        outcomeConfirmed: true,
        note: "Client asked to move to Thursday.",
        nextActionAt: new Date(Date.now() + 2 * 864e5).toISOString(),
        requestId: randomUUID(),
        expectedStage: "founder_meeting_booked",
      }),
    });
    const res = await route.PATCH(req, { params: Promise.resolve({ leadId }) });
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const assertNothingMoved = async (leadId: string, appointmentId: string) => {
    const stored = JSON.parse(String((await seed.execute({
      sql: "SELECT data FROM tenant_records WHERE id = ?",
      args: [leadId],
    })).rows[0].data)) as Record<string, unknown>;
    assert.equal(stored.stage, "founder_meeting_booked");
    assert.equal(stored.founder_meeting_status, "booked", "the lead was transitioned");
    const row = (await seed.execute({
      sql: "SELECT scheduled_for, revision, workflow_status, pending_request_id FROM call_appointments WHERE id = ?",
      args: [appointmentId],
    })).rows[0];
    assert.equal(row.scheduled_for, bookedFor);
    assert.equal(Number(row.revision), 1);
    assert.equal(row.workflow_status, "active");
    assert.equal(row.pending_request_id, null);
    const queued = await seed.execute({
      sql: "SELECT COUNT(*) AS n FROM website_sales_meeting_notifications WHERE appointment_id = ?",
      args: [appointmentId],
    });
    assert.equal(Number(queued.rows[0].n), 0, "reminder rows were queued");
  };

  await check("a meeting hosted by a deactivated rep: 409 meeting_host_deactivated, nothing moves", async () => {
    const res = await reschedule(LEAD_RETIRED_HOST);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error, "meeting_host_deactivated");
    await assertNothingMoved(LEAD_RETIRED_HOST, APPT_RETIRED_HOST);
  });

  await check("an unreadable host standing: retryable 503 meeting_host_check_failed, nothing moves", async () => {
    // memberStanding selects deactivated_at; the session, tenant and lead reads
    // the rest of the route needs do not.
    await seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivated_at TO deactivated_at_unreadable");
    try {
      const res = await reschedule(LEAD_READ_ERROR);
      assert.equal(res.status, 503, JSON.stringify(res.body));
      assert.equal(res.body.error, "meeting_host_check_failed");
    } finally {
      await seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivated_at_unreadable TO deactivated_at");
    }
    await assertNothingMoved(LEAD_READ_ERROR, APPT_READ_ERROR);
  });

  await check("the lifecycle UI explains both codes in plain English instead of printing them", async () => {
    const ui = readFileSync("app/pipeline/[id]/LeadLifecycleActions.tsx", "utf8");
    assert.ok(ui.includes(
      `meeting_host_deactivated: "This meeting's host has been deactivated. Mark it no-show and book a new audit with an active host."`,
    ));
    assert.match(ui, /meeting_host_check_failed: "[^"]*Retry[^"]*"/);
  });

  seed.close();
  if (failures) {
    console.error(`website-sales-reschedule-host-deactivated: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("website-sales-reschedule-host-deactivated: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
