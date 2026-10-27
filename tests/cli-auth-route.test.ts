/**
 * Exact-computer CLI authentication contract.
 *
 * The browser may request only one allowlisted vendor login for one approved
 * pairing owned by the signed-in person. The route queues a structured auth
 * job; it never accepts or forwards a shell command.
 *
 * Run: node --conditions=react-server --import tsx tests/cli-auth-route.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";

const ROOT = process.cwd();
const dbFile = join(mkdtempSync(join(tmpdir(), "cli-auth-route-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "cli-auth-route-test-secret-32-chars";
for (const key of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY"]) {
  delete process.env[key];
}

function stub(request: string, exports: Record<string, unknown>) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, path: dirname(path), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

stub("next/headers", {
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});

const TENANT = "tenant-auth-a";
const OTHER_TENANT = "tenant-auth-b";
const USER = "user-auth-a";
const OTHER_USER = "user-auth-b";
const STAMP = "2026-10-12T08:00:00.000Z";

type Session = {
  authUserId: string;
  profileId: string;
  tenantId: string;
  teamRole: "owner" | "member";
  isOwner: boolean;
  adminAccess: boolean;
} | null;

let session: Session = {
  authUserId: USER,
  profileId: "profile-auth-a",
  tenantId: TENANT,
  teamRole: "member",
  isOwner: false,
  adminAccess: false,
};
stub("../lib/team", { getSessionContext: async () => session });

const db: Client = createClient({ url: `file:${dbFile}` });

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buffer: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("--")) continue;
    buffer.push(line);
    if (stripped.endsWith(";")) {
      out.push(buffer.join("\n").trim().replace(/;$/, "").trim());
      buffer = [];
    }
  }
  const tail = buffer.join("\n").trim().replace(/;$/, "").trim();
  if (tail) out.push(tail);
  return out;
}

async function createSchema() {
  await db.executeMultiple(`
    CREATE TABLE agent_model_config (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, agent_key TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, updated_at TEXT
    );
    CREATE TABLE bridge_pairings (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, label TEXT,
      bridge_token_hash TEXT NOT NULL, revoked_at TEXT, claim_enabled_at TEXT,
      claim_enabled_by TEXT, paired_via TEXT, claim_protocols TEXT, created_at TEXT
    );
    CREATE TABLE dept_chat_runs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT);
    INSERT INTO tenants (id, slug) VALUES ('tenant-auth-a', 'oasis'), ('tenant-auth-b', 'acme-client');
  `);
  const migration = readFileSync(join(ROOT, "database", "turso", "bravo__215_ai_engine_pairing_runtime.sql"), "utf8");
  for (const statement of splitStatements(migration)) await db.execute(statement);
}

async function addPairing(input: {
  id: string;
  tenantId?: string;
  userId?: string;
  approved?: boolean;
  revoked?: boolean;
  pairedVia?: "pair_code" | "hmac" | "signup_secret" | null;
  protocols?: string[];
}) {
  await db.execute({
    sql: `INSERT INTO bridge_pairings
            (id, tenant_id, user_id, label, bridge_token_hash, revoked_at, claim_enabled_at, claim_enabled_by, paired_via, claim_protocols, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.tenantId ?? TENANT,
      input.userId ?? USER,
      `${input.id} computer`,
      `hash-${input.id}`,
      input.revoked ? STAMP : null,
      input.approved === false ? null : STAMP,
      input.approved === false ? null : input.userId ?? USER,
      input.pairedVia === undefined ? "pair_code" : input.pairedVia,
      JSON.stringify(input.protocols ?? ["runtime_action_v1"]),
      STAMP,
    ],
  });
}

function request(body: unknown): Request {
  return new Request("https://oasisai.work/api/bridge/cli-auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json(response: Response) {
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

let passed = 0;
let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    console.log(`  FAIL  ${name}\n        ${detail.split("\n").slice(0, 10).join("\n        ")}`);
  }
}

async function main() {
  await createSchema();
  const route = await import("../app/api/bridge/cli-auth/route");
  console.log("cli-auth-route:");

  await check("requires a signed-in session and a strict provider + pairing_id body", async () => {
    session = null;
    assert.equal((await json(await route.POST(request({ provider: "codex", pairing_id: "pair-ready" })))).status, 401);
    session = { authUserId: USER, profileId: "profile-auth-a", tenantId: TENANT, teamRole: "member", isOwner: false, adminAccess: false };

    const missing = await json(await route.POST(request({ provider: "codex" })));
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "invalid_pairing_id");
    const injected = await json(await route.POST(request({ provider: "codex", pairing_id: "pair-ready", command: "whoami" })));
    assert.equal(injected.status, 400);
    assert.equal(injected.body.error, "unexpected_field");
  });

  await check("fails closed for another user, tenant, revoked, unapproved, or old-protocol pairing", async () => {
    await addPairing({ id: "pair-other-user", userId: OTHER_USER });
    await addPairing({ id: "pair-other-tenant", tenantId: OTHER_TENANT });
    await addPairing({ id: "pair-revoked", revoked: true });
    await addPairing({ id: "pair-unapproved", approved: false });
    await addPairing({ id: "pair-signup-secret", pairedVia: "signup_secret" });
    await addPairing({ id: "pair-old-protocol", protocols: ["department_task_v1"] });

    for (const id of ["pair-other-user", "pair-other-tenant", "pair-revoked"]) {
      const result = await json(await route.POST(request({ provider: "codex", pairing_id: id })));
      assert.equal(result.status, 404, `${id}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.error, "pairing_not_found");
    }
    const unapproved = await json(await route.POST(request({ provider: "codex", pairing_id: "pair-unapproved" })));
    assert.equal(unapproved.status, 409);
    assert.equal(unapproved.body.error, "pairing_not_approved");
    const signupSecret = await json(await route.POST(request({ provider: "codex", pairing_id: "pair-signup-secret" })));
    assert.equal(signupSecret.status, 409);
    assert.equal(signupSecret.body.error, "pairing_not_approved");
    const old = await json(await route.POST(request({ provider: "codex", pairing_id: "pair-old-protocol" })));
    assert.equal(old.status, 409);
    assert.equal(old.body.error, "connector_update_required");
  });

  await check("deduplicates active Codex auth, then lets an explicit reconnect start a fresh login", async () => {
    await addPairing({ id: "pair-codex" });
    const result = await json(await route.POST(request({ provider: "codex", pairing_id: "pair-codex" })));
    assert.equal(result.status, 202, JSON.stringify(result.body));
    assert.equal(result.body.ok, true);
    assert.equal(result.body.command, "codex login");
    assert.match(String(result.body.instructions), /selected computer/i);
    assert.match(String(result.body.job_id), /^[0-9a-f-]{36}$/i);

    const rows = await db.execute({
      sql: `SELECT pairing_id, tenant_id, user_id, action, engine_kind, engine_name, prompt, status
              FROM bridge_runtime_jobs WHERE id = ?`,
      args: [String(result.body.job_id)],
    });
    assert.equal(rows.rows.length, 1);
    assert.deepEqual(
      [
        rows.rows[0].pairing_id,
        rows.rows[0].tenant_id,
        rows.rows[0].user_id,
        rows.rows[0].action,
        rows.rows[0].engine_kind,
        rows.rows[0].engine_name,
        rows.rows[0].prompt,
        rows.rows[0].status,
      ],
      ["pair-codex", TENANT, USER, "auth", "cli", "codex", null, "queued"],
    );
    const retry = await json(await route.POST(request({ provider: "codex", pairing_id: "pair-codex" })));
    assert.equal(retry.status, 202);
    assert.equal(retry.body.job_id, result.body.job_id, "a browser retry must reuse the queued operation, not a UUID-created duplicate");
    assert.equal(
      Number((await db.execute({ sql: "SELECT count(*) AS n FROM bridge_runtime_jobs WHERE pairing_id = ? AND action = 'auth' AND engine_name = 'codex'", args: ["pair-codex"] })).rows[0].n),
      1,
    );
    await db.execute({
      sql: "UPDATE bridge_runtime_jobs SET status = 'completed', result_code = 'auth_ok', result_json = ?, finished_at = ?, updated_at = ? WHERE id = ?",
      args: [JSON.stringify({ authenticated: true }), new Date().toISOString(), new Date().toISOString(), String(result.body.job_id)],
    });
    const recent = await json(await route.POST(request({ provider: "codex", pairing_id: "pair-codex" })));
    assert.notEqual(recent.body.job_id, result.body.job_id, "a finished sign-in is audit history; a later explicit Reconnect starts fresh work");
    assert.equal(recent.status, 202);
    assert.equal(
      Number((await db.execute({ sql: "SELECT count(*) AS n FROM bridge_runtime_jobs WHERE pairing_id = ? AND action = 'auth' AND engine_name = 'codex'", args: ["pair-codex"] })).rows[0].n),
      2,
    );
  });

  await check("queues Claude with the real interactive flow instructions", async () => {
    await addPairing({ id: "pair-claude" });
    const result = await json(await route.POST(request({ provider: "claude", pairing_id: "pair-claude" })));
    assert.equal(result.status, 202, JSON.stringify(result.body));
    assert.equal(result.body.command, "claude");
    assert.match(String(result.body.instructions), /\/login/);
    const row = await db.execute({ sql: "SELECT pairing_id, engine_name FROM bridge_runtime_jobs WHERE id = ?", args: [String(result.body.job_id)] });
    assert.deepEqual([row.rows[0].pairing_id, row.rows[0].engine_name], ["pair-claude", "claude"]);
  });

  await check("OpenCode sign-in is queued on that computer with its terminal command", async () => {
    await addPairing({ id: "pair-opencode" });
    const result = await json(await route.POST(request({ provider: "opencode", pairing_id: "pair-opencode" })));
    assert.equal(result.status, 202, JSON.stringify(result.body));
    assert.equal(result.body.command, "opencode auth login");
    assert.match(String(result.body.instructions), /Moonshot AI/);
    const row = await db.execute({ sql: "SELECT pairing_id, engine_name FROM bridge_runtime_jobs WHERE id = ?", args: [String(result.body.job_id)] });
    assert.deepEqual([row.rows[0].pairing_id, row.rows[0].engine_name], ["pair-opencode", "opencode"]);
  });

  await check("a client workspace cannot queue a Codex or OpenCode sign-in (the rollout gate, Codex review of #758)", async () => {
    await db.execute("UPDATE tenants SET slug = 'acme-client' WHERE id = 'tenant-auth-a'");
    try {
      await addPairing({ id: "pair-client-oc" });
      const before = Number((await db.execute("SELECT count(*) AS n FROM bridge_runtime_jobs")).rows[0].n);
      for (const provider of ["opencode", "codex"]) {
        const result = await json(await route.POST(request({ provider, pairing_id: "pair-client-oc" })));
        assert.equal(result.status, 409, JSON.stringify(result.body));
        assert.equal(result.body.error, "codex_oasis_rollout_only");
      }
      const after = Number((await db.execute("SELECT count(*) AS n FROM bridge_runtime_jobs")).rows[0].n);
      assert.equal(after, before, "nothing queued");
    } finally {
      await db.execute("UPDATE tenants SET slug = 'oasis' WHERE id = 'tenant-auth-a'");
    }
  });

  await check("Gemini CLI was removed: a sign-in for it is refused and queues no job", async () => {
    await addPairing({ id: "pair-gemini" });
    const before = Number((await db.execute("SELECT count(*) AS n FROM bridge_runtime_jobs")).rows[0].n);
    const result = await json(await route.POST(request({ provider: "gemini", pairing_id: "pair-gemini" })));
    const after = Number((await db.execute("SELECT count(*) AS n FROM bridge_runtime_jobs")).rows[0].n);
    assert.equal(result.status >= 400 && result.status < 500, true, JSON.stringify(result.body));
    assert.equal(after, before);
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
