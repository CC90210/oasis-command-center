/**
 * bridge-owner-gate.test.ts — O1: only a workspace's AGENTS OWNER may reach
 * that workspace's paired computer, against a real local libSQL file.
 *
 * WHY. Before this, authorizeBridgeRequest (lib/bridge-proxy.ts) admitted ANY
 * verified platform operator into an OASIS-surface workspace's bridge. Since
 * PR #576 made Adon a verified operator too (platform_operators), his
 * department chats, the coding harness and fleet control all ran on CC's PC
 * under CC's own Claude sign-in. database/turso/bravo__210_workspace_agents_owner.sql
 * + lib/agents-owner.ts name the one auth user (CC) whose computer this is;
 * everyone else is refused, truthfully, not routed around.
 *
 * WHAT IS PINNED, against the shared gate directly and against every route
 * under app/api/bridge, app/api/automations/background-workers/control and
 * app/api/leads/[id]/clair-report that calls it:
 *   - Adon (verified operator, NOT the owner) gets 403 not_your_computer on
 *     every one;
 *   - CC (the owner) is never refused BY THE OWNER GATE (whatever else a
 *     route does downstream with no live bridge mocked is unrelated to O1);
 *   - OASIS with no owner row at all: 403 agents_owner_not_set;
 *   - an owner row that cannot be read: 403 agents_owner_unavailable;
 *   - the SunBiz ('submissions') tenant is untouched by any of this: an
 *     owner (is_owner) there reaches exactly what it reached before.
 *
 * Run: node --conditions=react-server --import tsx tests/bridge-owner-gate.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "bridge-owner-gate-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.TURSO_AUTH_TOKEN;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "bridge-owner-gate-secret-long-enough-00000001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
// Adon's operator status must come from the P0-7 table (platform_operators),
// never an env alias — that is the realistic O1 scenario this gate exists for.
delete process.env.ADMIN_EMAILS;
// OASIS's own per-tenant bridge (as production resolves it: a per-tenant
// https URL plus BRIDGE_BEARER_TOKEN_<SLUG>). Fake values, never real ones.
process.env.BRIDGE_BEARER_TOKEN_OASIS_AI_CC = "test-bearer-not-real";
delete process.env.BRIDGE_VPS_URL;
delete process.env.BRIDGE_BEARER_TOKEN;
delete process.env.CHAT_RESUME_HMAC_KEY;

const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
let answer: (url: string) => Response = () => new Response(JSON.stringify({ ok: true, output: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  let body: unknown = init?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* keep raw */
    }
  }
  calls.push({ url, method: init?.method || "GET", headers, body });
  return answer(url);
}) as typeof fetch;

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({
    get: (name: string) => (name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined),
    getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
    has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
});

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const SUNBIZ = "5b5b5b5b-0000-4000-8000-00000000005b";
const u = (n: number, email: string) => ({ id: `0c000000-0000-4000-8000-${String(n).padStart(12, "0")}`, email });
const CC = u(1, "conaugh@oasisai.work"); // alias operator, OASIS owner, owns the computer
const ADON = u(2, "adon@oasisai.work"); // listed operator (platform_operators), admin seat, NOT the computer's owner
const SUNBIZ_OWNER = u(3, "owner@sunbiz.test"); // legacy 'submissions' tenant, unaffected by O1

