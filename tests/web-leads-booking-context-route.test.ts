/**
 * web-leads-booking-context-route.test.ts — GET /api/web-leads/[id]?view=booking,
 * what the call-screen "Book the Meet" panel reads before it renders.
 *
 * Proves the gate stack (401 / 403 another tenant / 404 out of scope), that
 * the prefill follows Pipeline's rules (the contact is the PERSON, the best
 * scraped email when none is stored), and that "may this rep book" agrees
 * with the booking route itself:
 *
 *   - a do-not-call lead the rep holds IS bookable, flagged doNotCall so the
 *     panel asks for the "owner asked for this meeting" confirmation the
 *     booking route requires (Adon, 2026-10-02: "allow");
 *   - a lapsed claim is not, do-not-call or not (claim_released);
 *   - booked, lost and non-cold-outbound leads are not booked from here;
 *   - a manager who is only a COLLABORATOR is refused, exactly as the
 *     booking PATCH refuses them (lead_not_assigned_to_agent), and the PATCH
 *     is called here to prove the two answers agree, not just asserted.
 *
 * The route runs for real against a local libSQL database; the only stand-in
 * is next/headers' cookie jar. Harness copied from tests/book-meet-route.test.ts.
 *
 * Run: node --conditions=react-server --import tsx tests/web-leads-booking-context-route.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "booking-context-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "booking-context-route-secret-that-is-long-enough-01";
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

const OWNER = "5e5e5e5e-0000-4000-8000-000000000001";
const OPENER = "5e5e5e5e-0000-4000-8000-000000000002";
const OTHER = "5e5e5e5e-0000-4000-8000-000000000003";
const SECOND_FOUNDER = "5e5e5e5e-0000-4000-8000-000000000004";
const MANAGER = "5e5e5e5e-0000-4000-8000-000000000005";
const FOREIGN = "5e5e5e5e-0000-4000-8000-000000000009";
const FOREIGN_TENANT = "9a9a9a9a-0000-4000-8000-000000000001";
const OWNER_EMAIL = "conaugh@oasisai.work";

const L_OK = "7a7a7a7a-0000-4000-8000-000000000001";
const L_DNC = "7a7a7a7a-0000-4000-8000-000000000002";
const L_LAPSED = "7a7a7a7a-0000-4000-8000-000000000003";
const L_BOOKED = "7a7a7a7a-0000-4000-8000-000000000004";
const L_LOST = "7a7a7a7a-0000-4000-8000-000000000005";
const L_INBOUND = "7a7a7a7a-0000-4000-8000-000000000006";
const L_OTHERS = "7a7a7a7a-0000-4000-8000-000000000007";
const L_DNC_LAPSED = "7a7a7a7a-0000-4000-8000-000000000008";
const L_COLLAB = "7a7a7a7a-0000-4000-8000-000000000009";

const recentIso = () => new Date(Date.now() - 60_000).toISOString();
const eightDaysAgo = () => new Date(Date.now() - 8 * 864e5).toISOString();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

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
  console.log("web-leads-booking-context-route:");
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
  `);

  const profile = (id: string, authId: string, email: string, role: string, tenant: string, owner = false) => ({
    sql: `INSERT INTO user_profiles
            (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, onboarding_completed_at,
             joined_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    args: [id, authId, email, tenant, role, owner ? 1 : 0, email],
  });
  const lead = (id: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, TENANT, JSON.stringify({
      business_name: "[TEST] Canary Plumbing",
      company: "[TEST] Canary Plumbing",
      owner_name: "Pat Owner",
      email: "",
      webdev_emails: [
        { email: "info@canary.test", confidence: 0.4 },
        { email: "pat@canary.test", confidence: 0.9 },
      ],
      phone: "604-555-0100",
      owner_phone: "604-555-0199",
      website: "canary.test",
      state: "BC",
      sales_program: OASIS_WEBSITE_SALES_PROGRAM,
      sales_motion: OASIS_COLD_OUTBOUND_MOTION,
      stage: "connected",
      assigned_to: OPENER,
      claimed_at: recentIso(),
      last_call_at: recentIso(),
      collaborators: [],
      ...data,
    })],
  });

  await seed.batch(
    [
      ...[
        [OWNER, OWNER_EMAIL],
        [SECOND_FOUNDER, "adon@oasisai.work"],
        [OPENER, "opener@oasis.test"],
        [OTHER, "other@oasis.test"],
        [MANAGER, "manager@oasis.test"],
        [FOREIGN, "foreign@sunbiz.test"],
      ].map(([id, email]) => ({
        sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`,
        args: [id, email],
      })),
      profile("p-owner", OWNER, OWNER_EMAIL, "owner", TENANT, true),
      profile("p-second", SECOND_FOUNDER, "adon@oasisai.work", "admin", TENANT),
      profile("p-opener", OPENER, "opener@oasis.test", "opener", TENANT),
      profile("p-other", OTHER, "other@oasis.test", "opener", TENANT),
      profile("p-manager", MANAGER, "manager@oasis.test", "manager", TENANT),
      profile("p-foreign", FOREIGN, "foreign@sunbiz.test", "owner", FOREIGN_TENANT, true),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-webdev', 'OASIS AI')", args: [TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'sunbiz', 'SunBiz')", args: [FOREIGN_TENANT] },
      lead(L_OK, {}),
      lead(L_DNC, { dnc: true }),
      lead(L_LAPSED, { stage: "assigned", claimed_at: eightDaysAgo(), last_call_at: null }),
      lead(L_BOOKED, {
        stage: "founder_meeting_booked",
        founder_meeting_at: new Date(Date.now() + 2 * 864e5).toISOString(),
        google_meet_link: "https://meet.google.com/abc-defg-hij",
      }),
      lead(L_LOST, { stage: "lost", lost_at: recentIso() }),
      lead(L_INBOUND, { sales_motion: "inbound" }),
      lead(L_OTHERS, { assigned_to: OTHER }),
      lead(L_DNC_LAPSED, { dnc: true, stage: "assigned", claimed_at: eightDaysAgo(), last_call_at: null }),
      lead(L_COLLAB, { collaborators: [MANAGER] }),
    ],
    "write",
  );

  const { signSession, SESSION_COOKIE } = await import("../lib/turso-auth");
  assert.equal(SESSION_COOKIE, SESSION_COOKIE_NAME, "the cookie-jar stand-in reads the wrong cookie name");
  const { NextRequest } = await import("next/server");
  const route = await import("../app/api/web-leads/[id]/route");
  const bookingRoute = await import("../app/api/website-sales/[leadId]/route");

  const signIn = (sub: string, email: string) => {
    sessionCookie = signSession({ sub, email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  };
  const get = async (id: string) => {
    const res = await route.GET(new NextRequest(`http://localhost/api/web-leads/${id}?view=booking`), {
      params: Promise.resolve({ id }),
    });
    return { status: res.status, body: (await res.json()) as Body };
  };

  await check("unauthenticated: 401", async () => {
    sessionCookie = undefined;
    assert.equal((await get(L_OK)).status, 401);
  });

  await check("another tenant: 403", async () => {
    signIn(FOREIGN, "foreign@sunbiz.test");
    assert.equal((await get(L_OK)).status, 403);
  });

  await check("the holder may book; prefill matches Pipeline's rules", async () => {
    signIn(OPENER, "opener@oasis.test");
    const { status, body } = await get(L_OK);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.canBook, true);
    assert.equal(body.blocked, null);
    assert.equal(body.doNotCall, false);
    assert.equal(body.stage, "connected");
    assert.equal(body.viewerUserId, OPENER);
    assert.equal(body.prefill.name, "Pat Owner", "contact name is the PERSON (contactNameFor), never the business");
    assert.equal(body.prefill.company, "[TEST] Canary Plumbing");
    assert.equal(body.prefill.email, "pat@canary.test", "no data.email: highest-confidence scraped address");
    assert.deepEqual(body.prefill.altEmails, ["info@canary.test"]);
    assert.equal(body.prefill.phone, "604-555-0100");
    assert.equal(body.prefill.altPhone, "604-555-0199");
    assert.equal(body.prospectZone.timeZone, "America/Vancouver");
    assert.equal(body.meeting, null);
  });

  await check("do-not-call the rep holds: bookable, flagged so the panel asks for the owner-asked confirmation", async () => {
    signIn(OPENER, "opener@oasis.test");
    const { status, body } = await get(L_DNC);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.canBook, true);
    assert.equal(body.blocked, null);
    assert.equal(body.doNotCall, true);
  });

  await check("do-not-call for an owner: bookable, still flagged", async () => {
    signIn(OWNER, OWNER_EMAIL);
    const { body } = await get(L_DNC);
    assert.equal(body.canBook, true);
    assert.equal(body.doNotCall, true);
  });

  await check("lapsed claim: cannot book", async () => {
    signIn(OPENER, "opener@oasis.test");
    const { body } = await get(L_LAPSED);
    assert.equal(body.canBook, false);
    assert.equal(body.blocked, "claim_released");
  });

  await check("lapsed do-not-call claim: claim_released, same answer as the booking route", async () => {
    signIn(OPENER, "opener@oasis.test");
    const { body } = await get(L_DNC_LAPSED);
    assert.equal(body.canBook, false);
    assert.equal(body.blocked, "claim_released");
  });

  await check("already booked: cannot book, meeting returned", async () => {
    signIn(OPENER, "opener@oasis.test");
    const { body } = await get(L_BOOKED);
    assert.equal(body.canBook, false);
    assert.equal(body.blocked, "already_booked");
    assert.equal(body.meeting.meetLink, "https://meet.google.com/abc-defg-hij");
  });

  await check("lost: cannot book", async () => {
    signIn(OPENER, "opener@oasis.test");
    assert.equal((await get(L_LOST)).body.blocked, "lost");
  });

  await check("not cold outbound: cannot book here", async () => {
    signIn(OPENER, "opener@oasis.test");
    assert.equal((await get(L_INBOUND)).body.blocked, "not_cold_outbound");
  });

  await check("another rep's lead: not bookable, or not visible at all", async () => {
    signIn(OPENER, "opener@oasis.test");
    const { status, body } = await get(L_OTHERS);
    assert.ok(
      status === 404 || (status === 200 && body.canBook === false && body.blocked === "not_yours"),
      JSON.stringify({ status, body }),
    );
  });

  await check("without ?view=booking the route still returns the whole lead, not the booking view", async () => {
    signIn(OPENER, "opener@oasis.test");
    const res = await route.GET(new NextRequest(`http://localhost/api/web-leads/${L_OK}`), {
      params: Promise.resolve({ id: L_OK }),
    });
    const body = (await res.json()) as Body;
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.canBook, undefined, "the plain read must not carry the booking view");
    assert.equal(body.id, L_OK);
  });

  await check("manager who is only a collaborator: not bookable, and the booking PATCH agrees (403)", async () => {
    signIn(MANAGER, "manager@oasis.test");
    const { status, body } = await get(L_COLLAB);
    // A collaborator manager CAN see the lead (coaching view), so this is a
    // 200 with a refusal, never a 404 that would pass for the wrong reason.
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.canBook, false, JSON.stringify(body));
    assert.equal(body.blocked, "not_yours");
    const patch = await bookingRoute.PATCH(
      new NextRequest(`http://localhost/api/website-sales/${L_COLLAB}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "book_founder", expectedStage: "connected" }),
      }),
      { params: Promise.resolve({ leadId: L_COLLAB }) },
    );
    const patchBody = (await patch.json()) as Body;
    assert.equal(patch.status, 403, JSON.stringify(patchBody));
    assert.equal(patchBody.error, "lead_not_assigned_to_agent");
  });

  await check("the same lead's assigned rep may book it (the collaborator refusal is about the seat, not the lead)", async () => {
    signIn(OPENER, "opener@oasis.test");
    const { status, body } = await get(L_COLLAB);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.canBook, true);
  });

  if (failures > 0) {
    console.error(`web-leads-booking-context-route: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("web-leads-booking-context-route: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
