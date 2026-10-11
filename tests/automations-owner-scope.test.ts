/**
 * tests/automations-owner-scope.test.ts — O2 requirement A: GET /api/cron-jobs
 * shows each person their OWN automations, a `team` lane of everyone else's
 * for owners/admins, and the house (Empire) lane only for the workspace's
 * AGENTS OWNER.
 *
 * WHY. Before O2, the house lane and its non-empty contract were armed by
 * "is a verified platform operator" — but PR #576 made Adon one too, without
 * making him CCPC's owner, so the old predicate would have handed him CC's
 * house schedules the moment it covered him. lib/agents-owner.ts is the
 * narrower, correct question.
 *
 * WHAT IS PINNED, through the real route handler, real signed sessions and a
 * local libSQL file (next/headers is the only stand-in):
 *   - CC (the agents owner) gets every house row, his own tenant rows under
 *     `jobs`, and Adon's under `team` with a display name.
 *   - Adon (admin, verified platform operator, NOT the agents owner) gets a
 *     valid 200 with no house rows and no contract 500; his own tenant rows
 *     under `jobs`, CC's under `team`.
 *   - A failed house read is 500; an empty house lane is 503 (OASIS's
 *     existing fail-loud contract, unchanged by O2).
 *   - A missing or unreadable agents-owner row is 500 agents_owner_not_set /
 *     agents_owner_unavailable — never a workspace-only 200 that looks
 *     healthy.
 *
 * Run: node --conditions=react-server --import tsx tests/automations-owner-scope.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "automations-owner-scope-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "automations-owner-scope-secret-0000000001";
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

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // OASIS_OPERATOR_TENANT_ID
const CC = { id: "5c000000-0000-4000-8000-000000000001", email: "conaugh@oasisai.work" };
// Verified platform operator (PR #576: operator alias OR owner/admin OASIS
// seat by auth id) who is NOT the agents owner.
const ADON = { id: "5c000000-0000-4000-8000-000000000002", email: "adon@oasisai.work" };
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

type Job = { id: string; source: string; owner_user_id?: string | null; owner_name?: string | null };
type Body = { ok?: boolean; error?: string; message?: string; jobs?: Job[]; team?: Job[]; inventory?: { empire_included?: boolean; team_included?: boolean; lanes?: { empire?: { queried?: boolean; count?: number } } } };

async function main() {
  console.log("automations-owner-scope:");
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
      // Adon: an admin seat (canManageTeam true) but NOT the agents owner.
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
        sql: `INSERT INTO tenant_cron_jobs (id, tenant_id, agent_key, name, schedule, action_type, action_payload, enabled, owner_user_id, created_at)
              VALUES ('adon1', ?, 'bravo', 'Adon automation', '0 10 * * *', 'script_run', '{}', 1, ?, ?)`,
        args: [OASIS, ADON.id, STAMP],
      },
      {
        sql: `INSERT INTO cron_jobs (id, tenant_id, name, schedule, action_type, action_config, owner_agent_key, created_at)
              VALUES ('house1', ?, 'Daily brief', '0 6 * * *', 'script_run', '{}', 'bravo', ?)`,
        args: [OASIS, STAMP],
      },
    ],
    "write",
  );

  const { signSession } = await import("../lib/turso-auth");
  const login = (who: typeof CC) => {
    sessionCookie = signSession({ sub: who.id, email: who.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
  };
  const route = await import("../app/api/cron-jobs/route");
  const get = async () => {
    const res = await route.GET();
    return { status: res.status, body: (await res.json()) as Body };
  };

  await check("CC (the agents owner) gets every house row, his own tenant row under jobs, Adon's under team", async () => {
    login(CC);
    const res = await get();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const jobIds = (res.body.jobs || []).map((j) => j.id).sort();
    assert.deepEqual(jobIds, ["cc1", "house1"], "CC sees his own tenant row plus the house row");
    const teamIds = (res.body.team || []).map((j) => j.id);
    assert.deepEqual(teamIds, ["adon1"], "Adon's automation shows in team");
    assert.equal(res.body.team?.[0]?.owner_name, "Adon", "team row names its owner");
    assert.equal(res.body.inventory?.empire_included, true);
    assert.equal(res.body.inventory?.team_included, true);
  });

  await check("Adon (verified operator, admin, NOT the agents owner) gets 200 with no house rows and no contract 500", async () => {
    login(ADON);
    const res = await get();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const jobIds = (res.body.jobs || []).map((j) => j.id).sort();
    assert.deepEqual(jobIds, ["adon1"], "Adon sees only his own tenant row; the house row is withheld");
    const teamIds = (res.body.team || []).map((j) => j.id);
    assert.deepEqual(teamIds, ["cc1"], "CC's automation shows in Adon's team list");
    assert.equal(res.body.inventory?.empire_included, false, "Adon is not entitled to the Empire lane");
    assert.equal(res.body.inventory?.lanes?.empire?.queried, false, "the house lane is never queried for a non-owner");
    assert.equal(res.body.inventory?.lanes?.empire?.count, 0);
  });

  await check("a failed house read is 500 for the agents owner", async () => {
    login(CC);
    await db.execute("ALTER TABLE cron_jobs RENAME TO cron_jobs_offline");
    try {
      const res = await get();
      assert.equal(res.status, 500, JSON.stringify(res.body));
    } finally {
      await db.execute("ALTER TABLE cron_jobs_offline RENAME TO cron_jobs");
    }
  });

  await check("an empty house lane is 503 for the agents owner (OASIS's existing fail-loud contract)", async () => {
    login(CC);
    await db.execute("DELETE FROM cron_jobs WHERE id = 'house1'");
    try {
      const res = await get();
      assert.equal(res.status, 503, JSON.stringify(res.body));
      assert.equal(res.body.error, "incomplete_automation_inventory");
    } finally {
      await db.execute({
        sql: `INSERT INTO cron_jobs (id, tenant_id, name, schedule, action_type, action_config, owner_agent_key, created_at)
              VALUES ('house1', ?, 'Daily brief', '0 6 * * *', 'script_run', '{}', 'bravo', ?)`,
        args: [OASIS, STAMP],
      });
    }
  });

  await check("a missing agents-owner row (table absent) is 500 agents_owner_unavailable, for CC too", async () => {
    login(CC);
    await db.execute("ALTER TABLE workspace_agents_owner RENAME TO workspace_agents_owner_offline");
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const res = await get();
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body.error, "agents_owner_unavailable");
    } finally {
      console.error = originalError;
      await db.execute("ALTER TABLE workspace_agents_owner_offline RENAME TO workspace_agents_owner");
    }
  });

  await check("an agents-owner row that has never been set is 500 agents_owner_not_set, for CC too", async () => {
    login(CC);
    await db.execute({ sql: "DELETE FROM workspace_agents_owner WHERE tenant_id = ?", args: [OASIS] });
    try {
      const res = await get();
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body.error, "agents_owner_not_set");
    } finally {
      await db.execute({
        sql: `INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at) VALUES (?, ?, ?, ?)`,
        args: [OASIS, CC.id, CC.id, STAMP],
      });
    }
  });

  // Codex review (O2): the Operations "all clear" must count the house
  // scheduler. Stalled is one thing needing the owner; an unreadable status
  // for the owner is unknown (null), never all clear; a non-owner has no item.
  await check("all clear counts the house scheduler: stalled is 1, an unreadable status is unknown, a non-owner has no item", async () => {
    const { needsYouCount, nothingNeedsYou } = await import("../lib/admin/attention");
    const base = { errors: 0, warnings: 0, cronFailures: 0, workersDown: 0, coldLeads: 0 };
    assert.equal(needsYouCount({ ...base }, null), 0, "no scheduler item (non-owner): unchanged");
    assert.equal(needsYouCount({ ...base, houseScheduler: { stalled: false, lastPollOkAt: "2026-10-11T05:00:00Z" } }, null), 0);
    assert.equal(needsYouCount({ ...base, houseScheduler: { stalled: true, lastPollOkAt: null } }, null), 1);
    assert.equal(nothingNeedsYou({ ...base, houseScheduler: { stalled: true, lastPollOkAt: null } }, null), false);
    assert.equal(needsYouCount({ ...base, houseScheduler: null }, null), null, "the owner's read failed: unknown");
    assert.equal(nothingNeedsYou({ ...base, houseScheduler: null }, null), false);
  });

  if (failures > 0) {
    console.log(`automations-owner-scope: ${failures} failing`);
    process.exit(1);
  }
  console.log("automations-owner-scope: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
