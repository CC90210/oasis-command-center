/**
 * Bridge/CLI chat saves the assistant's reply, and the write is kept alive until
 * it has landed.
 *
 * WHY (bridge chat saved no replies; 2026-10-20 audit). Production held three
 * bridge user turns and ZERO assistant turns, so the "Previous chats" drawer
 * showed questions with no answers. teeBridgeChatPersistence started the reply
 * write on the terminal `done` frame with a bare `void persistAssistant()`, set a
 * boolean latch before awaiting anything, and flush() found the latch set and
 * returned at once. The response then ended with the write still in flight, and
 * on Cloudflare Workers (OpenNext) a promise nobody awaits and nobody gave to
 * ctx.waitUntil is cancelled when the response ends. The user message survived
 * because it is written up front, while the request is still streaming.
 * app/api/bridge/chat/route.ts had the same hazard on a client disconnect: its
 * `void cancelHarnessJob(...)` runs at the moment Workers cancels the request.
 *
 * Now the first call keeps the write's PROMISE and hands it to the platform
 * (lib/os/runs/keepalive.ts -> ctx.waitUntil), and every later call returns that
 * same promise, so flush() holds the stream open until the reply has landed, for
 * at most REPLY_WRITE_CAP_MS (a database that never answers must not hold a
 * finished reply's stream open). The route hands its disconnect cancel to
 * keepAlive too.
 *
 * Real teeBridgeChatPersistence, chat-persistence writer, keepAlive and POST
 * /api/bridge/chat, real SQL through the Turso adapter on a local libSQL file
 * (tests/_delivery-harness.ts). Two stand-ins, both at the edges: Cloudflare's
 * ctx.waitUntil, which records what it is handed (getCloudflareContext() reads
 * the global that is set below, so the REAL keepAlive runs), and fault injection
 * on the app's own database client (getTursoClient().execute), so a reply write
 * or a job cancel can be held at the database's door.
 *
 * Run: node --conditions=react-server --import tsx tests/bridge-chat-persistence.test.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, finish, login, OASIS, setupDatabase, USERS } from "./_delivery-harness";
import type { BridgePersistCtx } from "../lib/bridge-chat-persistence";

// The Worker's side of keepAlive: ctx.waitUntil. Every promise handed over is
// kept, so a check can see WHAT was handed over and wait for it, as the platform
// would. getCloudflareContext() reads this global, so the REAL keepAlive runs.
const handedToPlatform: Promise<unknown>[] = [];
const CLOUDFLARE_CONTEXT = Symbol.for("__cloudflare-context__");
const platformGlobals = globalThis as unknown as Record<symbol, unknown>;
const platform = { env: {}, cf: {}, ctx: { waitUntil: (work: Promise<unknown>) => void handedToPlatform.push(work) } };
platformGlobals[CLOUDFLARE_CONTEXT] = platform;

const enc = new TextEncoder();
const dec = new TextDecoder();
const frame = (event: string, data: Record<string, unknown>) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const REPLY = ["You have four ", "new leads today."];
const FAILURE = "The selected computer could not finish this coding task.";

/**
 * An upstream that sends `chunks` and then closes (the bridge finishing its
 * reply) or, with `stayOpen`, never does (the browser is gone before the bridge
 * is). `cancelled()` says whether the cancel travelled back to it, as a real
 * disconnect's does.
 */
function upstreamOf(chunks: Uint8Array[], opts: { stayOpen?: boolean } = {}) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (!opts.stayOpen) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

/** Read a response body to its end, as the browser does. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    chunks.push(value);
  }
}

/** Read until `marker` has arrived; the stream stays open. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<void> {
  let seen = "";
  while (!seen.includes(marker)) {
    const { done, value } = await reader.read();
    assert.equal(done, false, `the stream ended before "${marker}" arrived`);
    seen += dec.decode(value, { stream: true });
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait for `ready`: the platform learns of a write a few ticks after the frame that starts it. */
async function until(ready: () => boolean, what: string, ms = 5_000): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Silence keepAlive's one-time "no Cloudflare context" warning for the length of `fn`. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

/** Run `fn` with console.error captured instead of printed; the lines it logged come back with its result. */
async function capturingErrors<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = original;
  }
}

