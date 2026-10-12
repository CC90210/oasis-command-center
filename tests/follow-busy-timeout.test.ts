/**
 * tests/follow-busy-timeout.test.ts - [P2] Codex review, 2026-10-11:
 * lib/os/runs/follow.ts's first-in-line clock must survive stream
 * reconnects. Before the fix, "first in line since" lived only in one
 * followRun() generator's closure; a reattach (the browser's own stream
 * ends every TAIL_WINDOW_MS and asks again) started a BRAND NEW generator
 * with no memory of it, so the clock reset on every reconnect and
 * computer_busy_timeout could never fire for a continuously busy computer
 * -- the run instead waited for the unrelated 10-minute absolute cap.
 *
 * This simulates many short-lived reconnects (a FRESH followRun() call each
 * time, exactly like a new HTTP request would be) against a SIMULATED
 * clock (the injected `now`/`sleep` hooks advance a local counter instead
 * of waiting in real time), and proves the run still reaches
 * computer_busy_timeout at 5 minutes of SIMULATED first-in-line wait,
 * however many times the stream reconnected along the way.
 *
 * Real libSQL file (bravo__192, bravo__207, bravo__213 applied); no network,
 * no real sleeping.
 * Run: node --conditions=react-server --import tsx tests/follow-busy-timeout.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";

const ROOT = process.cwd();
const dbFile = join(mkdtempSync(join(tmpdir(), "follow-busy-timeout-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.AUTH_SESSION_SECRET;
delete process.env.OASIS_RUN_TOKEN_KEY;

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

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 10).join("\n        ")}`);
  }
}

let seq = 0;
function uid(): string {
  seq += 1;
  const n = seq.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${n}`;
}

const RECONNECT_WINDOW_MS = 25_000; // TAIL_WINDOW_MS: a real stream reattaches about this often.
const FIXED_POLL_MS = 5_000; // a constant poll interval keeps the simulation's iteration count small.

async function main() {
  const db: Client = createClient({ url: `file:${dbFile}` });
  for (const file of ["bravo__192_ai_usage.sql", "bravo__207_department_chat_runs.sql", "bravo__213_dept_runs_computer.sql"]) {
    for (const stmt of splitStatements(readFileSync(join(ROOT, "database", "turso", file), "utf8"))) await db.execute(stmt);
  }
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN target_pairing_id TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_engine_kind TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_engine_name TEXT");

  const store = await import("../lib/os/runs/store");
  const follow = await import("../lib/os/runs/follow");
  const types = await import("../lib/os/runs/types");

  console.log("follow-busy-timeout ([P2] Codex finding):");

  /**
   * Drive followRun for ONE simulated "stream session" (ends at
   * RECONNECT_WINDOW_MS, exactly like a real reattach would), against a
   * clock this function owns ENTIRELY for its own call -- the caller
   * advances `clockRef.value` between calls to carry simulated time across
   * reconnects, the one thing a real browser's reconnect also does (real
   * wall-clock time keeps moving while the old stream is closing and the
   * new one is opening).
   */
  async function oneReconnect(scope: { tenantId: string; userId: string }, runId: string, clockRef: { value: number }, computerState: () => Promise<import("@/lib/devices/presence").ComputerAnswerState>) {
    const frames: unknown[] = [];
    const gen = follow.followRun({
      db,
      scope,
      runId,
      afterSeq: 0,
      windowMs: RECONNECT_WINDOW_MS,
      now: () => new Date(clockRef.value),
      sleep: async (ms: number) => {
        clockRef.value += ms;
      },
      pollMs: () => FIXED_POLL_MS,
      gone: () => false,
      computerState,
    });
    for await (const frame of gen) {
      frames.push(frame);
      if ((frame as { type: string }).type === "window" || (frame as { type: string }).type === "end" || (frame as { type: string }).type === "gone") break;
    }
    return frames;
  }

  await check("a continuously BUSY computer still reaches computer_busy_timeout at 5 minutes of simulated first-in-line wait, across MANY short-lived reconnects", async () => {
    const tenantId = uid();
    const userId = uid();
    const scope = { tenantId, userId };
    const conv = await store.createConversation(db, scope, { department: "sales", agentSlug: "sdr", now: new Date() });
    const q = await store.enqueueRun(db, scope, { conversationId: conv.id, text: "waiting on a busy computer", chatMode: "build", showThinking: false, now: new Date(), executor: "computer" });
    assert.ok(q.ok);
    const runId = q.ok ? q.run.id : "";

    const clockRef = { value: Date.now() };
    const busy = async () => "busy" as const;

    let reconnects = 0;
    let finalStatus = "queued";
    let finalErrorCode: string | null = null;
    // 5 minutes / 25 s per reconnect = 12 reconnects; give real headroom
    // (30) so the test proves the clock, not an off-by-one in this harness.
    for (; reconnects < 30; reconnects++) {
      await oneReconnect(scope, runId, clockRef, busy);
      const row = await store.getRun(db, scope, runId);
      assert.ok(row, "the run must still exist");
      finalStatus = row!.status;
      finalErrorCode = row!.errorCode;
      if (finalStatus !== "queued") break;
    }

    assert.ok(reconnects < 30, "the run never reached a terminal state within 30 simulated reconnects (~12.5 minutes) -- the clock is not firing at all");
    assert.equal(finalStatus, "failed");
    assert.equal(finalErrorCode, "computer_busy_timeout");
    // It must fire at (approximately) COMPUTER_BUSY_TIMEOUT_MS -- 5
    // minutes -- not merely "eventually, before the unrelated 10-minute
    // absolute cap". Within one reconnect window + one poll interval of
    // slack for the simulation's own quantization.
    const elapsedSimulatedMs = (reconnects + 1) * RECONNECT_WINDOW_MS;
    const slack = RECONNECT_WINDOW_MS + FIXED_POLL_MS;
    assert.ok(
      Math.abs(elapsedSimulatedMs - types.COMPUTER_BUSY_TIMEOUT_MS) <= slack,
      `fired after ~${elapsedSimulatedMs}ms of simulated first-in-line wait; expected ~${types.COMPUTER_BUSY_TIMEOUT_MS}ms (COMPUTER_BUSY_TIMEOUT_MS), not the unrelated 10-minute absolute cap or some other value`,
    );
  });

  await check("a computer that is can_answer (never busy, never blocked) is NOT touched by the busy clock across the same many reconnects", async () => {
    const tenantId = uid();
    const userId = uid();
    const scope = { tenantId, userId };
    const conv = await store.createConversation(db, scope, { department: "sales", agentSlug: "sdr", now: new Date() });
    const q = await store.enqueueRun(db, scope, { conversationId: conv.id, text: "a computer that could answer any moment", chatMode: "build", showThinking: false, now: new Date(), executor: "computer" });
    assert.ok(q.ok);
    const runId = q.ok ? q.run.id : "";
    const clockRef = { value: Date.now() };
    const canAnswer = async () => "can_answer" as const;
    for (let i = 0; i < 6; i++) await oneReconnect(scope, runId, clockRef, canAnswer);
    const row = await store.getRun(db, scope, runId);
    assert.equal(row?.status, "queued", "can_answer must never time out on its own; only computer_not_answering/busy/blocked clocks apply");
  });

  console.log("[P2, round 2] markFirstInLine must not start the clock behind an earlier QUEUED (not yet running) message");
  await check("following the SECOND of two queued computer messages never sets ITS OWN first_in_line_at while the first is still queued; its clock starts at zero only once the first truly leaves the queue", async () => {
    const tenantId = uid();
    const userId = uid();
    const scope = { tenantId, userId };
    const conv = await store.createConversation(db, scope, { department: "sales", agentSlug: "sdr", now: new Date() });
    const first = await store.enqueueRun(db, scope, { conversationId: conv.id, text: "seq 1, still queued", chatMode: "build", showThinking: false, now: new Date(), executor: "computer" });
    const second = await store.enqueueRun(db, scope, { conversationId: conv.id, text: "seq 2, waiting behind seq 1", chatMode: "build", showThinking: false, now: new Date(), executor: "computer" });
    assert.ok(first.ok && second.ok);
    const firstRunId = first.ok ? first.run.id : "";
    const secondRunId = second.ok ? second.run.id : "";

    const clockRef = { value: Date.now() };
    const busy = async () => "busy" as const;

    // Follow seq 2 directly for a few reconnects (how LONG it waits here
    // does not matter -- the mechanism is a boolean NOT EXISTS, not a
    // timer -- a few is enough to prove repeated observation still never
    // sets it, while leaving the full 10-minute absolute-cap budget free
    // for phase 3 below to demonstrate the 5-minute BUSY clock cleanly).
    // seq 1 sits untouched, still queued (never claimed) throughout.
    // Before this fix, conversationActivity.live checked only RUNNING
    // rows -- nothing was running, so markFirstInLine would have set seq
    // 2's own first_in_line_at on the very first observation, accumulating
    // wait time it never actually had.
    for (let i = 0; i < 2; i++) await oneReconnect(scope, secondRunId, clockRef, busy);
    const seq2WhileBehindSeq1 = await store.getRun(db, scope, secondRunId);
    assert.equal(seq2WhileBehindSeq1?.status, "queued", "seq 2 must still be queued: it must never time out while seq 1 is still ahead of it");
    const row = await db.execute({ sql: `SELECT first_in_line_at FROM dept_chat_runs WHERE id = ?`, args: [secondRunId] });
    assert.equal(row.rows[0].first_in_line_at, null, "seq 2's first_in_line_at must still be NULL: it has never truly been first in line");
    // seq 1 itself, followed the same way, DOES set its own clock and
    // would eventually time out on its own schedule -- untouched by this fix.
    const seq1Row = await store.getRun(db, scope, firstRunId);
    assert.equal(seq1Row?.status, "queued");

    // Now seq 1 is claimed and finishes: it truly leaves the queue.
    const pairing = { tenantId, userId, pairingId: uid() };
    await db.execute(`CREATE TABLE IF NOT EXISTS bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, label TEXT,
      revoked_at TEXT, claim_enabled_at TEXT, claim_enabled_by TEXT, paired_via TEXT)`).catch(() => undefined);
    await db.execute({
      sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, claim_enabled_at, claim_enabled_by, paired_via) VALUES (?, ?, ?, 'test computer', ?, 'test', 'pair_code')`,
      args: [pairing.pairingId, tenantId, userId, new Date(clockRef.value).toISOString()],
    });
    const claimedFirst = await store.claimComputerRun(db, pairing, "claim-seq-1-round2", new Date(clockRef.value));
    assert.ok(claimedFirst);
    assert.equal(claimedFirst!.id, firstRunId);
    await store.finishProducerRun(db, claimedFirst!, { status: "done", errorCode: null, message: null, inputTokens: 1, outputTokens: 1, now: new Date(clockRef.value) });

    // seq 2 is now TRULY first in line. One observation sets its clock at
    // (approximately) zero wait -- it must NOT already read as having
    // waited the many simulated minutes that passed while it sat behind
    // seq 1 (the exact bug: "failed... immediately when the first
    // finished, despite zero actual first-in-line waiting time").
    await oneReconnect(scope, secondRunId, clockRef, busy);
    const justBecameFirst = await store.getRun(db, scope, secondRunId);
    assert.equal(justBecameFirst?.status, "queued", "seq 2 must NOT fail immediately when seq 1 finishes: it has waited zero real first-in-line time so far");
    const afterRow = await db.execute({ sql: `SELECT first_in_line_at FROM dept_chat_runs WHERE id = ?`, args: [secondRunId] });
    assert.ok(afterRow.rows[0].first_in_line_at, "seq 2's first_in_line_at is now set, for the first time, now that it is truly first in line");

    // It still needs its OWN full 5 minutes from here before timing out.
    let reconnects = 0;
    for (; reconnects < 30; reconnects++) {
      await oneReconnect(scope, secondRunId, clockRef, busy);
      const r = await store.getRun(db, scope, secondRunId);
      if (r?.status !== "queued") break;
    }
    const finalRow = await store.getRun(db, scope, secondRunId);
    assert.equal(finalRow?.status, "failed");
    assert.equal(finalRow?.errorCode, "computer_busy_timeout");
    assert.ok(reconnects >= 10, `seq 2 timed out after only ${reconnects} reconnects (~${reconnects * RECONNECT_WINDOW_MS}ms) of ITS OWN wait -- it must take close to the full 5 minutes, not the leftover time it spent waiting behind seq 1`);
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