async function login(user: { id: string; email: string } | null) {
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
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

async function jsonOf(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  const stamp = "2026-10-10T00:00:00Z";
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      primary_agent TEXT, updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT, lifecycle TEXT);
    CREATE TABLE tenant_audit_log (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      actor_email TEXT, actor_user_id TEXT, action_type TEXT, target_table TEXT, target_id TEXT, after TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, label TEXT NOT NULL,
      last_seen_at TEXT, revoked_at TEXT);
    CREATE TABLE clair_reports (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, status TEXT,
      error_message TEXT, result_count INTEGER, people TEXT, phones TEXT, query_name TEXT,
      query_address TEXT, query_city TEXT, query_state TEXT, query_zip TEXT, query_dob TEXT,
      permissible_dppa TEXT, permissible_glb TEXT, permissible_voter TEXT, clear_environment TEXT,
      requested_by_email TEXT, created_at TEXT, completed_at TEXT);
    CREATE TABLE tenant_records (id TEXT PRIMARY KEY, tenant_id TEXT, entity_type TEXT, data TEXT,
      created_at TEXT, updated_at TEXT);
  `);
  // The real migrations, each run twice: they must create their table and be safe to re-run.
  for (const file of ["database/turso/bravo__208_platform_operators.sql", "database/turso/bravo__210_workspace_agents_owner.sql"]) {
    const migration = readFileSync(join(ROOT, file), "utf8");
    await db.executeMultiple(migration);
    await db.executeMultiple(migration);
  }
  const profile = (user: { id: string; email: string }, tenant: string, role: string, owner: 0 | 1 = 0) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, agents_enabled, primary_agent, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '["bravo"]', 'bravo', ?)`,
    args: [`p-${user.id}`, user.id, user.email, tenant, role, owner, stamp, stamp],
  });
  await db.batch(
    [
      ...[CC, ADON, SUNBIZ_OWNER].map((x) => ({ sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [x.id, x.email] })),
      { sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'oasis-ai-cc', 'OASIS AI', ?)", args: [OASIS, JSON.stringify({ bridge_url: "https://bridge.test" })] },
      { sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, 'submissions', 'SunBiz', '{}')", args: [SUNBIZ] },
      profile(CC, OASIS, "owner", 1),
      profile(ADON, OASIS, "admin", 0),
      profile(SUNBIZ_OWNER, SUNBIZ, "owner", 1),
      // Adon: listed operator (P0-7), never revoked.
      { sql: "INSERT INTO platform_operators (auth_user_id, added_by, added_at, note, revoked_at) VALUES (?, 'test', ?, 'fixture', NULL)", args: [ADON.id, stamp] },
      // CC: the workspace's agents owner (hand-inserted, as production will be before merge).
      { sql: "INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at, note, revoked_at) VALUES (?, ?, 'test', ?, 'fixture', NULL)", args: [OASIS, CC.id, stamp] },
    ],
    "write",
  );

  console.log("bridge-owner-gate:");
  const bridge = await import("../lib/bridge-proxy");

  // ── 1. The shared gate itself ────────────────────────────────────────────
  await check("CC (the owner) passes the gate unchanged: ok, the OASIS target, his own role", async () => {
    await login(CC);
    const auth = await bridge.authorizeBridgeRequest();
    assert.equal(auth.ok, true, JSON.stringify(auth));
    if (!auth.ok) return;
    assert.equal(auth.tenantSlug, "oasis-ai-cc");
    assert.equal(auth.teamRole, "owner");
    assert.equal(auth.target.baseUrl, "https://bridge.test");
    assert.equal(auth.target.bearerToken, "test-bearer-not-real");
  });

  await check("Adon (verified operator, NOT the owner) is refused: 403 not_your_computer", async () => {
    await login(ADON);
    assert.deepEqual(await bridge.authorizeBridgeRequest(), { ok: false, status: 403, error: "not_your_computer" });
  });

  await check("OASIS with no owner row at all: 403 agents_owner_not_set, for CC too (no one is named yet)", async () => {
    await db.execute("DELETE FROM workspace_agents_owner WHERE tenant_id = ?", [OASIS]);
    try {
      await login(CC);
      assert.deepEqual(await bridge.authorizeBridgeRequest(), { ok: false, status: 403, error: "agents_owner_not_set" });
      await login(ADON);
      assert.deepEqual(await bridge.authorizeBridgeRequest(), { ok: false, status: 403, error: "agents_owner_not_set" });
    } finally {
      await db.execute(
        "INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at, note, revoked_at) VALUES (?, ?, 'test', ?, 'fixture', NULL)",
        [OASIS, CC.id, stamp],
      );
    }
  });

  await check("a revoked owner row reads as not_set, not as the revoked person's computer", async () => {
    await db.execute("UPDATE workspace_agents_owner SET revoked_at = ? WHERE tenant_id = ?", [stamp, OASIS]);
    try {
      await login(CC);
      assert.deepEqual(await bridge.authorizeBridgeRequest(), { ok: false, status: 403, error: "agents_owner_not_set" });
    } finally {
      await db.execute("UPDATE workspace_agents_owner SET revoked_at = NULL WHERE tenant_id = ?", [OASIS]);
    }
  });

  await check("an owner row that cannot be read: 403 agents_owner_unavailable, even for the owner CC himself", async () => {
    await db.execute("ALTER TABLE workspace_agents_owner RENAME TO workspace_agents_owner_offline");
    try {
      await login(CC);
      assert.deepEqual(await bridge.authorizeBridgeRequest(), { ok: false, status: 403, error: "agents_owner_unavailable" });
      await login(ADON);
      assert.deepEqual(await bridge.authorizeBridgeRequest(), { ok: false, status: 403, error: "agents_owner_unavailable" });
    } finally {
      await db.execute("ALTER TABLE workspace_agents_owner_offline RENAME TO workspace_agents_owner");
    }
  });

  await check("the submissions ('SunBiz') tenant is untouched: its owner reaches exactly what it reached before", async () => {
    await login(SUNBIZ_OWNER);
    // No BRIDGE_VPS_URL/BRIDGE_BEARER_TOKEN is set globally in this fixture,
    // so the pre-O1 answer here is bridge_not_configured — never one of the
    // three new owner-gate codes, which must never fire for this tenant.
    assert.deepEqual(await bridge.authorizeBridgeRequest(), { ok: false, status: 503, error: "bridge_not_configured", isOperator: false, tenantSlug: "submissions" });
  });

  // ── 2. Every route that reaches the paired computer, through the one gate ─
  const routes = {
    chat: await import("../app/api/bridge/chat/route"),
    execTool: await import("../app/api/bridge/exec-tool/route"),
    warmStatus: await import("../app/api/bridge/warm-status/route"),
    prewarm: await import("../app/api/bridge/prewarm/route"),
    actions: await import("../app/api/bridge/actions/route"),
    cliAuth: await import("../app/api/bridge/cli-auth/route"),
    chatReset: await import("../app/api/bridge/chat-reset/route"),
    health: await import("../app/api/bridge/health/route"),
    control: await import("../app/api/automations/background-workers/control/route"),
    clairReport: await import("../app/api/leads/[id]/clair-report/route"),
  };
  const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body) });

  const asAdon = [
    ["chat", () => routes.chat.POST(post("/api/bridge/chat", { agent: "bravo", messages: [{ role: "user", content: "hi" }] }) as never)],
    ["exec-tool", () => routes.execTool.POST(post("/api/bridge/exec-tool", { tool_name: "bash", input: { command: "ls" } }) as never)],
    ["prewarm", () => routes.prewarm.POST(post("/api/bridge/prewarm", { agent: "bravo", tab_id: "t1" }) as never)],
    ["actions", () => routes.actions.POST(post("/api/bridge/actions", { type: "write_file" }) as never)],
    ["cli-auth", () => routes.cliAuth.POST(post("/api/bridge/cli-auth", { provider: "claude" }) as never)],
    ["chat-reset", () => routes.chatReset.POST(post("/api/bridge/chat-reset", { agent: "bravo", tab_id: "t1" }) as never)],
    ["fleet control", () => routes.control.POST(post("/api/automations/background-workers/control", { service: "pm2.bravo-ig-dm", action: "restart" }) as never)],
    ["clair-report GET", () => routes.clairReport.GET(new Request("http://localhost/api/leads/x/clair-report") as never, { params: Promise.resolve({ id: "lead-1" }) })],
    ["clair-report POST", () => routes.clairReport.POST(new Request("http://localhost/api/leads/x/clair-report", { method: "POST" }) as never, { params: Promise.resolve({ id: "lead-1" }) })],
  ] as const;

  // warm-status is the one route under app/api/bridge that does NOT answer a
  // non-401 auth failure with its own status: it is a 200 with a `reason`
  // field for every failure mode by design (file header: "A bridge failure
  // is a 200 with reason, so the page can still show the computer's
  // check-in"), bridge_not_configured and bridge_not_enabled_for_tenant
  // included. not_your_computer is correctly one more reason in that same
  // family, not a regression — the security property (no call to the
  // computer) is what this checks, not the HTTP status.
  await check("warm-status: a non-owner verified operator (Adon) gets reason not_your_computer (this route's own 200-with-reason shape), and no bridge call", async () => {
    await login(ADON);
    calls.length = 0;
    const { status, body } = await jsonOf(await routes.warmStatus.GET());
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.reason, "not_your_computer");
    assert.equal(calls.length, 0, "no call to the computer was made");
  });

  for (const [label, call] of asAdon) {
    await check(`${label}: a non-owner verified operator (Adon) gets 403 not_your_computer`, async () => {
      await login(ADON);
      calls.length = 0;
      const { status, body } = await jsonOf(await call());
      assert.equal(status, 403, `${label}: ${JSON.stringify(body)}`);
      assert.equal(body.error, "not_your_computer", `${label}: ${JSON.stringify(body)}`);
      assert.equal(calls.length, 0, `${label}: no call to the computer was made`);
    });
  }

  await check("/api/bridge/health: not_your_computer, never vps_unreachable, and the cloud probe is skipped", async () => {
    await login(ADON);
    calls.length = 0;
    const res = await routes.health.GET();
    assert.equal(res.status, 200, "a neutral 200, not an outage status");
    const body = (await res.json()) as { ok: boolean; reason: string };
    assert.deepEqual(body, { ok: false, reason: "not_your_computer", detail: "This runs on another team member's computer, so only they can use it." });
    assert.equal(calls.length, 0, "no probe of the computer was made for a non-owner");
  });

  await check("the owner (CC) is never refused BY THE OWNER GATE on any of these routes", async () => {
    await login(CC);
    for (const [label, call] of asAdon) {
      calls.length = 0;
      answer = (url) =>
        url === "https://bridge.test/exec-tool" || url === "https://bridge.test/chat" || url === "https://bridge.test/health"
          ? new Response(JSON.stringify({ ok: true, output: "ok", session_id: "s1" }), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      const res = await call();
      if (res.status === 403) {
        const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
        assert.notEqual(body.error, "not_your_computer", `${label}: owner refused by the owner gate`);
        assert.notEqual(body.error, "agents_owner_not_set", `${label}: owner refused by the owner gate`);
        assert.notEqual(body.error, "agents_owner_unavailable", `${label}: owner refused by the owner gate`);
      }
    }
    const warm = (await jsonOf(await routes.warmStatus.GET())).body as { reason?: string };
    assert.notEqual(warm.reason, "not_your_computer", "warm-status: owner refused by the owner gate");
    assert.notEqual(warm.reason, "agents_owner_not_set", "warm-status: owner refused by the owner gate");
    assert.notEqual(warm.reason, "agents_owner_unavailable", "warm-status: owner refused by the owner gate");
  });

  if (failures > 0) {
    console.log(`bridge-owner-gate: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("bridge-owner-gate: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
