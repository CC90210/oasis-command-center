/**
 * A person who leaves mid-turn cancels their coding task, on Cloudflare Workers too.
 *
 * WHY (2026-10-20 audit; workerd probe). Closing the tab must tell the paired
 * computer to stop, or the task keeps working, and acting, after the person has
 * gone. The cancel lived in two places and on Workers neither reliably ran:
 *   - the route's req.signal "abort" listener: workerd never fires request.signal
 *     for a closed tab (GET and POST, both signal flags);
 *   - the reply stream's cancel() (lib/bridge/harness-jobs/stream.ts): this one
 *     does fire, but the runtime has already dropped the request's context, so
 *     `await cancelHarnessJob(...)` started there was cut off, with or without
 *     keepAlive (getCloudflareContext() is not visible there).
 * What survived the probe was a HOLD: a promise made at request time and handed
 * to ctx.waitUntil then, with the cancel started from it when the person leaves.
 *
 * lib/bridge/harness-jobs/disconnect-hold.ts is that hold. The route makes one
 * per request and the streams share it, so the abort listener and the stream's
 * cancel() cancel the job ONCE. A reply that ends by itself releases it at once,
 * so a request never sits on a pending waitUntil for the ~30 s grace period.
 *
 * Real: POST /api/bridge/chat, harnessJobStream, harnessJobStreamWithUnclaimedFallback,
 * createDisconnectHold, keepAlive + getCloudflareContext, and the job store, on a
 * local libSQL file (tests/_delivery-harness.ts). Two stand-ins, both at the edges:
 *   - the Worker's request context: an accessor that stops returning the context
 *     once `requestAlive` is false, as OpenNext's AsyncLocalStorage one does outside
 *     the request, with a ctx.waitUntil that records what it is handed; and
 *   - fault injection on the app's own database client (getTursoClient().execute),
 *     which counts the job-cancel statements and can hold them at the database's
 *     door or refuse them.
 *
 * Run: node --conditions=react-server --import tsx tests/harness-cancel-on-disconnect.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { check, finish, login, OASIS, setupDatabase, USERS } from "./_delivery-harness";

const ROOT = join(__dirname, "..");
const CLOUDFLARE_CONTEXT = Symbol.for("__cloudflare-context__");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Let what is already queued run: keepAlive learns of a hold a few ticks after it is made. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const dec = new TextDecoder();

// ── The Worker's side: a request context that goes away, and ctx.waitUntil ──
type Handed = { work: Promise<unknown>; settled: boolean };
const handed: Handed[] = [];
let requestAlive = true; // false = Workers has dropped the request's context, as it has when a stream's cancel() runs
Object.defineProperty(globalThis, CLOUDFLARE_CONTEXT, {
  configurable: true,
  get: () =>
    requestAlive
      ? {
          env: {},
          cf: {},
          ctx: {
            waitUntil: (work: Promise<unknown>) => {
              const entry: Handed = { work, settled: false };
              const done = () => {
                entry.settled = true;
              };
              void work.then(done, done);
              handed.push(entry);
            },
          },
        }
      : undefined,
});

async function until(ready: () => boolean, what: string, ms = 5_000): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Run `fn` with console.error captured instead of printed; the lines it logged come back with its result. */
async function capturingErrors<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 4 }))).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = original;
  }
}

