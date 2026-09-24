/**
 * website-sales-deactivated-live-parties.test.ts — a deactivated teammate keeps
 * their HISTORY on an OASIS deal but is never handed LIVE work by the
 * website-sales lifecycle.
 *
 * Kept-hot board leads (qualified, founder_meeting_booked, ...) still carry a
 * rep retired on 2026-09-24 as attributed_rep_user_id. Before this fix:
 *
 *   - book_founder and the deal_outcome=reschedule path invited that frozen
 *     opener onto the CLIENT's Google Calendar event, and book_founder re-added
 *     them as a collaborator on the deal;
 *   - record_payment re-granted a deactivated opener/closer a collaborator seat
 *     and accepted a deactivated builder as the fulfillment owner (and wrote the
 *     payment receipt before it even looked at the builder);
 *   - the SMS reply agent invited the frozen opener on a client-driven
 *     reschedule, and threw — failing the client's reschedule — when the
 *     opener's profile could not be read.
 *
 * PATCH /api/website-sales/[leadId] runs for real against a local libSQL
 * database: session, tenant and profile reads, the rosters, and the
 * transition_pipeline_lead / close_website_deal shims over the real migration
 * 154/160/164 ledger tables. The stand-ins are next/headers' cookie jar, the
 * Google Calendar service boundary (lib/website-sales-founder-meeting, which
 * records the invite it was asked to send), and the stage hooks (emails).
 *
 * Run: node --conditions=react-server --import tsx tests/website-sales-deactivated-live-parties.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "website-sales-deactivated-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "website-sales-deactivated-secret-that-is-long-enough-01";
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

type OpenerAttendee = { email: string; displayName?: string } | null | undefined;
type CalendarCall = { kind: "create" | "reschedule"; leadId: string; openerAttendee: OpenerAttendee };
const calendarCalls: CalendarCall[] = [];
function verifiedMeeting(input: { requestId: string; meetingAt: string }) {
  return {
    appointmentId: randomUUID(),
    requestId: input.requestId,
    meetingAt: new Date(input.meetingAt).toISOString(),
    timezone: "America/Toronto",
    contact: {
      name: "Client Owner",
      company: "Client Co",
      email: "owner@client.test",
      phone: "+15145550100",
      website: "https://client.test",
    },
    receipt: {
      calendarId: "primary",
      eventId: `evt-${input.requestId.slice(0, 8)}`,
      htmlLink: "https://calendar.google.com/calendar/event?eid=test",
      meetLink: "https://meet.google.com/abc-defg-hij",
      iCalUID: "uid-test@google.com",
    },
    revision: 2,
  };
}
stubModule(require.resolve("../lib/website-sales-founder-meeting"), {
  createVerifiedFounderMeeting: async (input: {
    leadId: string; requestId: string; meetingAt: string; openerAttendee?: OpenerAttendee;
  }) => {
    calendarCalls.push({ kind: "create", leadId: input.leadId, openerAttendee: input.openerAttendee });
    return verifiedMeeting(input);
  },
  rescheduleVerifiedFounderMeeting: async (input: {
    leadId: string; requestId: string; meetingAt: string; openerAttendee?: OpenerAttendee;
  }) => {
    calendarCalls.push({ kind: "reschedule", leadId: input.leadId, openerAttendee: input.openerAttendee });
    return verifiedMeeting(input);
  },
  activateVerifiedFounderMeeting: async () => undefined,
  cancelVerifiedFounderMeeting: async () => ({ disposition: "cancelled" }),
  closeVerifiedFounderMeeting: async () => undefined,
  prepareVerifiedFounderMeetingCancellation: async () => ({ disposition: "cancelled" }),
  grantFounderMeetingSmsConsent: async () => undefined,
  founderMeetingSmsConsentErrorResponse: () => ({ status: 500, body: { ok: false } }),
});
stubModule(require.resolve("../lib/portals/stage-hooks"), {
  runStageTransitionHooks: async () => undefined,
});

const CC = "3c3c3c3c-0000-4000-8000-000000000001";
const ADON = "3c3c3c3c-0000-4000-8000-000000000002";
const OPENER = "3c3c3c3c-0000-4000-8000-000000000003";
const RETIRED = "3c3c3c3c-0000-4000-8000-000000000004";
const BUILDER = "3c3c3c3c-0000-4000-8000-000000000005";
const RETIRED_BUILDER = "3c3c3c3c-0000-4000-8000-000000000006";

const BOOK_RETIRED = "4d4d4d4d-0000-4000-8000-000000000001";
const BOOK_ACTIVE = "4d4d4d4d-0000-4000-8000-000000000002";
const RESCHED_RETIRED = "4d4d4d4d-0000-4000-8000-000000000003";
const RESCHED_ACTIVE = "4d4d4d4d-0000-4000-8000-000000000004";
const RESCHED_READ_ERROR = "4d4d4d4d-0000-4000-8000-000000000005";
const PAY_LEAD = "4d4d4d4d-0000-4000-8000-000000000006";

const RETIRED_AT = "2026-09-24T12:00:00Z";
const BUILD_BRIEF = {
  version: 1,
  status: "ready_for_pricing",
  businessGoal: "Generate qualified calls",
  targetAudience: "Local business customers",
  mustHavePages: "Home, services, contact",
  requiredFeatures: "Quote form and analytics",
  integrations: "GA4",
  contentAndAssets: "Logo ready; copy to draft",
  domainAndAccess: "Client owns domain",
  launchTiming: "Four weeks",
  decisionProcess: "Owner approves launch",
  transcriptNotes: "",
  capturedAt: "2026-09-20T00:00:00.000Z",
  capturedBy: CC,
};

type ApiBody = {
  ok?: boolean;
  error?: string;
  message?: string;
  idempotent?: boolean;
  stage?: string;
  builderUserId?: string;
};

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
  console.log("website-sales-deactivated-live-parties:");
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
    CREATE UNIQUE INDEX website_sales_interaction_request_uidx
      ON lead_interactions (tenant_id, json_extract(metadata, '$.request_id'))
      WHERE agent_source = 'website_sales_pipeline'
        AND json_extract(metadata, '$.request_id') IS NOT NULL;
    CREATE TABLE _realtime_nudges (scope TEXT PRIMARY KEY, bumped_at TEXT);
    CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT, applied_at TEXT, statements INTEGER);
  `);
  // The real ledger tables, straight from the migrations (same extraction as
  // tests/website-sales-close-ledger.test.ts) so the close runs end to end.
  const ledger = readFileSync("database/turso/154_commission_ledger_v3.turso.sql", "utf8");
  for (const stmt of ledger
    .split(/;\s*\n/)
    .filter((s) => /^\s*CREATE TABLE "website_(deals|sales_commissions|onboarding)"/m.test(s))) {
    await seed.execute(stmt);
  }
  const payments = readFileSync("database/turso/160_website_sales_payment_receipts.turso.sql", "utf8");
  const receiptTable = payments.match(/CREATE TABLE IF NOT EXISTS "website_sales_payment_receipts"[\s\S]*?\n\);/)?.[0];
  assert.ok(receiptTable, "migration 160 must define the verified-payment receipt table");
  await seed.execute(receiptTable);
  for (const match of payments.matchAll(/ALTER TABLE "website_deals" ADD COLUMN[\s\S]*?;/g)) {
    await seed.execute(match[0].slice(0, -1));
  }
  await seed.executeMultiple(readFileSync("database/turso/164_website_sales_installment_ledger.turso.sql", "utf8"));

  const profile = (
    id: string,
    authId: string,
    email: string,
    role: string,
    fullName: string,
    opts: { owner?: boolean; deactivatedAt?: string } = {},
  ) => ({
    sql: `INSERT INTO user_profiles
            (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at,
             joined_at, updated_at, deactivated_at, deactivation_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z',
                  '2026-09-01T00:00:00Z', ?, ?)`,
    args: [
      id, authId, email, TENANT, role, opts.owner ? 1 : 0, fullName,
      opts.deactivatedAt ?? null, opts.deactivatedAt ? "Sales team retired" : null,
    ],
  });
  const salesLead = (id: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, TENANT, JSON.stringify({
      name: "Client Owner",
      company: "Client Co",
      email: "owner@client.test",
      phone: "+15145550100",
      sales_program: OASIS_WEBSITE_SALES_PROGRAM,
      sales_motion: OASIS_COLD_OUTBOUND_MOTION,
      ...data,
    })],
  });
  // A booked meeting CC hosts; the opener is whoever the lead froze.
  const bookedMeeting = (attributed: string) => ({
    stage: "founder_meeting_booked",
    assigned_to: CC,
    attributed_rep_user_id: attributed,
    audit_host_user_id: CC,
    audit_host_email: "conaugh@oasisai.work",
    audit_host_role: "owner",
    calendar_appointment_id: randomUUID(),
    collaborators: [],
  });

  await seed.batch(
    [
      ...[
        [CC, "conaugh@oasisai.work"],
        [ADON, "adon@oasisai.work"],
        [OPENER, "opener@oasis.test"],
        [RETIRED, "retired@oasis.test"],
        [BUILDER, "builder@oasis.test"],
        [RETIRED_BUILDER, "retired-builder@oasis.test"],
      ].map(([id, email]) => ({
        sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`,
        args: [id, email],
      })),
      profile("p-cc", CC, "conaugh@oasisai.work", "owner", "Conaugh", { owner: true }),
      profile("p-adon", ADON, "adon@oasisai.work", "admin", "Adon"),
      profile("p-opener", OPENER, "opener@oasis.test", "opener", "Active Opener"),
      profile("p-retired", RETIRED, "retired@oasis.test", "opener", "Retired Rep", { deactivatedAt: RETIRED_AT }),
      profile("p-builder", BUILDER, "builder@oasis.test", "builder", "Active Builder"),
      profile("p-retired-builder", RETIRED_BUILDER, "retired-builder@oasis.test", "builder", "Retired Builder", {
        deactivatedAt: RETIRED_AT,
      }),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-webdev', 'OASIS AI')", args: [TENANT] },
      // Kept-hot leads: CC now holds them, the retired rep is the frozen opener.
      salesLead(BOOK_RETIRED, { stage: "qualified", assigned_to: CC, attributed_rep_user_id: RETIRED, collaborators: [] }),
      salesLead(BOOK_ACTIVE, { stage: "qualified", assigned_to: CC, attributed_rep_user_id: OPENER, collaborators: [] }),
      salesLead(RESCHED_RETIRED, bookedMeeting(RETIRED)),
      salesLead(RESCHED_ACTIVE, bookedMeeting(OPENER)),
      salesLead(RESCHED_READ_ERROR, bookedMeeting(OPENER)),
      // Proposal accepted; the retired rep opened it and the founder verifies
      // the cash, so the retired rep is the paid sales party (history).
      salesLead(PAY_LEAD, {
        stage: "proposal_sent",
        assigned_to: CC,
        attributed_rep_user_id: RETIRED,
        audit_host_user_id: CC,
        audit_host_role: "owner",
        booked_founder: CC,
        collaborators: [],
        recommended_tier: "starter",
        automation_interests: [],
        quoted_setup_amount: 1500,
        payment_due_amount: 1500,
        quoted_monthly_amount: 200,
        collected_setup_amount: 0,
        currency: "CAD",
        proposal_payment_token: randomUUID(),
        payment_plan_id: randomUUID(),
        build_brief: BUILD_BRIEF,
      }),
    ],
    "write",
  );

  const { signSession, SESSION_COOKIE } = await import("../lib/turso-auth");
  assert.equal(SESSION_COOKIE, SESSION_COOKIE_NAME, "the cookie-jar stand-in reads the wrong cookie name");
  const { NextRequest } = await import("next/server");
  const route = await import("../app/api/website-sales/[leadId]/route");
  const { resolveSmsAgentOpenerAttendee } = await import("../lib/sms/reply-agent");
  const { MEMBER_DEACTIVATED_MESSAGE } = await import("../lib/team");

  sessionCookie = signSession({
    sub: CC,
    email: "conaugh@oasisai.work",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ver: 0,
  });
  const patch = async (leadId: string, body: Record<string, unknown>) => {
    const req = new NextRequest(`http://localhost/api/website-sales/${leadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await route.PATCH(req, { params: Promise.resolve({ leadId }) });
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const stored = async (id: string) => {
    const res = await seed.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [id] });
    return JSON.parse(String(res.rows[0]?.data)) as Record<string, unknown>;
  };
  const count = async (sql: string, args: string[]) =>
    Number((await seed.execute({ sql, args })).rows[0]?.n ?? 0);
  const lastCall = (leadId: string) => calendarCalls.filter((call) => call.leadId === leadId).at(-1);
  const inTwoDays = () => new Date(Date.now() + 2 * 864e5).toISOString();
  // Make memberStanding's read fail (it selects deactivated_at) without
  // touching the session, tenant or lead reads the rest of the route needs.
  const breakStandingReads = () =>
    seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivated_at TO deactivated_at_unreadable");
  const restoreStandingReads = () =>
    seed.execute("ALTER TABLE user_profiles RENAME COLUMN deactivated_at_unreadable TO deactivated_at");

  const bookFounder = (leadId: string) =>
    patch(leadId, {
      action: "book_founder",
      requestId: randomUUID(),
      expectedStage: "qualified",
      founderUserId: CC,
      meetingAt: inTwoDays(),
      promisedDemo: "Homepage and quote-form walkthrough",
      note: "Owner wants more calls from the site.",
      confirmations: { contactConfirmed: true, clientAgreedToTime: true, handoffComplete: true },
      contact: { name: "Client Owner", email: "owner@client.test", phone: "+15145550100" },
      smsConsent: false,
    });
  const reschedule = (leadId: string) =>
    patch(leadId, {
      action: "deal_outcome",
      outcome: "reschedule",
      outcomeConfirmed: true,
      note: "Client asked to move to Thursday.",
      nextActionAt: inTwoDays(),
      requestId: randomUUID(),
      expectedStage: "founder_meeting_booked",
    });

  // ── book_founder ───────────────────────────────────────────────────────
  await check("book_founder: a deactivated opener is not invited or re-granted; attribution and booking stand", async () => {
    const booked = await bookFounder(BOOK_RETIRED);
    assert.equal(booked.status, 200, JSON.stringify(booked.body));
    const call = lastCall(BOOK_RETIRED);
    assert.equal(call?.kind, "create", "the verified booking never reached the calendar");
    assert.equal(call?.openerAttendee ?? null, null, "a deactivated opener was invited onto the client's event");
    const lead = await stored(BOOK_RETIRED);
    assert.equal(lead.stage, "founder_meeting_booked");
    assert.equal(lead.attributed_rep_user_id, RETIRED, "the opener's attribution (commission history) changed");
    assert.ok(
      !(lead.collaborators as string[]).includes(RETIRED),
      `a deactivated opener was re-granted the deal: ${JSON.stringify(lead.collaborators)}`,
    );
  });

  await check("book_founder: an active opener is still invited and seated", async () => {
    const booked = await bookFounder(BOOK_ACTIVE);
    assert.equal(booked.status, 200, JSON.stringify(booked.body));
    assert.deepEqual(lastCall(BOOK_ACTIVE)?.openerAttendee, {
      email: "opener@oasis.test",
      displayName: "Active Opener",
    });
    const lead = await stored(BOOK_ACTIVE);
    assert.equal(lead.attributed_rep_user_id, OPENER);
    assert.ok((lead.collaborators as string[]).includes(OPENER), JSON.stringify(lead.collaborators));
  });

  // ── deal_outcome = reschedule ──────────────────────────────────────────
  await check("reschedule: a deactivated opener is left off the moved event; the reschedule succeeds", async () => {
    const moved = await reschedule(RESCHED_RETIRED);
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const call = lastCall(RESCHED_RETIRED);
    assert.equal(call?.kind, "reschedule");
    assert.equal(call?.openerAttendee ?? null, null, "a deactivated opener was invited onto the moved event");
    const lead = await stored(RESCHED_RETIRED);
    assert.equal(lead.founder_meeting_status, "rescheduled");
    assert.equal(lead.attributed_rep_user_id, RETIRED, "the opener's attribution changed");
  });

  await check("reschedule: an active opener keeps their invite copy", async () => {
    const moved = await reschedule(RESCHED_ACTIVE);
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(lastCall(RESCHED_ACTIVE)?.openerAttendee, {
      email: "opener@oasis.test",
      displayName: "Active Opener",
    });
  });

  await check("reschedule: a standing read that fails skips the invite copy, never the reschedule", async () => {
    await breakStandingReads();
    try {
      const moved = await reschedule(RESCHED_READ_ERROR);
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      const call = lastCall(RESCHED_READ_ERROR);
      assert.equal(call?.kind, "reschedule");
      assert.equal(call?.openerAttendee ?? null, null, "an unverified opener was invited");
    } finally {
      await restoreStandingReads();
    }
  });

  // ── record_payment ─────────────────────────────────────────────────────
  const payLead = await stored(PAY_LEAD);
  const paymentBody = (builderUserId: string, requestId = randomUUID()) => ({
    action: "record_payment",
    requestId,
    expectedStage: "proposal_sent",
    paymentProvider: "manual",
    paymentReference: "WIRE-2026-0924-001",
    paymentAmount: 1500,
    paymentCurrency: "CAD",
    manualPaymentConfirmed: true,
    builderUserId,
  });
  const nothingWritten = async (label: string) => {
    assert.equal(
      await count("SELECT COUNT(*) AS n FROM website_sales_payment_receipts WHERE lead_id = ?", [PAY_LEAD]),
      0,
      `${label}: a payment receipt was written`,
    );
    assert.equal(
      await count("SELECT COUNT(*) AS n FROM website_deals WHERE lead_id = ?", [PAY_LEAD]),
      0,
      `${label}: a deal was closed`,
    );
    assert.equal(
      await count("SELECT COUNT(*) AS n FROM lead_interactions WHERE lead_id = ?", [PAY_LEAD]),
      0,
      `${label}: an interaction was logged`,
    );
    assert.deepEqual(await stored(PAY_LEAD), payLead, `${label}: the lead changed`);
  };

  await check("record_payment: a deactivated builder is refused (422 member_deactivated) before anything is written", async () => {
    for (const [label, builder] of [
      ["exact id", RETIRED_BUILDER],
      ["upper-cased id", RETIRED_BUILDER.toUpperCase()],
    ] as const) {
      const refused = await patch(PAY_LEAD, paymentBody(builder));
      assert.equal(refused.status, 422, `${label}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.error, "member_deactivated", label);
      assert.equal(refused.body.message, MEMBER_DEACTIVATED_MESSAGE, label);
      await nothingWritten(label);
    }
  });

  await check("record_payment: a builder whose standing cannot be read is refused (503) and nothing is written", async () => {
    await breakStandingReads();
    try {
      const refused = await patch(PAY_LEAD, paymentBody(BUILDER));
      assert.equal(refused.status, 503, JSON.stringify(refused.body));
      assert.equal(refused.body.error, "member_check_failed");
    } finally {
      await restoreStandingReads();
    }
    await nothingWritten("standing read failed");
  });

  const closeRequestId = randomUUID();
  await check("record_payment: an active builder closes the deal; a deactivated opener keeps credit but no seat", async () => {
    const closed = await patch(PAY_LEAD, paymentBody(BUILDER, closeRequestId));
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.stage, "won");
    const lead = await stored(PAY_LEAD);
    assert.equal(lead.stage, "won");
    assert.equal(lead.fulfillment_owner_id, BUILDER);
    assert.equal(lead.assigned_to, BUILDER, "the delivery cycle went to someone other than the builder");
    assert.equal(lead.attributed_rep_user_id, RETIRED, "the opener's attribution changed");
    const collaborators = lead.collaborators as string[];
    assert.ok(!collaborators.includes(RETIRED), `a deactivated opener was re-granted the deal: ${JSON.stringify(collaborators)}`);
    assert.ok(collaborators.includes(CC), JSON.stringify(collaborators));
    const deal = (await seed.execute({
      sql: "SELECT rep_user_id, builder_user_id FROM website_deals WHERE lead_id = ?",
      args: [PAY_LEAD],
    })).rows[0];
    assert.equal(deal?.rep_user_id, RETIRED, "the retired opener lost the sales credit they earned");
    assert.equal(deal?.builder_user_id, BUILDER);
  });

  await check("record_payment: replaying a recorded payment still succeeds after its builder is deactivated", async () => {
    await seed.execute({
      sql: "UPDATE user_profiles SET deactivated_at = ? WHERE auth_user_id = ?",
      args: [RETIRED_AT, BUILDER],
    });
    try {
      const replay = await patch(PAY_LEAD, paymentBody(BUILDER, closeRequestId));
      assert.equal(replay.status, 200, JSON.stringify(replay.body));
      assert.equal(replay.body.idempotent, true);
      assert.equal(
        await count("SELECT COUNT(*) AS n FROM website_deals WHERE lead_id = ?", [PAY_LEAD]),
        1,
        "the replay closed a second deal",
      );
    } finally {
      await seed.execute({ sql: "UPDATE user_profiles SET deactivated_at = NULL WHERE auth_user_id = ?", args: [BUILDER] });
    }
  });

  // ── SMS reply agent: client-driven reschedule ──────────────────────────
  const appointment = { tenant_id: TENANT, organizer_email_snapshot: "conaugh@oasisai.work" };
  await check("sms reschedule: no invite copy for a deactivated opener", async () => {
    assert.equal(await resolveSmsAgentOpenerAttendee(appointment, RETIRED), null);
  });

  await check("sms reschedule: an active opener keeps their invite copy; the host gets none", async () => {
    assert.deepEqual(await resolveSmsAgentOpenerAttendee(appointment, OPENER), {
      email: "opener@oasis.test",
      displayName: "Active Opener",
    });
    assert.equal(await resolveSmsAgentOpenerAttendee(appointment, CC), null, "the organizer was copied on their own event");
  });

  await check("sms reschedule: a failed or missing opener read never throws", async () => {
    assert.equal(
      await resolveSmsAgentOpenerAttendee(appointment, "3c3c3c3c-0000-4000-8000-0000000000ff"),
      null,
      "an opener with no profile in this workspace",
    );
    await breakStandingReads();
    try {
      assert.equal(await resolveSmsAgentOpenerAttendee(appointment, OPENER), null);
    } finally {
      await restoreStandingReads();
    }
  });

  if (failures > 0) {
    console.error(`website-sales-deactivated-live-parties: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("website-sales-deactivated-live-parties: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
