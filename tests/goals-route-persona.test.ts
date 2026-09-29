/**
 * goals-route-persona.test.ts — GET /api/goals answers only viewers who may see
 * company financials (doc 02 P0-9, 2026-09-28).
 *
 * WHY. The route returned the active revenue goal and its history to ANY
 * signed-in member, so a commission-only rep could read the company revenue
 * target that Today and Settings deliberately never fetch for them. The gate is
 * now resolveViewerSurface().capabilities.canSeeCompanyFinancials — the same
 * capability-AND-workspace rule every other company-money reader uses — so:
 *
 *   founder (owner / admin) in an OASIS workspace  → 200 with the goal
 *   manager, sales rep, worker, builder            → 404 (no company money;
 *       doc 02's test line said "manager 200", but lib/role-surfaces.ts gives
 *       the manager persona canSeeCompanyFinancials: false on purpose — "a
 *       manager is still a commission contractor, not a partner" — and the
 *       capability is the rule this gate follows)
 *   owner of a CLIENT workspace                    → 404 (OASIS money is not
 *       theirs, and capabilitiesFor switches it off outside OASIS slugs)
 *   founder whose workspace slug could not be read → 503, never a silent 404
 *   signed out                                     → 401
 *
 * Every non-200 body is checked for the goal's label and amount, so "404" can
 * never mean "404 status with the data still attached".
 *
 * Real everything against a local libSQL file: the real migration 182 (which
 * seeds OASIS's October goal), the real signed session, the real Turso
 * adapter and route. next/headers is the only stand-in.
 *
 * Run: node --conditions=react-server --import tsx tests/goals-route-persona.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "goals-route-persona-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "goals-route-persona-secret-that-is-long-enough-00001";

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = {
    id: p,
    filename: p,
    path: dirname(p),
    loaded: true,
    children: [],
    paths: [],
    exports,
  } as unknown as NodeModule;
}
stub("next/headers", {
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
// lib/role-surfaces-session.ts imports notFound; the real module needs the
// client router context, which does not exist under react-server.
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
});

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";
const VANISHED = "7c7c7c7c-0000-4000-8000-00000000007c"; // a profile's tenant with no tenants row

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0f000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  owner: u(1, "conaugh@oasisai.work"),
  admin: u(2, "adon@oasisai.work"),
  manager: u(3, "manager@oasisai.work"),
  closer: u(4, "closer@oasisai.work"),
  agent: u(5, "agent@oasisai.work"),
  member: u(6, "member@oasisai.work"),
  builder: u(7, "builder@oasisai.work"),
  clientOwner: u(8, "owner@client.test"),
  degradedFounder: u(9, "founder@vanished.test"),
} as const;

async function login(user: U | null): Promise<void> {
  if (!user) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 4).join("\n        ")}`);
  }
}

/** Split a migration the way scripts/apply_turso_migration.py does (no triggers in 182). */
function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("--")) continue;
    buf.push(line);
    if (t.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, ""));
      buf = [];
    }
  }
  if (buf.join("").trim()) out.push(buf.join("\n").trim());
  return out;
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT);
  `);
  const migration = readFileSync(join(__dirname, "..", "database", "turso", "182_revenue_goals.turso.sql"), "utf8");
  for (const stmt of splitSql(migration)) await db.execute(stmt);
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (user: U, tenant: string, role: string, owner: 0 | 1 = 0) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [`p-${user.id}`, user.id, user.email, tenant, role, owner, stamp, stamp],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
      // The client workspace has its own goal, so a 404 there is the gate, not an empty table.
      {
        sql: `INSERT INTO revenue_goals (id, tenant_id, label, target_cents, period_start, period_end, created_at)
              VALUES ('goal-client', ?, 'Client Co quarter', 123400, '2026-09-01', '2026-11-30', ?)`,
        args: [CLIENT, stamp],
      },
      profile(USERS.owner, OASIS, "owner", 1),
      profile(USERS.admin, OASIS, "admin"),
      profile(USERS.manager, OASIS, "manager"),
      profile(USERS.closer, OASIS, "closer"),
      profile(USERS.agent, OASIS, "agent"),
      profile(USERS.member, OASIS, "member"),
      profile(USERS.builder, OASIS, "builder"),
      profile(USERS.clientOwner, CLIENT, "owner", 1),
      profile(USERS.degradedFounder, VANISHED, "owner", 1),
    ],
    "write",
  );

  const route = await import("../app/api/goals/route");
  const OASIS_LABEL = "October sprint — revenue collected";

  console.log("goals-route-persona:");

  for (const key of ["owner", "admin"] as const) {
    await check(`OASIS ${key}: 200 with the company goal and history`, async () => {
      await login(USERS[key]);
      const res = await route.GET();
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; active: { label: string; target_cents: number } | null; history: unknown[] };
      assert.equal(body.ok, true);
      assert.equal(body.active?.label, OASIS_LABEL);
      assert.equal(body.active?.target_cents, 600000);
      assert.equal(body.history.length, 1);
    });
  }

  const refused: Array<[keyof typeof USERS, string]> = [
    ["manager", "sales manager (commission contractor, not a partner)"],
    ["closer", "closer rep"],
    ["agent", "commission-only agent"],
    ["member", "worker"],
    ["builder", "builder"],
    ["clientOwner", "owner of a client workspace"],
  ];
  for (const [key, why] of refused) {
    await check(`${why}: 404, and the body carries no goal`, async () => {
      await login(USERS[key]);
      const res = await route.GET();
      assert.equal(res.status, 404);
      const text = await res.text();
      assert.ok(!text.includes(OASIS_LABEL) && !text.includes("600000"), "OASIS goal leaked");
      assert.ok(!text.includes("Client Co quarter") && !text.includes("123400"), "client goal leaked");
    });
  }

  await check("a founder whose workspace slug cannot be read gets 503, not a silent 404", async () => {
    await login(USERS.degradedFounder);
    const res = await route.GET();
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: "workspace_unresolved" });
  });

  await check("signed out: 401", async () => {
    await login(null);
    assert.equal((await route.GET()).status, 401);
  });

  if (failures > 0) {
    console.log(`goals-route-persona: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("goals-route-persona: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
