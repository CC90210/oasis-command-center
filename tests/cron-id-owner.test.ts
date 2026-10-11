/**
 * tests/cron-id-owner.test.ts — O2 requirement B/C: /api/cron-jobs/[id]
 * PATCH and DELETE are scoped to the row's owner_user_id.
 *
 * WHY. Before O2, any owner/admin of the workspace could edit, toggle or
 * delete ANY tenant automation, whoever created it, and the house (Empire)
 * toggle needed only a verified platform operator — Adon is one (PR #576)
 * but CCPC is not his computer.
 *
 * WHAT IS PINNED, through the real route handlers, real signed sessions and a
 * local libSQL file (next/headers is the only stand-in):
 *   - Adon cannot PATCH (rename, reschedule, reassign agent, enable) or
 *     DELETE CC's automation by id: 403 not_your_automation, and nothing
 *     changes.
 *   - Adon (an admin) MAY switch CC's automation OFF, and that write lands
 *     through the audited CAS transaction.
 *   - owner_user_id never changes through this route, whatever the body asks.
 *   - The house (Empire) toggle needs the agents owner, not just operator
 *     status — Adon is refused, CC is not.
 *
 * Run: node --conditions=react-server --import tsx tests/cron-id-owner.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "cron-id-owner-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "cron-id-owner-secret-00000000000001";
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

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CC = { id: "6c000000-0000-4000-8000-000000000001", email: "conaugh@oasisai.work" };
const ADON = { id: "6c000000-0000-4000-8000-000000000002", email: "adon@oasisai.work" };
const STAMP = "2026-10-01T00:00:00Z";

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

type Body = { ok?: boolean; error?: string; message?: string; job?: { id: string; enabled?: boolean; owner_user_id?: string | null; name?: string } };

async function main() {
  console.log("cron-id-owner:");
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
      run_count INTEGER NOT NULL DEFAULT 0, created_by TEXT, owner_user_id TEXT,
      last_scheduled_for TEXT, tz TEXT, created_at TEXT NOT NULL, updated_at TEXT
    );
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
      schedule TEXT NOT NULL, action_type TEXT NOT NULL, action_config TEXT NOT NULL DEFAULT '{}',
      owner_agent_key TEXT, is_active INTEGER NOT NULL DEFAULT 1, last_run_at TEXT,
      last_result TEXT, next_run_at TEXT, run_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE workspace_agents_owner (
      tenant_id TEXT PRIMARY KEY, auth_user_id TEXT NOT NULL, set_by TEXT NOT NULL,
      set_at TEXT NOT NULL, note TEXT, revoked_at TEXT
    );
    CREATE TABLE tenant_audit_log (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL,
      actor_user_id TEXT, actor_email TEXT, action_type TEXT NOT NULL,
      target_table TEXT, target_id TEXT, before TEXT, after TEXT
    );
  `);

  await db.batch(
    [
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [CC.id, CC.email] },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [ADON.id, ADON.email] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at,
                full_name, agents_enabled, updated_at, joined_at) VALUES ('p-cc', ?, ?, ?, 'owner', 1, ?, 'CC', '[]', ?, ?)`,
        args: [CC.id, CC.email, OASIS, STAMP, STAMP, STAMP],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access, onboarding_completed_at,
                full_name, agents_enabled, updated_at, joined_at) VALUES ('p-adon', ?, ?, ?, 'admin', 0, 1, ?, 'Adon', '[]', ?, ?)`,
        args: [ADON.id, ADON.email, OASIS, STAMP, STAMP, STAMP],
      },
      {
        sql: `INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at) VALUES (?, ?, ?, ?)`,
        args: [OASIS, CC.id, CC.id, STAMP],
      },
      {
        sql: `INSERT INTO tenant_cron_jobs (id, tenant_id, agent_key, name, schedule, action_type, action_payload, enabled, owner_user_id, created_at)
              VALUES ('cc1', ?, 'bravo', 'CC automation', '0 9 * * *', 'script_run', '{}', 1, ?, ?)`,
        args: [OASIS, CC.id, STAMP],
      },
      {
        sql: `INSERT INTO cron_jobs (id, tenant_id, name, schedule, action_type, action_config, owner_agent_key, is_active, created_at)
              VALUES ('house1', ?, 'Daily brief', '0 6 * * *', 'script_run', '{}', 'bravo', 1, ?)`,
        args: [OASIS, STAMP],
      },
    ],
    "write",
  );

  const { signSession } = await import("../lib/turso-auth");
  const login = (who: typeof CC) => {
    sessionCookie = signSession({ sub: who.id, email: who.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  };
  const idRoute = await import("../app/api/cron-jobs/[id]/route");
  const { NextRequest } = await import("next/server");

  const patch = async (id: string, payload: Record<string, unknown>) => {
    const res = await idRoute.PATCH(
      new NextRequest(`http://localhost/api/cron-jobs/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ id }) },
    );
    return { status: res.status, body: (await res.json()) as Body };
  };
  const del = async (id: string) => {
    const res = await idRoute.DELETE(new NextRequest(`http://localhost/api/cron-jobs/${id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });
    return { status: res.status, body: (await res.json()) as Body };
  };
  const row = async (id: string) => {
    const rs = await db.execute({ sql: "SELECT * FROM tenant_cron_jobs WHERE id = ?", args: [id] });
    return rs.rows[0] as unknown as Record<string, unknown> | undefined;
  };
  const auditCount = async () => Number((await db.execute("SELECT COUNT(*) AS n FROM tenant_audit_log")).rows[0].n);

  await check("Adon cannot rename CC's automation: 403 not_your_automation, row unchanged", async () => {
    login(ADON);
    const before = await row("cc1");
    const res = await patch("cc1", { name: "Hijacked", source: "tenant" });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error, "not_your_automation");
    assert.match(String(res.body.message), /\s/, "the refusal is a sentence");
    assert.deepEqual(await row("cc1"), before);
  });

  await check("Adon cannot reschedule CC's automation", async () => {
    login(ADON);
    const res = await patch("cc1", { schedule: "*/5 * * * *", source: "tenant" });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error, "not_your_automation");
  });

  await check("Adon cannot reassign CC's automation's agent", async () => {
    login(ADON);
    const res = await patch("cc1", { agent_key: "maven", source: "tenant" });
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  await check("Adon cannot turn CC's automation ON (it is already on, so turning it 'on' again is still refused as a non-owner write)", async () => {
    login(ADON);
    const res = await patch("cc1", { enabled: true, source: "tenant" });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error, "not_your_automation");
  });

  await check("Adon (an admin) MAY switch CC's automation OFF, and an audit row is written", async () => {
    login(ADON);
    const auditsBefore = await auditCount();
    const res = await patch("cc1", { enabled: false, source: "tenant" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.job?.enabled, false);
    const persisted = await row("cc1");
    assert.equal(Number(persisted?.enabled), 0);
    assert.equal(await auditCount(), auditsBefore + 1, "the admin switch-off is audited");
    const audit = (await db.execute("SELECT actor_user_id, action_type FROM tenant_audit_log ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(audit.actor_user_id, ADON.id);
    assert.equal(audit.action_type, "cron_job_toggle");
  });

  await check("owner_user_id never changes through this route, whatever the body asks", async () => {
    login(CC);
    const res = await patch("cc1", { enabled: true, source: "tenant" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // CC re-enables his own row; even though CC is the owner, owner_user_id
    // is never in the accepted-fields list, so passing it is simply ignored.
    const attempt = await patch("cc1", { name: "Still CC's", owner_user_id: ADON.id, source: "tenant" } as Record<string, unknown>);
    assert.equal(attempt.status, 200, JSON.stringify(attempt.body));
    const persisted = await row("cc1");
    assert.equal(persisted?.owner_user_id, CC.id, "owner_user_id survives unchanged");
  });

  await check("Adon cannot delete CC's automation", async () => {
    login(ADON);
    const res = await del("cc1");
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error, "not_your_automation");
    assert.ok(await row("cc1"), "the row survives");
  });

  await check("CC can edit and delete his own automation", async () => {
    login(CC);
    const renamed = await patch("cc1", { name: "CC's automation (renamed)", source: "tenant" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const gone = await del("cc1");
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(await row("cc1"), undefined);
  });

  await check("the house (Empire) toggle needs the agents owner, not just operator status: Adon is refused, CC is not", async () => {
    login(ADON);
    const refused = await patch("house1", { enabled: false, source: "empire" });
    assert.equal(refused.status, 404, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "not_found_or_forbidden");
    const stillOn = await db.execute("SELECT is_active FROM cron_jobs WHERE id = 'house1'");
    assert.equal(Number(stillOn.rows[0].is_active), 1, "Adon's refused toggle changed nothing");

    login(CC);
    const allowed = await patch("house1", { enabled: false, source: "empire" });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    const nowOff = await db.execute("SELECT is_active FROM cron_jobs WHERE id = 'house1'");
    assert.equal(Number(nowOff.rows[0].is_active), 0);
  });

  if (failures > 0) {
    console.log(`cron-id-owner: ${failures} failing`);
    process.exit(1);
  }
  console.log("cron-id-owner: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
