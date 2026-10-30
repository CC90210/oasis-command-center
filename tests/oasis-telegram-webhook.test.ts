/** OASIS Telegram webhook -> queue -> exact paired-computer path, entirely local. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { OS_DEPARTMENTS } from "../lib/os/departments";
import type { RunSession } from "../lib/os/runs/session";
import { runOasisTelegramDeviceTurn, telegramDeviceRunIdentity } from "../lib/telegram/device-turn";
import {
  signTelegramJob,
  TELEGRAM_JOB_SIGNATURE_MAX_AGE_SEC,
  verifyTelegramJob,
} from "../lib/telegram/job-signature";
import { runOasisTelegramJob } from "../lib/telegram/jobs";
import {
  NO_PAIRED_COMPUTER_REPLY,
  OASIS_TELEGRAM_QUEUE_NAME,
  OASIS_TELEGRAM_TENANT_ID,
  TELEGRAM_WEBHOOK_SECRET_HEADER,
  isOasisTelegramJob,
  oasisTelegramConfig,
  parseOasisTelegramUpdate,
  telegramIdempotencyKey,
  telegramReceiptId,
  type OasisTelegramEnv,
  type OasisTelegramJob,
} from "../lib/telegram/protocol";
import { consumeTelegramJobs } from "../lib/telegram/queue-consumer";
import {
  claimTelegramReceipt,
  ensureTelegramReceipt,
  savePreparedTelegramReply,
} from "../lib/telegram/receipt-store";
import { handleOasisTelegramWebhook } from "../lib/telegram/webhook";
import { routeQueueBatch, SLACK_AGENT_QUEUE_NAME } from "../lib/worker/queue-router";

const CHAT = "7979676345";
const BOT_ID = 123456789;
const ENV: OasisTelegramEnv = {
  TELEGRAM_WEBHOOK_ENABLED: "on",
  OASIS_TELEGRAM_WEBHOOK_SECRET: "oasis_webhook_secret_0123456789",
  OASIS_TELEGRAM_JOB_SIGNING_SECRET: "oasis_job_secret_0123456789abcdef",
  OASIS_TELEGRAM_BOT_TOKEN: "123456789:test_bot_token_abcdefghijklmnopqrstuvwxyz",
  OASIS_TELEGRAM_CHAT_ID: CHAT,
  PUBLIC_APP_URL: "https://oasisai.work",
};
const NOW = new Date("2026-10-30T01:00:00.000Z");

async function main() {
const db = createClient({ url: "file::memory:" });
await db.execute(`CREATE TABLE agent_events (
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, publisher_agent TEXT NOT NULL, target_agent TEXT,
  severity TEXT NOT NULL, payload TEXT NOT NULL, correlation_id TEXT, published_at TEXT NOT NULL,
  consumed_by TEXT DEFAULT '[]', expires_at TEXT, created_at TEXT NOT NULL, source_agent TEXT NOT NULL,
  idempotency_key TEXT, status TEXT NOT NULL, processed_at TEXT, processed_by TEXT, retry_count INTEGER NOT NULL,
  last_error TEXT, visibility_until TEXT
)`);
await db.execute("CREATE UNIQUE INDEX idx_agent_events_idem ON agent_events (idempotency_key) WHERE idempotency_key IS NOT NULL");

let checks = 0;
async function check(name: string, run: () => unknown | Promise<unknown>) {
  await run();
  checks += 1;
  console.log(`  ok ${checks} - ${name}`);
}

const update = (updateId: number, text = "What needs me today?") => ({
  update_id: updateId,
  message: {
    message_id: updateId + 10,
    date: 1793322000,
    from: { id: Number(CHAT), is_bot: false, first_name: "CC" },
    chat: { id: Number(CHAT), type: "private", first_name: "CC" },
    text,
  },
});

const request = (body: unknown, secret = ENV.OASIS_TELEGRAM_WEBHOOK_SECRET!) =>
  new Request("https://oasisai.work/api/webhooks/oasis-telegram", {
    method: "POST",
    headers: { "content-type": "application/json", [TELEGRAM_WEBHOOK_SECRET_HEADER]: secret },
    body: JSON.stringify(body),
  });

const parsedJob = (id: number, text?: string, botId = BOT_ID): OasisTelegramJob => {
  const parsed = parseOasisTelegramUpdate(update(id, text), CHAT, botId);
  assert.ok(parsed.ok);
  return parsed.job;
};

const deviceSession = (engineKind: "cli" | "local", engineName: string | undefined): RunSession => ({
  scope: { tenantId: OASIS_TELEGRAM_TENANT_ID, userId: "auth-cc" },
  email: "conaugh@oasisai.work",
  tenantSlug: "oasis-ai-cc",
  dept: OS_DEPARTMENTS.find((item) => item.key === "chief_of_staff")!,
  operatorName: "CC",
  isOperator: true,
  canManageAi: true,
  fallback: null,
  viewer: { ok: true },
  bridge: null,
  computerDispatch: { pairingId: "pair-mac", label: "CC Mac", engineKind, engineName, fallback: "workspace_api" },
  apiEngineChoice: null,
  apiAccountSnapshot: { provider: "openrouter", model: "forbidden" },
  fallbackFrom: null,
  fallbackReason: null,
}) as unknown as RunSession;

console.log("oasis telegram webhook:");

await check("the off-switch is the first gate: body, database and queue stay untouched", async () => {
  let database = 0;
  let queue = 0;
  const req = request(update(1));
  const response = await handleOasisTelegramWebhook(req, {
    env: { ...ENV, TELEGRAM_WEBHOOK_ENABLED: "off" },
    database: () => { database += 1; return db; },
    queue: async () => { queue += 1; return { send: async () => undefined }; },
  });
  assert.equal(response.status, 503);
  assert.equal(req.bodyUsed, false);
  assert.deepEqual({ database, queue }, { database: 0, queue: 0 });
});

await check("missing, wrong and different-length webhook secrets fail closed before the body", async () => {
  for (const secret of ["", "wrong", `${ENV.OASIS_TELEGRAM_WEBHOOK_SECRET}x`, ENV.OASIS_TELEGRAM_WEBHOOK_SECRET!.slice(0, -1)]) {
    const req = request(update(2), secret);
    const response = await handleOasisTelegramWebhook(req, {
      env: ENV,
      database: () => { throw new Error("database must not be read"); },
      queue: async () => { throw new Error("queue must not be read"); },
    });
    assert.equal(response.status, 401, secret);
    assert.equal(req.bodyUsed, false, secret);
  }
});

await check("the numeric bot id comes only from a valid token and malformed tokens fail before the body", async () => {
  const config = oasisTelegramConfig(ENV);
  assert.equal(config?.botId, BOT_ID);
  assert.equal(parsedJob(2).botId, BOT_ID);
  for (const botToken of [
    "not-a-token",
    "012345:test_bot_token_abcdefghijklmnopqrstuvwxyz",
    "0:test_bot_token_abcdefghijklmnopqrstuvwxyz",
    "1234:test_bot_token_abcdefghijklmnopqrstuvwxyz",
    "123456789:",
  ]) {
    const req = request(update(2));
    const response = await handleOasisTelegramWebhook(req, {
      env: { ...ENV, OASIS_TELEGRAM_BOT_TOKEN: botToken },
      database: () => { throw new Error("database must not be read"); },
      queue: async () => { throw new Error("queue must not be read"); },
    });
    assert.equal(response.status, 503, botToken);
    assert.equal(req.bodyUsed, false, botToken);
  }
});

await check("only text from the configured CC private chat is accepted", async () => {
  const foreign = update(3);
  foreign.message.chat.id = 11112222;
  foreign.message.from.id = 11112222;
  const group = update(4);
  group.message.chat.type = "group";
  const voice = { ...update(5), message: { ...update(5).message, voice: { file_id: "x" } } };
  const callback = { update_id: 6, callback_query: { id: "cb", from: { id: Number(CHAT) } } };
  for (const body of [foreign, group, voice, callback]) {
    let touched = 0;
    const response = await handleOasisTelegramWebhook(request(body), {
      env: ENV,
      database: () => { touched += 1; return db; },
      queue: async () => { touched += 1; return { send: async () => undefined }; },
    });
    assert.equal(response.status, 200);
    assert.ok("ignored" in (await response.json()));
    assert.equal(touched, 0);
  }
});

await check("body limits and JSON schema reject oversized or malformed input without a write", async () => {
  const tooLarge = new Request("https://oasisai.work/api/webhooks/oasis-telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "999999",
      [TELEGRAM_WEBHOOK_SECRET_HEADER]: ENV.OASIS_TELEGRAM_WEBHOOK_SECRET!,
    },
    body: "{}",
  });
  const deps = { env: ENV, database: () => db, queue: async () => ({ send: async () => undefined }) };
  assert.equal((await handleOasisTelegramWebhook(tooLarge, deps)).status, 413);
  const bad = new Request("https://oasisai.work/api/webhooks/oasis-telegram", {
    method: "POST",
    headers: { "content-type": "application/json", [TELEGRAM_WEBHOOK_SECRET_HEADER]: ENV.OASIS_TELEGRAM_WEBHOOK_SECRET! },
    body: "{",
  });
  assert.equal((await handleOasisTelegramWebhook(bad, deps)).status, 400);
});

await check("a valid update is durably recorded before enqueue; its webhook retry is the same job", async () => {
  const queued: OasisTelegramJob[] = [];
  const deps = {
    env: ENV,
    database: () => db,
    queue: async () => ({ send: async (job: OasisTelegramJob) => { queued.push(job); } }),
    now: () => NOW,
  };
  const first = await handleOasisTelegramWebhook(request(update(10)), deps);
  const second = await handleOasisTelegramWebhook(request(update(10)), deps);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(queued.length, 2, "pending ingress is safe to re-enqueue after a lost queue response");
  assert.deepEqual(queued[1], queued[0]);
  const rows = await db.execute({ sql: "SELECT status, payload FROM agent_events WHERE idempotency_key LIKE ?", args: ["%:10"] });
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].status, "pending");
  assert.equal(JSON.parse(String(rows.rows[0].payload)).phase, "received");
});

await check("two consumers cannot claim one bot/update receipt", async () => {
  const job = parsedJob(20);
  await ensureTelegramReceipt(db, job, NOW);
  const results = await Promise.all([claimTelegramReceipt(db, job, NOW), claimTelegramReceipt(db, job, NOW)]);
  assert.deepEqual(results.map((value) => value.state).sort(), ["busy", "claimed"]);
});

await check("an expired receipt lease cannot mutate after a new consumer claims it", async () => {
  const job = parsedJob(21);
  await ensureTelegramReceipt(db, job, NOW);
  const first = await claimTelegramReceipt(db, job, NOW);
  if (first.state !== "claimed") throw new Error(`expected first claim, got ${first.state}`);
  const reclaimed = await claimTelegramReceipt(db, job, new Date(NOW.getTime() + 11 * 60_000));
  if (reclaimed.state !== "claimed") throw new Error(`expected reclaimed lease, got ${reclaimed.state}`);
  assert.notEqual(first.leaseToken, reclaimed.leaseToken);
  await assert.rejects(
    savePreparedTelegramReply(db, job, "stale worker must lose", first.leaseToken),
    /telegram_receipt_lease_lost/,
  );
  await savePreparedTelegramReply(db, job, "current worker owns the receipt", reclaimed.leaseToken);
});

await check("the same update id from two bot generations creates two receipts and two run identities", async () => {
  const oldBotJob = parsedJob(22, "old bot", BOT_ID);
  const replacementBotJob = parsedJob(22, "replacement bot", 987654321);
  assert.equal(isOasisTelegramJob({ ...oldBotJob, botId: undefined }), false, "bot id is required on every queued job");
  assert.notEqual(telegramReceiptId(oldBotJob), telegramReceiptId(replacementBotJob));
  assert.notEqual(telegramIdempotencyKey(oldBotJob), telegramIdempotencyKey(replacementBotJob));
  assert.notDeepEqual(
    telegramDeviceRunIdentity("auth-cc", oldBotJob),
    telegramDeviceRunIdentity("auth-cc", replacementBotJob),
  );

  const first = await ensureTelegramReceipt(db, oldBotJob, NOW);
  const second = await ensureTelegramReceipt(db, replacementBotJob, NOW);
  assert.deepEqual([first.created, second.created], [true, true]);
  const rows = await db.execute({
    sql: "SELECT id, idempotency_key FROM agent_events WHERE event_type = ? AND idempotency_key LIKE ? ORDER BY idempotency_key",
    args: ["oasis_telegram_message", "%:22"],
  });
  assert.equal(rows.rows.length, 2);
  assert.notEqual(rows.rows[0].id, rows.rows[1].id);
  assert.notEqual(rows.rows[0].idempotency_key, rows.rows[1].idempotency_key);
});

await check("queue routing is exact: Telegram, Slack and unknown queues never cross-consume", async () => {
  const calls: string[] = [];
  const retried: string[] = [];
  const batch = (queue: string) => ({
    queue,
    messages: [{ body: {}, ack: () => undefined, retry: () => retried.push(queue) }],
  });
  const deps = {
    telegram: (async () => { calls.push("telegram"); return { acked: 0, retried: 0 }; }) as typeof consumeTelegramJobs,
    slack: (async () => { calls.push("slack"); return { acked: 0, retried: 0 }; }) as never,
  };
  await routeQueueBatch(batch(OASIS_TELEGRAM_QUEUE_NAME), ENV, async () => new Response(), deps);
  await routeQueueBatch(batch(SLACK_AGENT_QUEUE_NAME), ENV, async () => new Response(), deps);
  await routeQueueBatch(batch("oasis-maven-publish-drain"), ENV, async () => new Response(), deps);
  assert.deepEqual(calls, ["telegram", "slack"]);
  assert.deepEqual(retried, ["oasis-maven-publish-drain"]);
});

await check("the queue signs in-process jobs; 2xx acks and failures retry", async () => {
  const acked: string[] = [];
  const retried: string[] = [];
  const message = (id: string) => ({ body: { id }, ack: () => acked.push(id), retry: () => retried.push(id) });
  const seen: Request[] = [];
  const result = await consumeTelegramJobs(
    { queue: OASIS_TELEGRAM_QUEUE_NAME, messages: [message("a"), message("b")] },
    ENV,
    async (req) => {
      seen.push(req);
      const body = await req.clone().text();
      assert.equal(await verifyTelegramJob({
        secret: ENV.OASIS_TELEGRAM_JOB_SIGNING_SECRET!,
        timestamp: req.headers.get("x-oasis-telegram-job-timestamp"),
        signature: req.headers.get("x-oasis-telegram-job-signature"),
        body,
        nowMs: Date.now(),
      }), true);
      return new Response("{}", { status: JSON.parse(body).id === "a" ? 200 : 503 });
    },
  );
  assert.deepEqual(result, { acked: 1, retried: 1 });
  assert.deepEqual(acked, ["a"]);
  assert.deepEqual(retried, ["b"]);
  assert.equal(new URL(seen[0].url).pathname, "/api/webhooks/oasis-telegram/jobs");
});

await check("queue-job HMAC refuses wrong, tampered, expired, future, missing, malformed and truncated proofs", async () => {
  const body = JSON.stringify(parsedJob(25));
  const nowSec = Math.floor(NOW.getTime() / 1000);
  const timestamp = String(nowSec);
  const signature = await signTelegramJob(ENV.OASIS_TELEGRAM_JOB_SIGNING_SECRET!, timestamp, body);
  const verify = (overrides: Partial<Parameters<typeof verifyTelegramJob>[0]> = {}) => verifyTelegramJob({
    secret: ENV.OASIS_TELEGRAM_JOB_SIGNING_SECRET!,
    timestamp,
    signature,
    body,
    nowMs: NOW.getTime(),
    ...overrides,
  });

  assert.equal(await verify(), true, "the exact proof is accepted");
  assert.equal(await verify({ secret: "wrong-job-secret" }), false, "wrong secret");
  assert.equal(await verify({ body: `${body} ` }), false, "tampered body");

  const expiredTimestamp = String(nowSec - TELEGRAM_JOB_SIGNATURE_MAX_AGE_SEC - 1);
  assert.equal(await verify({
    timestamp: expiredTimestamp,
    signature: await signTelegramJob(ENV.OASIS_TELEGRAM_JOB_SIGNING_SECRET!, expiredTimestamp, body),
  }), false, "expired timestamp");

  const futureTimestamp = String(nowSec + 1);
  assert.equal(await verify({
    timestamp: futureTimestamp,
    signature: await signTelegramJob(ENV.OASIS_TELEGRAM_JOB_SIGNING_SECRET!, futureTimestamp, body),
  }), false, "even a correctly signed future timestamp is refused");

  for (const missing of [{ secret: null }, { timestamp: null }, { signature: null }]) {
    assert.equal(await verify(missing), false, `missing ${Object.keys(missing)[0]}`);
  }
  for (const malformed of ["not-a-time", "-1", "1234567890123"]) {
    assert.equal(await verify({ timestamp: malformed }), false, `malformed timestamp ${malformed}`);
  }
  assert.equal(await verify({ signature: "not-a-telegram-job-proof" }), false, "malformed signature");
  assert.equal(await verify({ signature: signature.slice(0, -2) }), false, "truncated signature");
});

await check("one update infers and replies once; retries read the terminal receipt", async () => {
  const job = parsedJob(30);
  await ensureTelegramReceipt(db, job, NOW);
  let turns = 0;
  let sends = 0;
  const deps = {
    db,
    config: { webhookSecret: "w", jobSigningSecret: "j", botToken: ENV.OASIS_TELEGRAM_BOT_TOKEN!, botId: BOT_ID, chatId: CHAT },
    now: () => NOW,
    deviceTurn: async () => { turns += 1; return { outcome: "completed" as const, text: "The hot lead needs your reply." }; },
    sendReply: async () => { sends += 1; return { outcome: "sent" as const, messageId: 9001 }; },
  };
  assert.deepEqual(await runOasisTelegramJob(job, deps), { outcome: "sent", telegramMessageId: 9001, noComputer: false });
  assert.deepEqual(await runOasisTelegramJob(job, deps), { outcome: "duplicate", state: "sent" });
  assert.deepEqual({ turns, sends }, { turns: 1, sends: 1 });
});

await check("no exact online pairing gets the one deterministic Telegram reply", async () => {
  const job = parsedJob(31);
  await ensureTelegramReceipt(db, job, NOW);
  let text = "";
  const outcome = await runOasisTelegramJob(job, {
    db,
    config: { webhookSecret: "w", jobSigningSecret: "j", botToken: ENV.OASIS_TELEGRAM_BOT_TOKEN!, botId: BOT_ID, chatId: CHAT },
    now: () => NOW,
    deviceTurn: async () => ({ outcome: "no_computer", reason: "computer_offline" }),
    sendReply: async (input) => { text = input.text; return { outcome: "sent", messageId: 9002 }; },
  });
  assert.deepEqual(outcome, { outcome: "sent", telegramMessageId: 9002, noComputer: true });
  assert.equal(text, NO_PAIRED_COMPUTER_REPLY);
});

await check("a known rejection retries the saved reply without a second inference", async () => {
  const job = parsedJob(32);
  await ensureTelegramReceipt(db, job, NOW);
  let turns = 0;
  let sends = 0;
  const deps = {
    db,
    config: { webhookSecret: "w", jobSigningSecret: "j", botToken: ENV.OASIS_TELEGRAM_BOT_TOKEN!, botId: BOT_ID, chatId: CHAT },
    now: () => NOW,
    deviceTurn: async () => { turns += 1; return { outcome: "completed" as const, text: "Saved once" }; },
    sendReply: async () => { sends += 1; return sends === 1
      ? { outcome: "rejected" as const, reason: "telegram_rejected:retry later" }
      : { outcome: "sent" as const, messageId: 9003 }; },
  };
  assert.equal((await runOasisTelegramJob(job, deps)).outcome, "retry");
  assert.equal((await runOasisTelegramJob(job, deps)).outcome, "sent");
  assert.deepEqual({ turns, sends }, { turns: 1, sends: 2 });
});

await check("an ambiguous outbound result is terminal and can never duplicate the reply", async () => {
  const job = parsedJob(33);
  await ensureTelegramReceipt(db, job, NOW);
  let sends = 0;
  const deps = {
    db,
    config: { webhookSecret: "w", jobSigningSecret: "j", botToken: ENV.OASIS_TELEGRAM_BOT_TOKEN!, botId: BOT_ID, chatId: CHAT },
    now: () => NOW,
    deviceTurn: async () => ({ outcome: "completed" as const, text: "Maybe delivered" }),
    sendReply: async () => { sends += 1; return { outcome: "ambiguous" as const, reason: "network_unknown" }; },
  };
  assert.deepEqual(await runOasisTelegramJob(job, deps), { outcome: "delivery_unknown" });
  assert.deepEqual(await runOasisTelegramJob(job, deps), { outcome: "duplicate", state: "delivery_unknown" });
  assert.equal(sends, 1);
});

await check("the exact-device lane forces fallback=none and stable department_task_v2 run IDs", async () => {
  const job = parsedJob(40, "Run the handover");
  const session = deviceSession("cli", "codex");
  let sentArgs: Record<string, unknown> | null = null;
  const result = await runOasisTelegramDeviceTurn(db, job, {
    resolveContext: async () => ({
      ok: true,
      context: {
        session,
        engine: { kind: "cli", cli: "codex", pairingId: "pair-mac", fallback: "workspace_api" },
        agentSlug: "bravo",
        userId: "auth-cc",
      },
    }),
    executor: (() => ({ scope: session.scope })) as never,
    send: (async (args: Record<string, unknown>) => {
      sentArgs = args;
      return new Response('event: end\ndata: {"final_text":"Done from the Mac"}\n\n', { status: 200 });
    }) as never,
  });
  assert.deepEqual(result, { outcome: "completed", text: "Done from the Mac" });
  assert.deepEqual((sentArgs!.computerDispatch as { fallback: string }).fallback, "none");
  assert.equal(sentArgs!.apiAccountSnapshot, null);
  assert.equal(sentArgs!.fallbackFrom, null);
  assert.equal(sentArgs!.fallbackReason, null);
  assert.equal("computerFallbackDeps" in sentArgs!, false);
  const identity = sentArgs!.idempotency;
  assert.deepEqual(identity, telegramDeviceRunIdentity("auth-cc", job));
  assert.deepEqual(identity, telegramDeviceRunIdentity("auth-cc", job), "a queue retry follows one persisted run");

  const noAnswer = await runOasisTelegramDeviceTurn(db, job, {
    resolveContext: async () => ({
      ok: true,
      context: {
        session,
        engine: { kind: "cli", cli: "codex", pairingId: "pair-mac", fallback: "workspace_api" },
        agentSlug: "bravo",
        userId: "auth-cc",
      },
    }),
    executor: (() => ({ scope: session.scope })) as never,
    send: (async () => new Response(
      'event: end\ndata: {"error_code":"computer_not_answering"}\n\n',
      { status: 200 },
    )) as never,
  });
  assert.deepEqual(noAnswer, { outcome: "no_computer", reason: "computer_not_answering" });

  const openCodeSession = deviceSession("cli", "opencode");
  const openCode = await runOasisTelegramDeviceTurn(db, job, {
    resolveContext: async () => ({
      ok: true,
      context: {
        session: openCodeSession,
        engine: { kind: "cli", cli: "opencode", pairingId: "pair-mac", fallback: "none" },
        agentSlug: "bravo",
        userId: "auth-cc",
      },
    }),
    executor: (() => ({ scope: openCodeSession.scope })) as never,
    send: (async () => new Response('event: end\ndata: {"final_text":"Done through OpenCode/Kimi"}\n\n', { status: 200 })) as never,
  });
  assert.deepEqual(openCode, { outcome: "completed", text: "Done through OpenCode/Kimi" });
});

await check("stale Claude, API, local and unknown choices are refused before session resolution or dispatch", async () => {
  const job = parsedJob(41, "Do not dispatch this");
  const candidates = [
    { label: "claude", engine: { kind: "cli", cli: "claude", pairingId: "pair-mac", fallback: "none" }, session: deviceSession("cli", "claude") },
    { label: "api", engine: { kind: "api", provider: "openai", pairingId: "pair-mac" }, session: deviceSession("local", undefined) },
    { label: "local", engine: { kind: "local", model: "ollama/kimi", pairingId: "pair-mac", fallback: "none" }, session: deviceSession("local", "ollama/kimi") },
    { label: "unknown", engine: { kind: "future", model: "future-engine", pairingId: "pair-mac" }, session: deviceSession("local", "future-engine") },
  ] as const;
  let dispatched = 0;
  for (const candidate of candidates) {
    const result = await runOasisTelegramDeviceTurn(db, job, {
      resolveContext: async () => ({
        ok: true,
        context: {
          session: candidate.session,
          engine: candidate.engine as never,
          agentSlug: "bravo",
          userId: "auth-cc",
        },
      }),
      executor: (() => { dispatched += 1; return {}; }) as never,
      send: (async () => { dispatched += 1; return new Response("unexpected"); }) as never,
    });
    assert.deepEqual(result, { outcome: "no_computer", reason: "saved_engine_not_supported" }, candidate.label);
  }
  assert.equal(dispatched, 0, "unsupported saved choices never reach executor or send");

  const source = readFileSync("lib/telegram/device-turn.ts", "utf8");
  const savedEngineGate = source.indexOf("isOasisTelegramDeviceEngine(canonical.engine)");
  const sessionResolution = source.indexOf("const resolved = await resolveRunSession(");
  assert.ok(savedEngineGate >= 0 && savedEngineGate < sessionResolution, "the saved-engine gate runs before session resolution");
});

await check("cutover documentation keeps polling and webhook mutually exclusive", () => {
  const docs = readFileSync("docs/TELEGRAM_WEBHOOK_CUTOVER.md", "utf8");
  assert.match(docs, /Stop the one Windows poller before calling Telegram `setWebhook`/);
  assert.match(docs, /Never run polling and a webhook for the same bot together/);
  assert.match(docs, /TELEGRAM_WEBHOOK_ENABLED=off/);
  const wrangler = readFileSync("wrangler.jsonc", "utf8");
  assert.match(wrangler, /"binding": "TELEGRAM_AGENT_JOBS", "queue": "oasis-telegram-agent-jobs"/);
  assert.match(wrangler, /"dead_letter_queue": "oasis-telegram-agent-jobs-dlq"/);
  assert.match(wrangler, /"retry_delay": 30/);
  assert.match(docs, /exhaust retries.*oasis-telegram-agent-jobs-dlq/s);
  const worker = readFileSync("worker-entry.ts", "utf8");
  assert.match(worker, /routeQueueBatch\(batch, full/);
  const jobsRoute = readFileSync("app/api/webhooks/oasis-telegram/jobs/route.ts", "utf8");
  assert.match(jobsRoute, /job\.botId !== config\.botId/, "a queued job from a replaced bot is terminally dropped");
});

db.close();
console.log(`oasis telegram webhook: ${checks}/${checks} checks passed`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
