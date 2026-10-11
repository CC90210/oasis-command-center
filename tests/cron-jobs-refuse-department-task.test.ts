/**
 * tests/cron-jobs-refuse-department-task.test.ts — the old /api/cron-jobs
 * editor can never touch a department task, and its list resolves the
 * workspace the way every other route does (Automations guided setup, PR1).
 *
 * WHY. Department tasks will live in tenant_cron_jobs beside script jobs, but
 * every write to one must go through its own route: the signed brief, the
 * owner check, the admin lock and the audit trail all live there. The legacy
 * PATCH (toggle and edit) and DELETE only check canManageTeam and write the
 * row directly, so they would switch a task on with no armed slot, rename it
 * without re-signing the brief, or delete it with no audit row.
 *
 * And GET read the caller's tenant with
 * `user_profiles.select(...).eq("auth_user_id", id).maybeSingle()`. A person
 * with a seat in two workspaces has two rows, so that read fails and the
 * Automations tab answered 401 to a signed-in member. Every other route
 * resolves the ACTIVE profile through getSessionContext (lib/team.ts).
 *
 * WHAT IS PINNED, through the real route handlers, real signed sessions and a
 * local libSQL file (next/headers is the only stand-in):
 *   - PATCH toggle, PATCH edit and DELETE answer 409 use_department_task_route
 *     for a department task, with a sentence, and leave the row (and the audit
 *     log) exactly as it was.
 *   - Script rows behave as before: toggle, edit and delete succeed.
 *   - Another workspace's row is still 404 not_found_or_forbidden.
 *   - GET answers a two-workspace member with their ACTIVE workspace's jobs,
 *     and never lists a department task.
 *
 * Run: node --conditions=react-server --import tsx tests/cron-jobs-refuse-department-task.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "cron-jobs-refuse-dept-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "cron-jobs-refuse-department-task-secret-000001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
process.env.ADMIN_EMAILS = "";

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
{
  const p = require.resolve("next/headers");
  require.cache[p] = {
    id: p,
    filename: p,
    path: dirname(p),
    loaded: true,
    children: [],
    paths: [],
    exports: {
      cookies: async () => ({
        get: (name: string) => (name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined),
        getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
        has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
        set: () => undefined,
      }),
      headers: async () => new Headers(),
      draftMode: async () => ({ isEnabled: false }),
    },
  } as unknown as NodeModule;
}

const TENANT = "2c2c2c2c-0000-4000-8000-00000000002c";
const OTHER = "2d2d2d2d-0000-4000-8000-00000000002d";
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // OASIS_OPERATOR_TENANT_ID
const OWNER = { id: "2e000000-0000-4000-8000-000000000001", email: "owner@acme.test" };
// Verified platform operators (CodeRabbit PR #580, Empire-lane tenant scoping):
// conaugh@oasisai.work is the canonical operator alias (isOperatorEmail), live
// even with OPERATOR_EMAIL/ADMIN_EMAILS unset below, same as every other test
// in this suite that signs in as an operator.
const OPERATOR_OASIS = { id: "2f000000-0000-4000-8000-000000000001", email: "conaugh@oasisai.work" };
const OPERATOR_CLIENT = { id: "2f000000-0000-4000-8000-000000000002", email: "conaugh@oasisai.work" };
const STAMP = "2026-09-01T00:00:00Z";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").join("\n        ")}`);
  }
}

type Body = { ok?: boolean; error?: string; message?: string; jobs?: Array<{ id: string; action_type: string; source: string }> };

async function main() {
  console.log("cron-jobs-refuse-department-task:");
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      updated_at TEXT, deactivated_at TEXT, joined_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_cron_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_key TEXT NOT NULL DEFAULT 'bravo',
      name TEXT NOT NULL, description TEXT, schedule TEXT NOT NULL, action_type TEXT NOT NULL,
      action_payload TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT, last_run_status TEXT, last_run_output TEXT, last_run_error TEXT,
      run_count INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT
    );
    CREATE TABLE tenant_audit_log (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL,
      actor_user_id TEXT, actor_email TEXT, action_type TEXT NOT NULL,
      target_table TEXT, target_id TEXT, before TEXT, after TEXT
    );
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
      schedule TEXT NOT NULL, action_type TEXT NOT NULL, action_config TEXT NOT NULL DEFAULT '{}',
      owner_agent_key TEXT, is_active INTEGER NOT NULL DEFAULT 1, last_run_at TEXT,
      last_result TEXT, next_run_at TEXT, run_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
  `);
  const job = (id: string, tenant: string, actionType: string, enabled: 0 | 1, name: string) => ({
    sql: `INSERT INTO tenant_cron_jobs (id, tenant_id, agent_key, name, description, schedule, action_type, action_payload, enabled, created_at)
          VALUES (?, ?, 'sdr', ?, 'kept', '0 9 * * 1-5', ?, ?, ?, ?)`,
    args: [id, tenant, name, actionType, JSON.stringify({ v: 1, rev: 1, owner_user_id: OWNER.id }), enabled, STAMP],
  });
  await db.batch(
    [
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [OWNER.id, OWNER.email] },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [OPERATOR_OASIS.id, OPERATOR_OASIS.email] },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [OPERATOR_CLIENT.id, OPERATOR_CLIENT.email] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'acme', 'Acme')", args: [TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'beta', 'Beta')", args: [OTHER] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      // A verified operator whose ONLY seat is OASIS: its own active workspace,
      // trivially (chooseActiveProfile never has a second row to weigh).
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, agents_enabled, updated_at, joined_at)
              VALUES ('p-operator-oasis', ?, ?, ?, 'owner', 1, ?, 'OASIS Operator', '[]', ?, ?)`,
        args: [OPERATOR_OASIS.id, OPERATOR_OASIS.email, OASIS, STAMP, STAMP, STAMP],
      },
      // A verified operator with TWO seats: an owner/admin row in OASIS (what
      // isPlatformOperatorForAuthUser checks — scoped to that tenant alone, so
      // onboarding here is irrelevant), left un-onboarded on purpose so the
      // overall ACTIVE-profile pick (every tenant, tier: owner+onboarded >
      // onboarded > owner-only > neither) prefers the onboarded Acme seat
      // below. This is the "operator standing in a client workspace" case.
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, agents_enabled, updated_at, joined_at)
              VALUES ('p-operator-client-oasis-seat', ?, ?, ?, 'owner', 1, 'Client-Seat Operator', '[]', ?, ?)`,
        args: [OPERATOR_CLIENT.id, OPERATOR_CLIENT.email, OASIS, STAMP, STAMP],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, agents_enabled, updated_at, joined_at)
              VALUES ('p-operator-client-active-seat', ?, ?, ?, 'owner', 1, ?, 'Client-Seat Operator', '[]', ?, ?)`,
        args: [OPERATOR_CLIENT.id, OPERATOR_CLIENT.email, TENANT, STAMP, STAMP, STAMP],
      },
      // The ACTIVE seat: onboarded owner here, with the session's own email.
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, agents_enabled, updated_at, joined_at)
              VALUES ('p-acme', ?, ?, ?, 'owner', 1, ?, 'Acme Owner', '[]', ?, ?)`,
        args: [OWNER.id, OWNER.email, TENANT, STAMP, STAMP, STAMP],
      },
      // A second seat in another workspace (an older invite, never onboarded).
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, full_name, agents_enabled, updated_at, joined_at)
              VALUES ('p-beta', ?, 'owner+beta@acme.test', ?, 'member', 0, 'Acme Owner', '[]', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
        args: [OWNER.id, OTHER],
      },
      job("dt1", TENANT, "department_task", 0, "Weekly pipeline digest"),
      job("dt-on", TENANT, "department_task", 1, "Morning lead check"),
      job("sc1", TENANT, "snapshot_run", 1, "Daily snapshot"),
      job("sc2", TENANT, "snapshot_run", 1, "Disposable snapshot"),
      job("b1", OTHER, "snapshot_run", 1, "Beta snapshot"),
    ],
    "write",
  );

  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: OWNER.id, email: OWNER.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  const list = await import("../app/api/cron-jobs/route");
  const row = await import("../app/api/cron-jobs/[id]/route");
  const { NextRequest } = await import("next/server");

  const patch = async (id: string, body: Record<string, unknown>) => {
    const res = await row.PATCH(
      new NextRequest(`http://localhost/api/cron-jobs/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
    return { status: res.status, body: (await res.json()) as Body };
  };
  const del = async (id: string) => {
    const res = await row.DELETE(new NextRequest(`http://localhost/api/cron-jobs/${id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });
    return { status: res.status, body: (await res.json()) as Body };
  };
  const snapshot = async (id: string) => {
    const rs = await db.execute({ sql: "SELECT * FROM tenant_cron_jobs WHERE id = ?", args: [id] });
    return rs.rows[0] ? JSON.stringify(rs.rows[0]) : null;
  };
  const auditCount = async () => Number((await db.execute("SELECT COUNT(*) AS n FROM tenant_audit_log")).rows[0].n);
  const refused = (res: { status: number; body: Body }, label: string) => {
    assert.equal(res.status, 409, `${label}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, "use_department_task_route", label);
    assert.match(String(res.body.message), /\s/, `${label}: the refusal carries a sentence`);
    assert.notEqual(res.body.message, res.body.error);
  };

  await check("PATCH toggle on a department task is refused 409 and switches nothing on or off", async () => {
    const before = await snapshot("dt1");
    const audits = await auditCount();
    refused(await patch("dt1", { enabled: true, source: "tenant" }), "switch on");
    refused(await patch("dt-on", { enabled: false, source: "tenant" }), "switch off");
    assert.equal(await snapshot("dt1"), before);
    assert.equal(Number((await db.execute("SELECT enabled FROM tenant_cron_jobs WHERE id = 'dt-on'")).rows[0].enabled), 1);
    assert.equal(await auditCount(), audits, "no audit row for a refused toggle");
  });

  await check("PATCH edit on a department task is refused 409 and changes no field", async () => {
    const before = await snapshot("dt1");
    refused(await patch("dt1", { name: "Renamed", source: "tenant" }), "rename");
    refused(await patch("dt1", { schedule: "*/5 * * * *", source: "tenant" }), "reschedule");
    refused(await patch("dt1", { agent_key: "sdr", source: "tenant" }), "reassign");
    assert.equal(await snapshot("dt1"), before);
  });

  await check("DELETE on a department task is refused 409 and the row survives", async () => {
    const before = await snapshot("dt1");
    refused(await del("dt1"), "delete");
    assert.equal(await snapshot("dt1"), before);
  });

  await check("script rows keep working: toggle, edit and delete", async () => {
    const off = await patch("sc1", { enabled: false, source: "tenant" });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(Number((await db.execute("SELECT enabled FROM tenant_cron_jobs WHERE id = 'sc1'")).rows[0].enabled), 0);
    const renamed = await patch("sc1", { name: "Daily snapshot (renamed)", source: "tenant" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(String((await db.execute("SELECT name FROM tenant_cron_jobs WHERE id = 'sc1'")).rows[0].name), "Daily snapshot (renamed)");
    const gone = await del("sc2");
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(await snapshot("sc2"), null);
  });

  await check("another workspace's row is still 404 for toggle, edit and delete", async () => {
    const before = await snapshot("b1");
    for (const res of [
      await patch("b1", { enabled: false, source: "tenant" }),
      await patch("b1", { name: "Hijacked", source: "tenant" }),
      await del("b1"),
    ]) {
      assert.equal(res.status, 404, JSON.stringify(res.body));
      assert.equal(res.body.error, "not_found_or_forbidden");
    }
    assert.equal(await snapshot("b1"), before);
  });

  await check("GET answers a two-workspace member with their ACTIVE workspace's jobs, never a department task", async () => {
    const res = await list.GET();
    const body = (await res.json()) as Body;
    assert.equal(res.status, 200, JSON.stringify(body));
    const ids = (body.jobs || []).map((j) => j.id).sort();
    assert.deepEqual(ids, ["sc1"], `listed: ${ids.join(", ")}`);
    assert.ok(!(body.jobs || []).some((j) => j.action_type === "department_task"));
  });

  await check("GET still requires a non-empty Empire lane for an operator in OASIS's own tenant: zero cron_jobs rows is still 503", async () => {
    sessionCookie = signSession({
      sub: OPERATOR_OASIS.id,
      email: OPERATOR_OASIS.email,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ver: 0,
    });
    const res = await list.GET();
    const body = (await res.json()) as Body;
    assert.equal(res.status, 503, JSON.stringify(body));
    assert.equal(body.error, "incomplete_automation_inventory", JSON.stringify(body));
  });

  await check("GET answers 200 with the client's list for an operator whose ACTIVE profile is a client workspace with zero cron_jobs rows", async () => {
    sessionCookie = signSession({
      sub: OPERATOR_CLIENT.id,
      email: OPERATOR_CLIENT.email,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ver: 0,
    });
    const res = await list.GET();
    const body = (await res.json()) as Body;
    assert.equal(res.status, 200, JSON.stringify(body));
    const ids = (body.jobs || []).map((j) => j.id).sort();
    assert.deepEqual(ids, ["sc1"], `listed: ${ids.join(", ")}`);
  });

  await check("GET resolves the workspace through getSessionContext, not its own profile read", async () => {
    const src = readFileSync(join(ROOT, "app", "api", "cron-jobs", "route.ts"), "utf8");
    const getBody = src.slice(src.indexOf("export const GET"), src.indexOf("export async function POST"));
    assert.match(getBody, /await getSessionContext\(\)/);
    assert.doesNotMatch(getBody, /from\("user_profiles"\)/, "GET must not look the workspace up a second way");
    assert.match(getBody, /\.neq\("action_type", DEPARTMENT_TASK\)/);
  });

  if (failures > 0) {
    console.log(`cron-jobs-refuse-department-task: ${failures} failing`);
    process.exit(1);
  }
  console.log("cron-jobs-refuse-department-task: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
