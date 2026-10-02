/**
 * book-meet-route.test.ts — booking a founder meeting straight from a call.
 *
 * Proves the call screen can qualify and book in ONE request, and that the
 * booking route applies the same claim rules logging a call already has:
 *
 *   - a lead whose claim lapsed back into the pool cannot be booked by the
 *     rep who used to hold it (claim_released);
 *   - a do-not-call lead CAN be booked, but only when the rep confirms the
 *     owner asked for the meeting on this call (Adon, 2026-10-02: "allow").
 *     Without that confirmation it is refused (do_not_call) and Google is
 *     never called; with it, who confirmed and when is stored on the lead.
 *
 * PATCH /api/website-sales/[leadId] runs for real against a local libSQL
 * database. The stand-ins are next/headers' cookie jar, the Google Calendar
 * service boundary (lib/website-sales-founder-meeting) and the stage hooks.
 * Harness copied from tests/website-sales-deactivated-live-parties.test.ts.
 *
 * Run: node --conditions=react-server --import tsx tests/book-meet-route.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "book-meet-route-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "book-meet-route-secret-that-is-long-enough-000001";
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

type CalendarCall = { kind: "create" | "reschedule"; leadId: string };
const calendarCalls: CalendarCall[] = [];
function verifiedMeeting(input: { requestId: string; meetingAt: string }) {
  return {
    appointmentId: randomUUID(),
    requestId: input.requestId,
    meetingAt: new Date(input.meetingAt).toISOString(),
    timezone: "America/Toronto",
    contact: {
      name: "Test Owner",
      company: "[TEST] Canary Plumbing",
      email: "owner@client.test",
      phone: "+15145550100",
      website: "",
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
  createVerifiedFounderMeeting: async (input: { leadId: string; requestId: string; meetingAt: string }) => {
    calendarCalls.push({ kind: "create", leadId: input.leadId });
    return verifiedMeeting(input);
  },
  rescheduleVerifiedFounderMeeting: async (input: { leadId: string; requestId: string; meetingAt: string }) => {
    calendarCalls.push({ kind: "reschedule", leadId: input.leadId });
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

const OWNER = "5e5e5e5e-0000-4000-8000-000000000001"; // founder host (is_owner)
const OPENER = "5e5e5e5e-0000-4000-8000-000000000002"; // the rep on the phone
const OTHER = "5e5e5e5e-0000-4000-8000-000000000003"; // another rep
// The assignment roster refuses to load without BOTH founder accounts.
const SECOND_FOUNDER = "5e5e5e5e-0000-4000-8000-000000000004";
const OWNER_EMAIL = "conaugh@oasisai.work";

const L_CONNECTED = "6f6f6f6f-0000-4000-8000-000000000001";
const L_ASSIGNED = "6f6f6f6f-0000-4000-8000-000000000002";
const L_DNC = "6f6f6f6f-0000-4000-8000-000000000003";
const L_LAPSED = "6f6f6f6f-0000-4000-8000-000000000004";
const L_LEGACY_QUALIFIED = "6f6f6f6f-0000-4000-8000-000000000005";
const L_REPLAY = "6f6f6f6f-0000-4000-8000-000000000006";
const L_DNC_ADMIN = "6f6f6f6f-0000-4000-8000-000000000007";
const L_IDEMPOTENT = "6f6f6f6f-0000-4000-8000-000000000008";
const L_DNC_LAPSED = "6f6f6f6f-0000-4000-8000-000000000009";

const GATES = {
  authorityConfirmed: true,
  websiteProblemConfirmed: true,
  timingConfirmed: true,
  minimumInvestmentConfirmed: true,
};
const CONFIRMED = { contactConfirmed: true, clientAgreedToTime: true, handoffComplete: true };
const recentIso = () => new Date(Date.now() - 60_000).toISOString();
const eightDaysAgo = () => new Date(Date.now() - 8 * 864e5).toISOString();

type ApiBody = { ok?: boolean; error?: string; idempotent?: boolean; stage?: string };

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
  console.log("book-meet-route:");
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

  const profile = (id: string, authId: string, email: string, role: string, fullName: string, owner = false) => ({
    sql: `INSERT INTO user_profiles
            (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at,
             joined_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    args: [id, authId, email, TENANT, role, owner ? 1 : 0, fullName],
  });
  const salesLead = (id: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, TENANT, JSON.stringify({
      name: "Test Owner",
      company: "[TEST] Canary Plumbing",
      email: "owner@client.test",
      phone: "+15145550100",
      sales_program: OASIS_WEBSITE_SALES_PROGRAM,
      sales_motion: OASIS_COLD_OUTBOUND_MOTION,
      collaborators: [],
      ...data,
    })],
  });
  const held = (assignedTo: string, stage: string, extra: Record<string, unknown> = {}) => ({
    stage,
    assigned_to: assignedTo,
    claimed_at: recentIso(),
    last_call_at: recentIso(),
    ...extra,
  });

  await seed.batch(
    [
      ...[
        [OWNER, OWNER_EMAIL],
        [SECOND_FOUNDER, "adon@oasisai.work"],
        [OPENER, "opener@oasis.test"],
        [OTHER, "other@oasis.test"],
      ].map(([id, email]) => ({
        sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`,
        args: [id, email],
      })),
      profile("p-owner", OWNER, OWNER_EMAIL, "owner", "Founder", true),
      profile("p-second", SECOND_FOUNDER, "adon@oasisai.work", "admin", "Second Founder"),
      profile("p-opener", OPENER, "opener@oasis.test", "opener", "Opener"),
      profile("p-other", OTHER, "other@oasis.test", "opener", "Other Rep"),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-webdev', 'OASIS AI')", args: [TENANT] },
      salesLead(L_CONNECTED, held(OPENER, "connected")),
      salesLead(L_ASSIGNED, held(OPENER, "assigned", { last_call_at: null })),
      salesLead(L_DNC, held(OPENER, "connected", { dnc: true })),
      salesLead(L_LAPSED, held(OPENER, "assigned", { claimed_at: eightDaysAgo(), last_call_at: null })),
      salesLead(L_LEGACY_QUALIFIED, held(OPENER, "qualified", { qualification: { ...GATES, notes: "" } })),
      salesLead(L_REPLAY, held(OPENER, "connected")),
      salesLead(L_DNC_ADMIN, held(OWNER, "connected", { dnc: true })),
      salesLead(L_IDEMPOTENT, held(OWNER, "connected")),
      salesLead(L_DNC_LAPSED, held(OPENER, "assigned", { dnc: true, claimed_at: eightDaysAgo(), last_call_at: null })),
    ],
    "write",
  );

  const { signSession, SESSION_COOKIE } = await import("../lib/turso-auth");
  assert.equal(SESSION_COOKIE, SESSION_COOKIE_NAME, "the cookie-jar stand-in reads the wrong cookie name");
  const { NextRequest } = await import("next/server");
  const route = await import("../app/api/website-sales/[leadId]/route");

  const signIn = (sub: string, email: string) => {
    sessionCookie = signSession({ sub, email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  };
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
  const creates = (leadId: string) => calendarCalls.filter((c) => c.kind === "create" && c.leadId === leadId).length;
  const book = (leadId: string, expectedStage: string, extra: Record<string, unknown> = {}) =>
    patch(leadId, {
      action: "book_founder",
      requestId: randomUUID(),
      expectedStage,
      founderUserId: OWNER,
      meetingAt: new Date(Date.now() + 2 * 864e5).toISOString(),
      timezone: "America/Toronto",
      promisedDemo: "A 15-minute look at how calls, quotes, jobs and follow-ups run today.",
      note: 'In their words: "quotes go out a week late"\n\nOwner runs 3 crews.',
      contact: {
        name: "Test Owner",
        company: "[TEST] Canary Plumbing",
        email: "owner@client.test",
        phone: "+15145550100",
        website: "",
      },
      qualification: { ...GATES, operationsPainInTheirWords: "quotes go out a week late" },
      confirmations: CONFIRMED,
      smsConsent: false,
      ...extra,
    });

  await check("qualify-and-book in one request from connected: booked, gates stored normalized with the legacy key", async () => {
    signIn(OPENER, "opener@oasis.test");
    const res = await book(L_CONNECTED, "connected");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const lead = await stored(L_CONNECTED);
    assert.equal(lead.stage, "founder_meeting_booked");
    assert.equal(lead.qualification_source, "confirmed_calendar_handoff");
    assert.deepEqual(lead.qualification, { ...GATES, operationsPainInTheirWords: "quotes go out a week late" });
    assert.equal(lead.dnc_meeting_override, undefined, "an ordinary lead carries no do-not-call override");
  });

  await check("qualify-and-book from assigned also works (the server allows it; the call screen relies on it)", async () => {
    signIn(OPENER, "opener@oasis.test");
    const res = await book(L_ASSIGNED, "assigned");
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  await check("a renamed gate key is refused, proving the wire key did not change", async () => {
    signIn(OPENER, "opener@oasis.test");
    const { websiteProblemConfirmed: _drop, ...rest } = GATES;
    void _drop;
    const res = await book(L_REPLAY, "connected", { qualification: { ...rest, operationsPainConfirmed: true } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "qualify_before_booking");
  });

  await check("extra keys sent by a client are not stored", async () => {
    signIn(OPENER, "opener@oasis.test");
    const res = await book(L_REPLAY, "connected", { qualification: { ...GATES, injected: "<script>" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(
      Object.keys((await stored(L_REPLAY)).qualification as object).sort(),
      Object.keys(GATES).sort(),
    );
  });

  await check("a rep who does not hold the lead cannot book it", async () => {
    signIn(OTHER, "other@oasis.test");
    const res = await book(L_CONNECTED, "founder_meeting_booked");
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "lead_not_assigned_to_agent");
  });

  await check("a do-not-call lead is refused WITHOUT the owner-asked confirmation, and Google is never called", async () => {
    signIn(OPENER, "opener@oasis.test");
    const res = await book(L_DNC, "connected");
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "do_not_call");
    assert.equal(creates(L_DNC), 0, "a calendar invite was attempted for a do-not-call lead");
    assert.equal((await stored(L_DNC)).stage, "connected");
  });

  await check("a non-boolean confirmation is not consent", async () => {
    signIn(OPENER, "opener@oasis.test");
    const res = await book(L_DNC, "connected", { confirmations: { ...CONFIRMED, ownerRequestedMeeting: "true" } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "do_not_call");
    assert.equal(creates(L_DNC), 0);
  });

  await check("a do-not-call lead IS booked when the rep confirms the owner asked; who and when are stored", async () => {
    signIn(OPENER, "opener@oasis.test");
    const res = await book(L_DNC, "connected", { confirmations: { ...CONFIRMED, ownerRequestedMeeting: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(creates(L_DNC), 1);
    const lead = await stored(L_DNC);
    assert.equal(lead.stage, "founder_meeting_booked");
    assert.equal(lead.dnc, true, "booking must not clear the do-not-call flag");
    const override = lead.dnc_meeting_override as Record<string, unknown>;
    assert.equal(override?.confirmed_by, OPENER);
    assert.ok(Number.isFinite(Date.parse(String(override?.confirmed_at))), "override carries a timestamp");
  });

  await check("the same rule binds the owner: refused without the confirmation, booked with it", async () => {
    signIn(OWNER, OWNER_EMAIL);
    const refused = await book(L_DNC_ADMIN, "connected");
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "do_not_call");
    const booked = await book(L_DNC_ADMIN, "connected", { confirmations: { ...CONFIRMED, ownerRequestedMeeting: true } });
    assert.equal(booked.status, 200, JSON.stringify(booked.body));
    assert.equal((await stored(L_DNC_ADMIN)).dnc_meeting_override !== undefined, true);
  });

  await check("a lapsed claim (8 days, never dialled) cannot be booked by the rep", async () => {
    signIn(OPENER, "opener@oasis.test");
    const res = await book(L_LAPSED, "assigned");
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "claim_released");
    assert.equal(creates(L_LAPSED), 0);
  });

  await check("a lapsed do-not-call claim reports claim_released even with the confirmation", async () => {
    signIn(OPENER, "opener@oasis.test");
    const res = await book(L_DNC_LAPSED, "assigned", { confirmations: { ...CONFIRMED, ownerRequestedMeeting: true } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "claim_released");
    assert.equal(creates(L_DNC_LAPSED), 0);
  });

  await check("Pipeline-shaped booking of a legacy qualified record still succeeds", async () => {
    signIn(OPENER, "opener@oasis.test");
    const res = await book(L_LEGACY_QUALIFIED, "qualified", { qualification: { ...GATES } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  await check("the same request id twice moves the lead once", async () => {
    signIn(OWNER, OWNER_EMAIL);
    const id = randomUUID();
    const first = await book(L_IDEMPOTENT, "connected", { requestId: id });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const again = await book(L_IDEMPOTENT, "connected", { requestId: id });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.idempotent, true);
    assert.equal((await stored(L_IDEMPOTENT)).stage, "founder_meeting_booked");
  });

  if (failures > 0) {
    console.error(`book-meet-route: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("book-meet-route: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
