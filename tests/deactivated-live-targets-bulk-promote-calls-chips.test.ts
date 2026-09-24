/**
 * deactivated-live-targets-bulk-promote-calls-chips.test.ts — four more doors
 * that used to hand LIVE work to a deactivated teammate (2026-09-24).
 *
 *   POST /api/leads/bulk (op=assign)                 checked membership only, so a
 *                                                    whole selection could go to a
 *                                                    retired rep
 *   POST /api/manifest/<slug>/cold-leads/<id>/promote  the non-OASIS branch wrote any
 *                                                    UUID as assigned_to
 *   POST /api/call-appointments                      assignedTo became the appointment
 *                                                    owner with no check at all
 *   /t/<slug>/<page> admin filter chips              built from a raw user_profiles
 *                                                    read, deactivated people included
 *
 * History must survive: a deactivated rep keeps the deals they already hold, so
 * a bulk re-save of rows they own still works, and an existing ?agent=<their id>
 * link still filters (it just has no chip).
 *
 * The three route handlers run for real — session check, profile resolution,
 * tenant slug, data layer — against a local libSQL database; the only stand-in
 * is next/headers' cookie jar (same pattern as
 * tests/lead-assign-collaborators-deactivated.test.ts). The page cannot be
 * imported (a client component builds a React context at module load), so its
 * chip block is lifted out of the source, compiled, and run against the same
 * database with the real helpers injected.
 *
 * Run: node --conditions=react-server --import tsx tests/deactivated-live-targets-bulk-promote-calls-chips.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import { transformSync } from "esbuild";

const dbFile = join(mkdtempSync(join(tmpdir(), "deactivated-live-targets-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "deactivated-live-targets-secret-that-is-long-enough-0001";

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

// SunBiz (a non-OASIS tenant: every path under test is the membership path).
const SUN_TENANT = "5a5a5a5a-0000-4000-8000-00000000005a";
const OTHER_TENANT = "6b6b6b6b-0000-4000-8000-00000000006b";
const SUN_ADMIN = "1a1a1a1a-0000-4000-8000-000000000001";
const SUN_AGENT = "1a1a1a1a-0000-4000-8000-000000000002";
const SUN_AGENT_2 = "1a1a1a1a-0000-4000-8000-000000000003";
const SUN_RETIRED = "1a1a1a1a-0000-4000-8000-000000000004";
const STRANGER = "1a1a1a1a-0000-4000-8000-000000000005";

const LIVE_LEAD = "2b2b2b2b-0000-4000-8000-000000000001";
const POOL_LEAD = "2b2b2b2b-0000-4000-8000-000000000002";
const RETIRED_DEAL_1 = "2b2b2b2b-0000-4000-8000-000000000003";
const RETIRED_DEAL_2 = "2b2b2b2b-0000-4000-8000-000000000004";

const COLD_LIST = "3c3c3c3c-0000-4000-8000-000000000001";
const COLD_A = "3c3c3c3c-0000-4000-8000-000000000002";
const COLD_B = "3c3c3c3c-0000-4000-8000-000000000003";
const COLD_C = "3c3c3c3c-0000-4000-8000-000000000004";

type ApiBody = {
  ok?: boolean;
  error?: string;
  message?: string;
  updated?: number;
  skipped?: number;
  failed?: number;
  promoted_lead_id?: string;
  was_already_promoted?: boolean;
  appointment?: { assigned_to?: string | null };
};

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n")[0]}`);
  }
}

/** A refusal must be a sentence a person can act on, never the bare code. */
function assertReadable(body: ApiBody, label: string) {
  assert.equal(typeof body.message, "string", `${label}: no message`);
  assert.notEqual(body.message, body.error, `${label}: the message is just the code`);
  assert.match(body.message!, /\s/, `${label}: "${body.message}" is not a sentence`);
  assert.match(body.message!, /deactivated/i, `${label}: the message does not say why`);
}

/**
 * Lift the admin-chip block out of the catch-all page and compile it into a
 * callable. The block's free variables are passed in, so the SAME source the
 * page runs is what this test runs.
 */