/** keepAlive prints one warning when there is no Cloudflare context to hand a promise to. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

async function main() {
  const db = await setupDatabase();
  await db.executeMultiple(`
    CREATE TABLE agent_model_config (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, agent_key TEXT,
      provider TEXT, model TEXT, computer_pairing_id TEXT, fallback_policy TEXT, updated_at TEXT,
      runtime_probe_job_id TEXT, runtime_probe_pairing_id TEXT, runtime_probe_engine_kind TEXT,
      runtime_probe_engine_name TEXT, runtime_probe_engine_version TEXT, runtime_probe_verified_at TEXT);
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT, label TEXT, machine_fingerprint TEXT, scope TEXT,
      last_seen_at TEXT, revoked_at TEXT, claim_enabled_at TEXT, paired_via TEXT, claim_protocols TEXT, claim_runtime_state TEXT,
      claim_state_at TEXT, claim_capacity INTEGER, claim_in_flight INTEGER, claim_blocked_reason TEXT);
    CREATE TABLE bridge_runtime_jobs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
      pairing_id TEXT NOT NULL, action TEXT NOT NULL, engine_kind TEXT NOT NULL, engine_name TEXT NOT NULL,
      prompt TEXT, status TEXT NOT NULL, idempotency_key TEXT NOT NULL, claim_id TEXT, lease_id TEXT,
      claimed_at TEXT, heartbeat_at TEXT, deadline_at TEXT, progress_code TEXT, result_code TEXT,
      result_json TEXT, error_code TEXT, error_retryable INTEGER, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, finished_at TEXT);
    CREATE TABLE dept_chat_runs (tenant_id TEXT, status TEXT, claimed_pairing_id TEXT, target_pairing_id TEXT);
  `);
  for (const file of ["bravo__208_platform_operators.sql", "bravo__210_workspace_agents_owner.sql", "bravo__216_bridge_harness_pull.sql"]) {
    await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", file), "utf8"));
  }

  // keepAlive imports this the first time it runs; loading it now keeps every later registration to a few ticks.
  await import("@opennextjs/cloudflare");
  const harness = await import("../lib/bridge/harness-jobs");
  const { createDisconnectHold } = harness;
  const { getTursoClient } = await import("../lib/turso");

  // ── Fault injection on the app's own database client (the harness client is a separate connection) ──
  // Every statement that tries to cancel a job is recorded by job id. While `door` is set those statements
  // wait at the database's door; while `refuse` is set they fail there.
  type Door = { gate: Promise<void>; open: () => void; reached: number };
  let door: Door | null = null;
  let refuse: Error | null = null;
  const cancelStatements: string[] = [];
  const isJobCancel = (sql: string) => /^\s*update\s+bridge_harness_jobs\s+set\s+status\s*=\s*'cancelled'/i.test(sql);
  const appClient = getTursoClient() as unknown as Record<string, unknown>;
  const ownExecute = Reflect.getOwnPropertyDescriptor(appClient, "execute");
  const realExecute = (ownExecute?.value ?? (Object.getPrototypeOf(appClient) as Record<string, unknown>).execute) as (
    this: unknown,
    stmt: unknown,
  ) => Promise<unknown>;
  appClient.execute = async function (this: unknown, stmt: unknown) {
    const sql = typeof stmt === "string" ? stmt : String((stmt as { sql: string }).sql);
    const args = typeof stmt === "string" ? [] : (((stmt as { args?: unknown[] }).args ?? []) as unknown[]);
    if (isJobCancel(sql)) {
      // cancelHarnessJob binds [now, now, tenantId, userId, jobId]: the job id is the last value.
      cancelStatements.push(String(args[args.length - 1]));
      if (door) {
        door.reached += 1;
        await door.gate;
      }
      if (refuse) throw refuse;
    }
    return realExecute.call(this, stmt);
  };
  /** Hold every job cancel at the database's door until the returned door is opened. */
  function holdCancels(): Door {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    door = { gate, open, reached: 0 };
    return door;
  }

  const stamp = "2026-10-10T00:00:00Z";
  async function addPairing(id: string) {
    const seen = new Date().toISOString();
    await db.execute({
      sql: `INSERT OR REPLACE INTO bridge_pairings (id, tenant_id, user_id, label, machine_fingerprint, scope, last_seen_at, claim_enabled_at, paired_via, claim_protocols, claim_runtime_state, claim_state_at, claim_capacity, claim_in_flight)
            VALUES (?, ?, ?, 'Test computer', ?, 'daemon', ?, ?, 'pair_code', ?, ?, ?, 1, 0)`,
      args: [id, OASIS, USERS.cc.id, `fp-${id}`, seen, stamp, JSON.stringify([harness.HARNESS_PROTOCOL]), JSON.stringify({ codex: { installed: true, authenticated: true, state: "ready" } }), seen],
    });
  }
  await db.batch(
    [
      { sql: "INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at) VALUES (?, ?, 'test', ?)", args: [OASIS, USERS.cc.id, stamp] },
      {
        sql: "INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, computer_pairing_id, fallback_policy, updated_at, runtime_probe_job_id, runtime_probe_pairing_id, runtime_probe_engine_kind, runtime_probe_engine_name, runtime_probe_engine_version, runtime_probe_verified_at) VALUES ('engine-workspace', ?, NULL, '__engine__', 'cli', 'codex', 'pair-ccpc', 'none', ?, 'probe-codex', 'pair-ccpc', 'cli', 'codex', ?, ?)",
        args: [OASIS, stamp, stamp, stamp],
      },
    ],
    "write",
  );
  await addPairing("pair-ccpc");

  // ── Jobs: one per pairing, because a computer takes one task at a time ──
  let pairings = 0;
  async function newJob(fallbackPolicy: "none" | "workspace_api" = "none") {
    const pairingId = `pair-test-${++pairings}`;
    await addPairing(pairingId);
    const queued = await harness.enqueueHarnessJob({
      tenantId: OASIS,
      userId: USERS.cc.id,
      pairingOwnerId: USERS.cc.id,
      pairingId,
      agentKey: "bravo",
      engine: { kind: "cli", name: "codex" },
      chatMode: "plan",
      repoWrites: false,
      request: {
        messages: [{ role: "user", content: "keep going" }],
        attachments: [],
        session_id: null,
        tab_id: null,
        disallowed_tools: [],
        fallback_policy: fallbackPolicy,
      },
    });
    assert.ok(queued.ok, queued.ok ? "" : `the job was not queued: ${queued.code}`);
    return queued.job;
  }
  const rowOf = async (jobId: string) => (await db.execute({ sql: "SELECT status, error_code FROM bridge_harness_jobs WHERE id = ?", args: [jobId] })).rows[0];
  const statusOf = async (jobId: string) => String((await rowOf(jobId)).status);
  const claim = async (pairingId: string, claimId: string) => {
    const claimed = await harness.claimHarnessJob({ tenantId: OASIS, pairingId, claimId }, db);
    assert.ok(claimed, "the computer did not receive its queued task");
    return claimed;
  };
  const cancelJob = (job: { id: string; tenantId: string; userId: string }) =>
    harness.cancelHarnessJob({ tenantId: job.tenantId, userId: job.userId, jobId: job.id });

  /**
   * Start every check from the same place: nothing handed over, nothing cancelled, the request alive, the door
   * shut. keepAlive learns of a hold a few ticks after it is made, so the last check's are let land first: one
   * must never be counted as this check's.
   */
  async function reset() {
    await settle();
    handed.length = 0;
    cancelStatements.length = 0;
    requestAlive = true;
    door = null;
    refuse = null;
  }

  // ═══ The hold on its own ═══
  console.log("harness-cancel-on-disconnect:");

  await check("a hold is handed to the platform when it is made, before anything has gone wrong, and stays held", async () => {
    await reset();
    const hold = createDisconnectHold("unit:registered");
    await until(() => handed.length === 1, "the hold to reach ctx.waitUntil");
    await sleep(50);
    assert.equal(handed.length, 1, "one hold, one handover");
    assert.equal(handed[0].settled, false, "nothing has happened, so the platform is still being asked to wait");
    hold.release();
    await until(() => handed[0].settled, "the released hold to settle");
  });

  await check("run() cancels once however many triggers fire, and every trigger waits for that one cancel", async () => {
    await reset();
    const hold = createDisconnectHold("unit:once");
    await until(() => handed.length === 1, "the hold to reach ctx.waitUntil");
    let calls = 0;
    let finishCancel!: () => void;
    const first = () => {
      calls += 1;
      return new Promise<void>((resolve) => {
        finishCancel = resolve;
      });
    };
    const a = hold.run(first);
    const b = hold.run(async () => {
      calls += 10;
    });
    const c = hold.run(first);
    await settle();
    assert.equal(calls, 1, "the first trigger's cancel ran; the others started nothing");
    assert.equal(handed[0].settled, false, "the hold is held while the cancel is in flight");
    finishCancel();
    await Promise.all([a, b, c]);
    assert.equal(calls, 1, "still one cancel");
    await until(() => handed[0].settled, "the hold to settle once the cancel had");
  });

  await check("a release before any trigger means nothing is ever cancelled; a release during a cancel does not free the hold early", async () => {
    await reset();
    const released = createDisconnectHold("unit:released-first");
    released.release();
    let ran = false;
    await released.run(async () => {
      ran = true;
    });
    assert.equal(ran, false, "the reply had already ended by itself: there is nothing to cancel");

    const cancelling = createDisconnectHold("unit:release-during-cancel");
    await until(() => handed.length === 2, "both holds to reach ctx.waitUntil");
    let finishCancel!: () => void;
    const done = cancelling.run(
      () =>
        new Promise<void>((resolve) => {
          finishCancel = resolve;
        }),
    );
    await settle();
    cancelling.release(); // the reply stream's loop does this when it sees it was cancelled
    await sleep(50);
    assert.equal(handed[1].settled, false, "release() must not free the platform's hold while the cancel is still in flight");
    finishCancel();
    await done;
    await until(() => handed[1].settled, "the hold to settle once the cancel had");
  });

  await check("run() never throws, whether the cancel rejects or throws on the spot, and a failure is logged with the hold's label", async () => {
    await reset();
    for (const [name, cancel] of [
      ["rejects", () => Promise.reject(new Error("the database said no (rejected)"))],
      [
        "throws",
        () => {
          throw new Error("the database said no (thrown)");
        },
      ],
    ] as const) {
      const hold = createDisconnectHold(`unit:fails-${name}`);
      const { lines } = await capturingErrors(async () => {
        await hold.run(cancel as () => Promise<unknown>);
      });
      assert.ok(
        lines.some((line) => line.includes("[bridge.harness.disconnect-cancel]") && line.includes(`unit:fails-${name}`) && line.includes("the database said no")),
        `${name}: the failure is logged with the label and the database's words: ${lines.join(" | ")}`,
      );
    }
    await until(() => handed.length === 2 && handed.every((h) => h.settled), "both failed holds to settle");
  });

  await check("with no Cloudflare context at all (a script, Node), a hold still cancels", async () => {
    await reset();
    requestAlive = false;
    await quietly(async () => {
      const hold = createDisconnectHold("unit:no-context");
      let ran = false;
      await hold.run(async () => {
        ran = true;
      });
      assert.equal(ran, true);
      await settle(); // keepAlive looks for the context now, while there still is none
    });
    assert.equal(handed.length, 0, "nothing could be handed to a platform that is not there");
  });

  // ═══ The reply stream ═══
  await check("the stream's cancel() cancels the job once, through a hold the platform was given at request time, after the request is gone", async () => {
    await reset();
    const job = await newJob();
    const stream = harness.harnessJobStream(job);
    await until(() => handed.length === 1, "the stream's hold to reach ctx.waitUntil");
    const reader = stream.getReader();
    await reader.read(); // the first frame: the person is watching
    requestAlive = false; // the tab closes; Workers drops the request's context before it calls cancel()
    const gate = holdCancels();
    const leaving = reader.cancel();
    try {
      await until(() => gate.reached === 1, "the cancel to reach the database");
      // Long after the stream's own loop has seen it was cancelled and stopped, the cancel is still in flight, so
      // what the platform holds must still be held.
      await sleep(700);
      assert.equal(handed[0].settled, false, "the hold was freed while the cancel was still in flight");
      assert.equal(await statusOf(job.id), "queued", "the cancel is waiting at the database: only the platform holds it now");
    } finally {
      gate.open();
    }
    await leaving;
    await until(() => handed[0].settled, "the hold to settle once the cancel had");
    assert.deepEqual(cancelStatements, [job.id], "one cancel, for this job");
    assert.equal(handed.length, 1, "nothing was handed to the platform at cancel time, when it can no longer take it");
    const row = await rowOf(job.id);
    assert.deepEqual([row.status, row.error_code], ["cancelled", "browser_disconnected"]);
  });

  await check("a reply that ends by itself releases the hold at once and cancels nothing", async () => {
    await reset();
    const job = await newJob();
    const stream = harness.harnessJobStream(job);
    await db.batch(
      [
        { sql: "INSERT INTO bridge_harness_job_events (tenant_id, job_id, seq, event_type, data_json, created_at) VALUES (?, ?, 1, 'done', '{}', ?)", args: [OASIS, job.id, stamp] },
        { sql: "UPDATE bridge_harness_jobs SET status = 'completed', finished_at = ?, updated_at = ? WHERE id = ?", args: [stamp, stamp, job.id] },
      ],
      "write",
    );
    const text = await new Response(stream).text();
    assert.match(text, /event: done/);
    await until(() => handed[0]?.settled === true, "the hold to be released when the reply ended", 2_000);
    assert.equal(handed.length, 1);
    assert.deepEqual(cancelStatements, [], "the reply finished; nothing was cancelled");
    assert.equal(await statusOf(job.id), "completed");
  });

  await check("a stream nobody reads still releases its hold when the job ends", async () => {
    await reset();
    const job = await newJob();
    harness.harnessJobStream(job); // never read: the request that never streams
    await until(() => handed.length === 1, "the stream's hold to reach ctx.waitUntil");
    await db.batch(
      [
        { sql: "INSERT INTO bridge_harness_job_events (tenant_id, job_id, seq, event_type, data_json, created_at) VALUES (?, ?, 1, 'done', '{}', ?)", args: [OASIS, job.id, stamp] },
        { sql: "UPDATE bridge_harness_jobs SET status = 'completed', finished_at = ?, updated_at = ? WHERE id = ?", args: [stamp, stamp, job.id] },
      ],
      "write",
    );
    await until(() => handed[0].settled, "the unread stream's hold to be released", 3_000);
    assert.deepEqual(cancelStatements, []);
  });

  await check("a cancel the database refuses is logged with the job, and the hold is still released", async () => {
    await reset();
    const job = await newJob();
    const stream = harness.harnessJobStream(job);
    await until(() => handed.length === 1, "the stream's hold to reach ctx.waitUntil");
    const reader = stream.getReader();
    await reader.read();
    requestAlive = false;
    refuse = new Error("the database refused the cancel (test)");
    try {
      const { lines } = await capturingErrors(async () => {
        await reader.cancel(); // must resolve: a failed cancel is logged, never thrown at the runtime
      });
      assert.ok(
        lines.some((line) => line.includes("[bridge.harness.disconnect-cancel]") && line.includes(job.id) && line.includes("the database refused the cancel")),
        `the failure is logged with the job and the database's words: ${lines.join(" | ")}`,
      );
    } finally {
      refuse = null;
    }
    await until(() => handed[0].settled, "the hold to be released even though the cancel failed", 2_000);
    assert.equal(await statusOf(job.id), "queued", "the cancel did not land, and the log says so");
    await cancelJob(job); // free the computer for the next check
  });

  await check("the route's abort and the stream's cancel() share one hold: the job is cancelled once, not twice", async () => {
    await reset();
    const job = await newJob();
    const hold = createDisconnectHold(`test:shared:${job.id}`);
    const stream = harness.harnessJobStream(job, { disconnect: hold });
    await until(() => handed.length === 1, "the shared hold to reach ctx.waitUntil");
    const reader = stream.getReader();
    await reader.read();
    requestAlive = false;
    // The route's abort listener fires (a runtime that does fire one) ...
    void hold.run(() => harness.cancelHarnessJob({ tenantId: job.tenantId, userId: job.userId, jobId: job.id }));
    // ... and then the response stream is cancelled as well.
    await reader.cancel();
    await until(() => handed[0].settled, "the shared hold to settle");
    await sleep(400); // a second cancel, if one were coming, would have started by now
    assert.deepEqual(cancelStatements, [job.id], "one cancel for two triggers");
    assert.equal(handed.length, 1, "and one hold: the stream used the route's, it did not make its own");
  });

  // ═══ The fallback wrapper and the device stream inside it ═══
  await check("the fallback wrapper and its device stream cancel the job once between them", async () => {
    await reset();
    const job = await newJob("workspace_api");
    await claim(job.pairingId, `claim-${job.id}`); // the computer picked it up: the wrapper hands over to the device stream
    const disconnect = createDisconnectHold(`test:fallback:${job.id}`);
    const wrapper = harness.harnessJobStreamWithUnclaimedFallback(job, {
      deviceStream: () => harness.harnessJobStream(job, { disconnect }),
      fallbackResponse: async () => new Response(null, { status: 500 }),
      disconnect,
    });
    await until(() => handed.length === 1, "the shared hold to reach ctx.waitUntil");
    const reader = wrapper.getReader();
    let seen = "";
    while ((seen.match(/event: agent_status/g) ?? []).length < 2) {
      // the wrapper's own frame, then the device stream's: the device stream is relaying
      const { done, value } = await reader.read();
      assert.equal(done, false, "the wrapper ended before the device stream started");
      seen += dec.decode(value, { stream: true });
    }
    requestAlive = false;
    await reader.cancel();
    await until(() => handed[0].settled, "the shared hold to settle");
    await sleep(400);
    assert.deepEqual(cancelStatements, [job.id], "the wrapper's cancel and the device stream's cancel were one cancel");
    assert.equal(handed.length, 1);
    assert.equal(await statusOf(job.id), "cancelled");
  });

  await check("a fallback wrapper whose job is still queued cancels it through its hold too", async () => {
    await reset();
    const job = await newJob("workspace_api");
    const wrapper = harness.harnessJobStreamWithUnclaimedFallback(job, {
      deviceStream: () => {
        throw new Error("the device stream must not start for a job nobody claimed");
      },
      fallbackResponse: async () => new Response(null, { status: 500 }),
    });
    await until(() => handed.length === 1, "the wrapper's hold to reach ctx.waitUntil");
    const reader = wrapper.getReader();
    await reader.read();
    requestAlive = false;
    await reader.cancel();
    await until(() => handed[0].settled, "the wrapper's hold to settle");
    assert.deepEqual(cancelStatements, [job.id]);
    assert.equal(await statusOf(job.id), "cancelled");
  });

  await check("a fallback that answers instead of the computer releases the hold and cancels nothing", async () => {
    await reset();
    const job = await newJob("workspace_api");
    await db.execute({
      sql: "UPDATE bridge_harness_jobs SET status = 'failed', error_code = 'computer_not_answering', finished_at = ?, updated_at = ? WHERE id = ?",
      args: [stamp, stamp, job.id],
    });
    let devices = 0;
    const text = await new Response(
      harness.harnessJobStreamWithUnclaimedFallback(job, {
        deviceStream: () => {
          devices += 1;
          return new Response("").body!;
        },
        fallbackResponse: async () =>
          new Response("event: delta\ndata: {\"text\":\"workspace fallback\"}\n\nevent: done\ndata: {}\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      }),
    ).text();
    assert.match(text, /workspace fallback/);
    assert.equal(devices, 0);
    await until(() => handed[0]?.settled === true, "the hold to be released when the fallback reply ended", 2_000);
    assert.equal(handed.length, 1);
    assert.deepEqual(cancelStatements, []);
  });

  // ═══ The real route ═══
  const { NextRequest } = await import("next/server");
  const route = await import("../app/api/bridge/chat/route");
  await login(USERS.cc);
  const chat = (signal?: AbortSignal, fallbackPolicy: "none" | "workspace_api" = "none") =>
    route.POST(
      new NextRequest("http://localhost/api/bridge/chat", {
        method: "POST",
        signal,
        body: JSON.stringify({
          agent: "bravo",
          messages: [{ role: "user", content: "keep going" }],
          cli_provider: "codex",
          target_pairing_id: "pair-ccpc",
          runtime_engine_kind: "subscription",
          runtime_engine_name: "codex",
          fallback_policy: fallbackPolicy,
        }),
      }),
    );
  const answered = async (res: Response) => {
    assert.equal(res.status, 200, res.status === 200 ? "" : await res.text());
    return res;
  };
  const latestJob = async () => {
    const r = (await db.execute("SELECT id, status, error_code, pairing_id FROM bridge_harness_jobs WHERE pairing_id = 'pair-ccpc' ORDER BY created_at DESC, rowid DESC LIMIT 1")).rows[0];
    return { id: String(r.id), status: String(r.status), errorCode: r.error_code === null ? null : String(r.error_code) };
  };
  /** The route's computer, fresh and free: a previous check's task must not make it busy or stale. */
  async function freshComputer() {
    await db.execute("UPDATE bridge_harness_jobs SET status = 'cancelled' WHERE pairing_id = 'pair-ccpc' AND status IN ('queued', 'running')");
    await addPairing("pair-ccpc");
  }

  await check("the route: a closed tab cancels the job once, through the hold made when the request arrived", async () => {
    await reset();
    await freshComputer();
    const res = await answered(await chat());
    await until(() => handed.length === 1, "the route's hold to reach ctx.waitUntil");
    const queued = await latestJob();
    assert.equal(queued.status, "queued", "the computer has not picked the task up");
    requestAlive = false; // the tab closes: the context goes before the body's cancel() runs
    const gate = holdCancels();
    void res.body!.cancel();
    try {
      await until(() => gate.reached === 1, "the cancel to reach the database");
      await sleep(700);
      assert.equal(handed[0].settled, false, "the hold was freed while the cancel was still in flight");
      assert.equal((await latestJob()).status, "queued", "the cancel is waiting at the database: only the platform holds it now");
    } finally {
      gate.open();
    }
    await until(() => handed[0].settled, "the hold to settle");
    assert.deepEqual(cancelStatements, [queued.id], "one cancel");
    assert.equal(handed.length, 1, "one hold for the whole request: the route's, shared by its streams");
    assert.deepEqual(await latestJob(), { id: queued.id, status: "cancelled", errorCode: "browser_disconnected" });
  });

  await check("the route: the abort signal and the body's cancel together cancel the job once", async () => {
    await reset();
    await freshComputer();
    const abort = new AbortController();
    const res = await answered(await chat(abort.signal));
    await until(() => handed.length === 1, "the route's hold to reach ctx.waitUntil");
    const queued = await latestJob();
    requestAlive = false;
    abort.abort(); // a runtime that does fire the signal (Node, Vercel)
    void res.body!.cancel(); // and the response stream is cancelled as well
    await until(() => handed[0].settled, "the hold to settle");
    await sleep(400);
    assert.deepEqual(cancelStatements, [queued.id], "one cancel for two triggers");
    assert.equal(handed.length, 1);
    assert.deepEqual(await latestJob(), { id: queued.id, status: "cancelled", errorCode: "browser_disconnected" });
  });

  await check("the route: a request that is already disconnected when it reaches the queue cancels its job through the hold", async () => {
    await reset();
    await freshComputer();
    const res = await answered(await chat(AbortSignal.abort()));
    await until(() => handed.length === 1, "the route's hold to reach ctx.waitUntil");
    await until(() => handed[0].settled, "the hold to settle");
    const job = await latestJob();
    assert.deepEqual([job.status, job.errorCode], ["cancelled", "browser_disconnected"]);
    await res.body!.cancel(); // the response stream goes too: still the same single cancel
    await sleep(300);
    assert.deepEqual(cancelStatements, [job.id]);
    assert.equal(handed.length, 1);
  });

  await check("the route: a reply that finishes releases the hold at once and cancels nothing", async () => {
    await reset();
    await freshComputer();
    const res = await answered(await chat());
    await until(() => handed.length === 1, "the route's hold to reach ctx.waitUntil");
    const claimed = await claim("pair-ccpc", "route-completes");
    const terminal = await harness.appendHarnessEvents({ tenantId: OASIS, jobId: claimed.id, events: [{ seq: 1, type: "done", data: {} }] }, db);
    assert.deepEqual(terminal, { ok: true, terminal: true });
    const text = await res.text();
    assert.match(text, /event: done/);
    await until(() => handed[0]?.settled === true, "the hold to be released when the reply ended", 2_000);
    assert.equal(handed.length, 1);
    assert.deepEqual(cancelStatements, []);
    assert.equal((await latestJob()).status, "completed");
  });

  for (const stage of ["queued", "running"] as const) {
    await check(`the route with the workspace fallback on, task ${stage}: a closed tab cancels the job once`, async () => {
      await reset();
      await freshComputer();
      await db.execute("UPDATE agent_model_config SET fallback_policy = 'workspace_api' WHERE id = 'engine-workspace'");
      try {
        const res = await answered(await chat(undefined, "workspace_api"));
        await until(() => handed.length === 1, "the route's hold to reach ctx.waitUntil");
        const queued = await latestJob();
        const reader = res.body!.getReader();
        let seen = "";
        const frames = stage === "running" ? 2 : 1; // running: the wrapper's frame, then the device stream's
        if (stage === "running") await claim("pair-ccpc", "route-fallback-running");
        while ((seen.match(/event: agent_status/g) ?? []).length < frames) {
          const { done, value } = await reader.read();
          assert.equal(done, false, "the reply ended before the task could be followed");
          seen += dec.decode(value, { stream: true });
        }
        requestAlive = false;
        void reader.cancel();
        await until(() => handed[0].settled, "the hold to settle", 30_000);
        await sleep(400);
        assert.deepEqual(cancelStatements, [queued.id], "the wrapper's cancel and the device stream's were one cancel");
        assert.equal(handed.length, 1);
        assert.equal((await latestJob()).status, "cancelled");
      } finally {
        await db.execute("UPDATE agent_model_config SET fallback_policy = 'none' WHERE id = 'engine-workspace'");
      }
    });
  }

  // ═══ Source-level backstop ═══
  const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
  await check("source: nothing in the streams or the route cancels a job outside the disconnect hold", () => {
    for (const file of ["lib/bridge/harness-jobs/stream.ts", "app/api/bridge/chat/route.ts"]) {
      const calls = read(file)
        .replace(/\.run\(\(\) => cancelHarnessJob\(/g, ".run(() => HELD(")
        .split(/\r?\n/)
        .filter((line) => /\bcancelHarnessJob\(/.test(line) && !/^\s*(import|\*|\/\/)/.test(line));
      assert.deepEqual(calls, [], `${file}: a cancel that does not go through disconnect.run(...) would be lost on Workers`);
    }
  });
  await check("source: the route makes the hold after the job is queued and hands it to both streams", () => {
    const source = read("app/api/bridge/chat/route.ts");
    const made = source.indexOf("createDisconnectHold(");
    assert.ok(made > source.indexOf("const queued = await enqueueHarnessJob"), "the hold is made once there is a job to cancel");
    assert.ok(made < source.indexOf("req.signal.addEventListener"), "the abort listener cancels through it");
    assert.match(source, /harnessJobStream\(queued\.job, \{ disconnect \}\)/);
    assert.match(source, /harnessJobStreamWithUnclaimedFallback\(queued\.job, \{[^}]*\bdisconnect,[^}]*\}\)/s);
  });

  finish("harness-cancel-on-disconnect");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
