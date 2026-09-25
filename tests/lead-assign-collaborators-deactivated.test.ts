/**
 * lead-assign-collaborators-deactivated.test.ts — a deactivated teammate is not
 * a live target for the lead drawer's two write routes, whatever the client sends.
 *
 * The drawer stopped offering deactivated people as owner or collaborator
 * (tests/lead-member-controls-inactive.test.ts), but a stale tab or a crafted
 * request can still post their id. The server must refuse it:
 *
 *   POST /api/leads/[id]/assign         (every tenant; SunBiz checks membership,
 *                                        OASIS the active assignment roster)
 *   POST /api/leads/[id]/collaborators  (add refused; an existing deactivated
 *                                        collaborator stays listed and can go,
 *                                        and re-adding them is a no-op success)
 *
 * History must survive: a deactivated rep keeps assigned_to on the deals they
 * already hold, so re-saving that SAME owner still works, and null still
 * unassigns.
 *
 * Both handlers run for real — session check, profile resolution, tenant slug,
 * data layer and the patch_tenant_record_data shim — against a local libSQL
 * database. The only stand-in is next/headers' cookie jar (same pattern as
 * tests/oasis-create-stage-contract.test.ts).
 *
 * Run: node --conditions=react-server --import tsx tests/lead-assign-collaborators-deactivated.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "lead-assign-deactivated-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "lead-assign-deactivated-secret-that-is-long-enough-0001";

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

// SunBiz (a non-OASIS tenant: the membership path).
const SUN_TENANT = "5a5a5a5a-0000-4000-8000-00000000005a";
const SUN_ADMIN = "1a1a1a1a-0000-4000-8000-000000000001";
const SUN_AGENT = "1a1a1a1a-0000-4000-8000-000000000002";
const SUN_AGENT_2 = "1a1a1a1a-0000-4000-8000-000000000003";
const SUN_RETIRED = "1a1a1a1a-0000-4000-8000-000000000004";
const STRANGER = "1a1a1a1a-0000-4000-8000-000000000005";
const OTHER_TENANT = "6b6b6b6b-0000-4000-8000-00000000006b";

const LIVE_LEAD = "2b2b2b2b-0000-4000-8000-000000000001";
const RETIRED_OWNED_LEAD = "2b2b2b2b-0000-4000-8000-000000000002";
const POOL_LEAD = "2b2b2b2b-0000-4000-8000-000000000003";
const SHARED_LEAD = "2b2b2b2b-0000-4000-8000-000000000004";

// OASIS (the assignment-roster path).
const OASIS_CC = "3c3c3c3c-0000-4000-8000-000000000001";
const OASIS_ADON = "3c3c3c3c-0000-4000-8000-000000000002";
const OASIS_OPENER = "3c3c3c3c-0000-4000-8000-000000000003";
const OASIS_RETIRED = "3c3c3c3c-0000-4000-8000-000000000004";
const OASIS_LEAD = "4d4d4d4d-0000-4000-8000-000000000001";

type ApiBody = {
  ok?: boolean;
  error?: string;
  message?: string;
  assigned_to?: string | null;
  collaborators?: string[];
};

function run(name: string) {
  console.log(`  ok  ${name}`);
}

/** A refusal must be a sentence a person can act on, never the bare code. */
function assertReadable(body: ApiBody, label: string) {
  assert.equal(typeof body.message, "string", `${label}: no message`);
  assert.notEqual(body.message, body.error, `${label}: the message is just the code`);
  assert.match(body.message!, /\s/, `${label}: "${body.message}" is not a sentence`);
}