async function main() {
  const db = await setupDatabase();
  // chat_sessions / chat_messages as the live schema has them (the shapes the
  // chat route tests use); the vault table is read for redaction before a write.
  await db.executeMultiple(`
    CREATE TABLE chat_sessions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL,
      user_id TEXT, agent_key TEXT, provider TEXT, model TEXT, title TEXT,
      total_input_tokens INTEGER NOT NULL DEFAULT 0, total_output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd TEXT NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), session_id TEXT, tenant_id TEXT,
      role TEXT, content TEXT, input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER, error TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    CREATE TABLE tenant_integration_credentials (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      service TEXT, field_key TEXT, encrypted_value TEXT, created_at TEXT, updated_at TEXT);
  `);

  const { teeBridgeChatPersistence, REPLY_WRITE_CAP_MS } = await import("../lib/bridge-chat-persistence");
  const { getTursoClient } = await import("../lib/turso");

  // Fault injection on the app's own database client (the harness client is a
  // separate connection): while a hold is open, the statements it names wait at
  // the database's door. Nothing else is touched. Every statement the checks care
  // about is recorded: the reply INSERTs (to count a conversation's writes), the
  // reply write's LAST statement and the job cancel (to say when each has really
  // finished, so a check can tell the work the platform holds from a promise that
  // merely settles early).
  type Hold = { open: () => void; opened: boolean; reached: number; waiting: Promise<void>; matches: (sql: string, args: unknown[]) => boolean };
  let hold: Hold | null = null;
  const isReplyInsert = (sql: string, args: unknown[]) => /insert\s+into\s+"?chat_messages"?/i.test(sql) && args.includes("assistant");
  const isReplyLastStatement = (sql: string) => /^\s*update\s+"?chat_sessions"?\s+set\s+"?updated_at"?/i.test(sql);
  const isJobCancel = (sql: string) => /^\s*update\s+"?bridge_harness_jobs"?\s+set\s+status\s*=\s*'cancelled'/i.test(sql);
  const replyWrites: unknown[][] = [];
  const replyWritesFinished = new Set<string>();
  const jobCancelsFinished = new Map<string, number>(); // by job id: a stream's own cancel of an earlier job lands late
  const appClient = getTursoClient() as unknown as Record<string, unknown>;
  const ownExecute = Reflect.getOwnPropertyDescriptor(appClient, "execute");
  const realExecute = (ownExecute?.value ?? (Object.getPrototypeOf(appClient) as Record<string, unknown>).execute) as (
    this: unknown,
    stmt: unknown,
  ) => Promise<unknown>;
  appClient.execute = async function (this: unknown, stmt: unknown) {
    const sql = typeof stmt === "string" ? stmt : String((stmt as { sql: string }).sql);
    const args = typeof stmt === "string" ? [] : (((stmt as { args?: unknown[] }).args ?? []) as unknown[]);
    if (isReplyInsert(sql, args)) replyWrites.push(args);
    if (hold?.matches(sql, args)) {
      hold.reached += 1;
      await hold.waiting;
    }
    const result = await realExecute.call(this, stmt);
    // .update({ updated_at }).eq("id", conversationId): the id is the last bound value.
    if (isReplyLastStatement(sql)) replyWritesFinished.add(String(args[args.length - 1]));
    // cancelHarnessJob binds [now, now, tenantId, userId, jobId]: the job id is the last value.
    if (isJobCancel(sql)) jobCancelsFinished.set(String(args[args.length - 1]), (jobCancelsFinished.get(String(args[args.length - 1])) ?? 0) + 1);
    return result;
  };
  /** Hold the statements `matches` names at the database's door for the length of `fn`; they always go through afterwards. */
  async function holding<T>(matches: Hold["matches"], fn: (h: Hold) => Promise<T>): Promise<T> {
    let release!: () => void;
    const h: Hold = {
      waiting: new Promise<void>((resolve) => {
        release = resolve;
      }),
      opened: false,
      reached: 0,
      matches,
      open: () => {
        h.opened = true;
        release();
      },
    };
    hold = h;
    try {
      return await fn(h);
    } finally {
      hold = null;
      h.open();
    }
  }
  const holdingReplyWrites = <T>(fn: (h: Hold) => Promise<T>) => holding(isReplyInsert, fn);
  const holdingJobCancels = <T>(fn: (h: Hold) => Promise<T>) => holding((sql) => isJobCancel(sql), fn);
  // The INSERT's first bound value is session_id (persistAssistantTurn's row order).
  const replyWritesFor = (conversationId: string) => replyWrites.filter((args) => args[0] === conversationId).length;

  const turnOf = (over: Partial<BridgePersistCtx> = {}): BridgePersistCtx => ({
    tenantId: OASIS,
    userId: USERS.cc.id,
    agent: "bravo",
    cliProvider: "claude",
    conversationId: randomUUID(),
    userMessage: `How many leads came in today? (${randomUUID().slice(0, 8)})`,
    startedAt: Date.now() - 1_500,
    ...over,
  });
  const messagesOf = async (conversationId: string) =>
    (await db.execute({ sql: "SELECT role, content, error FROM chat_messages WHERE session_id = ? ORDER BY rowid", args: [conversationId] })).rows.map(
      (r) => ({ role: String(r.role), content: String(r.content), error: r.error === null ? null : String(r.error) }),
    );
  const rolesOf = async (conversationId: string) => (await messagesOf(conversationId)).map((m) => m.role);
  const replyFrames = () => [frame("delta", { text: REPLY[0] }), frame("delta", { text: REPLY[1] }), frame("done", {})];
  /** The platform has been handed `n` writes, and no more arrive. */
  const handedExactly = async (n: number, what: string) => {
    await until(() => handedToPlatform.length >= n, `${what} to reach ctx.waitUntil`);
    await sleep(40);
    assert.equal(handedToPlatform.length, n, `${what}: handed to ctx.waitUntil ${n} time(s), not ${handedToPlatform.length}`);
  };

  console.log("bridge-chat-persistence:");

  await check("a streamed reply is saved: the question, then the reply as streamed, on the bridge session the drawer lists; the client's bytes are untouched", async () => {
    const turn = turnOf();
    const sent = [frame("agent_status", { phase: "queued", agent: "bravo" }), ...replyFrames()];
    const got = await drain(teeBridgeChatPersistence(upstreamOf(sent).stream, turn));
    assert.deepEqual(got, Buffer.concat(sent), "the bytes the browser reads are the bytes the bridge sent");
    assert.deepEqual(await messagesOf(turn.conversationId), [
      { role: "user", content: turn.userMessage, error: null },
      { role: "assistant", content: REPLY.join(""), error: null },
    ]);
    const sessions = (await db.execute({ sql: "SELECT tenant_id, user_id, agent_key, provider, model, title FROM chat_sessions WHERE id = ?", args: [turn.conversationId] })).rows;
    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.deepEqual(
      [s.tenant_id, s.user_id, s.agent_key, s.provider, s.model, s.title],
      [OASIS, USERS.cc.id, "bravo", "bridge", "bridge:claude", turn.userMessage.slice(0, 80)],
    );
    await Promise.all(handedToPlatform);
  });

  await check("the response does not end before the reply has landed: a slow write is waited for, not cut off with the response", async () => {
    // On Workers whatever is still in flight, and not handed to waitUntil, dies
    // when the response ends. The old latch let flush() return at once.
    const turn = turnOf();
    await holdingReplyWrites(async (h) => {
      setTimeout(() => h.open(), 200);
      await drain(teeBridgeChatPersistence(upstreamOf(replyFrames()).stream, turn));
      assert.equal(h.opened, true, "the response ended while the reply write was still waiting on the database");
      assert.equal(h.reached, 1, "the reply write reached the database once");
      assert.deepEqual(await rolesOf(turn.conversationId), ["user", "assistant"], "the reply is in chat_messages the moment the response ends");
    });
    await Promise.all(handedToPlatform);
  });

  await check("a database that never answers costs the response at most the cap: the stream ends on time, the cap is logged, and the write is still the one handed to the platform", async () => {
    handedToPlatform.length = 0;
    const turn = turnOf();
    const CAP = 300;
    const GIVE_UP = CAP * 10 + 2_000;
    await holdingReplyWrites(async (h) => {
      const started = Date.now();
      // The write is held at the database's door and never released inside this check: only the cap can end the stream.
      const { value: outcome, lines } = await capturingErrors(() =>
        Promise.race([
          drain(teeBridgeChatPersistence(upstreamOf(replyFrames()).stream, turn, { replyWriteCapMs: CAP })).then(() => "ended" as const),
          sleep(GIVE_UP).then(() => "still open" as const),
        ]),
      );
      const took = Date.now() - started;
      assert.equal(outcome, "ended", `the stream was still open ${GIVE_UP} ms after a write that never answers: flush() waits for the write with no cap`);
      assert.ok(took >= CAP - 50, `the stream ended after ${took} ms, before the ${CAP} ms cap`);
      await until(() => h.reached === 1, "the reply write to reach the database");
      assert.equal(h.opened, false, "the write was released before the stream ended, so the cap proved nothing");
      assert.deepEqual(await rolesOf(turn.conversationId), ["user"], "no reply is saved while the database does not answer");
      const capped = lines.filter((l) => l.includes("[bridge-chat-persistence.flush-cap]"));
      assert.equal(capped.length, 1, `the cap is logged once: ${JSON.stringify(lines)}`);
      assert.ok(capped[0].includes(`${CAP} ms`) && capped[0].includes(turn.conversationId), `the log line names the cap and the conversation: ${capped[0]}`);
      // The response is gone; the write is not. It is the promise the platform holds, and the cap did not settle it.
      await handedExactly(1, "the reply write");
      const platformPromise = handedToPlatform[0];
      const state = await Promise.race([platformPromise.then(() => "settled" as const), sleep(60).then(() => "pending" as const)]);
      assert.equal(state, "pending", "the promise handed to ctx.waitUntil settled with the cap: it must be the write itself");
      h.open();
      await platformPromise;
      assert.equal(replyWritesFinished.has(turn.conversationId), true, "the promise handed to ctx.waitUntil settled before the reply write finished");
      assert.deepEqual(await messagesOf(turn.conversationId), [
        { role: "user", content: turn.userMessage, error: null },
        { role: "assistant", content: REPLY.join(""), error: null },
      ]);
      assert.equal(replyWritesFor(turn.conversationId), 1, "the cap did not start a second write");
    });
  });

  await check("the cap is REPLY_WRITE_CAP_MS unless overridden, armed for the length of the wait only, and silent when the write wins", async () => {
    assert.ok(
      REPLY_WRITE_CAP_MS >= 1_000 && REPLY_WRITE_CAP_MS <= 30_000,
      `REPLY_WRITE_CAP_MS (${REPLY_WRITE_CAP_MS}) must be a cap: far under the widget's 10-minute inactivity timeout, inside the ~30 s waitUntil grace`,
    );
    const armed: unknown[] = [];
    const cleared = new Set<unknown>();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      const handle = realSetTimeout(handler, ms, ...rest);
      if (ms === REPLY_WRITE_CAP_MS) armed.push(handle);
      return handle;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
      cleared.add(handle);
      realClearTimeout(handle);
    }) as unknown as typeof clearTimeout;
    try {
      // No option passed, as the route calls it: the production default.
      const { lines } = await capturingErrors(() => drain(teeBridgeChatPersistence(upstreamOf(replyFrames()).stream, turnOf())));
      assert.ok(armed.length >= 1, "flush() never armed a timer of REPLY_WRITE_CAP_MS: the cap the route gets is not the constant");
      assert.ok(armed.every((handle) => cleared.has(handle)), "a cap timer outlived the wait: it would hold a request open past its response");
      assert.deepEqual(
        lines.filter((l) => l.includes("flush-cap")),
        [],
        "the cap was logged although the write won the race",
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
    await Promise.all(handedToPlatform);
  });

  await check("the reply write is handed to ctx.waitUntil exactly once, and made once: the terminal frame starts it, flush() on a normal close adds nothing", async () => {
    handedToPlatform.length = 0;
    const turn = turnOf();
    await drain(teeBridgeChatPersistence(upstreamOf(replyFrames()).stream, turn));
    await handedExactly(1, "the reply write");
    await handedToPlatform[0];
    assert.equal(replyWritesFor(turn.conversationId), 1, "one write to chat_messages, not one per call");
    assert.deepEqual(await rolesOf(turn.conversationId), ["user", "assistant"]);
  });

  await check("a browser that disconnects before flush() still gets its reply saved: the write was handed to the platform, and the platform is what keeps it alive", async () => {
    handedToPlatform.length = 0;
    const turn = turnOf();
    const up = upstreamOf(replyFrames(), { stayOpen: true });
    await holdingReplyWrites(async (h) => {
      const reader = teeBridgeChatPersistence(up.stream, turn).getReader();
      await readUntil(reader, "event: done");
      await reader.cancel(); // the tab is closed: flush() never runs
      await until(up.cancelled, "the disconnect to reach the upstream");
      await handedExactly(1, "the reply write");
      assert.equal((await rolesOf(turn.conversationId)).includes("assistant"), false, "the write is still waiting on the database: only the platform holds it now");
      h.open();
      await handedToPlatform[0];
      // Checked the instant the platform's promise settles, before anything else
      // is awaited: what the platform holds must BE the write, not a promise that
      // settles early and leaves the write to finish on its own.
      assert.equal(replyWritesFinished.has(turn.conversationId), true, "the promise handed to ctx.waitUntil settled before the reply write finished");
      assert.deepEqual(await messagesOf(turn.conversationId), [
        { role: "user", content: turn.userMessage, error: null },
        { role: "assistant", content: REPLY.join(""), error: null },
      ]);
      assert.equal(replyWritesFor(turn.conversationId), 1);
    });
  });

  for (const shape of [{ code: "harness_failed", message: FAILURE }, { error: FAILURE }]) {
    await check(`an error frame saves the turn with its error (${Object.keys(shape).join("+")}), once: the done frame after it adds no second write`, async () => {
      handedToPlatform.length = 0;
      const turn = turnOf();
      const sent = [frame("delta", { text: "Starting. " }), frame("error", shape), frame("done", {})];
      await drain(teeBridgeChatPersistence(upstreamOf(sent).stream, turn));
      await handedExactly(1, "the failed turn's write");
      await Promise.all(handedToPlatform);
      assert.deepEqual(await messagesOf(turn.conversationId), [
        { role: "user", content: turn.userMessage, error: null },
        { role: "assistant", content: "Starting. ", error: FAILURE },
      ]);
      assert.equal(replyWritesFor(turn.conversationId), 1);
    });
  }

  await check("an error frame with the browser already gone still saves the turn with its error", async () => {
    handedToPlatform.length = 0;
    const turn = turnOf();
    const up = upstreamOf([frame("delta", { text: "Half an answer. " }), frame("error", { code: "harness_failed", message: FAILURE })], { stayOpen: true });
    const reader = teeBridgeChatPersistence(up.stream, turn).getReader();
    await readUntil(reader, "event: error");
    await reader.cancel();
    await until(up.cancelled, "the disconnect to reach the upstream");
    await handedExactly(1, "the failed turn's write");
    await handedToPlatform[0];
    assert.deepEqual(await messagesOf(turn.conversationId), [
      { role: "user", content: turn.userMessage, error: null },
      { role: "assistant", content: "Half an answer. ", error: FAILURE },
    ]);
  });

  await check("a reply the bridge ends without a done frame is still saved: flush() starts the write and waits for it", async () => {
    handedToPlatform.length = 0;
    const turn = turnOf();
    await holdingReplyWrites(async (h) => {
      setTimeout(() => h.open(), 150);
      await drain(teeBridgeChatPersistence(upstreamOf([frame("delta", { text: REPLY.join("") })]).stream, turn));
      assert.equal(h.opened, true, "the response ended before the write did");
      assert.deepEqual(await rolesOf(turn.conversationId), ["user", "assistant"]);
    });
    await handedExactly(1, "the reply write");
  });

  await check("with no platform context (a dev run) the reply is still saved before the response ends", async () => {
    delete platformGlobals[CLOUDFLARE_CONTEXT];
    handedToPlatform.length = 0;
    try {
      const turn = turnOf();
      await quietly(() =>
        holdingReplyWrites(async (h) => {
          setTimeout(() => h.open(), 150);
          await drain(teeBridgeChatPersistence(upstreamOf(replyFrames()).stream, turn));
          assert.equal(h.opened, true, "the response ended while the reply write was still waiting on the database");
          assert.deepEqual(await rolesOf(turn.conversationId), ["user", "assistant"]);
        }),
      );
      assert.equal(handedToPlatform.length, 0, "nothing reached a waitUntil that does not exist");
    } finally {
      platformGlobals[CLOUDFLARE_CONTEXT] = platform;
    }
  });

  await check("a request with no valid tab_id writes nothing and hands nothing to the platform", async () => {
    handedToPlatform.length = 0;
    for (const conversationId of ["not-a-uuid", ""]) {
      const turn = turnOf({ conversationId });
      await drain(teeBridgeChatPersistence(upstreamOf(replyFrames()).stream, turn));
      await sleep(40);
      const stored = (await db.execute({ sql: "SELECT count(*) AS n FROM chat_messages WHERE session_id = ? OR content = ?", args: [conversationId, turn.userMessage] })).rows[0];
      assert.equal(Number(stored.n), 0, `tab_id ${JSON.stringify(conversationId)}: nothing in chat_messages`);
      assert.equal(replyWritesFor(conversationId), 0);
    }
    assert.equal(handedToPlatform.length, 0, "no write, so nothing to hand over");
  });

  // ── The route: a disconnect cancels the harness job, and the platform holds that cancel ──
  // The real POST /api/bridge/chat with the fixture tests/bridge-chat-body-allowlist.test.ts
  // uses: a signed-in owner, a paired and probed computer, a saved engine. The
  // request carries NO tab_id, so the persistence tee stays inert and the only
  // thing the platform can be handed is the route's own disconnect cancel.
  const ROOT = join(__dirname, "..");
  const stamp = "2026-10-10T00:00:00Z";
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
  const { HARNESS_PROTOCOL } = await import("../lib/bridge/harness-jobs");
  const seen = new Date().toISOString();
  await db.batch(
    [
      { sql: "INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at) VALUES (?, ?, 'test', ?)", args: [OASIS, USERS.cc.id, stamp] },
      {
        sql: "INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, computer_pairing_id, fallback_policy, updated_at, runtime_probe_job_id, runtime_probe_pairing_id, runtime_probe_engine_kind, runtime_probe_engine_name, runtime_probe_engine_version, runtime_probe_verified_at) VALUES ('engine-workspace', ?, NULL, '__engine__', 'cli', 'codex', 'pair-ccpc', 'none', ?, 'probe-codex', 'pair-ccpc', 'cli', 'codex', ?, ?)",
        args: [OASIS, stamp, stamp, stamp],
      },
      {
        sql: "INSERT INTO bridge_pairings (id, tenant_id, user_id, label, machine_fingerprint, scope, last_seen_at, claim_enabled_at, paired_via, claim_protocols, claim_runtime_state, claim_state_at, claim_capacity, claim_in_flight) VALUES ('pair-ccpc', ?, ?, 'CCPC', 'fp-ccpc', 'daemon', ?, ?, 'pair_code', ?, ?, ?, 1, 0)",
        args: [
          OASIS,
          USERS.cc.id,
          seen,
          stamp,
          JSON.stringify([HARNESS_PROTOCOL]),
          JSON.stringify({ codex: { installed: true, authenticated: true, state: "ready" } }),
          seen,
        ],
      },
    ],
    "write",
  );
  const { NextRequest } = await import("next/server");
  const route = await import("../app/api/bridge/chat/route");
  await login(USERS.cc);
  const chat = (signal: AbortSignal) =>
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
          fallback_policy: "none",
        }),
      }),
    );
  const latestJob = async () => {
    const r = (await db.execute("SELECT id, status, error_code FROM bridge_harness_jobs ORDER BY created_at DESC, rowid DESC LIMIT 1")).rows[0];
    return { id: String(r.id), status: String(r.status), errorCode: r.error_code === null ? null : String(r.error_code) };
  };
  const answered = async (res: Response) => {
    assert.equal(res.status, 200, res.status === 200 ? "" : await res.text());
    return res;
  };

  await check("a browser that disconnects mid-reply: the route hands the job's cancel to the platform, and what the platform holds is that cancel", async () => {
    handedToPlatform.length = 0;
    const abort = new AbortController();
    const res = await answered(await chat(abort.signal));
    const queued = await latestJob();
    assert.equal(queued.status, "queued", "the computer has not picked the task up");
    await holdingJobCancels(async (h) => {
      abort.abort(); // the tab is closed
      await handedExactly(1, "the disconnect cancel");
      assert.equal((await latestJob()).status, "queued", "the cancel is still waiting on the database: only the platform holds it now");
      h.open();
      await handedToPlatform[0];
      // Before anything else is awaited: the platform's promise must settle only once the cancel has.
      assert.equal(jobCancelsFinished.get(queued.id), 1, "the promise handed to ctx.waitUntil settled before the job's cancel finished");
    });
    assert.deepEqual(await latestJob(), { id: queued.id, status: "cancelled", errorCode: "browser_disconnected" });
    await res.body?.cancel();
  });

  await check("a request already disconnected when it reaches the queue cancels its job through the platform too", async () => {
    handedToPlatform.length = 0;
    await holdingJobCancels(async (h) => {
      const res = await answered(await chat(AbortSignal.abort()));
      try {
        const queued = await latestJob();
        await handedExactly(1, "the disconnect cancel");
        h.open();
        await handedToPlatform[0];
        assert.equal(jobCancelsFinished.get(queued.id), 1, "the promise handed to ctx.waitUntil settled before the job's cancel finished");
        const job = await latestJob();
        assert.deepEqual([job.status, job.errorCode], ["cancelled", "browser_disconnected"]);
      } finally {
        await res.body?.cancel();
      }
    });
  });

  finish("bridge-chat-persistence");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
