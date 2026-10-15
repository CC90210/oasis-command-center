import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createClient } from "@libsql/client";

function stub(request: string, exports: Record<string, unknown>) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, path: dirname(path), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stub("next/navigation", {
  notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); },
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT;${url}`); },
});

let passed = 0;
let failed = 0;

async function check(name: string, run: () => Promise<void> | void) {
  try {
    await run();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.stack : String(error)}`);
  }
}

const NOW = new Date("2026-10-12T18:00:00.000Z");
const baseRun = { createdAt: "2026-10-12T17:59:00.000Z" };

async function testDb() {
  const db = createClient({ url: "file::memory:" });
  await db.executeMultiple(`
    CREATE TABLE dept_chat_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      department_key TEXT NOT NULL,
      agent_slug TEXT NOT NULL,
      seq INTEGER NOT NULL,
      status TEXT NOT NULL,
      user_text TEXT NOT NULL,
      chat_mode TEXT NOT NULL,
      source TEXT NOT NULL,
      show_thinking INTEGER NOT NULL,
      final_text TEXT,
      agent_json TEXT,
      error_code TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      lease_id TEXT,
      heartbeat_at TEXT,
      cancel_requested_at TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      executor TEXT NOT NULL,
      claimed_pairing_id TEXT,
      origin TEXT NOT NULL,
      deadline_at TEXT,
      first_in_line_at TEXT,
      target_pairing_id TEXT,
      runtime_engine_kind TEXT,
      runtime_engine_name TEXT,
      runtime_fallback_policy TEXT,
      runtime_fallback_reason TEXT,
      runtime_api_provider TEXT,
      runtime_api_model TEXT
    );
    CREATE TABLE dept_chat_run_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      tenant_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
  return db;
}

async function insertCandidate(
  db: Awaited<ReturnType<typeof testDb>>,
  input: {
    id: string;
    conversationId: string;
    seq?: number;
    executor?: "computer" | "worker";
    reason?: string | null;
    apiProvider?: "anthropic" | "openai";
    apiModel?: string;
  },
) {
  await db.execute({
    sql: `INSERT INTO dept_chat_runs (
      id, tenant_id, user_id, conversation_id, department_key, agent_slug, seq,
      status, user_text, chat_mode, source, show_thinking, created_at, executor,
      origin, first_in_line_at, target_pairing_id, runtime_engine_kind,
      runtime_engine_name, runtime_fallback_policy, runtime_fallback_reason,
      runtime_api_provider, runtime_api_model
    ) VALUES (?, 'tenant-a', 'user-a', ?, 'chief-of-staff', 'bravo', ?,
      'queued', 'Help me', 'plan', 'worker', 0, ?, ?, 'chat', ?, 'pairing-a',
      'cli', 'codex', 'workspace_api', ?, ?, ?)`,
    args: [
      input.id,
      input.conversationId,
      input.seq ?? 1,
      baseRun.createdAt,
      input.executor ?? "computer",
      "2026-10-12T17:59:30.000Z",
      input.reason ?? null,
      input.apiProvider ?? "anthropic",
      input.apiModel ?? "claude-sonnet-4-6",
    ],
  });
}

async function main() {
  const { dispatchDueEngineFallbacks, fallbackQueueDecision } = await import("../lib/os/runs/fallback-dispatcher");
  const { validateQueuedFallbackAuthorization } = await import("../lib/os/runs/session");
  console.log("engine-fallback-dispatcher:");

  await check("only availability failures activate opted-in fallback clocks", () => {
    assert.deepEqual(fallbackQueueDecision({ run: baseRun, firstInLineAt: "2026-10-12T17:59:30.000Z", state: "offline", nowMs: NOW.getTime() }), {
      action: "fallback",
      reason: "computer_not_answering",
    });
    assert.deepEqual(fallbackQueueDecision({ run: baseRun, firstInLineAt: "2026-10-12T17:59:59.000Z", state: "busy", nowMs: NOW.getTime() }), {
      action: "wait",
    });
    assert.deepEqual(fallbackQueueDecision({ run: baseRun, firstInLineAt: "2026-10-12T17:59:30.000Z", state: "not_approved", nowMs: NOW.getTime() }), {
      action: "fail",
      code: "computer_not_approved",
    });
    assert.deepEqual(fallbackQueueDecision({ run: baseRun, firstInLineAt: "2026-10-12T17:59:30.000Z", state: "blocked:subscription_auth_failure", nowMs: NOW.getTime() }), {
      action: "fallback",
      reason: "subscription_auth_failure",
    });
    assert.equal(
      fallbackQueueDecision({ run: baseRun, firstInLineAt: "2026-10-12T17:59:30.000Z", state: "blocked:computer_not_approved", nowMs: NOW.getTime() }).action,
      "fail",
    );
  });

  await check("the scheduler atomically promotes and drives one exact queued fallback", async () => {
    const db = await testDb();
    const conversationId = "18b8518c-d82b-4d88-a371-129bf21b8737";
    await insertCandidate(db, { id: "run-a", conversationId });
    const driven: string[] = [];
    const summary = await dispatchDueEngineFallbacks({
      db,
      now: NOW,
      deps: {
        readState: async () => "offline",
        resolveSession: async () => ({ ok: true, session: {} as never }),
        drive: async (_session, id) => {
          driven.push(id);
          await db.execute({ sql: "UPDATE dept_chat_runs SET status = 'done' WHERE id = 'run-a'" });
        },
      },
    });
    assert.deepEqual(summary.promoted, ["run-a"]);
    assert.deepEqual(summary.started, ["run-a"]);
    assert.deepEqual(driven, [conversationId]);
    const row = await db.execute("SELECT executor, runtime_fallback_reason, status FROM dept_chat_runs WHERE id = 'run-a'");
    assert.deepEqual(Array.from(row.rows[0]), ["worker", "computer_not_answering", "done"]);

    const again = await dispatchDueEngineFallbacks({ db, now: NOW, deps: { readState: async () => "offline" } });
    assert.equal(again.scanned, 0, "a completed run is not dispatched twice");
  });

  await check("a promoted run abandoned by a browser is resumed durably", async () => {
    const db = await testDb();
    const conversationId = "a8c2f6ea-1fa2-4f4f-9e39-5d7bd469814c";
    await insertCandidate(db, {
      id: "run-promoted",
      conversationId,
      executor: "worker",
      reason: "computer_not_answering",
    });
    const driven: string[] = [];
    const summary = await dispatchDueEngineFallbacks({
      db,
      now: NOW,
      deps: {
        resolveSession: async () => ({ ok: true, session: {} as never }),
        drive: async (_session, id) => {
          driven.push(id);
          await db.execute({ sql: "UPDATE dept_chat_runs SET status = 'done' WHERE id = 'run-promoted'" });
        },
      },
    });
    assert.deepEqual(summary.promoted, []);
    assert.deepEqual(summary.started, ["run-promoted"]);
    assert.deepEqual(driven, [conversationId]);
  });

  await check("a promoted fallback fails closed when its exact pairing or expected owner loses authorization", async () => {
    const requester = "user-a";
    const owner = "agents-owner-a";
    const baseComputer = {
      id: "pairing-a",
      userId: owner,
      label: "Owner Mac",
      lastSeenAt: NOW.toISOString(),
      revokedAt: null,
      scope: "connector",
      pairedVia: "pair_code" as const,
      claimEnabledAt: NOW.toISOString(),
      claimStateAt: NOW.toISOString(),
      claimBlockedReason: null,
      claimCapacity: 1,
      claimProtocols: ["department_task_v2"],
      claimRuntimeState: null,
    };
    const live = (userId: string) => ({
      live: true as const,
      profile: { id: `profile-${userId}`, email: null, teamRole: "member", isOwner: false, adminAccess: false },
    });
    const runGate = (overrides: {
      computer?: typeof baseComputer | null;
      currentOwner?: string;
      inactiveUser?: string;
    } = {}) => validateQueuedFallbackAuthorization(
      { tenantId: "tenant-a", userId: requester, targetPairingId: "pairing-a" },
      {
        readComputer: async () => overrides.computer === undefined ? baseComputer : overrides.computer,
        readOwner: async () => ({ state: "set", authUserId: overrides.currentOwner ?? owner }),
        readSeat: async (_tenantId, userId) => userId === overrides.inactiveUser
          ? { live: false, reason: "deactivated" as const }
          : live(userId),
      },
    );

    assert.equal((await runGate()).ok, true, "the still-approved exact agents-owner pairing remains eligible");
    assert.deepEqual(
      await runGate({ computer: { ...baseComputer, claimEnabledAt: null } }),
      { ok: false, status: 409, error: "computer_not_approved" },
      "approval revoked after promotion must stop API fallback",
    );
    assert.deepEqual(
      await runGate({ computer: null }),
      { ok: false, status: 409, error: "computer_not_connected" },
      "pairing revocation after promotion must stop API fallback",
    );
    assert.deepEqual(
      await runGate({ computer: { ...baseComputer, userId: "unexpected-owner" } }),
      { ok: false, status: 403, error: "computer_not_yours" },
      "a pairing ownership change must not inherit workspace authority",
    );
    assert.deepEqual(
      await runGate({ inactiveUser: owner }),
      { ok: false, status: 409, error: "computer_owner_unavailable" },
      "an inactive pairing owner must stop API fallback",
    );
  });

  await check("browser-immediate and cron-recovery fallback paths converge on the same pre-spend gate", () => {
    const starter = readFileSync("lib/os/runs/turn-starter.ts", "utf8");
    const authorizationAt = starter.indexOf("await validateQueuedFallbackAuthorization(");
    const keyResolutionAt = starter.indexOf("await prepareAgentTurn(");
    assert.ok(authorizationAt > 0 && authorizationAt < keyResolutionAt, "the fresh pairing gate must run before API account/key resolution");

    const browser = readFileSync("app/api/os/runs/[id]/stream/route.ts", "utf8");
    assert.match(browser, /queuedFallback:[\s\S]*executorDepsFor\(/, "the open-browser fallback must use the guarded turn starter");
    const scheduler = readFileSync("lib/os/runs/fallback-dispatcher.ts", "utf8");
    assert.match(scheduler, /resolveStoredFallbackSession[\s\S]*executorDepsFor\(/, "cron recovery must use the guarded resolver and turn starter");
    const sessionSource = readFileSync("lib/os/runs/session.ts", "utf8");
    const storedResolverAt = sessionSource.indexOf("export async function resolveStoredFallbackSession");
    const storedAuthorizationAt = sessionSource.indexOf("await validateQueuedFallbackAuthorization(", storedResolverAt);
    const storedAccountAt = sessionSource.indexOf("await currentWorkspaceApiSnapshot(", storedResolverAt);
    assert.ok(
      storedAuthorizationAt > storedResolverAt && storedAuthorizationAt < storedAccountAt,
      "cron recovery must reject a revoked target before resolving the workspace API account",
    );
  });

  await check("differently snapshotted fallbacks in one conversation each get their own resolved session", async () => {
    const db = await testDb();
    const conversationId = "c525197b-4636-4dc0-9547-a739027d7655";
    await insertCandidate(db, {
      id: "run-api-a",
      conversationId,
      seq: 1,
      executor: "worker",
      reason: "computer_not_answering",
      apiProvider: "anthropic",
      apiModel: "claude-sonnet-4-6",
    });
    await insertCandidate(db, {
      id: "run-api-b",
      conversationId,
      seq: 2,
      executor: "worker",
      reason: "computer_not_answering",
      apiProvider: "openai",
      apiModel: "gpt-5.2",
    });
    const resolved: string[] = [];
    const driven: string[] = [];
    const summary = await dispatchDueEngineFallbacks({
      db,
      now: NOW,
      deps: {
        resolveSession: async ({ snapshot }) => {
          const identity = `${snapshot.runtimeApiProvider}/${snapshot.runtimeApiModel}`;
          resolved.push(identity);
          return { ok: true, session: { apiAccountSnapshot: {
            provider: snapshot.runtimeApiProvider,
            model: snapshot.runtimeApiModel,
          } } as never };
        },
        drive: async (session, id, runId) => {
          driven.push(`${runId}:${session.apiAccountSnapshot?.provider}/${session.apiAccountSnapshot?.model}`);
          await db.execute({ sql: "UPDATE dept_chat_runs SET status = 'done' WHERE id = ?", args: [runId] });
          assert.equal(id, conversationId);
        },
      },
    });
    assert.deepEqual(resolved, ["anthropic/claude-sonnet-4-6", "openai/gpt-5.2"]);
    assert.deepEqual(driven, ["run-api-a:anthropic/claude-sonnet-4-6", "run-api-b:openai/gpt-5.2"]);
    assert.deepEqual(summary.started, ["run-api-a", "run-api-b"]);
  });

  await check("a killed long-running origin is reaped instead of stranding the queue", async () => {
    const db = await testDb();
    const conversationId = "399ba1e9-cef3-4bfd-a53b-fbe7e5d0cde2";
    await insertCandidate(db, {
      id: "run-stale",
      conversationId,
      executor: "worker",
      reason: "computer_not_answering",
    });
    await db.execute({
      sql: `UPDATE dept_chat_runs
            SET status = 'running', lease_id = 'dead-lease', started_at = ?, heartbeat_at = ?
            WHERE id = 'run-stale'`,
      args: ["2026-10-12T17:55:00.000Z", "2026-10-12T17:58:00.000Z"],
    });
    const summary = await dispatchDueEngineFallbacks({ db, now: NOW });
    assert.deepEqual(summary.recovered, ["run-stale"]);
    const row = await db.execute("SELECT status, error_code FROM dept_chat_runs WHERE id = 'run-stale'");
    assert.deepEqual(Array.from(row.rows[0]), ["interrupted", "interrupted"]);
    const events = await db.execute("SELECT kind FROM dept_chat_run_events WHERE run_id = 'run-stale' ORDER BY seq");
    assert.deepEqual(events.rows.map((row) => row[0]), ["error", "done"]);
  });

  await check("the durable dispatcher is registered in every scheduler surface", () => {
    const route = readFileSync("app/api/cron/dispatch-engine-fallbacks/route.ts", "utf8");
    const registry = readFileSync("config/cron-registry.json", "utf8");
    const worker = readFileSync("workers/oasis-cc-cron/src/index.ts", "utf8");
    const rollback = readFileSync(".github/workflows/cron-driver.yml", "utf8");
    assert.match(route, /dispatchDueEngineFallbacks/);
    assert.match(route, /export const GET = handle/);
    assert.match(registry, /\/api\/cron\/dispatch-engine-fallbacks/);
    assert.match(worker, /\/api\/cron\/dispatch-engine-fallbacks/);
    assert.match(worker, /dispatch-engine-fallbacks[\s\S]*dispatch-automations[\s\S]*840_000 : 120_000/);
    assert.match(rollback, /\/api\/cron\/dispatch-engine-fallbacks/);
    assert.match(rollback, /timeout-minutes:\s*70/);
    assert.match(rollback, /if \[ "\$\{path\}" = "\/api\/cron\/dispatch-engine-fallbacks" \][\s\S]*\/api\/cron\/dispatch-automations[\s\S]*timeout_s=840/);
  });

  console.log(`engine-fallback-dispatcher: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void main();