function loadChipBlock(): (scope: {
  showLeadFilter: boolean;
  dataTenantId: string;
  service: unknown;
  buildMemberDirectory: unknown;
}) => Promise<Array<{ id: string; name: string }>> {
  const src = readFileSync("app/t/[slug]/[...path]/page.tsx", "utf8");
  const start = src.indexOf("let adminRoster");
  assert.ok(start > 0, "the page no longer declares adminRoster");
  const ifAt = src.indexOf("if (showLeadFilter && dataTenantId) {", start);
  assert.ok(ifAt > start, "the chip block is no longer gated on showLeadFilter && dataTenantId");
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf("{", ifAt); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > ifAt, "the chip block has no closing brace");
  const ts = `async function chipBlock({ showLeadFilter, dataTenantId, service, buildMemberDirectory }: any) {
    ${src.slice(start, end)}
    return adminRoster;
  }`;
  const js = transformSync(ts, { loader: "ts" }).code;
  return new Function(`${js}\nreturn chipBlock;`)();
}

async function main() {
  console.log("deactivated-live-targets (bulk assign, cold-lead promote, call appointments, filter chips):");

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
    CREATE TABLE cold_lead_lists (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT,
      promoted_count INTEGER DEFAULT 0, updated_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE cold_leads (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, list_id TEXT NOT NULL,
      business_name TEXT, contact_name TEXT, phone TEXT, email TEXT,
      stage TEXT, promoted_lead_id TEXT, raw TEXT,
      updated_at TEXT DEFAULT ${NOW_SQL}
    );
    CREATE TABLE call_appointments (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL, entity_type TEXT NOT NULL DEFAULT 'lead',
      scheduled_for TEXT NOT NULL, assigned_to TEXT, status TEXT NOT NULL DEFAULT 'scheduled',
      pre_call_note TEXT, outcome_note TEXT, created_by TEXT NOT NULL,
      created_at TEXT DEFAULT ${NOW_SQL}, updated_at TEXT DEFAULT ${NOW_SQL}, completed_at TEXT
    );
  `);

  const RETIRED_AT = "2026-09-24T12:00:00Z";
  const profile = (
    id: string,
    authId: string,
    email: string,
    tenant: string,
    role: string,
    name: string,
    deactivatedAt: string | null = null,
  ) => ({
    sql: `INSERT INTO user_profiles
            (id, auth_user_id, email, tenant_id, team_role, full_name, onboarding_completed_at,
             joined_at, updated_at, deactivated_at, deactivation_reason)
          VALUES (?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z',
                  '2026-09-01T00:00:00Z', ?, ?)`,
    args: [id, authId, email, tenant, role, name, deactivatedAt, deactivatedAt ? "Sales team retired" : null],
  });
  const record = (id: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, SUN_TENANT, JSON.stringify(data)],
  });
  const coldLead = (id: string, name: string) => ({
    sql: `INSERT INTO cold_leads (id, tenant_id, list_id, business_name, contact_name, phone, email, stage, raw)
          VALUES (?, ?, ?, ?, 'Casey Cold', '4165550198', 'casey@cold.test', 'imported', '{}')`,
    args: [id, SUN_TENANT, COLD_LIST, name],
  });

  await seed.batch(
    [
      ...[
        [SUN_ADMIN, "admin@sun.test"],
        [SUN_AGENT, "agent@sun.test"],
        [SUN_AGENT_2, "agent2@sun.test"],
        [SUN_RETIRED, "retired@sun.test"],
        [STRANGER, "stranger@elsewhere.test"],
      ].map(([id, email]) => ({
        sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`,
        args: [id, email],
      })),
      profile("p-sun-admin", SUN_ADMIN, "admin@sun.test", SUN_TENANT, "admin", "Sam Admin"),
      profile("p-sun-agent", SUN_AGENT, "agent@sun.test", SUN_TENANT, "agent", "Riley Agent"),
      profile("p-sun-agent-2", SUN_AGENT_2, "agent2@sun.test", SUN_TENANT, "agent", "Jordan Agent"),
      profile("p-sun-retired", SUN_RETIRED, "retired@sun.test", SUN_TENANT, "agent", "Ethan Retired", RETIRED_AT),
      profile("p-stranger", STRANGER, "stranger@elsewhere.test", OTHER_TENANT, "agent", "Stella Stranger"),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'sun', 'Sun Biz Funding')", args: [SUN_TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'elsewhere', 'Elsewhere')", args: [OTHER_TENANT] },
      record(LIVE_LEAD, { business_name: "Live Merchant", stage: "contacted", assigned_to: SUN_AGENT }),
      // Deactivation cleared it: it must not flow back to them.
      record(POOL_LEAD, { business_name: "Pool Merchant", stage: "new", assigned_to: null }),
      // Deals the retired rep closed: their name stays on them (history).
      record(RETIRED_DEAL_1, { business_name: "Closed One", stage: "funded", assigned_to: SUN_RETIRED }),
      record(RETIRED_DEAL_2, { business_name: "Closed Two", stage: "funded", assigned_to: SUN_RETIRED }),
      {
        sql: "INSERT INTO cold_lead_lists (id, tenant_id, name) VALUES (?, ?, 'September list')",
        args: [COLD_LIST, SUN_TENANT],
      },
      coldLead(COLD_A, "Cold A Co"),
      coldLead(COLD_B, "Cold B Co"),
      coldLead(COLD_C, "Cold C Co"),
    ],
    "write",
  );

  const { signSession, SESSION_COOKIE } = await import("../lib/turso-auth");
  assert.equal(SESSION_COOKIE, SESSION_COOKIE_NAME, "the cookie-jar stand-in reads the wrong cookie name");
  const { NextRequest } = await import("next/server");
  const bulk = await import("../app/api/leads/bulk/route");
  const promote = await import("../app/api/manifest/[slug]/cold-leads/[id]/promote/route");
  const calls = await import("../app/api/call-appointments/route");

  sessionCookie = signSession({
    sub: SUN_ADMIN,
    email: "admin@sun.test",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ver: 0,
  });

  const post = async (
    url: string,
    body: Record<string, unknown>,
    handler: (req: InstanceType<typeof NextRequest>) => Promise<Response>,
  ) => {
    const req = new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await handler(req);
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  const bulkAssign = (ids: string[], assignedTo: string | null) =>
    post("http://localhost/api/leads/bulk", { op: "assign", ids, assigned_to: assignedTo }, (req) => bulk.POST(req));
  const promoteCold = (id: string, body: Record<string, unknown>) =>
    post(`http://localhost/api/manifest/sun/cold-leads/${id}/promote`, body, (req) =>
      promote.POST(req, { params: Promise.resolve({ slug: "sun", id }) }),
    );
  const scheduleCall = (body: Record<string, unknown>) =>
    post(
      "http://localhost/api/call-appointments",
      { leadId: LIVE_LEAD, scheduledFor: new Date(Date.now() + 86_400_000).toISOString(), ...body },
      (req) => calls.POST(req),
    );

  const ownerOf = async (id: string) => {
    const r = await seed.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [id] });
    return (JSON.parse(String(r.rows[0]?.data)) as Record<string, unknown>).assigned_to ?? null;
  };
  const count = async (sql: string, args: string[] = []) =>
    Number((await seed.execute({ sql, args })).rows[0]?.n ?? 0);
  const reassignLogs = () => count("SELECT COUNT(*) AS n FROM lead_interactions WHERE type = 'lead_reassigned'");
  const leadRows = () => count("SELECT COUNT(*) AS n FROM tenant_records WHERE entity_type = 'lead'");
  const appointments = () => count("SELECT COUNT(*) AS n FROM call_appointments");

  // ── (a) bulk assign ───────────────────────────────────────────────────────
  await check("bulk assign: a selection including new work for a deactivated rep is refused whole, nothing written", async () => {
    const logsBefore = await reassignLogs();
    for (const [label, target] of [
      ["exact id", SUN_RETIRED],
      ["padded, upper-cased id", `  ${SUN_RETIRED.toUpperCase()} `],
    ] as const) {
      const refused = await bulkAssign([LIVE_LEAD, POOL_LEAD, RETIRED_DEAL_1], target);
      assert.equal(refused.status, 400, `${label}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.error, "member_deactivated", label);
      assertReadable(refused.body, `${label}: member_deactivated`);
    }
    assert.equal(await ownerOf(LIVE_LEAD), SUN_AGENT, "a refused batch moved a live lead");
    assert.equal(await ownerOf(POOL_LEAD), null, "an unassigned lead flowed back to a deactivated rep");
    assert.equal(await ownerOf(RETIRED_DEAL_1), SUN_RETIRED, "history lost its owner");
    assert.equal(await reassignLogs(), logsBefore, "a refused batch was logged as a reassignment");
  });

  await check("bulk assign: re-saving rows a deactivated rep already owns still works", async () => {
    const resave = await bulkAssign([RETIRED_DEAL_1, RETIRED_DEAL_2], SUN_RETIRED);
    assert.equal(resave.status, 200, JSON.stringify(resave.body));
    assert.equal(resave.body.updated, 2);
    assert.equal(await ownerOf(RETIRED_DEAL_1), SUN_RETIRED);
    assert.equal(await ownerOf(RETIRED_DEAL_2), SUN_RETIRED);
  });

  await check("bulk assign: a user from another tenant is still not_a_tenant_member", async () => {
    const stranger = await bulkAssign([LIVE_LEAD], STRANGER);
    assert.equal(stranger.status, 400, JSON.stringify(stranger.body));
    assert.equal(stranger.body.error, "not_a_tenant_member");
    assert.equal(await ownerOf(LIVE_LEAD), SUN_AGENT);
  });

  await check("bulk assign: an active member takes the batch; a deactivated owner's deal can be handed off", async () => {
    const toActive = await bulkAssign([POOL_LEAD, RETIRED_DEAL_2], SUN_AGENT_2);
    assert.equal(toActive.status, 200, JSON.stringify(toActive.body));
    assert.equal(toActive.body.updated, 2);
    assert.equal(await ownerOf(POOL_LEAD), SUN_AGENT_2);
    assert.equal(await ownerOf(RETIRED_DEAL_2), SUN_AGENT_2);
  });

  // ── (b) cold-lead promote (non-OASIS branch) ─────────────────────────────
  await check("promote: a deactivated assignee is refused (400 member_deactivated), no lead created", async () => {
    const before = await leadRows();
    const refused = await promoteCold(COLD_A, { assignee_user_id: SUN_RETIRED });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "member_deactivated");
    assertReadable(refused.body, "promote member_deactivated");
    assert.equal(await leadRows(), before, "a refused promotion still created a lead");
    const cold = await seed.execute({ sql: "SELECT stage, promoted_lead_id FROM cold_leads WHERE id = ?", args: [COLD_A] });
    assert.equal(cold.rows[0]?.stage, "imported");
    assert.equal(cold.rows[0]?.promoted_lead_id, null);
  });

  await check("promote: a user from another tenant is refused (400 not_a_tenant_member), no lead created", async () => {
    const before = await leadRows();
    const stranger = await promoteCold(COLD_A, { assignee_user_id: STRANGER });
    assert.equal(stranger.status, 400, JSON.stringify(stranger.body));
    assert.equal(stranger.body.error, "not_a_tenant_member");
    assert.equal(await leadRows(), before, "a refused promotion still created a lead");
  });

  await check("promote: an active member is assigned; no assignee still promotes unassigned", async () => {
    const toActive = await promoteCold(COLD_B, { assignee_user_id: SUN_AGENT_2 });
    assert.equal(toActive.status, 200, JSON.stringify(toActive.body));
    assert.equal(await ownerOf(toActive.body.promoted_lead_id!), SUN_AGENT_2);
    const unassigned = await promoteCold(COLD_C, {});
    assert.equal(unassigned.status, 200, JSON.stringify(unassigned.body));
    assert.equal(await ownerOf(unassigned.body.promoted_lead_id!), null);
  });

  // ── (c) call appointments ─────────────────────────────────────────────────
  await check("call appointment: booking one for a deactivated rep is refused (400 member_deactivated), no row", async () => {
    const before = await appointments();
    const refused = await scheduleCall({ assignedTo: SUN_RETIRED });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "member_deactivated");
    assertReadable(refused.body, "call member_deactivated");
    assert.equal(await appointments(), before, "a refused booking still reached a call sheet");
  });

  await check("call appointment: a user from another tenant is refused (400 not_a_tenant_member), no row", async () => {
    const before = await appointments();
    const stranger = await scheduleCall({ assignedTo: STRANGER });
    assert.equal(stranger.status, 400, JSON.stringify(stranger.body));
    assert.equal(stranger.body.error, "not_a_tenant_member");
    assert.equal(await appointments(), before);
  });

  await check("call appointment: self (omitted or any case) and an active teammate are accepted", async () => {
    const own = await scheduleCall({});
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.appointment?.assigned_to, SUN_ADMIN);
    const ownUpper = await scheduleCall({ assignedTo: SUN_ADMIN.toUpperCase() });
    assert.equal(ownUpper.status, 200, JSON.stringify(ownUpper.body));
    assert.equal(ownUpper.body.appointment?.assigned_to, SUN_ADMIN, "self must land on the caller's own sheet");
    const teammate = await scheduleCall({ assignedTo: SUN_AGENT_2 });
    assert.equal(teammate.status, 200, JSON.stringify(teammate.body));
    assert.equal(teammate.body.appointment?.assigned_to, SUN_AGENT_2);
  });

  // ── (d) admin filter chips on /t/<slug>/<page> ────────────────────────────
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { buildMemberDirectory } = await import("../lib/assigned-names");
  const { resolveAssignedScope, assignedWhere } = await import("../lib/lead-scope");

  await check("filter chips: only active teammates of this tenant get a chip", async () => {
    const chipBlock = loadChipBlock();
    const roster = await chipBlock({
      showLeadFilter: true,
      dataTenantId: SUN_TENANT,
      service: getServiceSupabase(),
      buildMemberDirectory,
    });
    const ids = roster.map((m) => m.id);
    assert.ok(!ids.includes(SUN_RETIRED), "a deactivated rep is still offered as a live filter chip");
    assert.ok(!ids.includes(STRANGER), "another tenant's member got a chip");
    assert.deepEqual([...ids].sort(), [SUN_ADMIN, SUN_AGENT, SUN_AGENT_2].sort());
    assert.equal(roster.find((m) => m.id === SUN_AGENT_2)?.name, "Jordan Agent");
  });

  await check("filter chips: an existing ?agent=<deactivated id> link still filters (no chip needed)", async () => {
    const scope = resolveAssignedScope(
      { isAdmin: true, userId: SUN_ADMIN },
      { agent: SUN_RETIRED, unassigned: false },
      true,
    );
    assert.equal(scope, SUN_RETIRED);
    assert.deepEqual(assignedWhere(scope), { assigned_to: SUN_RETIRED });
    // The page must keep feeding the raw ?agent= value to the scope, never
    // re-derive it from the (now active-only) chip roster.
    const page = readFileSync("app/t/[slug]/[...path]/page.tsx", "utf8");
    assert.match(page, /resolveAssignedScope\(\s*viewer,\s*\{ agent: agentFilter, unassigned: unassignedFilter \}/);
    const scopeBlock = page.slice(page.indexOf("const leadScope"), page.indexOf("let adminRoster"));
    assert.ok(scopeBlock.length > 0 && !scopeBlock.includes("adminRoster"), "leadScope must not depend on the chips");
  });

  if (failures) {
    console.error(`deactivated-live-targets: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("deactivated-live-targets: ok");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
