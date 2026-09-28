/**
 * admin-surfaces-operator-only.test.ts — the operator-only admin surfaces admit
 * a platform operator by AUTH USER, never by an email string alone.
 * (doc 02 P0-5, P0-6, P0-7 interim, F3 — 2026-09-28)
 *
 * WHY. /runs, /inbox, /reasoning and /system-health had no gate (or gated only
 * a composer), /api/state-health handed the empire's latest session-log summary
 * and agents' working memory to any signed-in member of any tenant, and
 * /api/quests served CC's task list to the whole internet. The only operator
 * test in the codebase was isOperatorEmail — an email string — and any alias on
 * OPERATOR_EMAIL / ADMIN_EMAILS with no live auth user could be registered by a
 * stranger, who then held operator on every tenant.
 *
 * The gate (lib/role-surfaces-session.ts resolvePlatformOperator) now demands
 * the alias AND an active owner/admin OASIS membership read by auth_user_id.
 * The central case below is the SQUATTER: a session whose email IS on the
 * alias list but whose auth user owns only their own workspace. Under the old
 * rule that session was an operator everywhere; it must now get a 404 from
 * every surface.
 *
 * Everything runs for real against a local libSQL file: the real signed
 * session cookie, the real Turso adapter, the real route handlers and page
 * components. next/headers and next/navigation are the only stand-ins (the
 * same ones tests/_delivery-harness.ts uses, inlined so a concurrent edit to
 * that shared harness cannot change what this test proves).
 *
 * Run: node --conditions=react-server --import tsx tests/admin-surfaces-operator-only.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "admin-surfaces-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "admin-surfaces-operator-only-secret-long-enough-0001";
// The alias list as the gate reads it. conaugh@oasisai.work is the hardcoded
// default in lib/operator-credentials.ts; the rest are configured aliases.
delete process.env.OPERATOR_EMAIL;
process.env.ADMIN_EMAILS = [
  "adon@oasisai.work",
  "squatter@alias.test",
  "unlinked@alias.test",
  "exadmin@alias.test",
  "toggled@alias.test",
  "gone@alias.test",
].join(",");
// state-api must be unreachable so /api/state-health takes its database path;
// port 9 refuses at once rather than waiting out the 2 s timeout.
process.env.STATE_API_URL = "http://127.0.0.1:9";
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;

// tsconfig.json sets jsx:"preserve", so tsx compiles page JSX with the classic
// runtime, which expects a global React (same as tests/delivery-pages.test.ts).
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

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
// The real next/navigation loads the client router context, which does not
// exist under react-server. notFound throws exactly the digest Next's does.
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
});
// next/link is a client component that loads the browser router context too;
// the pages only need it as an anchor (as in tests/delivery-pages.test.ts).
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const SQUAT_TENANT = "5a5a5a5a-0000-4000-8000-00000000005a";
const CLIENT = "6b6b6b6b-0000-4000-8000-00000000006b";

type U = { id: string; email: string };
const u = (n: number, email: string): U => ({ id: `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const USERS = {
  cc: u(1, "conaugh@oasisai.work"), // hardcoded default alias; OASIS owner
  adon: u(2, "adon@oasisai.work"), // ADMIN_EMAILS; OASIS admin
  squatter: u(3, "squatter@alias.test"), // ADMIN_EMAILS; owns only their own new workspace
  unlinked: u(4, "unlinked@alias.test"), // ADMIN_EMAILS; an OASIS owner row carries this EMAIL but no auth link
  exadmin: u(5, "exadmin@alias.test"), // ADMIN_EMAILS; OASIS member, but a closer, not owner/admin
  toggled: u(6, "toggled@alias.test"), // ADMIN_EMAILS; OASIS member via the admin_access toggle only
  gone: u(7, "gone@alias.test"), // ADMIN_EMAILS; OASIS owner row, deactivated
  rep: u(8, "rep@oasisai.work"), // not an alias; OASIS opener
  client: u(9, "owner@client.test"), // not an alias; owner of a client workspace
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
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 4).join("\n        ")}`);
  }
}

async function is404(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (err) {
    if (/NEXT_HTTP_ERROR_FALLBACK;404/.test((err as Error).message)) return true;
    throw err;
  }
}

const SECRET_SUMMARY = "EMPIRE-SESSION-SUMMARY-DO-NOT-LEAK";
const SECRET_FOCUS = "BRAVO-WORKING-MEMORY-DO-NOT-LEAK";
const SECRET_QUEST = "CC-ACTIVE-TASK-DO-NOT-LEAK";

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, agents_enabled TEXT, updated_at TEXT,
      deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE oasis_quests (id TEXT PRIMARY KEY, bucket TEXT, title TEXT, owner TEXT, status TEXT,
      source_file TEXT, source_line INTEGER, first_seen_at TEXT, completed_at TEXT, updated_at TEXT);
    CREATE TABLE agent_state_snapshot (agent_name TEXT PRIMARY KEY, tick_count INTEGER,
      last_tick_at TEXT, working_memory TEXT, health_status TEXT);
    CREATE TABLE session_logs (id TEXT PRIMARY KEY, session_date TEXT, agent_interface TEXT,
      summary TEXT, created_at TEXT);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY, event_type TEXT, publisher_agent TEXT,
      source_agent TEXT, correlation_id TEXT, payload TEXT, published_at TEXT);
  `);
  const stamp = "2026-09-01T00:00:00Z";
  const profile = (user: U, tenant: string, role: string, opts: { owner?: 1 | 0; adminAccess?: 1 | 0; deactivated?: string } = {}) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, admin_access,
            onboarding_completed_at, agents_enabled, updated_at, deactivated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, '["bravo"]', ?, ?)`,
    args: [`p-${user.id}-${tenant.slice(0, 4)}`, user.id, user.email, tenant, role, opts.owner ?? 0, opts.adminAccess ?? 0, stamp, stamp, opts.deactivated ?? null],
  });
  await db.batch(
    [
      ...Object.values(USERS).map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'squatter-co', 'Squatter Co')", args: [SQUAT_TENANT] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-co', 'Client Co')", args: [CLIENT] },
      profile(USERS.cc, OASIS, "owner", { owner: 1 }),
      profile(USERS.adon, OASIS, "admin"),
      // What signup + provision hands anyone who registers an alias: the owner
      // seat of a brand-new workspace of their own. Never a row in OASIS.
      profile(USERS.squatter, SQUAT_TENANT, "owner", { owner: 1 }),
      profile(USERS.unlinked, SQUAT_TENANT, "owner", { owner: 1 }),
      profile(USERS.exadmin, OASIS, "closer"),
      profile(USERS.toggled, OASIS, "member", { adminAccess: 1 }),
      profile(USERS.gone, OASIS, "owner", { owner: 1, deactivated: "2026-09-20T00:00:00Z" }),
      profile(USERS.rep, OASIS, "opener"),
      profile(USERS.client, CLIENT, "owner", { owner: 1 }),
      // A legacy OASIS owner row that carries the alias as its EMAIL but is not
      // linked to that auth user. An email-keyed check would crown the squatter
      // of "unlinked@alias.test"; an auth-id check must not.
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, updated_at)
              VALUES ('p-legacy-unlinked', NULL, ?, ?, 'owner', 1, ?, ?)`,
        args: [USERS.unlinked.email, OASIS, stamp, stamp],
      },
      {
        sql: `INSERT INTO oasis_quests (id, bucket, title, owner, status, updated_at) VALUES ('q1', 'P0', ?, 'cc', 'open', ?)`,
        args: [SECRET_QUEST, stamp],
      },
      {
        sql: `INSERT INTO agent_state_snapshot (agent_name, tick_count, last_tick_at, working_memory, health_status)
              VALUES ('bravo', 7, ?, ?, 'healthy')`,
        args: [stamp, JSON.stringify({ last_focus: SECRET_FOCUS })],
      },
      {
        sql: `INSERT INTO session_logs (id, session_date, agent_interface, summary, created_at) VALUES ('s1', '2026-09-27', 'claude', ?, ?)`,
        args: [SECRET_SUMMARY, stamp],
      },
      {
        sql: `INSERT INTO agent_events (id, event_type, publisher_agent, source_agent, correlation_id, payload, published_at)
              VALUES ('e1', 'dashboard_action', 'bravo', 'bravo', ?, '{"type":"set_mrr_target","ok":true,"summary":"x"}', ?)`,
        args: [OASIS, stamp],
      },
    ],
    "write",
  );

  const gate = await import("../lib/role-surfaces-session");
  const pages = {
    "/runs": (await import("../app/runs/page")).default,
    "/inbox": (await import("../app/inbox/page")).default,
    "/reasoning": (await import("../app/reasoning/page")).default,
    "/system-health": (await import("../app/system-health/page")).default,
  } as Record<string, () => Promise<unknown>>;
  const stateHealth = await import("../app/api/state-health/route");
  const quests = await import("../app/api/quests/route");
  const { NextRequest } = await import("next/server");
  const questsGet = () => quests.GET(new NextRequest("http://localhost/api/quests"));

  console.log("admin-surfaces-operator-only:");

  // ── who is an operator ────────────────────────────────────────────────
  const expected: Array<[keyof typeof USERS, boolean, string]> = [
    ["cc", true, "OASIS owner on the hardcoded default alias"],
    ["adon", true, "OASIS admin on a configured alias"],
    ["squatter", false, "alias email, but the auth user owns only its own workspace"],
    ["unlinked", false, "alias email matching an UNLINKED OASIS owner row (email is not identity)"],
    ["exadmin", false, "alias email, OASIS member below owner/admin"],
    ["toggled", false, "alias email, OASIS member through the admin_access toggle only"],
    ["gone", false, "alias email, deactivated OASIS owner row"],
    ["rep", false, "OASIS opener, not an alias"],
    ["client", false, "client-workspace owner, not an alias"],
  ];
  const { isOperatorEmail } = await import("../lib/operator-credentials");
  const aliased = new Set<keyof typeof USERS>(["cc", "adon", "squatter", "unlinked", "exadmin", "toggled", "gone"]);
  for (const [key, want, why] of expected) {
    await check(`${want ? "operator" : "NOT an operator"}: ${why}`, async () => {
      // Pin the premise: every alias case passes the OLD, email-only rule, so
      // each "NOT an operator" among them is a session that used to be one.
      assert.equal(isOperatorEmail(USERS[key].email), aliased.has(key), `${key} alias premise`);
      await login(USERS[key]);
      assert.equal(await gate.isPlatformOperator(), want);
      assert.equal(await is404(() => gate.requireOperator()), !want);
    });
  }
  await check("NOT an operator: no session", async () => {
    await login(null);
    assert.deepEqual(await gate.resolvePlatformOperator(), { operator: false, reason: "no_session" });
    assert.equal(await is404(() => gate.requireOperator()), true);
  });

  // ── the pages ────────────────────────────────────────────────────────
  for (const key of ["squatter", "unlinked", "rep", "client"] as const) {
    await check(`${key}: every admin page is a 404`, async () => {
      await login(USERS[key]);
      for (const [path, page] of Object.entries(pages)) {
        assert.equal(await is404(page), true, `${path} must 404 for ${key}`);
      }
    });
  }
  await check("signed out: every admin page is a 404", async () => {
    await login(null);
    for (const [path, page] of Object.entries(pages)) {
      assert.equal(await is404(page), true, `${path} must 404 when signed out`);
    }
  });
  await check("the operator still gets every admin page", async () => {
    await login(USERS.cc);
    for (const [path, page] of Object.entries(pages)) {
      assert.equal(await is404(page), false, `${path} must render for CC`);
    }
  });

  // Ordering is the point: the gate must run before ANY query, so the data is
  // never fetched for a non-operator (a fetched-then-hidden value still ships
  // in the RSC payload). A runtime 404 cannot see ordering; the source can.
  await check("each admin page calls requireOperator() as its first statement", () => {
    for (const file of ["app/runs/page.tsx", "app/inbox/page.tsx", "app/reasoning/page.tsx", "app/system-health/page.tsx"]) {
      const src = readFileSync(join(__dirname, "..", file), "utf8");
      const body = src.match(/export default async function \w+\([^)]*\)[^{]*\{([\s\S]*)$/);
      assert.ok(body, `${file}: default export not found`);
      const firstStatement = body[1]
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"));
      assert.equal(firstStatement, "await requireOperator();", `${file}: first statement is "${firstStatement}"`);
    }
  });

  // ── /api/state-health (F3) ───────────────────────────────────────────
  for (const key of ["squatter", "unlinked", "rep", "client"] as const) {
    await check(`${key}: /api/state-health is a 404 carrying no session log or working memory`, async () => {
      await login(USERS[key]);
      const res = await stateHealth.GET();
      assert.equal(res.status, 404);
      const text = await res.text();
      assert.ok(!text.includes(SECRET_SUMMARY), "session_logs summary leaked");
      assert.ok(!text.includes(SECRET_FOCUS), "working memory leaked");
    });
  }
  await check("signed out: /api/state-health is a 401", async () => {
    await login(null);
    assert.equal((await stateHealth.GET()).status, 401);
  });
  await check("the operator keeps the empire-wide state-health view", async () => {
    await login(USERS.cc);
    const res = await stateHealth.GET();
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      available: boolean;
      source: string;
      state_db: { agents: Array<{ agent: string; current_focus: string }>; last_session_log?: { note: string } };
    };
    assert.equal(body.available, true);
    assert.equal(body.source, "supabase-mirror");
    assert.equal(body.state_db.agents[0]?.current_focus, SECRET_FOCUS);
    assert.equal(body.state_db.last_session_log?.note, SECRET_SUMMARY);
  });

  // ── /api/quests (P0-6) ───────────────────────────────────────────────
  await check("middleware no longer lists /api/quests as public", async () => {
    const { isPublic } = await import("../middleware");
    assert.equal(isPublic("/api/quests"), false);
  });
  await check("signed out: /api/quests is a 401 with no rows", async () => {
    await login(null);
    const res = await questsGet();
    assert.equal(res.status, 401);
    assert.ok(!(await res.text()).includes(SECRET_QUEST));
  });
  for (const key of ["squatter", "rep", "client"] as const) {
    await check(`${key}: /api/quests is a 404 with no rows`, async () => {
      await login(USERS[key]);
      const res = await questsGet();
      assert.equal(res.status, 404);
      assert.ok(!(await res.text()).includes(SECRET_QUEST));
    });
  }
  await check("the operator still reads the quest log", async () => {
    await login(USERS.cc);
    const res = await questsGet();
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; rows: Array<{ title: string }> };
    assert.deepEqual(body.rows.map((r) => r.title), [SECRET_QUEST]);
  });

  // ── fail closed ──────────────────────────────────────────────────────
  await check("a failed membership lookup is NOT an operator (fails closed, loudly)", async () => {
    await login(USERS.cc);
    await db.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      assert.deepEqual(await gate.resolvePlatformOperator(), { operator: false, reason: "lookup_failed" });
      assert.equal(await is404(() => gate.requireOperator()), true);
      assert.equal((await stateHealth.GET()).status, 404);
    } finally {
      console.error = originalError;
      await db.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");
    }
    assert.ok(logged.some((l) => l.includes("[role-surfaces.platform_operator")), "the lookup failure must be logged");
  });

  if (failures > 0) {
    console.log(`admin-surfaces-operator-only: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("admin-surfaces-operator-only: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
