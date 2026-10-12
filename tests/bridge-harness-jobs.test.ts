/**
 * Exact-pairing coding-harness pull contract.
 * Run: node --conditions=react-server --import tsx tests/bridge-harness-jobs.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import { NextRequest } from "next/server";

const ROOT = process.cwd();
const dbFile = join(mkdtempSync(join(tmpdir(), "bridge-harness-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "bridge-harness-session-secret-at-least-32-characters";
for (const key of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY", "OASIS_RUN_TOKEN_KEY"]) delete process.env[key];

function stub(request: string, exports: Record<string, unknown>) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, path: dirname(path), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
let sessionCookie: string | undefined;
stub("next/headers", {
  cookies: async () => ({
    get: (name: string) => (name === "oasis_session" && sessionCookie ? { name, value: sessionCookie } : undefined),
    getAll: () => (sessionCookie ? [{ name: "oasis_session", value: sessionCookie }] : []),
  }),
  headers: async () => new Headers(),
});
stub("next/navigation", { notFound: () => { throw new Error("not_found"); }, redirect: (url: string) => { throw new Error(url); } });

const db = createClient({ url: `file:${dbFile}` });
const TENANT = "tenant-harness";
const USER = "user-harness";
const OTHER = "user-other";
const NOW = "2026-10-12T10:00:00.000Z";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function statements(sql: string): string[] {
  const out: string[] = [];
  let buffer: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("--")) continue;
    buffer.push(line);
    if (line.trim().endsWith(";")) {
      out.push(buffer.join("\n").replace(/;\s*$/, ""));
      buffer = [];
    }
  }
  return out;
}

async function setup() {
  await db.executeMultiple(`
    CREATE TABLE bridge_pairings (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, label TEXT,
      bridge_token_hash TEXT NOT NULL, previous_token_hash TEXT, token_rotated_at TEXT,
      revoked_at TEXT, scope TEXT, paired_via TEXT, claim_enabled_at TEXT,
      claim_enabled_by TEXT, claim_protocols TEXT, claim_state_at TEXT,
      claim_capacity INTEGER, claim_in_flight INTEGER, claim_blocked_reason TEXT,
      created_at TEXT
    );
    CREATE TABLE user_profiles (
      id TEXT PRIMARY KEY, tenant_id TEXT, auth_user_id TEXT, email TEXT,
      team_role TEXT, is_owner INTEGER, admin_access INTEGER, deactivated_at TEXT,
      onboarding_completed_at TEXT, updated_at TEXT
    );
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT);
    CREATE TABLE _supabase_auth_users (id TEXT PRIMARY KEY, email TEXT, banned_until TEXT, deleted_at TEXT, session_version INTEGER);
    CREATE TABLE workspace_agents_owner (tenant_id TEXT PRIMARY KEY, auth_user_id TEXT, revoked_at TEXT);
    CREATE TABLE agent_events (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), event_type TEXT, publisher_agent TEXT, severity TEXT, payload TEXT, correlation_id TEXT, created_at TEXT);
    CREATE TABLE bridge_runtime_jobs (id TEXT PRIMARY KEY, tenant_id TEXT, pairing_id TEXT, status TEXT);
    CREATE TABLE dept_chat_runs (id TEXT PRIMARY KEY, tenant_id TEXT, target_pairing_id TEXT, claimed_pairing_id TEXT, status TEXT);
  `);
  const migration = readFileSync(join(ROOT, "database", "turso", "bravo__216_bridge_harness_pull.sql"), "utf8");
  for (const statement of statements(migration)) await db.execute(statement);
  await db.execute({ sql: "INSERT INTO user_profiles VALUES ('profile-h', ?, ?, 'h@example.test', 'owner', 1, 1, NULL, ?, ?)", args: [TENANT, USER, NOW, NOW] });
  await db.execute({ sql: "INSERT INTO _supabase_auth_users VALUES (?, 'h@example.test', NULL, NULL, 0)", args: [USER] });
  await db.execute({ sql: "INSERT INTO user_profiles VALUES ('profile-o', ?, ?, 'o@example.test', 'member', 0, 0, NULL, ?, ?)", args: [TENANT, OTHER, NOW, NOW] });
  await db.execute({ sql: "INSERT INTO _supabase_auth_users VALUES (?, 'o@example.test', NULL, NULL, 0)", args: [OTHER] });
  await db.execute({ sql: "INSERT INTO tenants VALUES (?, 'harness-workspace')", args: [TENANT] });
}

async function pairing(userId: string) {
  const id = `pair-${randomUUID()}`;
  const token = `oab_${randomUUID()}`;
  const claimStateAt = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO bridge_pairings
      (id, tenant_id, user_id, label, bridge_token_hash, scope, paired_via, claim_enabled_at, claim_enabled_by,
       claim_protocols, claim_state_at, claim_capacity, claim_in_flight, claim_blocked_reason, created_at)
      VALUES (?, ?, ?, 'Laptop', ?, 'connector', 'pair_code', ?, ?, ?, ?, 1, 0, NULL, ?)`,
    args: [id, TENANT, userId, sha256(token), NOW, userId, JSON.stringify(["coding_harness_task_v1"]), claimStateAt, NOW],
  });
  return { id, token };
}

function post(path: string, token: string | null, body: unknown) {
  return new NextRequest(`https://oasisai.work${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

let failures = 0;
let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
  try { await run(); passed += 1; console.log(`  ok    ${name}`); }
  catch (error) { failures += 1; console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.stack : String(error)}`); }
}

async function main() {
  await setup();
  const harness = await import("../lib/bridge/harness-jobs");
  const claimRoute = await import("../app/api/bridge/harness-jobs/claim/route");
  const eventsRoute = await import("../app/api/bridge/harness-jobs/[job_id]/events/route");
  const heartbeatRoute = await import("../app/api/bridge/harness-jobs/[job_id]/heartbeat/route");
  console.log("bridge-harness-jobs:");

  await check("claim rejects top-level primitives and unknown fields before dereferencing", async () => {
    const computer = await pairing(USER);
    for (const value of [null, [], "text", 7, true, { protocol: harness.HARNESS_PROTOCOL, claim_id: "shape", capacity: 1, wait_ms: 0, command: "whoami" }]) {
      const response = await claimRoute.POST(post("/api/bridge/harness-jobs/claim", computer.token, value));
      assert.equal(response.status, 400, JSON.stringify(value));
      assert.equal(((await response.json()) as { error?: string }).error, "invalid_body");
    }
  });

  await check("harness claim long-polls are throttled independently per pairing and protocol", async () => {
    const computer = await pairing(USER);
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await claimRoute.POST(post("/api/bridge/harness-jobs/claim", computer.token, {
        protocol: harness.HARNESS_PROTOCOL,
        claim_id: `rate-harness-${index}`,
        capacity: 1,
        wait_ms: 0,
      }));
      statuses.push(response.status);
      if (index === 3) assert.equal(((await response.json()) as { error?: string }).error, "claim_too_fast");
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  });

  await check("migration has tenant-leading claim/event indexes", async () => {
    const indexes = (await db.execute("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name LIKE 'bridge_harness%'")).rows;
    assert.ok(indexes.some((row) => String(row.name) === "bridge_harness_jobs_claim_idx"));
    for (const row of indexes) if (String(row.sql || "").includes("CREATE INDEX")) assert.match(String(row.sql), /\(tenant_id,/);
  });

  await check("missing chat mode is read-only and malformed authority is rejected", () => {
    assert.deepEqual(harness.parseHarnessChatMode(undefined), { ok: true, value: "plan" });
    assert.deepEqual(harness.parseHarnessChatMode("plan"), { ok: true, value: "plan" });
    assert.deepEqual(harness.parseHarnessChatMode("build"), { ok: true, value: "build" });
    assert.deepEqual(harness.parseHarnessChatMode("BUILD"), { ok: false, code: "invalid_chat_mode" });
    assert.deepEqual(harness.parseHarnessChatMode(null), { ok: false, code: "invalid_chat_mode" });
  });

  await check("only an explicit Codex build task may request repo-scoped writes", async () => {
    const computer = await pairing(USER);
    const base = {
      tenantId: TENANT, userId: USER, pairingId: computer.id, agentKey: "bravo",
      pairingOwnerId: USER,
      chatMode: "build" as const, repoWrites: true,
      request: { messages: [{ role: "user" as const, content: "Edit the test." }], attachments: [], session_id: null, tab_id: "tab-1", disallowed_tools: [], fallback_policy: "none" as const },
    };
    assert.equal((await harness.enqueueHarnessJob({ ...base, engine: { kind: "cli", name: "claude" } })).ok, false);
    assert.equal((await harness.enqueueHarnessJob({ ...base, engine: { kind: "local", name: "ollama/llama3.3" } })).ok, false);
    const queued = await harness.enqueueHarnessJob({ ...base, engine: { kind: "cli", name: "codex" } });
    assert.equal(queued.ok, true);
  });

  await check("only the targeted pairing can claim; payload contains an agent-root scope and no path/command", async () => {
    const target = await pairing(USER);
    const other = await pairing(OTHER);
    const queued = await harness.enqueueHarnessJob({
      tenantId: TENANT, userId: USER, pairingOwnerId: USER, pairingId: target.id, agentKey: "bravo",
      engine: { kind: "cli", name: "codex" }, chatMode: "build", repoWrites: true,
      request: { messages: [{ role: "user", content: "Implement it." }], attachments: [], session_id: null, tab_id: "tab-2", disallowed_tools: [], fallback_policy: "none" },
    });
    assert.equal(queued.ok, true);
    const wrong = await claimRoute.POST(post("/api/bridge/harness-jobs/claim", other.token, { protocol: harness.HARNESS_PROTOCOL, claim_id: "wrong", capacity: 1, wait_ms: 0 }));
    assert.equal((await wrong.json()).job, null);
    const claimed = await claimRoute.POST(post("/api/bridge/harness-jobs/claim", target.token, { protocol: harness.HARNESS_PROTOCOL, claim_id: "right", capacity: 1, wait_ms: 0 }));
    assert.equal(claimed.status, 200);
    const body = await claimed.json() as { job: Record<string, unknown> };
    assert.deepEqual(body.job.sandbox, { mode: "workspace_write", repo_writes: true });
    assert.deepEqual(body.job.task, { kind: "coding", repo_scope: { kind: "agent_root", agent: "bravo" } });
    assert.equal(body.job.events_url, `/api/bridge/harness-jobs/${body.job.job_id}/events`);
    assert.equal(body.job.heartbeat_url, `/api/bridge/harness-jobs/${body.job.job_id}/heartbeat`);
    const serialized = JSON.stringify(body.job);
    assert.doesNotMatch(serialized, /(?:command|cwd|repo_path|shell)/i);

    const jobId = String(body.job.job_id);
    const token = String(body.job.run_token);
    const heartbeat = await heartbeatRoute.POST(post(`/api/bridge/harness-jobs/${jobId}/heartbeat`, token, {}), { params: Promise.resolve({ job_id: jobId }) });
    assert.equal(heartbeat.status, 200);
    const events = await eventsRoute.POST(post(`/api/bridge/harness-jobs/${jobId}/events`, token, { events: [
      { seq: 1, type: "tool_result", data: { name: "Bash", output: "SECRET_OUTPUT", tool_use_id: "t1" } },
      { seq: 2, type: "delta", data: { text: "Done." } },
      { seq: 3, type: "done", data: {} },
    ] }), { params: Promise.resolve({ job_id: jobId }) });
    assert.equal(events.status, 200);
    const stored = (await db.execute({ sql: "SELECT data_json FROM bridge_harness_job_events WHERE job_id = ? AND seq = 1", args: [jobId] })).rows[0];
    assert.doesNotMatch(String(stored.data_json), /SECRET_OUTPUT/);
    assert.equal((await db.execute({ sql: "SELECT status FROM bridge_harness_jobs WHERE id = ?", args: [jobId] })).rows[0].status, "completed");
  });

  await check("a signed event credential cannot write a different job", async () => {
    const target = await pairing(USER);
    const otherTarget = await pairing(USER);
    const make = (pairingId: string) => harness.enqueueHarnessJob({
      tenantId: TENANT, userId: USER, pairingOwnerId: USER, pairingId, agentKey: "bravo",
      engine: { kind: "cli", name: "codex" }, chatMode: "plan" as const, repoWrites: false,
      request: { messages: [{ role: "user" as const, content: "Read only." }], attachments: [], session_id: null, tab_id: null, disallowed_tools: [], fallback_policy: "none" as const },
    });
    const one = await make(target.id); const two = await make(otherTarget.id);
    assert.ok(one.ok && two.ok);
    const claimed = await claimRoute.POST(post("/api/bridge/harness-jobs/claim", target.token, { protocol: harness.HARNESS_PROTOCOL, claim_id: "signed-one", capacity: 1, wait_ms: 0 }));
    const body = await claimed.json() as { job: Record<string, unknown> };
    const refused = await eventsRoute.POST(post(`/api/bridge/harness-jobs/${two.job.id}/events`, String(body.job.run_token), { events: [{ seq: 1, type: "done", data: {} }] }), { params: Promise.resolve({ job_id: two.job.id }) });
    assert.equal(refused.status, 401);
  });

  await check("pairing-owner deactivation stops post-claim heartbeat and event producers", async () => {
    const claimWorkspaceJob = async (claimId: string) => {
      const ownerComputer = await pairing(USER);
      const queued = await harness.enqueueHarnessJob({
        tenantId: TENANT,
        userId: OTHER,
        pairingOwnerId: USER,
        pairingId: ownerComputer.id,
        agentKey: "bravo",
        engine: { kind: "cli", name: "codex" },
        chatMode: "plan",
        repoWrites: false,
        request: {
          messages: [{ role: "user", content: "Owner-gated producer." }],
          attachments: [],
          session_id: null,
          tab_id: null,
          disallowed_tools: [],
          fallback_policy: "none",
        },
      });
      assert.ok(queued.ok);
      const response = await claimRoute.POST(post("/api/bridge/harness-jobs/claim", ownerComputer.token, {
        protocol: harness.HARNESS_PROTOCOL,
        claim_id: claimId,
        capacity: 1,
        wait_ms: 0,
      }));
      assert.equal(response.status, 200);
      const body = await response.json() as { job: Record<string, unknown> };
      return { jobId: queued.job.id, token: String(body.job.run_token) };
    };

    try {
      const heartbeatJob = await claimWorkspaceJob("owner-revoked-heartbeat");
      const before = (await db.execute({
        sql: "SELECT heartbeat_at FROM bridge_harness_jobs WHERE tenant_id = ? AND id = ?",
        args: [TENANT, heartbeatJob.jobId],
      })).rows[0].heartbeat_at;
      await db.execute({
        sql: "UPDATE user_profiles SET deactivated_at = ? WHERE tenant_id = ? AND auth_user_id = ?",
        args: [NOW, TENANT, USER],
      });
      const heartbeat = await heartbeatRoute.POST(
        post(`/api/bridge/harness-jobs/${heartbeatJob.jobId}/heartbeat`, heartbeatJob.token, {}),
        { params: Promise.resolve({ job_id: heartbeatJob.jobId }) },
      );
      assert.equal(heartbeat.status, 403);
      assert.equal((await heartbeat.json()).error, "pairing_owner_inactive");
      const heartbeatStored = (await db.execute({
        sql: "SELECT status, error_code, heartbeat_at FROM bridge_harness_jobs WHERE tenant_id = ? AND id = ?",
        args: [TENANT, heartbeatJob.jobId],
      })).rows[0];
      assert.equal(heartbeatStored.status, "failed");
      assert.equal(heartbeatStored.error_code, "pairing_owner_seat_inactive");
      assert.equal(heartbeatStored.heartbeat_at, before);

      await db.execute({
        sql: "UPDATE user_profiles SET deactivated_at = NULL WHERE tenant_id = ? AND auth_user_id = ?",
        args: [TENANT, USER],
      });
      const eventsJob = await claimWorkspaceJob("owner-revoked-events");
      await db.execute({
        sql: "UPDATE user_profiles SET deactivated_at = ? WHERE tenant_id = ? AND auth_user_id = ?",
        args: [NOW, TENANT, USER],
      });
      const events = await eventsRoute.POST(
        post(`/api/bridge/harness-jobs/${eventsJob.jobId}/events`, eventsJob.token, {
          events: [{ seq: 1, type: "delta", data: { text: "must not persist" } }],
        }),
        { params: Promise.resolve({ job_id: eventsJob.jobId }) },
      );
      assert.equal(events.status, 403);
      assert.equal((await events.json()).error, "pairing_owner_inactive");
      assert.equal(Number((await db.execute({
        sql: "SELECT COUNT(*) AS n FROM bridge_harness_job_events WHERE tenant_id = ? AND job_id = ?",
        args: [TENANT, eventsJob.jobId],
      })).rows[0].n), 0);
    } finally {
      await db.execute({
        sql: "UPDATE user_profiles SET deactivated_at = NULL WHERE tenant_id = ? AND auth_user_id = ?",
        args: [TENANT, USER],
      });
    }
  });

  await check("workspace inheritance may target the agents-owner pairing while personal setup may not", async () => {
    const ownerComputer = await pairing(USER);
    const workspace = await harness.enqueueHarnessJob({
      tenantId: TENANT,
      userId: OTHER,
      pairingOwnerId: USER,
      pairingId: ownerComputer.id,
      agentKey: "bravo",
      engine: { kind: "cli", name: "codex" },
      chatMode: "plan",
      repoWrites: false,
      request: { messages: [{ role: "user", content: "Inherited workspace turn." }], attachments: [], session_id: null, tab_id: null, disallowed_tools: [], fallback_policy: "none" },
    });
    assert.ok(workspace.ok);
    const claimed = await claimRoute.POST(post("/api/bridge/harness-jobs/claim", ownerComputer.token, { protocol: harness.HARNESS_PROTOCOL, claim_id: "workspace-owner", capacity: 1, wait_ms: 0 }));
    assert.equal(claimed.status, 200);
    assert.equal(String(((await claimed.json()) as { job: Record<string, unknown> }).job.job_id), workspace.job.id);

    const personalCrossUser = await harness.enqueueHarnessJob({
      tenantId: TENANT,
      userId: OTHER,
      pairingOwnerId: OTHER,
      pairingId: ownerComputer.id,
      agentKey: "bravo",
      engine: { kind: "cli", name: "codex" },
      chatMode: "plan",
      repoWrites: false,
      request: { messages: [{ role: "user", content: "Wrong personal computer." }], attachments: [], session_id: null, tab_id: null, disallowed_tools: [], fallback_policy: "none" },
    });
    assert.deepEqual(personalCrossUser, { ok: false, code: "pairing_unavailable" });
  });

  await check("pairing-owner deactivation during a long poll prevents payload disclosure", async () => {
    const ownerComputer = await pairing(USER);
    const realSetTimeout = globalThis.setTimeout;
    let markPollStarted!: () => void;
    let releasePoll!: () => void;
    const pollStarted = new Promise<void>((resolve) => { markPollStarted = resolve; });
    const pollRelease = new Promise<void>((resolve) => { releasePoll = resolve; });
    let intercepted = false;
    globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (!intercepted && delay === 1_000) {
        intercepted = true;
        markPollStarted();
        void pollRelease.then(() => handler(...args));
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(handler, delay, ...args);
    }) as typeof setTimeout;

    let queuedId = "";
    try {
      const responsePromise = claimRoute.POST(post("/api/bridge/harness-jobs/claim", ownerComputer.token, {
        protocol: harness.HARNESS_PROTOCOL,
        claim_id: "owner-removed-during-poll",
        capacity: 1,
        wait_ms: 3_000,
      }));
      await pollStarted;
      const queued = await harness.enqueueHarnessJob({
        tenantId: TENANT,
        userId: OTHER,
        pairingOwnerId: USER,
        pairingId: ownerComputer.id,
        agentKey: "bravo",
        engine: { kind: "cli", name: "codex" },
        chatMode: "plan",
        repoWrites: false,
        request: {
          messages: [{ role: "user", content: "SECRET_OWNER_REMOVED_DURING_POLL" }],
          attachments: [],
          session_id: null,
          tab_id: null,
          disallowed_tools: [],
          fallback_policy: "none",
        },
      });
      assert.ok(queued.ok);
      queuedId = queued.job.id;
      await db.execute({
        sql: "UPDATE user_profiles SET deactivated_at = ? WHERE tenant_id = ? AND auth_user_id = ?",
        args: [NOW, TENANT, USER],
      });
      releasePoll();

      const response = await responsePromise;
      assert.equal(response.status, 403);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.error, "pairing_owner_inactive");
      assert.doesNotMatch(JSON.stringify(body), /SECRET_OWNER_REMOVED_DURING_POLL/);
      const stored = (await db.execute({
        sql: "SELECT status, error_code FROM bridge_harness_jobs WHERE tenant_id = ? AND id = ?",
        args: [TENANT, queuedId],
      })).rows[0];
      assert.equal(stored.status, "failed");
      assert.equal(stored.error_code, "pairing_owner_seat_inactive");
    } finally {
      releasePoll?.();
      globalThis.setTimeout = realSetTimeout;
      await db.execute({
        sql: "UPDATE user_profiles SET deactivated_at = NULL WHERE tenant_id = ? AND auth_user_id = ?",
        args: [TENANT, USER],
      });
    }
  });

  await check("an exact computer already running department or probe work rejects a new harness turn as busy", async () => {
    const target = await pairing(USER);
    const input = {
      tenantId: TENANT,
      userId: USER,
      pairingOwnerId: USER,
      pairingId: target.id,
      agentKey: "bravo",
      engine: { kind: "cli" as const, name: "codex" },
      chatMode: "plan" as const,
      repoWrites: false,
      request: { messages: [{ role: "user" as const, content: "Do not leave this behind busy work." }], attachments: [], session_id: null, tab_id: null, disallowed_tools: [], fallback_policy: "none" as const },
    };

    await db.execute({
      sql: "INSERT INTO dept_chat_runs (id, tenant_id, target_pairing_id, claimed_pairing_id, status) VALUES (?, ?, ?, ?, 'running')",
      args: [`dept-${randomUUID()}`, TENANT, target.id, target.id],
    });
    assert.deepEqual(await harness.enqueueHarnessJob(input), { ok: false, code: "computer_busy" });
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM bridge_harness_jobs WHERE pairing_id = ?", args: [target.id] })).rows[0].n), 0);

    await db.execute({ sql: "DELETE FROM dept_chat_runs WHERE tenant_id = ? AND claimed_pairing_id = ?", args: [TENANT, target.id] });
    await db.execute({
      sql: "INSERT INTO bridge_runtime_jobs (id, tenant_id, pairing_id, status) VALUES (?, ?, ?, 'running')",
      args: [`probe-${randomUUID()}`, TENANT, target.id],
    });
    assert.deepEqual(await harness.enqueueHarnessJob(input), { ok: false, code: "computer_busy" });
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM bridge_harness_jobs WHERE pairing_id = ?", args: [target.id] })).rows[0].n), 0);

    await db.execute({ sql: "DELETE FROM bridge_runtime_jobs WHERE tenant_id = ? AND pairing_id = ?", args: [TENANT, target.id] });
    await db.execute({
      sql: "UPDATE bridge_pairings SET claim_state_at = ?, claim_capacity = 0, claim_in_flight = 1 WHERE tenant_id = ? AND id = ?",
      args: [new Date().toISOString(), TENANT, target.id],
    });
    assert.deepEqual(await harness.enqueueHarnessJob(input), { ok: false, code: "computer_busy" });
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM bridge_harness_jobs WHERE pairing_id = ?", args: [target.id] })).rows[0].n), 0);
  });

  await check("a revoked workspace requester is terminalized before the connector sees its prompt", async () => {
    const ownerComputer = await pairing(USER);
    const queued = await harness.enqueueHarnessJob({
      tenantId: TENANT,
      userId: OTHER,
      pairingOwnerId: USER,
      pairingId: ownerComputer.id,
      agentKey: "bravo",
      engine: { kind: "cli", name: "codex" },
      chatMode: "plan",
      repoWrites: false,
      request: { messages: [{ role: "user", content: "SECRET_REVOKED_MEMBER_PROMPT" }], attachments: [], session_id: null, tab_id: null, disallowed_tools: [], fallback_policy: "none" },
    });
    assert.ok(queued.ok);
    await db.execute({ sql: "UPDATE user_profiles SET deactivated_at = ? WHERE tenant_id = ? AND auth_user_id = ?", args: [NOW, TENANT, OTHER] });

    const response = await claimRoute.POST(post("/api/bridge/harness-jobs/claim", ownerComputer.token, {
      protocol: harness.HARNESS_PROTOCOL,
      claim_id: "revoked-requester",
      capacity: 1,
      wait_ms: 0,
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(body, { ok: true, job: null });
    assert.doesNotMatch(JSON.stringify(body), /SECRET_REVOKED_MEMBER_PROMPT/);

    const stored = (await db.execute({
      sql: "SELECT status, error_code, lease_id, finished_at FROM bridge_harness_jobs WHERE tenant_id = ? AND id = ?",
      args: [TENANT, queued.job.id],
    })).rows[0];
    assert.equal(stored.status, "failed");
    assert.equal(stored.error_code, "requester_seat_inactive");
    assert.ok(stored.lease_id);
    assert.ok(stored.finished_at);

    await db.execute({ sql: "UPDATE user_profiles SET deactivated_at = NULL WHERE tenant_id = ? AND auth_user_id = ?", args: [TENANT, OTHER] });
  });

  await check("browser cancellation closes the job so its connector can no longer heartbeat", async () => {
    const target = await pairing(USER);
    const queued = await harness.enqueueHarnessJob({
      tenantId: TENANT, userId: USER, pairingOwnerId: USER, pairingId: target.id, agentKey: "bravo",
      engine: { kind: "cli", name: "codex" }, chatMode: "build", repoWrites: true,
      request: { messages: [{ role: "user", content: "Make one safe edit." }], attachments: [], session_id: null, tab_id: "cancel-tab", disallowed_tools: [], fallback_policy: "none" },
    });
    assert.ok(queued.ok);
    const claimed = await claimRoute.POST(post("/api/bridge/harness-jobs/claim", target.token, { protocol: harness.HARNESS_PROTOCOL, claim_id: "cancel-me", capacity: 1, wait_ms: 0 }));
    const body = await claimed.json() as { job: Record<string, unknown> };
    assert.equal(await harness.cancelHarnessJob({ tenantId: TENANT, userId: USER, jobId: queued.job.id }), true);
    const heartbeat = await heartbeatRoute.POST(post(`/api/bridge/harness-jobs/${queued.job.id}/heartbeat`, String(body.job.run_token), {}), { params: Promise.resolve({ job_id: queued.job.id }) });
    assert.equal(heartbeat.status, 409);
    assert.equal((await heartbeat.json()).error, "job_not_running");
  });

  await check("workspace API fallback activates only after the exact job was never claimed", async () => {
    const target = await pairing(USER);
    const make = () => harness.enqueueHarnessJob({
      tenantId: TENANT, userId: USER, pairingOwnerId: USER, pairingId: target.id, agentKey: "bravo",
      engine: { kind: "cli" as const, name: "codex" }, chatMode: "plan" as const, repoWrites: false,
      request: {
        messages: [{ role: "user" as const, content: "Use the exact computer first." }], attachments: [],
        session_id: null, tab_id: randomUUID(), disallowed_tools: [], fallback_policy: "workspace_api" as const,
      },
    });
    const unclaimed = await make();
    assert.ok(unclaimed.ok);
    await db.execute({
      sql: "UPDATE bridge_harness_jobs SET status = 'failed', error_code = 'computer_not_answering', finished_at = ?, updated_at = ? WHERE id = ?",
      args: [NOW, NOW, unclaimed.job.id],
    });
    let fallbacks = 0;
    let devices = 0;
    const fallbackText = await new Response(harness.harnessJobStreamWithUnclaimedFallback(unclaimed.job, {
      deviceStream: () => {
        devices += 1;
        return new Response("event: delta\ndata: {\"text\":\"device\"}\n\n").body!;
      },
      fallbackResponse: async () => {
        fallbacks += 1;
        return new Response("event: delta\ndata: {\"text\":\"workspace fallback\"}\n\nevent: done\ndata: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    })).text();
    assert.equal(fallbacks, 1);
    assert.equal(devices, 0);
    assert.match(fallbackText, /workspace fallback/);

    const claimedCandidate = await make();
    assert.ok(claimedCandidate.ok);
    const claimed = await harness.claimHarnessJob({ tenantId: TENANT, pairingId: target.id, claimId: "claimed-no-fallback" });
    assert.ok(claimed);
    const deviceText = await new Response(harness.harnessJobStreamWithUnclaimedFallback(claimedCandidate.job, {
      deviceStream: () => {
        devices += 1;
        return new Response("event: delta\ndata: {\"text\":\"device authoritative\"}\n\nevent: done\ndata: {}\n\n").body!;
      },
      fallbackResponse: async () => {
        fallbacks += 1;
        return new Response(null, { status: 500 });
      },
    })).text();
    assert.equal(fallbacks, 1, "a claimed job can never replay through the API");
    assert.equal(devices, 1);
    assert.match(deviceText, /device authoritative/);
  });

  await check("a terminal harness stream drains every committed event beyond the 100-row page before closing", async () => {
    const target = await pairing(USER);
    const queued = await harness.enqueueHarnessJob({
      tenantId: TENANT, userId: USER, pairingOwnerId: USER, pairingId: target.id, agentKey: "bravo",
      engine: { kind: "cli", name: "codex" }, chatMode: "plan", repoWrites: false,
      request: { messages: [{ role: "user", content: "Stream every frame." }], attachments: [], session_id: null, tab_id: null, disallowed_tools: [], fallback_policy: "none" },
    });
    assert.ok(queued.ok);
    const rows = Array.from({ length: 101 }, (_, index) => ({
      sql: "INSERT INTO bridge_harness_job_events (tenant_id, job_id, seq, event_type, data_json, created_at) VALUES (?, ?, ?, 'delta', ?, ?)",
      args: [TENANT, queued.job.id, index + 1, JSON.stringify({ text: `chunk-${index + 1}` }), NOW],
    }));
    rows.push({
      sql: "INSERT INTO bridge_harness_job_events (tenant_id, job_id, seq, event_type, data_json, created_at) VALUES (?, ?, 102, 'done', '{}', ?)",
      args: [TENANT, queued.job.id, NOW],
    });
    await db.batch(rows, "write");
    await db.execute({
      sql: "UPDATE bridge_harness_jobs SET status = 'completed', finished_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
      args: [NOW, NOW, TENANT, queued.job.id],
    });
    const streamed = await new Response(harness.harnessJobStream(queued.job)).text();
    assert.match(streamed, /chunk-101/);
    assert.equal((streamed.match(/event: done/g) || []).length, 1, "the persisted terminal frame is emitted exactly once");
  });

  await check("the public chat route always pulls the exact pairing and rechecks rollout/readiness", () => {
    const source = readFileSync(join(ROOT, "app", "api", "bridge", "chat", "route.ts"), "utf8");
    const runtimeAvailabilitySource = readFileSync(join(ROOT, "lib", "bridge", "runtime-availability.ts"), "utf8");
    assert.match(source, /authorizeBridgePullActor\(\)/);
    assert.match(source, /parseHarnessChatMode\(clientBody\.chat_mode\)/);
    assert.match(source, /jsonError\(400, parsedChatMode\.code\)/);
    assert.match(source, /enqueueHarnessJob/);
    assert.match(source, /subscriptionRolloutError\(savedRoute\.runtime!, await isOasisWorkspace\(auth\.tenantId\)\)/);
    assert.match(source, /readLatestRuntimeProbeReceipts/);
    assert.match(source, /readEffectiveAgentEngineWithProof/);
    assert.match(source, /savedRuntimeProbeProofReady\(savedProbeProof, savedRoute\.pairingId, runtimeEngine, receipt\)/);
    assert.match(source, /select\("id, user_id, last_seen_at, claim_enabled_at, paired_via, scope, claim_protocols, claim_runtime_state"\)/);
    assert.match(source, /pairingScope === "daemon"/);
    assert.match(source, /jsonError\(409, "agents_owner_only"\)/);
    assert.match(source, /cancelHarnessJob/);
    assert.match(
      runtimeAvailabilitySource,
      /if \(!selected \|\| typeof selected !== "object" \|\| Array\.isArray\(selected\)\) return \{ ok: false, error: "model_not_found" \}/,
      "the shared runtime availability gate must fail closed when the selected local model is absent",
    );
    assert.ok(
      source.indexOf("const runtimeCheck = runtimeAvailability") < source.indexOf("const queued = await enqueueHarnessJob"),
      "an explicit missing local model must fail before any harness row is enqueued",
    );
    assert.ok(
      source.indexOf("const receipts = await readLatestRuntimeProbeReceipts") < source.indexOf("const queued = await enqueueHarnessJob"),
      "the saved version-bound probe gate must run before enqueue",
    );
    assert.ok(
      source.indexOf('pairingScope === "daemon"') < source.indexOf("const queued = await enqueueHarnessJob"),
      "a daemon pairing must pass the agents-owner gate before enqueue",
    );
    assert.doesNotMatch(source, /fetch\(`\$\{auth\.target\.baseUrl\}/);
    assert.doesNotMatch(source, /const useExactPairingPull/);
    assert.match(source, /mintEngineFallbackDispatch/);
    assert.match(source, /harnessJobStreamWithUnclaimedFallback/);
    assert.match(source, /liveSeat\(auth\.tenantId, auth\.userId\)/, "delayed fallback rechecks the requesting member before spending");
    assert.match(source, /liveSeat\(auth\.tenantId, pairingOwnerId\)/, "fallback rechecks the pairing owner's seat before spending");
    const widget = readFileSync(join(ROOT, "components", "ChatWidget.tsx"), "utf8");
    assert.match(widget, /effectiveRuntime\?\.pairingId === harnessRoute\.pairingId/);
    assert.match(widget, /explicitWorkspaceFallback/);
    assert.match(widget, /const lastEngineKeyRef = useRef<string \| null>\(null\)/);
    assert.match(widget, /if \(!engineChanged\) return;\s*setSessionId\(null\)/, "a routine readiness refresh must preserve the active session and CLI resume id");
    assert.doesNotMatch(widget, /\/api\/bridge\/(?:prewarm|chat-reset)/);
  });

  await check("a saved coding-harness probe remains valid beyond ten minutes without letting heartbeat-only state establish readiness", async () => {
    const { savedRuntimeProbeProofReady } = await import("../lib/ai/agent-engine-store");
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    const engine = { kind: "cli" as const, name: "codex" };
    const proof = {
      jobId: "probe-harness-codex",
      pairingId: "pair-harness-codex",
      engine,
      engineVersion: "engine-v11",
      verifiedAt: old,
    };
    assert.equal(
      savedRuntimeProbeProofReady(proof, proof.pairingId, engine, { pairingId: proof.pairingId, engine, ready: true, finishedAt: old }),
      true,
      "a normal harness POST must not expire a successfully saved engine after ten minutes",
    );
    assert.equal(savedRuntimeProbeProofReady(null, proof.pairingId, engine), false, "heartbeat-only state has no durable saved proof");
  });

  await check("the pull actor gate requires a live seat before enqueue", () => {
    const source = readFileSync(join(ROOT, "lib", "bridge-proxy.ts"), "utf8");
    const gate = source.slice(source.indexOf("export async function authorizeBridgePullActor"), source.indexOf("export async function authorizeBridgeActor"));
    assert.match(gate, /resolveActiveProfileForUser\(user\)/);
    assert.doesNotMatch(gate, /from\("user_profiles"\)[\s\S]*?maybeSingle\(\)/);
    assert.match(gate, /liveSeat\(tenantId, user\.id\)/);
    assert.match(gate, /status: 403, error: "seat_inactive"/);
  });

  await check("the coding-harness pull actor resolves duplicate profiles without stale-role elevation", async () => {
    const { signSession } = await import("../lib/turso-auth");
    await db.execute({
      sql: "INSERT INTO user_profiles VALUES ('profile-o-stale-admin', ?, ?, 'o@example.test', 'admin', 0, 0, NULL, ?, '2026-10-11T10:00:00.000Z')",
      args: [TENANT, OTHER, NOW],
    });
    sessionCookie = signSession({
      sub: OTHER,
      email: "o@example.test",
      exp: Math.floor(Date.now() / 1000) + 3_600,
      ver: 0,
    });
    try {
      const { authorizeBridgePullActor } = await import("../lib/bridge-proxy");
      const authorized = await authorizeBridgePullActor();
      assert.equal(authorized.ok, true);
      if (!authorized.ok) return;
      assert.equal(authorized.tenantId, TENANT);
      assert.equal(authorized.tenantSlug, "harness-workspace");
      assert.equal(authorized.userId, OTHER);
      assert.equal(authorized.teamRole, "member", "the newer canonical member row must beat a stale admin duplicate");
      assert.equal(authorized.isOperator, false);
    } finally {
      sessionCookie = undefined;
    }
  });

  await check("a deactivated requester gets 403 and queues zero harness rows", async () => {
    const { signSession } = await import("../lib/turso-auth");
    sessionCookie = signSession({
      sub: OTHER,
      email: "o@example.test",
      exp: Math.floor(Date.now() / 1000) + 3_600,
      ver: 0,
    });
    await db.execute({ sql: "UPDATE user_profiles SET deactivated_at = ? WHERE tenant_id = ? AND auth_user_id = ?", args: [NOW, TENANT, OTHER] });
    const before = Number((await db.execute("SELECT count(*) AS n FROM bridge_harness_jobs")).rows[0].n);
    try {
      const chatRoute = await import("../app/api/bridge/chat/route");
      const response = await chatRoute.POST(new NextRequest("https://oasisai.work/api/bridge/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "bravo", messages: [{ role: "user", content: "must not queue" }] }),
      }));
      assert.equal(response.status, 403);
      assert.equal(((await response.json()) as { error?: string }).error, "seat_inactive");
      const after = Number((await db.execute("SELECT count(*) AS n FROM bridge_harness_jobs")).rows[0].n);
      assert.equal(after, before);
    } finally {
      await db.execute({ sql: "UPDATE user_profiles SET deactivated_at = NULL WHERE tenant_id = ? AND auth_user_id = ?", args: [TENANT, OTHER] });
      sessionCookie = undefined;
    }
  });

  console.log(`bridge-harness-jobs: ${passed} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

void main();
