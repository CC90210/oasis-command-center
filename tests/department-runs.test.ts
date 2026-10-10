/**
 * department-runs.test.ts - a department channel message is a RUN that outlives
 * the page (lib/os/runs/*, migration bravo__207).
 *
 * WHY (CC, 2026-10-10: "it doesn't let me send more messages while it's
 * thinking... Users should be able to click off it and the chat is still there
 * and saved... run a prompt, check your Schedule or Playbook, come back, and
 * it's still working"). What must hold:
 *   - the run is finished by a server-side driver, not by the browser: the
 *     browser leaving (its response cancelled) changes nothing, and a page that
 *     comes back replays the saved events in order, then follows live;
 *   - messages sent while it works queue and run in order, one model call each;
 *     Stop ends the current run with a `cancelled` ledger row; a queued run that
 *     never ran writes no ledger row at all;
 *   - conversations are private to the person AND the workspace;
 *   - what the browser can read is plain: lookups by label, no persona names, no
 *     credentials, no raw provider JSON, reasoning only for those who may see
 *     it and never saved;
 *   - a producer (the paired computer's bridge) can write the same events with a
 *     run-scoped credential, idempotently, and never into another workspace.
 * Real libSQL (a temp file with bravo__192 and bravo__207 applied); the model is
 * a scripted stream under the real meter and the real bridge-turn ledger wrapper.
 *
 * Run: node --conditions=react-server --import tsx tests/department-runs.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";

const ROOT = process.cwd();
const dbFile = join(mkdtempSync(join(tmpdir(), "department-runs-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
// A credential-shaped env value (lib/secret-redaction.ts snapshots these on first use).
const ENV_SECRET = "sk-runs-env-secret-0123456789abcdef";
process.env.RUNS_FIXTURE_API_KEY = ENV_SECRET;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "department-runs-field-key-long-enough-0001";
const RUN_KEY = "test-run-signing-key-0123456789-abcdefghij";

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});

const ACME = "a1a1a1a1-0000-4000-8000-0000000000a1";
const ZETA = "b2b2b2b2-0000-4000-8000-0000000000b2";
const ANN = "0e000000-0000-4000-8000-000000000001";
const BEN = "0e000000-0000-4000-8000-000000000002";

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

/** scripts/apply_turso_migration.py split_statements: a trigger body stays one statement. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let depth = 0;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("--")) continue;
    buf.push(line);
    const upper = stripped.toUpperCase();
    if (/\bBEGIN\b/.test(upper)) depth += 1;
    if (/\bEND\s*;/.test(upper)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        out.push(buf.join("\n").trim().replace(/;$/, "").trim());
        buf = [];
        continue;
      }
    }
    if (depth === 0 && stripped.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, "").trim());
      buf = [];
    }
  }
  const tail = buf.join("\n").trim().replace(/;$/, "").trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null | false | undefined>, ms = 6000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

const realError = console.error;
const logged: unknown[][] = [];
console.error = (...args: unknown[]) => void logged.push(args);

async function main() {
  const db: Client = createClient({ url: `file:${dbFile}` });
  for (const file of ["bravo__192_ai_usage.sql", "bravo__207_department_chat_runs.sql"]) {
    for (const stmt of splitStatements(readFileSync(join(ROOT, "database", "turso", file), "utf8"))) await db.execute(stmt);
  }
  await db.executeMultiple(`
    CREATE TABLE tenant_integration_credentials (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      service TEXT, field_key TEXT, encrypted_value TEXT, created_at TEXT, updated_at TEXT);
  `);

  const store = await import("../lib/os/runs/store");
  const exec = await import("../lib/os/runs/executor");
  const follow = await import("../lib/os/runs/follow");
  const send = await import("../lib/os/runs/send");
  const reduce = await import("../lib/os/runs/reduce");
  const types = await import("../lib/os/runs/types");
  const activity = await import("../lib/os/runs/activity");
  const producer = await import("../lib/os/runs/producer");
  const auth = await import("../lib/os/runs/producer-auth");
  const transcript = await import("../lib/os/runs/transcript");
  const usage = await import("../lib/ai/usage");
  const agent = await import("../lib/os/department-agent");
  const identity = await import("../lib/os/channel/identity");
  type StreamEvent = import("../lib/providers").StreamEvent;
  type ExecutorDeps = import("../lib/os/runs/executor").ExecutorDeps;
  type Run = import("../lib/os/runs/store").Run;

  const scopeA = { tenantId: ACME, userId: ANN };
  const scopeB = { tenantId: ACME, userId: BEN };
  const scopeZ = { tenantId: ZETA, userId: ANN };

  // ── The scripted model ──────────────────────────────────────────────────
  type Step = StreamEvent | { wait: number };
  const started: string[] = [];
  const histories: string[][] = [];
  const outcomes: Array<{ ok: boolean; code: string | null }> = [];
  let script: Step[] = [];
  let scriptFor: ((run: Run) => Step[]) | null = null;

  function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
  }

  function depsFor(scope = scopeA, extra: Partial<ExecutorDeps> = {}): ExecutorDeps {
    return {
      db,
      scope,
      departmentLabel: "Sales",
      heartbeatMs: 20,
      startTurn: async ({ run, messages, signal }) => {
        started.push(run.userText);
        histories.push(messages.map((m) => `${m.role}: ${m.content}`));
        const steps = scriptFor ? scriptFor(run) : script;
        async function* inner(): AsyncGenerator<StreamEvent> {
          for (const s of steps) {
            if ("wait" in s) {
              await abortableSleep(s.wait, signal);
              if (signal.aborted) {
                yield { type: "error", message: "bridge_unreachable:AbortError" };
                return;
              }
              continue;
            }
            yield s;
          }
        }
        const meter = usage.modelCallMeter({
          tenantId: scope.tenantId,
          surface: "agents.chat",
          ...usage.billingForBridge({ kind: "cli" }),
          departmentKey: "sales",
          teammateId: "sdr",
          userId: scope.userId,
        });
        return {
          ok: true,
          agent: { display_name: "Sales", department: "sales" },
          channelKey: "department:sales",
          agentSlug: "sdr",
          failureModel: () => null,
          stream: agent.meteredBridgeTurn(meter, { kind: "cli", cli: "claude" }, inner(), { maxOutputTokens: 100, promptBytes: 10 }, signal),
        };
      },
      recordOutcome: async (o) => void outcomes.push({ ok: o.ok, code: o.code }),
      ...extra,
    };
  }

  const ledger = async (tenant = ACME) =>
    (await db.execute({ sql: "SELECT outcome, error_code FROM ai_usage_events WHERE tenant_id = ? AND surface = 'agents.chat' ORDER BY id", args: [tenant] })).rows.map((r) => ({ ...r }));
  const resetLedger = async () => {
    await db.execute("DELETE FROM ai_usage_events");
    started.length = 0;
    histories.length = 0;
    outcomes.length = 0;
  };
  const keepRecorder: Array<Promise<unknown>> = [];
  const keep = async (p: Promise<unknown>) => {
    keepRecorder.push(p);
    return "detached" as const;
  };

  const now = () => new Date();
  const frameSeqs = (frames: Array<{ type: string; event?: { seq: number } }>) => frames.filter((f) => f.type === "event").map((f) => f.event!.seq);
  async function collect(gen: AsyncGenerator<import("../lib/os/runs/follow").Frame>, stopAfter = Infinity) {
    const out: import("../lib/os/runs/follow").Frame[] = [];
    for await (const f of gen) {
      out.push(f);
      if (out.length >= stopAfter) break;
    }
    return out;
  }
  const SAY: Step[] = [
    { type: "tool", phase: "start", label: "Pipeline", ok: null },
    { wait: 40 },
    { type: "tool", phase: "done", label: "Pipeline", ok: true, detail: "12 leads" },
    { type: "delta", text: "Twelve leads. " },
    { wait: 40 },
    { type: "delta", text: "Two need a call." },
    { type: "done", inputTokens: 10, outputTokens: 7 },
  ];

  console.log("Conversations are private to the person and the workspace");
  await check("a conversation is listed, read, renamed and deleted only by the person in the workspace that has it", async () => {
    const conv = await store.createConversation(db, scopeA, { department: "sales", agentSlug: "sdr", now: now() });
    const queued = await store.enqueueRun(db, scopeA, { conversationId: conv.id, text: "How is the pipeline", chatMode: "build", showThinking: false, now: now() });
    assert.ok(queued.ok);
    const runId = queued.ok ? queued.run.id : "";
    assert.equal((await store.listConversations(db, scopeA, "sales")).length >= 1, true);
    for (const stranger of [scopeB, scopeZ]) {
      assert.deepEqual(await store.listConversations(db, stranger, "sales"), [], "the list leaked");
      assert.equal(await store.getConversation(db, stranger, conv.id), null, "the conversation leaked");
      assert.equal(await store.getRun(db, stranger, runId), null, "the run leaked");
      assert.equal(await store.renameConversation(db, stranger, conv.id, "mine now", now()), false, "renamed by a stranger");
      assert.equal(await store.deleteConversation(db, stranger, conv.id), false, "deleted by a stranger");
      assert.equal(await store.requestCancel(db, stranger, runId, now()), "not_found", "a stranger stopped the run");
      assert.deepEqual(await store.readEvents(db, stranger, runId, 0), []);
      assert.equal((await store.enqueueRun(db, stranger, { conversationId: conv.id, text: "hi", chatMode: "build", showThinking: false, now: now() })).ok, false, "a stranger queued into it");
      assert.equal(await transcript.buildTranscript(db, stranger, conv.id), null);
    }
    assert.equal(await store.renameConversation(db, scopeA, conv.id, "Pipeline check", now()), true);
    assert.equal((await store.getConversation(db, scopeA, conv.id))?.title, "Pipeline check");
    assert.equal(await store.deleteConversation(db, scopeA, conv.id), true);
    assert.equal(await store.getConversation(db, scopeA, conv.id), null);
    assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM dept_chat_runs WHERE conversation_id = ?", args: [conv.id] })).rows[0].n, 0);
  });
  await check("the first message names a conversation, and a user's own name survives later messages", async () => {
    const conv = await store.createConversation(db, scopeA, { department: "sales", agentSlug: "sdr", now: now() });
    await store.enqueueRun(db, scopeA, { conversationId: conv.id, text: "  What is\n happening   in the pipeline  ", chatMode: "build", showThinking: false, now: now() });
    assert.equal((await store.getConversation(db, scopeA, conv.id))?.title, "What is happening in the pipeline");
    await store.renameConversation(db, scopeA, conv.id, "Mine", now());
    await store.enqueueRun(db, scopeA, { conversationId: conv.id, text: "second", chatMode: "build", showThinking: false, now: now() });
    assert.equal((await store.getConversation(db, scopeA, conv.id))?.title, "Mine");
  });

  console.log("A run outlives the page");
  await check("the browser leaving does not stop the run: it finishes, is saved, and a page that comes back replays it in order", async () => {
    await resetLedger();
    script = [{ type: "thinking", text: "Checking the pipeline first. " }, ...SAY];
    const res = await send.sendMessage({
      db,
      deps: depsFor(),
      showThinking: true,
      input: { department: "sales", agentSlug: "sdr", text: "How is the pipeline?", conversationId: "", chatMode: "build" },
      keep,
      pollMs: () => 15,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    // The browser reads a little... then leaves (a navigation cancels the response body).
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!/event: ev\ndata: .*"kind":"tool"/.test(seen)) {
      const { value, done } = await reader.read();
      assert.ok(!done, "the stream ended before the run's first step");
      seen += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    // The run is still going when the browser is gone; it finishes on its own.
    const conv = (await db.execute("SELECT id FROM dept_chat_conversations ORDER BY created_at DESC LIMIT 1")).rows[0].id as string;
    const run = await until("the run to finish", async () => {
      const runs = await store.listRuns(db, scopeA, conv);
      return runs[0] && types.isTerminalStatus(runs[0].status) ? runs[0] : null;
    });
    assert.equal(run.status, "done");
    assert.equal(run.finalText, "Twelve leads. Two need a call.");
    assert.deepEqual(await ledger(), [{ outcome: "ok", error_code: null }], "one ledger row for the one turn");
    assert.deepEqual(outcomes, [{ ok: true, code: null }], "the channel's last turn was recorded");
    // A page that comes back replays the saved events in order and ends with the answer.
    const frames = await collect(follow.followRun({ db, scope: scopeA, runId: run.id, afterSeq: 0, pollMs: () => 5 }));
    const seqs = frameSeqs(frames as never);
    assert.ok(seqs.length >= 5, `only ${seqs.length} events replayed`);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "events replayed out of order");
    assert.equal(new Set(seqs).size, seqs.length, "an event was replayed twice");
    const end = frames[frames.length - 1];
    assert.equal(end.type, "end");
    assert.equal(end.type === "end" && end.run.finalText, "Twelve leads. Two need a call.");
    const view = reduce.reduceRunEvents(frames.filter((f) => f.type === "event").map((f) => (f as { event: never }).event));
    assert.equal(view.finished, "done");
    assert.deepEqual(
      view.steps.map((s) => (s.kind === "tool" ? [s.label, s.state, s.detail] : ["thinking"])),
      [["Looking up Pipeline", "ok", "12 leads"]],
      "the trail replays the lookup (reasoning is never saved)",
    );
    assert.ok(keepRecorder.length >= 1, "the driver was handed to the platform");
  });
  await check("a page that attaches mid-run follows from the last event it saw, with no gap and no repeat", async () => {
    await resetLedger();
    script = [{ type: "delta", text: "One. " }, { wait: 60 }, { type: "delta", text: "Two. " }, { wait: 60 }, { type: "delta", text: "Three." }, { type: "done", inputTokens: 1, outputTokens: 1 }];
    const conv = await store.createConversation(db, scopeA, { department: "sales", agentSlug: "sdr", now: now() });
    const q = await store.enqueueRun(db, scopeA, { conversationId: conv.id, text: "count", chatMode: "build", showThinking: false, now: now() });
    assert.ok(q.ok);
    const runId = q.ok ? q.run.id : "";
    const driving = exec.driveConversation(depsFor(), conv.id);
    const first = await collect(follow.followRun({ db, scope: scopeA, runId, afterSeq: 0, pollMs: () => 10 }), 4);
    const last = Math.max(...frameSeqs(first as never));
    const rest = await collect(follow.followRun({ db, scope: scopeA, runId, afterSeq: last, pollMs: () => 10 }));
    await driving;
    const all = [...frameSeqs(first as never), ...frameSeqs(rest as never)];
    assert.deepEqual(all, [...new Set(all)].sort((a, b) => a - b), "gap-free order broke across the re-attach");
    const end = rest[rest.length - 1];
    assert.equal(end.type === "end" && end.run.finalText, "One. Two. Three.");
  });

  console.log("Queue and Stop");
  await check("messages sent while it works queue, run in order, each with the answers before it, and the sixth waiting is refused", async () => {
    await resetLedger();
    scriptFor = (run) => [{ wait: 60 }, { type: "delta", text: `answer to ${run.userText}` }, { type: "done", inputTokens: 1, outputTokens: 1 }];
    const input = (text: string, conversationId: string) => ({ department: "sales", agentSlug: "sdr", text, conversationId, chatMode: "build" as const });
    const first = await send.sendMessage({ db, deps: depsFor(), showThinking: false, input: input("one", ""), keep, pollMs: () => 10 });
    const conv = (await db.execute("SELECT id FROM dept_chat_conversations ORDER BY created_at DESC LIMIT 1")).rows[0].id as string;
    await until("the first run to start", async () => (await store.listRuns(db, scopeA, conv))[0]?.status === "running");
    const codes: number[] = [];
    for (const t of ["two", "three", "four", "five", "six", "seven"]) {
      codes.push((await send.sendMessage({ db, deps: depsFor(), showThinking: false, input: input(t, conv), keep, pollMs: () => 10 })).status);
    }
    assert.deepEqual(codes, [202, 202, 202, 202, 202, 429], "five may wait; the sixth is refused");
    assert.deepEqual((await store.listRuns(db, scopeA, conv)).map((r) => r.status), ["running", "queued", "queued", "queued", "queued", "queued"]);
    // The sender's own stream follows the whole queue to its end.
    const text = await first.text();
    assert.deepEqual(started, ["one", "two", "three", "four", "five", "six"], "ran out of order");
    assert.match(text, /answer to six/);
    assert.deepEqual((await store.listRuns(db, scopeA, conv)).map((r) => r.status), ["done", "done", "done", "done", "done", "done"]);
    assert.ok(histories[2].some((h) => h === "user: one") && histories[2].some((h) => h === "assistant: answer to two"), "a run did not see the conversation before it");
    assert.equal((await ledger()).length, 6, "exactly one ledger row per run that ran");
    scriptFor = null;
  });
  await check("Stop ends the current run with a cancelled ledger row and keeps its partial answer; the queue behind it still runs; a queued run stopped before it started writes nothing", async () => {
    await resetLedger();
    scriptFor = (run) =>
      run.userText === "slow"
        ? [{ type: "delta", text: "Starting. " }, { wait: 5000 }, { type: "delta", text: "never" }, { type: "done", inputTokens: 1, outputTokens: 1 }]
        : [{ type: "delta", text: "quick" }, { type: "done", inputTokens: 1, outputTokens: 1 }];
    const input = (text: string, conversationId: string) => ({ department: "sales", agentSlug: "sdr", text, conversationId, chatMode: "build" as const });
    const res = await send.sendMessage({ db, deps: depsFor(), showThinking: false, input: input("slow", ""), keep, pollMs: () => 10 });
    const conv = (await db.execute("SELECT id FROM dept_chat_conversations ORDER BY created_at DESC LIMIT 1")).rows[0].id as string;
    await until("the slow run to be writing", async () => {
      const r = (await store.listRuns(db, scopeA, conv))[0];
      return r?.status === "running" && (await store.readEvents(db, scopeA, r.id, 0)).some((e) => e.kind === "delta" || e.kind === "agent");
    });
    await send.sendMessage({ db, deps: depsFor(), showThinking: false, input: input("after", conv), keep, pollMs: () => 10 });
    const doomed = await send.sendMessage({ db, deps: depsFor(), showThinking: false, input: input("doomed", conv), keep, pollMs: () => 10 });
    assert.equal(doomed.status, 202);
    const runs = await store.listRuns(db, scopeA, conv);
    assert.deepEqual(runs.map((r) => r.status), ["running", "queued", "queued"]);
    assert.equal(await store.requestCancel(db, scopeA, runs[2].id, now()), "cancelled", "a queued run is cancelled on the spot");
    assert.equal(await store.requestCancel(db, scopeA, runs[0].id, now()), "requested");
    await res.text(); // the sender's stream ends when the queue is empty
    const after = await store.listRuns(db, scopeA, conv);
    assert.deepEqual(after.map((r) => r.status), ["cancelled", "done", "cancelled"]);
    assert.equal(after[0].finalText?.trim(), "Starting.", "the partial answer is kept");
    assert.deepEqual(started, ["slow", "after"], "the stopped queued run was never started");
    assert.deepEqual(
      (await ledger()).map((r) => r.outcome).sort(),
      ["cancelled", "ok"],
      "the stopped run writes cancelled; the queued run that never ran writes nothing",
    );
    assert.deepEqual(outcomes, [{ ok: true, code: null }], "a Stop is not a verdict on the channel");
    scriptFor = null;
  });
  await check("a run whose driver died is closed as interrupted, with its partial answer, so the queue behind it can run", async () => {
    const conv = await store.createConversation(db, scopeA, { department: "sales", agentSlug: "sdr", now: now() });
    const a = await store.enqueueRun(db, scopeA, { conversationId: conv.id, text: "dead", chatMode: "build", showThinking: false, now: now() });
    const b = await store.enqueueRun(db, scopeA, { conversationId: conv.id, text: "next", chatMode: "build", showThinking: false, now: now() });
    assert.ok(a.ok && b.ok);
    const run = await store.claimNextRun(db, scopeA, conv.id, "lease-dead", now());
    assert.ok(run);
    await store.appendEvents(db, scopeA, run!.id, [{ seq: 1, kind: "delta", data: { text: "half an ans" } }], now());
    // Two runs cannot run at once: the second claim finds the first running.
    assert.equal(await store.claimNextRun(db, scopeA, conv.id, "lease-two", now()), null);
    const later = new Date(Date.now() + types.RUN_STALE_MS + 1000);
    assert.deepEqual(await store.reapStale(db, scopeA, conv.id, later), [run!.id]);
    const closed = await store.getRun(db, scopeA, run!.id);
    assert.equal(closed?.status, "interrupted");
    assert.equal(closed?.finalText, "half an ans");
    const evs = await store.readEvents(db, scopeA, run!.id, 0);
    assert.deepEqual(evs.slice(-2).map((e) => e.kind), ["error", "done"], "a follower is told it ended");
    assert.ok(await store.claimNextRun(db, scopeA, conv.id, "lease-next", now()), "the queue behind it can run now");
    // The dead driver cannot overwrite what was decided without it.
    assert.equal(
      await store.finishRun(db, scopeA, run!.id, "lease-dead", { status: "done", finalText: "x", errorCode: null, inputTokens: null, outputTokens: null, agent: null, now: now() }),
      false,
    );
  });

  console.log("What the browser may read");
  await check("lookups show by label and result line; reasoning only for those who may see it, and never saved; no persona names, credentials or raw JSON", async () => {
    await resetLedger();
    const risky: Step[] = [
      { type: "thinking", text: `As Bravo I should look; the key is ${ENV_SECRET}. ` },
      { wait: 250 },
      { type: "tool", phase: "start", label: "Pipeline", ok: null },
      { type: "tool", phase: "done", label: "Pipeline", ok: true, detail: `12 leads (Maven noted ${ENV_SECRET})`, size: 4096 },
      { wait: 200 },
      { type: "delta", text: `Hello. The token is ${ENV_SECRET}.` },
      { type: "done", inputTokens: 1, outputTokens: 1 },
    ];
    for (const show of [false, true]) {
      script = risky;
      const conv = await store.createConversation(db, scopeA, { department: "sales", agentSlug: "sdr", now: now() });
      const q = await store.enqueueRun(db, scopeA, { conversationId: conv.id, text: "go", chatMode: "build", showThinking: show, now: now() });
      assert.ok(q.ok);
      const runId = q.ok ? q.run.id : "";
      const driving = exec.driveConversation(depsFor(), conv.id);
      // While it works, reasoning is there for the person who may see it.
      const live = await collect(follow.followRun({ db, scope: scopeA, runId, afterSeq: 0, pollMs: () => 5 }));
      await driving;
      const liveKinds = new Set(frameSeqs(live as never).length ? live.filter((f) => f.type === "event").map((f) => (f as { event: { kind: string } }).event.kind) : []);
      const stored = (await store.readEvents(db, scopeA, runId, 0)).map((e) => JSON.stringify(e));
      const everything = stored.join("\n") + JSON.stringify(live.filter((f) => f.type === "end"));
      assert.ok(!everything.includes(ENV_SECRET), `a credential reached the browser (show=${show})`);
      assert.ok(!identity.namesPersona(everything), `a persona name reached the browser (show=${show}): ${everything.match(identity.PERSONA_NAME_PATTERN)?.[0]}`);
      assert.ok(!/"input"|"args"|"summary"|"raw_name"|anthropic|gemini_|"type":"tool_use"/i.test(everything), "raw provider fields reached the browser");
      assert.equal(liveKinds.has("thinking"), show, show ? "the reasoning never showed" : "reasoning reached a person who may not see it");
      // Saved: the trail and the answer, never the reasoning.
      assert.ok(!stored.some((s) => s.includes('"kind":"thinking"')), "reasoning was saved");
      const t = await transcript.buildTranscript(db, scopeA, conv.id);
      assert.ok(!JSON.stringify(t).includes(ENV_SECRET));
      assert.equal(t?.runs[0].events.some((e) => e.kind === "thinking" || e.kind === "delta"), false, "the transcript holds reasoning or reply fragments");
      const result = t?.runs[0].events.find((e) => e.kind === "tool" && e.data.phase === "done");
      assert.match(String(result?.data.detail), /^12 leads \(the Sales department noted /, "the lookup's result line was not kept, or not scrubbed");
      assert.equal(result?.data.size, 4096);
    }
  });
  await check("a failed turn is the run's failure in one plain sentence with a code, and is the channel's last turn", async () => {
    await resetLedger();
    script = [{ type: "delta", text: "Partial. " }, { type: "error", message: "anthropic_401:{\"error\":\"invalid x-api-key sk-secret\"}" }];
    const conv = await store.createConversation(db, scopeA, { department: "sales", agentSlug: "sdr", now: now() });
    await store.enqueueRun(db, scopeA, { conversationId: conv.id, text: "fail", chatMode: "build", showThinking: false, now: now() });
    await exec.driveConversation(depsFor(), conv.id);
    const run = (await store.listRuns(db, scopeA, conv.id))[0];
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "provider_401");
    assert.equal(run.finalText, "Partial. ");
    const evs = await store.readEvents(db, scopeA, run.id, 0);
    const err = evs.find((e) => e.kind === "error");
    assert.equal(err?.data.code, "provider_401");
    assert.ok(!JSON.stringify(evs).includes("sk-secret") && !JSON.stringify(evs).includes("anthropic_401"), "the provider's own text reached the browser");
    assert.deepEqual(outcomes, [{ ok: false, code: "provider_401" }]);
    assert.deepEqual((await ledger()).map((r) => r.outcome), ["error"]);
  });
  await check("a refusal before any model is asked (no AI account) fails the run with its code and writes no model row", async () => {
    await resetLedger();
    const conv = await store.createConversation(db, scopeA, { department: "sales", agentSlug: "sdr", now: now() });
    await store.enqueueRun(db, scopeA, { conversationId: conv.id, text: "hello", chatMode: "build", showThinking: false, now: now() });
    await exec.driveConversation(
      depsFor(scopeA, { startTurn: async () => ({ ok: false, status: 412, error: "agent_not_configured" }) }),
      conv.id,
    );
    const run = (await store.listRuns(db, scopeA, conv.id))[0];
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "agent_not_configured");
    assert.deepEqual(await ledger(), []);
    assert.deepEqual(outcomes, [], "no key was tried: not a verdict on the channel");
  });

  console.log("The view and the trail words");
  await check("replaying an event is harmless, steps pair by id, and finished steps read in the past tense", () => {
    const evs: import("../lib/os/runs/types").RunEvent[] = [
      { seq: 1, kind: "tool", data: { id: "t1", phase: "start", label: "Looking up Pipeline", ok: null } },
      { seq: 2, kind: "tool", data: { id: "t1", phase: "done", ok: true, detail: "12 leads" } },
      { seq: 3, kind: "delta", data: { text: "Hi" } },
    ];
    const once = reduce.reduceRunEvents(evs);
    const twice = reduce.reduceRunEvents(evs, once);
    assert.deepEqual(twice, once, "a replayed event changed the view");
    assert.deepEqual(once.steps, [{ kind: "tool", id: "t1", label: "Looking up Pipeline", state: "ok", detail: "12 leads", size: null }]);
    assert.equal(reduce.pastTense("Looking up Pipeline"), "Looked up Pipeline");
    assert.equal(reduce.pastTense("Checking the playbook"), "Checked the playbook");
    assert.equal(reduce.pastTense("Working on it"), "Working on it");
  });
  await check("a producer's tool names become plain labels: the oasis lookups by name, the playbook folder by kind, nothing with a path", () => {
    assert.equal(activity.producerToolLabel("mcp__oasis__leads_search"), "Looking up Leads");
    assert.equal(activity.producerToolLabel("Read"), "Checking the playbook");
    assert.equal(activity.producerToolLabel("Grep"), "Checking the playbook");
    assert.equal(activity.producerToolLabel("Bash"), "Working on it");
    assert.ok(!identity.namesPersona(activity.producerToolLabel("mcp__oasis__bravo_secret")));
  });

  console.log("The producer door (the paired computer's bridge)");
  const routeMod = await import("../app/api/os/runs/[id]/events/route");
  const { NextRequest } = await import("next/server");
  async function producerRun(opts: { show?: boolean; source?: "producer" | "worker"; tenant?: typeof scopeA } = {}) {
    const scope = opts.tenant ?? scopeA;
    const conv = await store.createConversation(db, scope, { department: "sales", agentSlug: "sdr", now: now() });
    const q = await store.enqueueRun(db, scope, { conversationId: conv.id, text: "from the bridge", chatMode: "build", showThinking: opts.show ?? false, now: now() });
    assert.ok(q.ok);
    const lease = `lease-${Math.random().toString(36).slice(2)}`;
    const claimed = await store.claimNextRun(db, scope, conv.id, lease, now());
    assert.ok(claimed);
    if ((opts.source ?? "producer") === "producer") assert.equal(await store.attachProducer(db, scope, claimed!.id, lease, now()), true);
    return { run: claimed!, conv, scope };
  }
  async function post(runId: string, body: unknown, headers: Record<string, string> = {}) {
    const req = new NextRequest(`http://localhost/api/os/runs/${runId}/events`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const res = await routeMod.POST(req, { params: Promise.resolve({ id: runId }) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }
  const credential = (runId: string, tenantId: string, over: Partial<{ ttlSec: number; nowMs: number }> = {}) =>
    auth.mintRunCredential(RUN_KEY, { runId, tenantId, ttlSec: over.ttlSec ?? 300, nowMs: over.nowMs });
  process.env.OASIS_RUN_TOKEN_KEY = RUN_KEY;
  const bearer = (c: string) => ({ authorization: `Bearer ${c}` });

  await check("the run credential: signed, run-scoped, audience-checked, expiring; a wrong key, a tampered body, or an old one is refused", async () => {
    const c = await credential("run-1", ACME);
    assert.equal((await auth.verifyRunCredential(RUN_KEY, c)).ok, true);
    assert.deepEqual(await auth.verifyRunCredential("another-signing-key-0123456789-abcdefghijkl", c), { ok: false, reason: "bad_signature" });
    const [p, body, sig] = c.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), tid: ZETA })).toString("base64url");
    assert.deepEqual(await auth.verifyRunCredential(RUN_KEY, `${p}.${forged}.${sig}`), { ok: false, reason: "bad_signature" });
    const old = await credential("run-1", ACME, { nowMs: Date.now() - 400_000, ttlSec: 300 });
    assert.deepEqual(await auth.verifyRunCredential(RUN_KEY, old), { ok: false, reason: "expired" });
    assert.deepEqual(await auth.verifyRunCredential(RUN_KEY, "not-a-credential"), { ok: false, reason: "malformed" });
    // A very long life is clamped, not honoured.
    const long = await auth.verifyRunCredential(RUN_KEY, await credential("run-1", ACME, { ttlSec: 999_999 }));
    assert.ok(long.ok && long.claims.exp - long.claims.iat <= auth.RUN_CREDENTIAL_MAX_TTL_SEC);
  });
  await check("the events route refuses, in order: no key set, a browser origin, no or bad credential, another run's credential, another workspace's, a worker-driven run", async () => {
    const { run } = await producerRun();
    const good = bearer(await credential(run.id, ACME));
    delete process.env.OASIS_RUN_TOKEN_KEY;
    assert.equal((await post(run.id, { events: [] }, good)).status, 503, "with no signing key nothing may verify");
    process.env.OASIS_RUN_TOKEN_KEY = RUN_KEY;
    assert.equal((await post(run.id, { events: [] }, { ...good, origin: "https://evil.example" })).status, 403, "a page cannot be a producer");
    assert.equal((await post(run.id, { events: [] })).status, 401);
    assert.equal((await post(run.id, { events: [] }, bearer("orun1.x.y"))).status, 401);
    assert.equal((await post(run.id, { events: [] }, bearer(await credential("some-other-run", ACME)))).status, 401, "another run's credential");
    assert.equal((await post(run.id, { events: [] }, bearer(await credential(run.id, ZETA)))).status, 403, "a credential for another workspace");
    const worker = await producerRun({ source: "worker" });
    assert.equal((await post(worker.run.id, { events: [] }, bearer(await credential(worker.run.id, ACME)))).status, 409, "a Worker-driven run takes no producer");
    assert.equal((await post(run.id, { events: "nope" }, good)).status, 400);
    assert.equal((await post(run.id, { events: [{ seq: 0, type: "delta", text: "x" }] }, good)).status, 400);
    assert.equal((await post(run.id, { events: [{ seq: 1, type: "shell", cmd: "ls" }] }, good)).status, 400);
  });
  await check("a producer's events are stored once each (a resent batch changes nothing), in order, in the RUN's workspace, and never from the body", async () => {
    const { run, conv } = await producerRun();
    const good = bearer(await credential(run.id, ACME));
    const batch = {
      tenant_id: ZETA, // ignored: the run row decides
      user_id: BEN,
      events: [
        { seq: 1, type: "status", label: "Thinking" },
        { seq: 2, type: "tool", id: "a", name: "mcp__oasis__pipeline_summary" },
        { seq: 3, type: "tool_result", id: "a", ok: true, size: 900 },
        { seq: 4, type: "delta", text: `Fine. ${ENV_SECRET}` },
        { seq: 5, type: "delta", text: " Done." },
      ],
    };
    const r1 = await post(run.id, batch, good);
    assert.deepEqual([r1.status, r1.json.accepted, r1.json.finished, r1.json.cancel], [200, 5, false, false]);
    const after1 = await store.readEvents(db, scopeA, run.id, 0);
    const again = await post(run.id, batch, good);
    assert.equal(again.status, 200);
    assert.deepEqual(await store.readEvents(db, scopeA, run.id, 0), after1, "a resent batch wrote again");
    assert.deepEqual(after1.map((e) => e.seq), [101, 102, 103, 104, 105], "producer events live at seq 100 + n");
    assert.deepEqual(await store.readEvents(db, scopeZ, run.id, 0), [], "an event landed in the body's workspace");
    assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM dept_chat_run_events WHERE run_id = ? AND tenant_id = ?", args: [run.id, ACME] })).rows[0].n, 5);
    assert.ok(!JSON.stringify(after1).includes(ENV_SECRET), "a credential in a producer's text reached the browser");
    assert.deepEqual(
      reduce.reduceRunEvents(after1).steps,
      [{ kind: "tool", id: "pa", label: "Looking up Pipeline", state: "ok", detail: null, size: 900 }],
      "the producer's lookup is a plain label, and its result closes the same step",
    );
    // The browser can follow it like any other run; a Stop surfaces to the producer.
    assert.equal(await store.requestCancel(db, scopeA, run.id, now()), "requested");
    const hb = await post(run.id, { events: [] }, good);
    assert.deepEqual([hb.json.finished, hb.json.cancel], [false, true], "the producer learns the person pressed Stop");
    // The producer ends the run: the answer is what it posted.
    const done = await post(run.id, { events: [{ seq: 6, type: "done", usage: { input_tokens: 5, output_tokens: 6 } }] }, good);
    assert.deepEqual([done.json.finished], [true]);
    const fin = await store.getRun(db, scopeA, run.id);
    assert.equal(fin?.status, "done");
    assert.equal(fin?.finalText?.includes("Fine."), true);
    assert.deepEqual([fin?.inputTokens, fin?.outputTokens], [5, 6]);
    const closing = await store.readEvents(db, scopeA, run.id, 105);
    assert.equal(closing[closing.length - 1].kind, "done");
    assert.ok(!(await store.readEvents(db, scopeA, run.id, 0)).some((e) => e.kind === "delta"), "reply fragments were kept after the run ended");
    // A late resend, after the end, is told it is over and writes nothing.
    const late = await post(run.id, batch, good);
    assert.deepEqual([late.status, late.json.finished, late.json.accepted], [200, true, 0]);
    assert.equal((await transcript.buildTranscript(db, scopeA, conv.id))?.runs[0].final_text?.includes("Fine."), true);
  });
  await check("a producer's error ends the run failed with a code; reasoning is dropped unless the run's person may see it, and is not kept after", async () => {
    for (const show of [false, true]) {
      const { run } = await producerRun({ show });
      const good = bearer(await credential(run.id, ACME));
      await post(run.id, { events: [{ seq: 1, type: "thinking", text: "As Bravo, hmm" }, { seq: 2, type: "delta", text: "part" }] }, good);
      const mid = await store.readEvents(db, scopeA, run.id, 0);
      assert.equal(mid.some((e) => e.kind === "thinking"), show, "reasoning gating on the run row");
      if (show) assert.ok(!identity.namesPersona(JSON.stringify(mid)), "a persona name reached the browser");
      const res = await post(run.id, { events: [{ seq: 3, type: "error", code: "bridge_unreachable" }] }, good);
      assert.equal(res.json.finished, true);
      const fin = await store.getRun(db, scopeA, run.id);
      assert.deepEqual([fin?.status, fin?.errorCode, fin?.finalText], ["failed", "bridge_unreachable", "part"]);
      assert.ok(!(await store.readEvents(db, scopeA, run.id, 0)).some((e) => e.kind === "thinking"), "reasoning was kept after the run ended");
    }
  });
  await check("a producer is given up on after 120 s of silence, a Worker driver after 45 s", async () => {
    const p = await producerRun();
    const w = await producerRun({ source: "worker" });
    const at = (s: number) => new Date(Date.now() + s * 1000);
    assert.deepEqual(await store.reapStale(db, scopeA, w.conv.id, at(60)), [w.run.id], "a silent worker driver at 60 s");
    assert.deepEqual(await store.reapStale(db, scopeA, p.conv.id, at(60)), [], "a producer heartbeats every ~25 s: 60 s is not silence yet");
    assert.deepEqual(await store.reapStale(db, scopeA, p.conv.id, at(130)), [p.run.id], "a producer silent for 130 s");
  });
  await check("middleware lets exactly the producer path through without a session", async () => {
    const { isPublic } = await import("../middleware");
    assert.equal(isPublic("/api/os/runs/0e000000-0000-4000-8000-00000000abcd/events"), true);
    for (const p of ["/api/os/runs", "/api/os/runs/0e000000-0000-4000-8000-00000000abcd/stream", "/api/os/runs/0e000000-0000-4000-8000-00000000abcd/stop", "/api/os/runs/x/events", "/api/os/runs/0e000000-0000-4000-8000-00000000abcd/events/extra", "/api/os/conversations"]) {
      assert.equal(isPublic(p), false, `${p} must stay behind the session`);
    }
  });

  console.log("Registered in CI");
  await check("the suite is named by an npm script group", () => {
    const pkg = readFileSync(join(ROOT, "package.json"), "utf8");
    assert.match(pkg, /tests\/department-runs\.test\.ts/);
  });

  console.error = realError;
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures) {
    for (const l of logged.slice(-10)) process.stdout.write(`  log: ${JSON.stringify(l).slice(0, 300)}\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error = realError;
  console.error(error);
  for (const l of logged.slice(-10)) realError(...l);
  process.exit(1);
});
