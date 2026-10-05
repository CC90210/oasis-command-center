/**
 * web-leads-claim-active-roster.test.ts -- who may RECEIVE a pool lead, driven
 * through the real POST /api/web-leads/claim handler.
 *
 * THE CHANGE (2026-09-24). The OASIS sales team was retired. CC kept Schneur
 * (builder) and David (opener) as working reps and asked that the Leads page
 * assign to them as well as to the founders, so getOasisPipelineAssignmentRoster
 * widened from "CC + Adon" to "CC + Adon + ACTIVE reps". The claim route
 * validates every claim -- a self-claim included -- against that roster, so the
 * widening is an authorization change on this route, not only a menu change:
 *
 *   an active rep       may self-claim from the pool       (was refused)
 *   a founder           may assign a pool lead to them     (was refused)
 *   a deactivated rep   may do neither, and nothing is written
 *   a rep               still may not push work onto a colleague, and may not
 *                       send assignTo at all -- not even naming themselves
 *
 * Which gate refuses a deactivated rep depends on how far deactivation got.
 * The normal path (deactivateMember) bans the login and bumps session_version,
 * so the session check answers 401 before the roster is read; that is pinned
 * here too. The roster refusal is for a session that still resolves, which is
 * how the deactivated rep is seeded below.
 *
 * tests/web-leads-assign-to-rep.test.ts pins the route's SHAPE from its source
 * text. It cannot see membership, which is decided at runtime by who is in
 * user_profiles and whether deactivated_at is set -- so this drives the handler
 * against a local libSQL file, through the real session check, profile
 * resolution, roster read and claimLeads write. The only stand-in is the
 * request cookie jar (next/headers), the same one
 * tests/oasis-create-stage-contract.test.ts uses.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

// Env before any module under test is imported: lib/turso.ts and
// lib/supabase-server.ts memoise their clients on first use.
const dbFile = join(mkdtempSync(join(tmpdir(), "claim-roster-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "web-leads-claim-active-roster-secret-that-is-long-enough-01";

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

const CC = "1a1a1a1a-0000-4000-8000-000000000001";
const ADON = "1a1a1a1a-0000-4000-8000-000000000002";
const DAVID = "1a1a1a1a-0000-4000-8000-000000000003"; // active opener
const SCHNEUR = "1a1a1a1a-0000-4000-8000-000000000004"; // active builder
const RETIRED = "1a1a1a1a-0000-4000-8000-000000000005"; // deactivated opener
const POOL_A = "1b1b1b1b-0000-4000-8000-000000000001";
const POOL_B = "1b1b1b1b-0000-4000-8000-000000000002";
const POOL_C = "1b1b1b1b-0000-4000-8000-000000000003";

type ClaimBody = {
  ok?: boolean;
  error?: string;
  message?: string;
  assignedTo?: string;
  claimed?: string[];
  refused?: { id: string; reason: string }[];
  lostRace?: string[];
};

function run(name: string) {
  console.log(`  ok  ${name}`);
}

async function main() {
  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
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
  `);
  const people: [string, string, string, number][] = [
    [CC, "conaugh@oasisai.work", "owner", 1],
    [ADON, "adon@oasisai.work", "closer", 0],
    [DAVID, "david@oasis.test", "opener", 0],
    [SCHNEUR, "schneur@oasis.test", "builder", 0],
    [RETIRED, "retired@oasis.test", "opener", 0],
  ];
  // A pool lead: unowned, in the prospect stage, no call on it.
  const poolLead = (id: string, name: string) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, WEBDEV_TENANT_ID, JSON.stringify({ business_name: name, state: "ON", stage: "researched" })],
  });
  await seed.batch(
    [
      ...people.map(([id, email]) => ({
        sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`,
        args: [id, email],
      })),
      ...people.map(([id, email, role, owner]) => ({
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, joined_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
        args: [`p-${email}`, id, email, WEBDEV_TENANT_ID, role, owner],
      })),
      // Retired the way migration 179 records it, with no ban on the auth row --
      // the "session still resolves" case the route header lists. Every refusal
      // below is the roster's, not sign-in's, until the ban step bans it.
      {
        sql: `UPDATE user_profiles SET deactivated_at = '2026-09-24T00:00:00Z', deactivated_by = ?,
              deactivation_reason = 'sales team retired' WHERE auth_user_id = ?`,
        args: [CC, RETIRED],
      },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [WEBDEV_TENANT_ID] },
      poolLead(POOL_A, "Pool A Bakery"),
      poolLead(POOL_B, "Pool B Salon"),
      poolLead(POOL_C, "Pool C Garage"),
    ],
    "write",
  );

  const { signSession, SESSION_COOKIE } = await import("../lib/turso-auth");
  assert.equal(SESSION_COOKIE, SESSION_COOKIE_NAME, "the cookie-jar stand-in reads the wrong cookie name");
  const { NextRequest } = await import("next/server");
  const claimRoute = await import("../app/api/web-leads/claim/route");
  const { getOasisPipelineAssignmentRoster } = await import("../lib/team");
  const { resolveAssignableTarget } = await import("../lib/web-leads/assign-target");
  const { DEACTIVATION_BAN_UNTIL } = await import("../lib/team-activation-rules");

  // A fresh sign-in: the cookie carries the account's CURRENT session_version,
  // as lib/turso-auth.ts verifyPassword mints it.
  const login = async (userId: string) => {
    const email = people.find(([id]) => id === userId)![1];
    const r = await seed.execute({ sql: `SELECT session_version FROM "_supabase_auth_users" WHERE id = ?`, args: [userId] });
    const ver = Number(r.rows[0].session_version);
    sessionCookie = signSession({ sub: userId, email, exp: Math.floor(Date.now() / 1000) + 3600, ver });
  };
  const postClaim = async (body: Record<string, unknown>) => {
    const req = new NextRequest("http://localhost/api/web-leads/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await claimRoute.POST(req);
    return { status: res.status, body: (await res.json()) as ClaimBody };
  };
  // The whole stored row, so "nothing is written" covers the JSON blob AND the
  // row version the claim's compare-and-swap pins.
  const stored = async (id: string) => {
    const r = await seed.execute({ sql: "SELECT data, updated_at FROM tenant_records WHERE id = ?", args: [id] });
    assert.equal(r.rows.length, 1, `lead ${id} is not in the database`);
    return {
      data: JSON.parse(String(r.rows[0].data)) as Record<string, unknown>,
      updatedAt: String(r.rows[0].updated_at),
    };
  };
  const interactionCount = async () =>
    Number((await seed.execute("SELECT count(*) AS n FROM lead_interactions")).rows[0].n);
  const assertRosterRefusal = (res: { status: number; body: ClaimBody }, label: string) => {
    assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "target_not_on_sales_roster", label);
    assert.equal(res.body.ok, false, label);
    // The copy states the current rule, as a sentence, and not the retired one.
    assert.match(res.body.message ?? "", /CC, Adon or an active sales rep/, `${label}: refusal copy`);
    assert.match(res.body.message ?? "", /deactivated/i, `${label}: refusal copy`);
    assert.doesNotMatch(res.body.message ?? "", /only to CC or Adon/, `${label}: pre-2026-09-24 copy`);
  };

  console.log("web-leads-claim-active-roster:");

  // ── the roster the route composes ────────────────────────────────────────
  // Read the way the route reads it: founders first, then active reps; the
  // deactivated opener is absent, and resolveAssignableTarget agrees.
  const roster = await getOasisPipelineAssignmentRoster(WEBDEV_TENANT_ID);
  const rosterIds = roster.map((m) => m.auth_user_id);
  assert.deepEqual(rosterIds.slice(0, 2), [CC, ADON], "the founders lead the roster");
  assert.deepEqual([...rosterIds.slice(2)].sort(), [DAVID, SCHNEUR].sort(), "the active reps follow them");
  assert.equal(rosterIds.includes(RETIRED), false, "a deactivated rep is on the assignment roster");
  assert.equal(resolveAssignableTarget(roster, RETIRED), null);
  assert.equal(resolveAssignableTarget(roster, ` ${DAVID.toUpperCase()} `), DAVID);
  run("the assignment roster is CC, Adon and the active reps -- never the deactivated one");

  // ── an ACTIVE rep self-claims from the pool ──────────────────────────────
  await login(DAVID);
  const selfClaim = await postClaim({ leadIds: [POOL_A] });
  assert.equal(selfClaim.status, 200, JSON.stringify(selfClaim.body));
  assert.equal(selfClaim.body.ok, true);
  assert.equal(selfClaim.body.assignedTo, DAVID);
  assert.deepEqual(selfClaim.body.claimed, [POOL_A]);
  const claimedA = await stored(POOL_A);
  assert.equal(claimedA.data.assigned_to, DAVID, "the active rep's claim did not land on the row");
  assert.equal(claimedA.data.stage, "assigned");
  assert.equal(typeof claimedA.data.claimed_at, "string");
  run("an active opener self-claims a pool lead");

  // ── a DEACTIVATED rep is refused, and nothing is written ─────────────────
  await login(RETIRED);
  const beforeB = await stored(POOL_B);
  const touchesBefore = await interactionCount();
  const retiredSelf = await postClaim({ leadIds: [POOL_B] });
  assertRosterRefusal(retiredSelf, "deactivated self-claim");
  assert.deepEqual(await stored(POOL_B), beforeB, "a refused self-claim changed the lead");
  assert.equal(await interactionCount(), touchesBefore, "a refused self-claim wrote a touch");
  run("a deactivated opener is refused with target_not_on_sales_roster and nothing is written");

  // ── a rep still may not push work onto a colleague ───────────────────────
  // Reps are on the roster now, so the manager gate is the only thing between
  // one rep and another's book. It must answer first.
  await login(DAVID);
  const repPush = await postClaim({ leadIds: [POOL_B], assignTo: SCHNEUR });
  assert.equal(repPush.status, 403, JSON.stringify(repPush.body));
  assert.equal(repPush.body.error, "assign_requires_manager");
  assert.deepEqual(await stored(POOL_B), beforeB, "a refused rep-to-rep assignment changed the lead");
  run("an active rep naming another active rep is still refused as not a manager");

  // ── ...and assignTo is manager-only even when it names the caller ─────────
  // The gate reads "was assignTo sent", not "does it name someone else". A rep
  // self-claims by leaving it out; sending their own id is refused the same way.
  const repNamesSelf = await postClaim({ leadIds: [POOL_B], assignTo: DAVID });
  assert.equal(repNamesSelf.status, 403, JSON.stringify(repNamesSelf.body));
  assert.equal(repNamesSelf.body.error, "assign_requires_manager");
  assert.deepEqual(await stored(POOL_B), beforeB, "a rep's assignTo-self changed the lead");
  run("a rep who sends assignTo with their own id is refused as not a manager");

  // ── a founder assigns a pool lead to an ACTIVE rep ───────────────────────
  await login(CC);
  // Padded and upper-cased: the route must store the roster's id, not the
  // request's spelling of it.
  const toActive = await postClaim({ leadIds: [POOL_B], assignTo: ` ${SCHNEUR.toUpperCase()} ` });
  assert.equal(toActive.status, 200, JSON.stringify(toActive.body));
  assert.equal(toActive.body.assignedTo, SCHNEUR);
  assert.deepEqual(toActive.body.claimed, [POOL_B]);
  assert.equal((await stored(POOL_B)).data.assigned_to, SCHNEUR, "the founder's assignment did not land");
  run("a founder assigns a pool lead to an active rep");

  // ── ...but not to a DEACTIVATED one ──────────────────────────────────────
  const beforeC = await stored(POOL_C);
  const touchesBeforeC = await interactionCount();
  const toRetired = await postClaim({ leadIds: [POOL_C], assignTo: RETIRED });
  assertRosterRefusal(toRetired, "founder assigning to a deactivated rep");
  assert.deepEqual(await stored(POOL_C), beforeC, "a refused assignment changed the lead");
  assert.equal(await interactionCount(), touchesBeforeC, "a refused assignment wrote a touch");
  run("a founder cannot assign a pool lead to a deactivated rep; nothing is written");

  // ── the NORMAL deactivation path ends the session first ──────────────────
  // deactivateMember step 2, verbatim: ban the login and bump session_version.
  // The rep's open cookie then fails the session check -- 401, before the
  // roster is read -- so the roster refusal above is defense in depth, not the
  // only thing standing between a deactivated rep and the pool.
  await login(RETIRED);
  await seed.execute({
    sql: `UPDATE "_supabase_auth_users" SET banned_until = ?, session_version = session_version + 1 WHERE id = ?`,
    args: [DEACTIVATION_BAN_UNTIL, RETIRED],
  });
  const banned = await postClaim({ leadIds: [POOL_C] });
  assert.equal(banned.status, 401, JSON.stringify(banned.body));
  assert.equal(banned.body.error, "no_session");
  assert.deepEqual(await stored(POOL_C), beforeC, "a banned session changed the lead");
  assert.equal(await interactionCount(), touchesBeforeC, "a banned session wrote a touch");
  run("a normally-deactivated rep (login banned, session bumped) is refused at the session check, 401");

  // ── control: deactivated_at is the ONLY thing that refused them ──────────
  // Reactivated the way reactivateMember does it (clear the profile flag, lift
  // only the deactivation ban) and signed in afresh. Same profile, same lead:
  // the answer must flip, or the refusals above were about something else.
  await seed.batch(
    [
      {
        sql: "UPDATE user_profiles SET deactivated_at = NULL, deactivated_by = NULL, deactivation_reason = NULL WHERE auth_user_id = ?",
        args: [RETIRED],
      },
      {
        sql: `UPDATE "_supabase_auth_users" SET banned_until = NULL WHERE id = ? AND banned_until = ?`,
        args: [RETIRED, DEACTIVATION_BAN_UNTIL],
      },
    ],
    "write",
  );
  await login(RETIRED);
  const reactivated = await postClaim({ leadIds: [POOL_C] });
  assert.equal(reactivated.status, 200, JSON.stringify(reactivated.body));
  assert.equal((await stored(POOL_C)).data.assigned_to, RETIRED);
  run("control: the same rep, reactivated, self-claims the same lead");

  seed.close();
  console.log("web-leads-claim-active-roster: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
