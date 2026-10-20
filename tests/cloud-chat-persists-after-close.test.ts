/**
 * Cloud chat (/api/chat and /api/chat/resume) keeps its reply when the platform
 * cancels everything it was not handed.
 *
 * WHY (cloud chat post-turn tail; 2026-10-20 audit). Both routes sent `done`,
 * closed the stream, and only THEN awaited the post-turn tail inside the stream's
 * start(): persistAssistantTurn, addToSessionTotals, the key's last_used_at stamp
 * and the inbox read-marks. On Cloudflare Workers (OpenNext) the request is
 * cancelled once its response has ended, and work nobody gave to ctx.waitUntil
 * dies with it. Run in workerd (the runtime wrangler ships) with that same shape,
 * the first write was ABORTED in flight and the other three were NEVER SENT: no
 * reply was saved. Production could not show it: nobody has used the cloud chat
 * since May, so there are no /api/chat rows at all.
 *
 * Now the tail is ONE job handed to keepAlive (lib/os/runs/keepalive.ts ->
 * ctx.waitUntil) BEFORE the stream closes, while the request is still live, and
 * `done` and close follow at once, so the person waits for nothing.
 *
 * Real route handlers, real SQL on a local libSQL file. The stand-ins sit at the
 * edges: the provider (a stubbed fetch), ctx.waitUntil (recorded, so a check can
 * see WHAT was handed over and when), and a PLATFORM that behaves as workerd did:
 * every database statement takes a short trip, and a request whose response has
 * ended with nothing held dies, so a statement issued or in flight at that moment
 * never runs and never answers.
 *
 * Run: node --conditions=react-server --import tsx tests/cloud-chat-persists-after-close.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "cloud-chat-persists-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "cloud-chat-persists-secret-long-enough-0000001";
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "cloud-chat-persists-field-key-long-enough-001";
process.env.CHAT_RESUME_HMAC_KEY = "cloud-chat-persists-resume-hmac-key-long-0001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
process.env.ADMIN_EMAILS = "";
for (const k of Object.keys(process.env)) {
  if (k.startsWith("PLATFORM_DEFAULT_") || k.startsWith("BRIDGE_")) delete process.env[k];
}

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

// A workspace with its own AI key and no monthly cap, and its owner.
const OPEN = "6b6b6b6b-0000-4000-8000-00000000006b";
const OWNER = { id: "0f000000-0000-4000-8000-000000000013", email: "owner@open.test" };

async function login(user: { id: string; email: string }) {
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
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

// ── the provider: a stubbed global fetch answering as Anthropic's stream ──
const REPLY = "known";
globalThis.fetch = (async () => {
  const frames: Array<[string, unknown]> = [
    ["message_start", { message: { usage: { input_tokens: 1000, output_tokens: 1 } } }],
    ["content_block_start", { index: 0, content_block: { type: "text" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text: REPLY } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 200 } }],
    ["message_stop", {}],
  ];
  const body = frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

const dec = new TextDecoder();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait up to `ms` for `ready`; says whether it came true. */
async function waitFor(ready: () => boolean, ms: number): Promise<boolean> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > ms) return false;
    await sleep(5);
  }
  return true;
}

/** Wait for `ready`, and fail loudly, naming what never happened, if it does not come. */
async function until(ready: () => boolean, what: string, ms = 5_000): Promise<void> {
  if (!(await waitFor(ready, ms))) throw new Error(`timed out waiting for ${what}`);
}

/**
 * How long a check waits for a registration to reach ctx.waitUntil. keepAlive
 * registers only after an async `import("@opennextjs/cloudflare")` resolves: a few
 * microtasks where that import is cached on a fast machine, but a round trip to the
 * loader-hooks thread on Node 22 (CI). A check never reads the ledger the moment a
 * stream ends; it waits for what it caused.
 */
const HANDOFF_WAIT_MS = 3_000;

/**
 * How long a turn may take to end its stream while its reply write is held. A whole turn runs before the stream
 * ends (dozens of statements, each a simulated trip), so this is generous: it only has to separate "ended" from
 * "waits for the held write forever".
 */