async function main() {
  console.log("lead-assign-collaborators-deactivated:");
  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
  const { MEMBER_DEACTIVATED_MESSAGE } = await import("../lib/team");
  const { OASIS_WEBSITE_SALES_PROGRAM, OASIS_COLD_OUTBOUND_MOTION } = await import(
    "../lib/leads/canonical-lead-fields"
  );

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
  `);

  const profile = (
    id: string,
    authId: string,
    email: string,
    tenant: string,
    role: string,
    opts: { owner?: boolean; deactivatedAt?: string } = {},
  ) => ({
    sql: `INSERT INTO user_profiles
            (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at,
             joined_at, updated_at, deactivated_at, deactivation_reason)
          VALUES (?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z',
                  '2026-09-01T00:00:00Z', ?, ?)`,
    args: [
      id, authId, email, tenant, role, opts.owner ? 1 : 0,
      opts.deactivatedAt ?? null, opts.deactivatedAt ? "Sales team retired" : null,
    ],
  });
  const record = (id: string, tenant: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, tenant, JSON.stringify(data)],
  });
  const RETIRED_AT = "2026-09-24T12:00:00Z";

  await seed.batch(
    [
      ...[
        [SUN_ADMIN, "admin@sun.test"],
        [SUN_AGENT, "agent@sun.test"],
        [SUN_AGENT_2, "agent2@sun.test"],
        [SUN_RETIRED, "retired@sun.test"],
        [STRANGER, "stranger@elsewhere.test"],
        [OASIS_CC, "conaugh@oasisai.work"],
        [OASIS_ADON, "adon@oasisai.work"],
        [OASIS_OPENER, "opener@oasis.test"],
        [OASIS_RETIRED, "retired@oasis.test"],
      ].map(([id, email]) => ({
        sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`,
        args: [id, email],
      })),
      profile("p-sun-admin", SUN_ADMIN, "admin@sun.test", SUN_TENANT, "admin"),
      profile("p-sun-agent", SUN_AGENT, "agent@sun.test", SUN_TENANT, "agent"),
      profile("p-sun-agent-2", SUN_AGENT_2, "agent2@sun.test", SUN_TENANT, "agent"),
      profile("p-sun-retired", SUN_RETIRED, "retired@sun.test", SUN_TENANT, "agent", { deactivatedAt: RETIRED_AT }),
      profile("p-stranger", STRANGER, "stranger@elsewhere.test", OTHER_TENANT, "agent"),
      profile("p-oasis-cc", OASIS_CC, "conaugh@oasisai.work", WEBDEV_TENANT_ID, "owner", { owner: true }),
      profile("p-oasis-adon", OASIS_ADON, "adon@oasisai.work", WEBDEV_TENANT_ID, "admin"),
      profile("p-oasis-opener", OASIS_OPENER, "opener@oasis.test", WEBDEV_TENANT_ID, "opener"),
      profile("p-oasis-retired", OASIS_RETIRED, "retired@oasis.test", WEBDEV_TENANT_ID, "opener", {
        deactivatedAt: RETIRED_AT,
      }),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'sun', 'Sun Biz Funding')", args: [SUN_TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'elsewhere', 'Elsewhere')", args: [OTHER_TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [WEBDEV_TENANT_ID] },
      // A live SunBiz lead with an active owner.
      record(LIVE_LEAD, SUN_TENANT, { business_name: "Live Merchant", stage: "contacted", assigned_to: SUN_AGENT }),
      // A funded deal the retired agent closed: their name stays on it (history).
      record(RETIRED_OWNED_LEAD, SUN_TENANT, {
        business_name: "Closed Merchant", stage: "funded", assigned_to: SUN_RETIRED,
      }),
      // Unassigned: deactivation cleared it, so it must not flow back to them.
      record(POOL_LEAD, SUN_TENANT, { business_name: "Pool Merchant", stage: "new", assigned_to: null }),
      // Shared with the retired agent before they left.
      record(SHARED_LEAD, SUN_TENANT, {
        business_name: "Shared Merchant", stage: "contacted", assigned_to: SUN_AGENT,
        collaborators: [SUN_RETIRED],
      }),
      record(OASIS_LEAD, WEBDEV_TENANT_ID, {
        name: "OASIS Prospect", state: "ON", stage: "assigned", assigned_to: OASIS_OPENER,
        sales_program: OASIS_WEBSITE_SALES_PROGRAM, sales_motion: OASIS_COLD_OUTBOUND_MOTION,
      }),
    ],
    "write",
  );

  const { signSession, SESSION_COOKIE } = await import("../lib/turso-auth");
  assert.equal(SESSION_COOKIE, SESSION_COOKIE_NAME, "the cookie-jar stand-in reads the wrong cookie name");
  const { NextRequest } = await import("next/server");
  const assignRoute = await import("../app/api/leads/[id]/assign/route");
  const collaboratorsRoute = await import("../app/api/leads/[id]/collaborators/route");

  const login = (userId: string, email: string) => {
    sessionCookie = signSession({ sub: userId, email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  };
  const postAssign = async (id: string, assignedTo: string | null) => {
    const req = new NextRequest(`http://localhost/api/leads/${id}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assigned_to: assignedTo }),
    });
    const res = await assignRoute.POST(req, { params: Promise.resolve({ id }) });
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const postCollaborators = async (id: string, body: { add?: string; remove?: string }) => {
    const req = new NextRequest(`http://localhost/api/leads/${id}/collaborators`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await collaboratorsRoute.POST(req, { params: Promise.resolve({ id }) });
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const stored = async (id: string) => {
    const res = await seed.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [id] });
    return JSON.parse(String(res.rows[0]?.data)) as Record<string, unknown>;
  };
  const interactionCount = async (leadId: string) => {
    const res = await seed.execute({
      sql: "SELECT COUNT(*) AS n FROM lead_interactions WHERE lead_id = ?",
      args: [leadId],
    });
    return Number(res.rows[0]?.n ?? 0);
  };

  // ── assign, SunBiz (membership path) ────────────────────────────────────
  login(SUN_ADMIN, "admin@sun.test");

  const logBefore = await interactionCount(LIVE_LEAD);
  for (const [label, target] of [
    ["exact id", SUN_RETIRED],
    ["padded, upper-cased id", `  ${SUN_RETIRED.toUpperCase()} `],
  ] as const) {
    const refused = await postAssign(LIVE_LEAD, target);
    assert.equal(refused.status, 400, `${label}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, "member_deactivated", label);
    assertReadable(refused.body, `${label}: member_deactivated`);
    assert.equal(refused.body.message, MEMBER_DEACTIVATED_MESSAGE, `${label}: not the shared refusal`);
  }
  assert.equal((await stored(LIVE_LEAD)).assigned_to, SUN_AGENT, "a refused assignment moved the lead");
  assert.equal(await interactionCount(LIVE_LEAD), logBefore, "a refused assignment was logged as a reassignment");

  const refusedFromPool = await postAssign(POOL_LEAD, SUN_RETIRED);
  assert.equal(refusedFromPool.status, 400, JSON.stringify(refusedFromPool.body));
  assert.equal(refusedFromPool.body.error, "member_deactivated");
  assert.equal((await stored(POOL_LEAD)).assigned_to, null, "an unassigned lead flowed back to a deactivated rep");
  run("assign: a deactivated SunBiz member is refused (400 member_deactivated) and nothing is written");

  const stranger = await postAssign(LIVE_LEAD, STRANGER);
  assert.equal(stranger.status, 400);
  assert.equal(stranger.body.error, "not_a_tenant_member", "a non-member must still read as a non-member");
  run("assign: a user from another tenant is still not_a_tenant_member");

  const toActive = await postAssign(LIVE_LEAD, SUN_AGENT_2);
  assert.equal(toActive.status, 200, JSON.stringify(toActive.body));
  assert.equal(toActive.body.assigned_to, SUN_AGENT_2);
  assert.equal((await stored(LIVE_LEAD)).assigned_to, SUN_AGENT_2);
  run("assign: an active member is accepted");

  const cleared = await postAssign(LIVE_LEAD, null);
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.assigned_to, null);
  assert.equal((await stored(LIVE_LEAD)).assigned_to, null);
  run("assign: null unassigns");

  const resave = await postAssign(RETIRED_OWNED_LEAD, SUN_RETIRED.toUpperCase());
  assert.equal(resave.status, 200, `re-saving the unchanged deactivated owner was refused: ${JSON.stringify(resave.body)}`);
  assert.equal((await stored(RETIRED_OWNED_LEAD)).assigned_to, SUN_RETIRED, "history lost its owner");
  run("assign: re-saving a lead with its unchanged deactivated owner is accepted");

  const handOff = await postAssign(RETIRED_OWNED_LEAD, SUN_AGENT);
  assert.equal(handOff.status, 200, JSON.stringify(handOff.body));
  assert.equal((await stored(RETIRED_OWNED_LEAD)).assigned_to, SUN_AGENT);
  run("assign: a deactivated owner's lead can be handed to an active member");

  // ── assign, OASIS (assignment-roster path) ─────────────────────────────
  login(OASIS_CC, "conaugh@oasisai.work");
  const oasisRefused = await postAssign(OASIS_LEAD, OASIS_RETIRED);
  assert.equal(oasisRefused.status, 422, JSON.stringify(oasisRefused.body));
  assert.equal(oasisRefused.body.error, "target_not_on_sales_roster");
  assertReadable(oasisRefused.body, "OASIS target_not_on_sales_roster");
  assert.doesNotMatch(oasisRefused.body.message!, /Choose CC or Adon for this pipeline cycle/, "pre-2026-09-24 copy");
  assert.match(oasisRefused.body.message!, /active sales rep/);
  assert.equal((await stored(OASIS_LEAD)).assigned_to, OASIS_OPENER, "a refused OASIS assignment moved the lead");
  run("assign: OASIS refuses a deactivated rep through the active assignment roster");

  // ── collaborators ───────────────────────────────────────────────────────
  login(SUN_ADMIN, "admin@sun.test");

  const addRetired = await postCollaborators(LIVE_LEAD, { add: SUN_RETIRED });
  assert.equal(addRetired.status, 400, JSON.stringify(addRetired.body));
  assert.equal(addRetired.body.error, "member_deactivated");
  assertReadable(addRetired.body, "collaborator member_deactivated");
  assert.deepEqual((await stored(LIVE_LEAD)).collaborators ?? [], [], "a refused add still shared the lead");
  run("collaborators: adding a deactivated member is refused and nothing is written");

  const addStranger = await postCollaborators(LIVE_LEAD, { add: STRANGER });
  assert.equal(addStranger.status, 400);
  assert.equal(addStranger.body.error, "not_a_tenant_member");
  run("collaborators: a user from another tenant is still not_a_tenant_member");

  // Re-adding someone ALREADY on the deal grants nothing, so it is a no-op
  // success even for a deactivated teammate: no refusal, no write, no audit row.
  const sharedAuditBefore = await interactionCount(SHARED_LEAD);
  for (const [label, target] of [
    ["exact id", SUN_RETIRED],
    ["padded, upper-cased id", `  ${SUN_RETIRED.toUpperCase()} `],
  ] as const) {
    const readd = await postCollaborators(SHARED_LEAD, { add: target });
    assert.equal(readd.status, 200, `${label}: re-adding a listed deactivated collaborator was refused: ${JSON.stringify(readd.body)}`);
    assert.equal(readd.body.ok, true, label);
    assert.deepEqual(readd.body.collaborators, [SUN_RETIRED], `${label}: the list changed`);
  }
  assert.deepEqual((await stored(SHARED_LEAD)).collaborators, [SUN_RETIRED], "a no-op re-add rewrote the list");
  assert.equal(await interactionCount(SHARED_LEAD), sharedAuditBefore, "a no-op re-add was audited as a new grant");
  run("collaborators: re-adding an already-listed deactivated collaborator is a no-op success (nothing written)");

  const addActive = await postCollaborators(SHARED_LEAD, { add: SUN_AGENT_2 });
  assert.equal(addActive.status, 200, JSON.stringify(addActive.body));
  assert.deepEqual(
    addActive.body.collaborators,
    [SUN_RETIRED, SUN_AGENT_2],
    "adding an active teammate dropped the existing deactivated collaborator",
  );
  assert.deepEqual((await stored(SHARED_LEAD)).collaborators, [SUN_RETIRED, SUN_AGENT_2]);
  run("collaborators: an active member is added; the existing deactivated collaborator stays listed");

  const auditAfterAdd = await interactionCount(SHARED_LEAD);
  assert.equal(auditAfterAdd, sharedAuditBefore + 1, "fixture: a real add must be audited, or the no-op checks prove nothing");
  const readdActive = await postCollaborators(SHARED_LEAD, { add: SUN_AGENT_2 });
  assert.equal(readdActive.status, 200, JSON.stringify(readdActive.body));
  assert.deepEqual(readdActive.body.collaborators, [SUN_RETIRED, SUN_AGENT_2]);
  assert.equal(await interactionCount(SHARED_LEAD), auditAfterAdd, "re-adding a listed teammate logged a second grant");
  run("collaborators: re-adding an already-listed active collaborator is the same no-op");

  const removeRetired = await postCollaborators(SHARED_LEAD, { remove: SUN_RETIRED.toUpperCase() });
  assert.equal(removeRetired.status, 200, JSON.stringify(removeRetired.body));
  assert.deepEqual(removeRetired.body.collaborators, [SUN_AGENT_2]);
  assert.deepEqual((await stored(SHARED_LEAD)).collaborators, [SUN_AGENT_2]);
  run("collaborators: a deactivated collaborator can be removed");

  // The no-op covers who is ALREADY listed; it is no way around the refusal.
  const readdAfterRemoval = await postCollaborators(SHARED_LEAD, { add: SUN_RETIRED });
  assert.equal(readdAfterRemoval.status, 400, JSON.stringify(readdAfterRemoval.body));
  assert.equal(readdAfterRemoval.body.error, "member_deactivated");
  assert.deepEqual((await stored(SHARED_LEAD)).collaborators, [SUN_AGENT_2]);
  run("collaborators: once removed, a deactivated teammate cannot be added back");

  console.log("lead-assign-collaborators-deactivated: ok");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