const STREAM_ENDS_WITHIN_MS = 8_000;

/** Run `fn` with console.error captured instead of printed; the lines it logged come back with its result. */
async function capturingErrors<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = original;
  }
}

async function main() {
  // A cancelled tail never settles, and Node exits 0 when nothing is left on the event loop: a stuck check would
  // read as a pass. This ref'd timer keeps the loop alive and turns a stuck run into a loud failure.
  setTimeout(() => {
    console.error("cloud-chat-persists-after-close: still running after 90 s, a check is stuck");
    process.exit(1);
  }, 90_000);
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT, custom_fields TEXT,
      updated_at TEXT, deactivated_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE agent_model_config (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, agent_key TEXT,
      provider TEXT, model TEXT, encrypted_api_key TEXT, enabled INTEGER, system_prompt_override TEXT,
      display_name_override TEXT, last_used_at TEXT, updated_at TEXT);
    -- The totals columns as the live bravo schema has them (estimated_cost_usd is TEXT there).
    CREATE TABLE chat_sessions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL,
      user_id TEXT, agent_key TEXT, provider TEXT, model TEXT, title TEXT,
      total_input_tokens INTEGER NOT NULL DEFAULT 0, total_output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd TEXT NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), session_id TEXT, tenant_id TEXT,
      role TEXT, content TEXT, input_tokens INTEGER, output_tokens INTEGER, latency_ms INTEGER, error TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
    CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT, last_seen_at TEXT, tool_capabilities TEXT, revoked_at TEXT);
    -- The agents' inbox (lib/agent-inbox-db.ts): an unread message addressed to the agent is injected into the
    -- turn and marked read once the reply is saved.
    CREATE TABLE agent_messages (id TEXT PRIMARY KEY, message_id TEXT, tenant_id TEXT, from_agent TEXT, to_agent TEXT,
      subject TEXT, body TEXT, priority TEXT, requires_response INTEGER, in_reply_to TEXT, thread_id TEXT,
      read_at TEXT, created_at TEXT);
  `);
  await db.executeMultiple(readFileSync(join(__dirname, "..", "database", "turso", "bravo__192_ai_usage.sql"), "utf8"));
  const { encryptField } = await import("../lib/field-encryption");
  const stamp = "2026-09-01T00:00:00Z";
  await db.batch(
    [
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [OWNER.id, OWNER.email] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'open-co', 'Open Co')", args: [OPEN] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, updated_at)
              VALUES ('p-open-owner', ?, ?, ?, 'owner', 1, ?, 'Test Person', ?)`,
        args: [OWNER.id, OWNER.email, OPEN, stamp, stamp],
      },
      // The workspace's own AI key (Anthropic), and the canonical API engine that selects it.
      {
        sql: `INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at)
              VALUES ('c-open', ?, NULL, 'bravo', 'anthropic', 'claude-sonnet-4-6', ?, 1, ?)`,
        args: [OPEN, encryptField("sk-ant-open-0001"), stamp],
      },
      {
        sql: "INSERT INTO agent_model_config (id, tenant_id, user_id, agent_key, provider, model, encrypted_api_key, enabled, updated_at) VALUES ('e-open', ?, NULL, '__engine__', 'api', 'anthropic', NULL, 1, ?)",
        args: [OPEN, stamp],
      },
    ],
    "write",
  );

  const chatRoute = await import("../app/api/chat/route");
  const resumeRoute = await import("../app/api/chat/resume/route");
  const { signResumeState } = await import("../lib/resume-hmac");
  const { NextRequest } = await import("next/server");
  const { getTursoClient } = await import("../lib/turso");
  const post = (path: string, body: Record<string, unknown>) =>
    new NextRequest(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // ── The Worker: ctx.waitUntil, and a request that dies when its response ends ──
  // Every promise handed to waitUntil is kept, so a check can see WHAT was handed over and wait for it, as the
  // platform would. getCloudflareContext() reads this global, so the REAL keepAlive runs.
  const handedToPlatform: Promise<unknown>[] = [];
  // One object per request, captured by whatever belongs to it (a registration, a statement), so work still
  // running from an earlier request can never change the accounting of the one that is live now.
  type Request = { live: boolean; ended: boolean; held: number; dropped: string[] };
  const newRequest = (): Request => ({ live: true, ended: false, held: 0, dropped: [] });
  let request = newRequest();
  const beginRequest = () => {
    request = newRequest();
  };
  /** The person has read the whole stream. With nothing held, the platform cancels the request here. */
  const responseEnded = () => {
    const mine = request;
    mine.ended = true;
    if (mine.held === 0) mine.live = false;
  };
  const CLOUDFLARE_CONTEXT = Symbol.for("__cloudflare-context__");
  (globalThis as unknown as Record<symbol, unknown>)[CLOUDFLARE_CONTEXT] = {
    env: {},
    cf: {},
    ctx: {
      waitUntil: (work: Promise<unknown>) => {
        handedToPlatform.push(work);
        const mine = request;
        if (mine.ended && !mine.live) return; // too late: this request is already gone
        mine.held += 1;
        const release = () => {
          mine.held -= 1;
          if (mine.ended && mine.held === 0) mine.live = false;
        };
        void work.then(release, release);
      },
    },
  };

  // The ledger at each controller.close() during a turn (the route closes one stream: its own).
  const closes: number[] = [];
  let watchingCloses = false;
  const controllerProto = ReadableStreamDefaultController.prototype as unknown as { close: () => void };
  const realClose = controllerProto.close;
  controllerProto.close = function (this: unknown) {
    if (watchingCloses) closes.push(handedToPlatform.length);
    return realClose.call(this);
  };

  // ── Fault injection on the app's own database client: the platform, a hold, and a failing statement ──
  // Every statement takes a short trip (STATEMENT_MS). If the request has died by the time it is issued, or while
  // it is in flight, it never runs and never answers, as workerd did. A hold keeps matching statements at the
  // database's door; `failing` makes matching statements throw as in an outage.
  const STATEMENT_MS = 4;
  type Hold = { open: () => void; opened: boolean; reached: number; waiting: Promise<void> };
  let hold: Hold | null = null;
  let failing: ((sql: string) => boolean) | null = null;
  const isReplyInsert = (sql: string, args: unknown[]) => /insert\s+into\s+"?chat_messages"?/i.test(sql) && args.includes("assistant");
  const appClient = getTursoClient() as unknown as Record<string, unknown>;
  const ownExecute = Reflect.getOwnPropertyDescriptor(appClient, "execute");
  const realExecute = (ownExecute?.value ?? (Object.getPrototypeOf(appClient) as Record<string, unknown>).execute) as (
    this: unknown,
    stmt: unknown,
  ) => Promise<unknown>;
  appClient.execute = async function (this: unknown, stmt: unknown) {
    const sql = typeof stmt === "string" ? stmt : String((stmt as { sql: string }).sql);
    const args = typeof stmt === "string" ? [] : (((stmt as { args?: unknown[] }).args ?? []) as unknown[]);
    const mine = request;
    const lost = () => {
      mine.dropped.push(sql.replace(/\s+/g, " ").slice(0, 70));
      return new Promise<never>(() => undefined);
    };
    if (!mine.live) return lost();
    if (failing?.(sql)) throw new Error("test: connection reset");
    if (hold && isReplyInsert(sql, args)) {
      hold.reached += 1;
      await hold.waiting;
    }
    await sleep(STATEMENT_MS);
    if (!mine.live) return lost();
    return realExecute.call(this, stmt);
  };
  /** Hold the assistant reply INSERT at the database's door for the length of `fn`; it always goes through afterwards. */
  async function holdingReplyWrites<T>(fn: (h: Hold) => Promise<T>): Promise<T> {
    let release!: () => void;
    const h: Hold = {
      waiting: new Promise<void>((resolve) => {
        release = resolve;
      }),
      opened: false,
      reached: 0,
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

  // ── The ledger of registrations, and the rule that keeps it honest ──
  /**
   * The platform has received `n` registrations, and no more arrive. This WAITS for them (failing loudly,
   * naming `what`, if they never come) rather than reading the ledger the moment a stream ends, because the
   * registration lands some time after that; then it stays quiet for a moment to catch a second one.
   */
  const handedExactly = async (n: number, what: string) => {
    await until(() => handedToPlatform.length >= n, `${what} to reach ctx.waitUntil`, HANDOFF_WAIT_MS);
    await sleep(40);
    assert.equal(handedToPlatform.length, n, `${what}: handed to ctx.waitUntil ${n} time(s), not ${handedToPlatform.length}`);
  };
  const lostNote = () => `the platform cancelled ${request.dropped.length} statement(s): ${request.dropped.join(" | ") || "none"}`;
  /**
   * The work handed to the platform has finished. Bounded: a tail the platform cancelled never settles, and that
   * must read as a failure that names the lost statements, never as a test that hangs (Node exits 0 when nothing
   * is left on the event loop, so a hang would look like a pass).
   */
  const settleHandedWork = async () => {
    const settled = await Promise.race([Promise.all(handedToPlatform).then(() => true), sleep(HANDOFF_WAIT_MS).then(() => false)]);
    if (!settled) throw new Error(`the work handed to ctx.waitUntil never finished: ${lostNote()}`);
  };
  /**
   * A check, under the rule that keeps the shared ledger honest. A registration can land after the stream has
   * ended, so a check that ends first leaves it to land in the NEXT check's ledger as a second handoff. So every
   * check says how many registrations it causes, starts from a live request and an empty ledger, and does not
   * end until exactly that many have landed, no more, and the work they hold has finished.
   */
  const step = (name: string, handoffs: number, body: () => Promise<void>) =>
    check(name, async () => {
      handedToPlatform.length = 0;
      beginRequest();
      try {
        await body();
        await handedExactly(handoffs, `the ${handoffs} registration(s) this check caused`);
        await settleHandedWork();
      } finally {
        // Cleanup only: the check's own outcome is already decided (a pass, or the error being thrown).
        await waitFor(() => handedToPlatform.length >= handoffs, 1_500);
      }
    });

  // keepAlive's first import of "@opennextjs/cloudflare" is a cold ESM load. Do it once here, so no check's
  // wait for its registration has to cover it. Nothing depends on this: the checks wait for what they cause.
  await import("@opennextjs/cloudflare");

  // ── Running a turn ──
  type Turn = { status: number; text: string; events: string[]; ledgerAtDone: number; closes: number[]; sessionId: string };
  /** Read a route's answer to its end, as the browser does, noting the ledger as each frame arrives. */
  const readTurn = async (res: Response): Promise<Turn> => {
    if (res.status !== 200) throw new Error(`the route answered ${res.status}: ${await res.text()}`);
    const reader = res.body!.getReader();
    const events: string[] = [];
    let ledgerAtDone = -1;
    let text = "";
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      text += chunk;
      pending += chunk;
      let i: number;
      while ((i = pending.indexOf("\n\n")) !== -1) {
        const block = pending.slice(0, i);
        pending = pending.slice(i + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1] ?? "message";
        events.push(event);
        if (event === "done") ledgerAtDone = handedToPlatform.length;
      }
    }
    watchingCloses = false;
    responseEnded();
    const sessionId = String(JSON.parse(/^data: (.+)$/m.exec(text.split("\n\n")[0] ?? "")?.[1] ?? "{}").session_id ?? "");
    return { status: res.status, text, events, ledgerAtDone, closes: [...closes], sessionId };
  };
  const chatTurn = async (message: string): Promise<Turn> => {
    await login(OWNER);
    closes.length = 0;
    watchingCloses = true;
    return readTurn(await chatRoute.POST(post("/api/chat", { agent_key: "bravo", cloud_tools: "off", messages: [{ role: "user", content: message }] })));
  };
  /** A paused turn's resume, as /api/chat issues the state: signed, naming a session the caller owns. */
  const resumeTurn = async (): Promise<Turn & { pausedSession: string }> => {
    await login(OWNER);
    const pausedSession = `c0${Math.random().toString(16).slice(2, 14)}`.padEnd(32, "d").slice(0, 32);
    await db.execute({
      sql: `INSERT INTO chat_sessions (id, tenant_id, user_id, agent_key, provider, model, title) VALUES (?, ?, ?, 'bravo', 'anthropic', 'claude-sonnet-4-6', 'paused')`,
      args: [pausedSession, OPEN, OWNER.id],
    });
    const state = {
      model: "claude-sonnet-4-6",
      system: "sys",
      history: [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "tool_use", id: "tu_r", name: "read_file", input: {} }] }],
      iteration: 1,
      totalIn: 0,
      totalOut: 0,
      sessionId: pausedSession,
    };
    const sig = signResumeState(state, { tenant_id: OPEN, user_id: OWNER.id, agent_key: "bravo" });
    closes.length = 0;
    watchingCloses = true;
    const turn = await readTurn(
      await resumeRoute.POST(
        post("/api/chat/resume", { agent_key: "bravo", session_id: pausedSession, resume_state: state, resume_signature: sig, tool_use_id: "tu_r", tool_result: { content: "file text", is_error: false } }),
      ),
    );
    return { ...turn, pausedSession };
  };

  // ── What the database ends up holding ──
  const messagesOf = async (sessionId: string) =>
    (await db.execute({ sql: "SELECT role, content, input_tokens, output_tokens, error FROM chat_messages WHERE session_id = ? ORDER BY rowid", args: [sessionId] })).rows.map(
      (r) => ({
        role: String(r.role),
        content: String(r.content),
        input: r.input_tokens === null ? null : Number(r.input_tokens),
        output: r.output_tokens === null ? null : Number(r.output_tokens),
        error: r.error === null ? null : String(r.error),
      }),
    );
  const totalsOf = async (sessionId: string) => {
    const r = (await db.execute({ sql: "SELECT total_input_tokens, total_output_tokens, estimated_cost_usd FROM chat_sessions WHERE id = ?", args: [sessionId] })).rows[0];
    return r ? [Number(r.total_input_tokens), Number(r.total_output_tokens), Number(r.estimated_cost_usd)] : null;
  };
  const lastUsed = async () => (await db.execute("SELECT last_used_at FROM agent_model_config WHERE id = 'c-open'")).rows[0]?.last_used_at ?? null;
  const unreadInbox = async () => {
    const id = `m-${Math.random().toString(16).slice(2, 10)}`;
    await db.execute({
      sql: `INSERT INTO agent_messages (id, message_id, tenant_id, from_agent, to_agent, subject, body, priority, requires_response, read_at, created_at)
            VALUES (?, ?, ?, 'maven', 'bravo', 'Heads up', 'Please look at the Friday numbers.', 'normal', 0, NULL, ?)`,
      args: [id, id, OPEN, new Date().toISOString()],
    });
    return id;
  };
  const readAt = async (id: string) => (await db.execute({ sql: "SELECT read_at FROM agent_messages WHERE id = ?", args: [id] })).rows[0]?.read_at ?? null;
  /**
   * The tail is over. A route that handed it to the platform gives a promise that settles when it does; a route
   * that did not has nothing to wait for, so the cancelled tail is given every chance and the rows are read.
   */
  const tailSettled = async () => {
    if (await waitFor(() => handedToPlatform.length >= 1, 1_000)) await Promise.race([handedToPlatform[0], sleep(HANDOFF_WAIT_MS)]);
    else await sleep(500);
  };

  // The SSE a simple turn sends, as the route sent it before this change. The redactor holds the last characters
  // of a reply back until the terminal event, so the delta arrives just before `done`, after `usage`. The session
  // id is the only part the route makes up.
  const GOLDEN_CHAT =
    'event: session\ndata: {"session_id":"<session>"}\n\n' +
    'event: usage\ndata: {"input_tokens":1000,"output_tokens":200}\n\n' +
    'event: delta\ndata: {"text":"known"}\n\n' +
    "event: done\ndata: {}\n\n";
  const GOLDEN_RESUME = GOLDEN_CHAT;

  console.log("cloud-chat-persists-after-close:");

  // ───────────────────────────── /api/chat ─────────────────────────────
  await step("/api/chat: the post-turn tail is handed to ctx.waitUntil once, BEFORE the stream closes: when controller.close() runs and when `done` reaches the browser, the platform already holds it", 1, async () => {
    const t = await chatTurn("What is on today?");
    assert.deepEqual(t.closes, [1], `the route closes its stream once, with the tail already handed over: the ledger at each close was ${JSON.stringify(t.closes)}`);
    assert.equal(t.ledgerAtDone, 1, "the browser saw `done` before the platform held the tail");
    assert.deepEqual(t.events, ["session", "usage", "delta", "done"]);
  });

  await step("/api/chat: the stream's bytes are exactly what they were: the session, the usage, the reply, done", 1, async () => {
    const t = await chatTurn("Say it once");
    assert.equal(t.text.replace(t.sessionId, "<session>"), GOLDEN_CHAT);
  });

  await step("/api/chat: a platform that cancels everything it was not handed still gets the WHOLE tail: the reply, the session's totals, last_used_at and the inbox read-mark", 1, async () => {
    const inbox = await unreadInbox();
    await db.execute("UPDATE agent_model_config SET last_used_at = NULL WHERE id = 'c-open'");
    const t = await chatTurn("Remember this");
    await tailSettled();
    assert.deepEqual(
      await messagesOf(t.sessionId),
      [
        { role: "user", content: "Remember this", input: null, output: null, error: null },
        { role: "assistant", content: REPLY, input: 1000, output: 200, error: null },
      ],
      `the reply was not saved: ${lostNote()}`,
    );
    assert.deepEqual(await totalsOf(t.sessionId), [1000, 200, 0.006], `the session's totals were not added: ${lostNote()}`);
    assert.ok(await lastUsed(), `the key's last_used_at was not stamped: ${lostNote()}`);
    assert.ok(await readAt(inbox), `the inbox message was not marked read: ${lostNote()}`);
    assert.deepEqual(request.dropped, [], "the platform cancelled a statement of the tail");
  });

  await step("/api/chat: the person waits for nothing: the stream ends while the reply write is still held at the database, and the write finishes under the platform's hold", 1, async () => {
    await holdingReplyWrites(async (h) => {
      const GIVE_UP = STREAM_ENDS_WITHIN_MS;
      const outcome = await Promise.race([chatTurn("Held write").then((t) => t), sleep(GIVE_UP).then(() => "still open" as const)]);
      assert.notEqual(outcome, "still open", `the stream was still open ${GIVE_UP} ms after the answer: the route waits for its post-turn writes before it sends done`);
      const t = outcome as Turn;
      await until(() => h.reached === 1, "the reply write to reach the database");
      assert.equal(h.opened, false, "the write was released before the stream ended, so the check proved nothing");
      assert.deepEqual((await messagesOf(t.sessionId)).map((m) => m.role), ["user"], "the reply is not saved while the database does not answer");
      await handedExactly(1, "the post-turn tail");
      const tail = handedToPlatform[0];
      const state = await Promise.race([tail.then(() => "settled" as const), sleep(60).then(() => "pending" as const)]);
      assert.equal(state, "pending", "the promise handed to ctx.waitUntil settled with the response: it must be the tail itself");
      h.open();
      await tail;
      assert.deepEqual((await messagesOf(t.sessionId)).map((m) => m.role), ["user", "assistant"], `the reply was lost after the response ended: ${lostNote()}`);
      assert.deepEqual(await totalsOf(t.sessionId), [1000, 200, 0.006]);
    });
  });

  await step("/api/chat: a step that fails keeps its error handling: the totals failure is logged and the tail goes on to last_used_at and the inbox", 1, async () => {
    const inbox = await unreadInbox();
    await db.execute("UPDATE agent_model_config SET last_used_at = NULL WHERE id = 'c-open'");
    failing = (sql) => /set\s+total_input_tokens/i.test(sql);
    try {
      const { value: t, lines } = await capturingErrors(async () => {
        const turn = await chatTurn("Totals will fail");
        await tailSettled();
        return turn;
      });
      assert.ok(
        lines.some((l) => l.includes("[chat.session_totals]") && l.includes("connection reset")),
        `the failed totals were not logged where they always were: ${JSON.stringify(lines)}`,
      );
      assert.deepEqual((await messagesOf(t.sessionId)).map((m) => m.role), ["user", "assistant"], "the reply was not saved");
      assert.deepEqual(await totalsOf(t.sessionId), [0, 0, 0], "a failed increment still moved the totals");
      assert.ok(await lastUsed(), "the failed totals stopped the tail before last_used_at");
      assert.ok(await readAt(inbox), "the failed totals stopped the tail before the inbox read-mark");
    } finally {
      failing = null;
    }
  });

  // ─────────────────────────── /api/chat/resume ───────────────────────────
  await step("/api/chat/resume: the post-turn tail is handed to ctx.waitUntil once, BEFORE the stream closes", 1, async () => {
    const t = await resumeTurn();
    assert.deepEqual(t.closes, [1], `the route closes its stream once, with the tail already handed over: the ledger at each close was ${JSON.stringify(t.closes)}`);
    assert.equal(t.ledgerAtDone, 1, "the browser saw `done` before the platform held the tail");
    assert.deepEqual(t.events, ["session", "usage", "delta", "done"]);
  });

  await step("/api/chat/resume: the stream's bytes are exactly what they were", 1, async () => {
    const t = await resumeTurn();
    assert.equal(t.text.replace(t.pausedSession, "<session>"), GOLDEN_RESUME);
  });

  await step("/api/chat/resume: a platform that cancels everything it was not handed still gets the whole tail: the resumed reply (with its header) and the session's totals", 1, async () => {
    const t = await resumeTurn();
    await tailSettled();
    const rows = await messagesOf(t.pausedSession);
    assert.equal(rows.length, 1, `the resumed reply was not saved: ${lostNote()}`);
    assert.equal(rows[0].role, "assistant");
    assert.ok(rows[0].content.startsWith("[resume after tool: tu_r]") && rows[0].content.endsWith(REPLY), rows[0].content);
    assert.deepEqual([rows[0].input, rows[0].output], [1000, 200]);
    assert.deepEqual(await totalsOf(t.pausedSession), [1000, 200, 0.006], `the session's totals were not added: ${lostNote()}`);
    assert.deepEqual(request.dropped, [], "the platform cancelled a statement of the tail");
  });

  await step("/api/chat/resume: the person waits for nothing: the stream ends while the reply write is still held", 1, async () => {
    await holdingReplyWrites(async (h) => {
      const GIVE_UP = STREAM_ENDS_WITHIN_MS;
      const outcome = await Promise.race([resumeTurn().then((t) => t), sleep(GIVE_UP).then(() => "still open" as const)]);
      assert.notEqual(outcome, "still open", `the stream was still open ${GIVE_UP} ms after the answer: the route waits for its post-turn writes before it sends done`);
      const t = outcome as Turn & { pausedSession: string };
      await until(() => h.reached === 1, "the reply write to reach the database");
      assert.equal(h.opened, false, "the write was released before the stream ended, so the check proved nothing");
      assert.equal((await messagesOf(t.pausedSession)).length, 0, "the reply is not saved while the database does not answer");
      await handedExactly(1, "the post-turn tail");
      h.open();
      await handedToPlatform[0];
      assert.equal((await messagesOf(t.pausedSession)).length, 1, `the reply was lost after the response ended: ${lostNote()}`);
    });
  });

  if (failures) {
    console.log(`cloud-chat-persists-after-close: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("cloud-chat-persists-after-close: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
