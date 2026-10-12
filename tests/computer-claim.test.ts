/**
 * tests/computer-claim.test.ts - O4's pull dispatch, the store.ts layer: a
 * person's own paired computer claims ITS OWN queued runs by one
 * compare-and-swap, idempotently, and never anyone else's; a Worker driver
 * (claimNextRun) can never take one; the pre-claim cleanup reaps a silent
 * producer and times out a run nobody answered.
 *
 * Every check uses a FRESH tenant/user/pairing triple (uid()) so one check's
 * leftover queued rows can never be picked up by another's claim call --
 * claimComputerRun claims a person's EARLIEST queued computer run across
 * EVERY conversation they have, by design, so sharing a scope across checks
 * would make an older check's row the "right" answer for a newer one.
 *
 * Real libSQL file (bravo__192, bravo__207, bravo__213 applied); no network.
 * Run: node --conditions=react-server --import tsx tests/computer-claim.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";

const ROOT = process.cwd();
const dbFile = join(mkdtempSync(join(tmpdir(), "computer-claim-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.AUTH_SESSION_SECRET;
delete process.env.OASIS_RUN_TOKEN_KEY;

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

const realError = console.error;
console.error = () => undefined;

let seq = 0;
/** A fresh, valid-shaped UUID per call, so checks never share rows through a reused id. */
function uid(): string {
  seq += 1;
  const n = seq.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${n}`;
}

async function main() {
  const db: Client = createClient({ url: `file:${dbFile}` });
  for (const file of ["bravo__192_ai_usage.sql", "bravo__207_department_chat_runs.sql", "bravo__213_dept_runs_computer.sql"]) {
    for (const stmt of splitStatements(readFileSync(join(ROOT, "database", "turso", file), "utf8"))) await db.execute(stmt);
  }
  // claimComputerRun's CAS re-checks the pairing's live state in THIS same
  // table now (Codex review, [P1]/[P2]): every `person()` below seeds a
  // real, approved, unrevoked row here, or every claimComputerRun call
  // would throw "no such table: bridge_pairings".
  await db.execute(`CREATE TABLE bridge_pairings (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, label TEXT,
    revoked_at TEXT, claim_enabled_at TEXT, claim_enabled_by TEXT, paired_via TEXT)`);
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN target_pairing_id TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_engine_kind TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_engine_name TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_fallback_policy TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_fallback_reason TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_api_provider TEXT");
  await db.execute("ALTER TABLE dept_chat_runs ADD COLUMN runtime_api_model TEXT");

  const store = await import("../lib/os/runs/store");
  const types = await import("../lib/os/runs/types");

  let clock = Date.now();
  const now = () => new Date(clock);
  const advance = (ms: number) => void (clock += ms);

  /** A fresh (tenant, user) and the matching claim pairing (a real, approved, unrevoked bridge_pairings row), isolated from every other check. */
  async function person(tenantId = uid()) {
    const userId = uid();
    const pairingId = uid();
    await db.execute({
      sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, claim_enabled_at, claim_enabled_by, paired_via) VALUES (?, ?, ?, ?, ?, 'test', 'pair_code')`,
      args: [pairingId, tenantId, userId, `test computer ${pairingId}`, new Date().toISOString()],
    });
    return { scope: { tenantId, userId }, pairing: { tenantId, userId, pairingId } };
  }

  async function conv(scope: { tenantId: string; userId: string }, dept = "sales") {
    return store.createConversation(db, scope, { department: dept, agentSlug: "sdr", now: now() });
  }

  console.log("enqueueRun carries executor and origin");
  await check("a 'computer' run enqueues queued, executor 'computer', origin 'chat', and is NOT claimable by the Worker driver", async () => {
    const { scope } = await person();
    const c = await conv(scope);
    const q = await store.enqueueRun(db, scope, { conversationId: c.id, text: "hi", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(q.ok);
    if (!q.ok) return;
    assert.equal(q.run.executor, "computer");
    assert.equal(q.run.origin, "chat");
    assert.equal(q.run.status, "queued");
    // The Worker's own chat driver must never claim it: this is the one
    // fallback O4 must never have (no key fallback).
    assert.equal(await store.claimNextRun(db, scope, c.id, "worker-lease-1", now()), null, "a Worker driver claimed a computer-executor run");
    const stillQueued = await store.getRun(db, scope, q.run.id);
    assert.equal(stillQueued?.status, "queued");
  });
  await check("a default enqueueRun call is executor 'worker', origin 'chat' (unchanged behaviour)", async () => {
    const { scope } = await person();
    const c = await conv(scope);
    const q = await store.enqueueRun(db, scope, { conversationId: c.id, text: "hi", chatMode: "build", showThinking: false, now: now() });
    assert.ok(q.ok);
    if (q.ok) {
      assert.equal(q.run.executor, "worker");
      assert.equal(q.run.origin, "chat");
      assert.ok(await store.claimNextRun(db, scope, c.id, "worker-lease-2", now()), "a normal chat run still claims as before");
    }
  });

  console.log("claimComputerRun: only the owner's runs, one compare-and-swap, chats first");
  await check("Ann's computer can never claim Ben's run, and the reverse", async () => {
    const tenant = uid();
    const ann = await person(tenant);
    const ben = await person(tenant);
    const cA = await conv(ann.scope);
    const cB = await conv(ben.scope);
    const qA = await store.enqueueRun(db, ann.scope, { conversationId: cA.id, text: "ann's", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    const qB = await store.enqueueRun(db, ben.scope, { conversationId: cB.id, text: "ben's", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(qA.ok && qB.ok);

    const claimedByBen = await store.claimComputerRun(db, ben.pairing, "claim-ben-1", now());
    assert.ok(claimedByBen);
    assert.equal(claimedByBen?.id, qB.ok ? qB.run.id : undefined);

    const claimedByAnn = await store.claimComputerRun(db, ann.pairing, "claim-ann-1", now());
    assert.ok(claimedByAnn);
    assert.equal(claimedByAnn?.id, qA.ok ? qA.run.id : undefined);

    // Claiming hands the run straight to the producer: the events route's
    // existing door, with no separate attachProducer step.
    assert.equal(claimedByAnn?.source, "producer");
    assert.equal(claimedByAnn?.status, "running");
    assert.equal(claimedByAnn?.claimedPairingId, ann.pairing.pairingId);
    assert.ok(claimedByAnn?.deadlineAt);

    // Neither pairing can claim again: each person had exactly one queued run.
    assert.equal(await store.claimComputerRun(db, ann.pairing, "claim-ann-2", now()), null);
    assert.equal(await store.claimComputerRun(db, ben.pairing, "claim-ben-2", now()), null);
  });
  await check("a different workspace's queued computer run is invisible to this one (tenant scoping)", async () => {
    const zeta = await person();
    const cZ = await conv(zeta.scope);
    await store.enqueueRun(db, zeta.scope, { conversationId: cZ.id, text: "zeta's", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    const wrongTenantSamePairingId = await store.claimComputerRun(db, { tenantId: uid(), userId: zeta.scope.userId, pairingId: zeta.pairing.pairingId }, "claim-x", now());
    assert.equal(wrongTenantSamePairingId, null, "the tenant id differs, so no row matches even with the right user id");
  });
  await check("two concurrent claims for the same person have exactly one winner (compare-and-swap)", async () => {
    const owner = await person();
    const secondPairingId = uid();
    await db.execute({
      sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, claim_enabled_at, claim_enabled_by, paired_via) VALUES (?, ?, ?, ?, ?, 'test', 'pair_code')`,
      args: [secondPairingId, owner.scope.tenantId, owner.scope.userId, "owner's second computer", new Date().toISOString()],
    });
    const otherPairingSamePerson = { ...owner.pairing, pairingId: secondPairingId };
    const c = await conv(owner.scope);
    const q = await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "race", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(q.ok);
    const [a, b] = await Promise.all([
      store.claimComputerRun(db, owner.pairing, "race-claim-a", now()),
      store.claimComputerRun(db, otherPairingSamePerson, "race-claim-b", now()),
    ]);
    const winners = [a, b].filter(Boolean);
    assert.equal(winners.length, 1, "exactly one claim won");
    assert.equal(winners[0]?.id, q.ok ? q.run.id : undefined);
  });
  await check("an exact-device run can be claimed only by its snapshotted pairing, even when another computer belongs to the same person", async () => {
    const owner = await person();
    const otherPairingId = uid();
    await db.execute({
      sql: `INSERT INTO bridge_pairings (id, tenant_id, user_id, label, claim_enabled_at, claim_enabled_by, paired_via) VALUES (?, ?, ?, ?, ?, 'test', 'pair_code')`,
      args: [otherPairingId, owner.scope.tenantId, owner.scope.userId, "other approved computer", new Date().toISOString()],
    });
    const c = await conv(owner.scope);
    const queued = await store.enqueueRun(db, owner.scope, {
      conversationId: c.id,
      text: "run this on the selected Codex machine",
      chatMode: "build",
      showThinking: false,
      now: now(),
      executor: "computer",
      targetPairingId: owner.pairing.pairingId,
      runtimeEngineKind: "cli",
      runtimeEngineName: "codex",
    });
    assert.ok(queued.ok);
    if (!queued.ok) return;
    assert.equal(queued.run.targetPairingId, owner.pairing.pairingId);
    assert.equal(queued.run.runtimeEngineKind, "cli");
    assert.equal(queued.run.runtimeEngineName, "codex");
    assert.equal(
      await store.claimComputerRun(
        db,
        { ...owner.pairing, pairingId: otherPairingId },
        "wrong-computer",
        now(),
        "department_task_v2",
      ),
      null,
    );
    const claimed = await store.claimComputerRun(db, owner.pairing, "right-computer", now(), "department_task_v2");
    assert.equal(claimed?.id, queued.run.id);
    assert.equal(claimed?.claimedPairingId, owner.pairing.pairingId);
  });
  await check("[P2] claim-id dedup is atomic with claiming: two overlapping requests for the SAME claim_id, with TWO different runs available, never claim two different runs under it", async () => {
    // The scenario the previous check cannot reach: with only ONE queued
    // run, the loser's CAS subquery finds no candidate at all (0 rows
    // matched, not a unique violation). With TWO queued runs for the same
    // person, each racer's CAS can target a DIFFERENT row and successfully
    // claim it -- and only the partial unique index on (claimed_pairing_id,
    // lease_id) stops the SECOND commit from landing the SAME claim_id onto
    // a SECOND run.
    const owner = await person();
    const c1 = await conv(owner.scope);
    const c2 = await conv(owner.scope, "marketing");
    const q1 = await store.enqueueRun(db, owner.scope, { conversationId: c1.id, text: "first conversation", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    const q2 = await store.enqueueRun(db, owner.scope, { conversationId: c2.id, text: "second conversation", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(q1.ok && q2.ok);
    const sharedClaimId = "shared-overlapping-claim-id";
    // Sequential, not Promise.all: SQLite serializes writes on one
    // connection anyway, so this reproduces exactly what two truly
    // concurrent requests would each see once their UPDATEs are ordered --
    // the SECOND one must never silently succeed on a DIFFERENT row.
    const first = await store.claimComputerRun(db, owner.pairing, sharedClaimId, now());
    assert.ok(first, "the first request claims a run");
    const second = await store.claimComputerRun(db, owner.pairing, sharedClaimId, now());
    assert.equal(second, null, "the second request, same claim_id, must NOT claim the other run");
    // The loser's own recovery path: ask for the winner's assignment.
    const winnersAssignment = await store.findClaimedComputerRun(db, owner.pairing, sharedClaimId);
    assert.ok(winnersAssignment);
    assert.equal(winnersAssignment!.id, first!.id, "the loser must be told the WINNER's run, never nothing");
    // Exactly ONE run is running under this claim_id; the other is still queued, untouched.
    const running = await db.execute({ sql: `SELECT id FROM dept_chat_runs WHERE tenant_id = ? AND user_id = ? AND lease_id = ? AND status = 'running'`, args: [owner.scope.tenantId, owner.scope.userId, sharedClaimId] });
    assert.equal(running.rows.length, 1);
    const otherRunId = (q1.ok ? q1.run.id : "") === first!.id ? (q2.ok ? q2.run.id : "") : (q1.ok ? q1.run.id : "");
    const other = await store.getRun(db, owner.scope, otherRunId);
    assert.equal(other?.status, "queued");
  });
  await check("[P2] truly concurrent (Promise.all) overlapping claims for the same claim_id still land on exactly one run", async () => {
    const owner = await person();
    const c1 = await conv(owner.scope);
    const c2 = await conv(owner.scope, "marketing");
    const q1 = await store.enqueueRun(db, owner.scope, { conversationId: c1.id, text: "concurrent 1", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    const q2 = await store.enqueueRun(db, owner.scope, { conversationId: c2.id, text: "concurrent 2", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(q1.ok && q2.ok);
    const sharedClaimId = "truly-concurrent-claim-id";
    const [a, b] = await Promise.all([
      store.claimComputerRun(db, owner.pairing, sharedClaimId, now()),
      store.claimComputerRun(db, owner.pairing, sharedClaimId, now()),
    ]);
    const claimedDirectly = [a, b].filter(Boolean);
    assert.ok(claimedDirectly.length <= 1, "never two different runs claimed directly under the same claim_id");
    const running = await db.execute({ sql: `SELECT id FROM dept_chat_runs WHERE tenant_id = ? AND user_id = ? AND lease_id = ? AND status = 'running'`, args: [owner.scope.tenantId, owner.scope.userId, sharedClaimId] });
    assert.equal(running.rows.length, 1, "exactly one run ends up running under the shared claim_id, never two");
  });
  await check("order is kept within a conversation; chats go before automations (origin ordering)", async () => {
    const owner = await person();
    const c = await conv(owner.scope);
    const chatRun = await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "the chat one", chatMode: "build", showThinking: false, now: now(), executor: "computer", origin: "chat" });
    assert.ok(chatRun.ok);
    // A second, separate conversation holds the 'automation'-origin run, so
    // both are eligible to the SAME claim call at once (one claim per call,
    // across every conversation this person has) and origin ordering decides
    // which one wins.
    const c2 = await conv(owner.scope, "marketing");
    const autoRun = await store.enqueueRun(db, owner.scope, {
      conversationId: c2.id,
      text: "the automation one",
      chatMode: "build",
      showThinking: false,
      now: now(),
      executor: "computer",
      origin: "automation",
    });
    assert.ok(autoRun.ok);
    const claimed = await store.claimComputerRun(db, owner.pairing, "order-claim-1", now());
    assert.ok(claimed);
    assert.equal(claimed?.id, chatRun.ok ? chatRun.run.id : undefined, "the chat-origin run claimed first, even though it was not inserted first");
  });
  await check("a Worker driver (claimNextRun) never claims a computer-executor run, even with the chat queue otherwise empty", async () => {
    const owner = await person();
    const c = await conv(owner.scope);
    await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "mine", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.equal(await store.claimNextRun(db, owner.scope, c.id, "worker-lease-x", now()), null);
  });
  await check("[P2, round 2] a person who sends a computer message, switches engines, then sends a worker message: the worker claim must NOT skip ahead of the still-queued computer message", async () => {
    const owner = await person();
    const c = await conv(owner.scope);
    const seq1 = await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "computer message, seq 1", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    const seq2 = await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "switched to the API key, seq 2", chatMode: "build", showThinking: false, now: now(), executor: "worker" });
    assert.ok(seq1.ok && seq2.ok);
    // Before the fix, this subquery filtered to executor='worker' FIRST and
    // found seq 2 as "the earliest WORKER row", claiming it while seq 1 sat
    // untouched -- the later reply would then run with NO history of seq 1.
    assert.equal(await store.claimNextRun(db, owner.scope, c.id, "worker-lease-skip-check", now()), null, "the worker claim must claim NOTHING while an earlier computer message is still queued");
    const stillQueued1 = await store.getRun(db, owner.scope, seq1.ok ? seq1.run.id : "");
    const stillQueued2 = await store.getRun(db, owner.scope, seq2.ok ? seq2.run.id : "");
    assert.equal(stillQueued1?.status, "queued");
    assert.equal(stillQueued2?.status, "queued", "seq 2 must not have been claimed either -- the whole point is order, not merely refusing seq 1");

    // Once seq 1 (the earlier, computer-executor message) is claimed and
    // finishes, the worker claim may THEN take seq 2, in order.
    const claimed1 = await store.claimComputerRun(db, owner.pairing, "computer-claim-for-order-check", now());
    assert.ok(claimed1);
    assert.equal(claimed1!.id, seq1.ok ? seq1.run.id : "");
    await store.finishProducerRun(db, claimed1!, { status: "done", errorCode: null, message: null, inputTokens: 1, outputTokens: 1, now: now() });
    const nowClaimable = await store.claimNextRun(db, owner.scope, c.id, "worker-lease-after-seq1-done", now());
    assert.ok(nowClaimable);
    assert.equal(nowClaimable!.id, seq2.ok ? seq2.run.id : "");
  });
  await check("[P2, round 2] the reverse: a worker message queued before a computer message is never skipped by claimComputerRun either", async () => {
    const owner = await person();
    const c = await conv(owner.scope);
    const seq1 = await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "worker message, seq 1", chatMode: "build", showThinking: false, now: now(), executor: "worker" });
    const seq2 = await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "switched to a computer, seq 2", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(seq1.ok && seq2.ok);
    assert.equal(await store.claimComputerRun(db, owner.pairing, "computer-claim-skip-check", now()), null, "the computer claim must claim NOTHING while an earlier worker message is still queued");
    const stillQueued1 = await store.getRun(db, owner.scope, seq1.ok ? seq1.run.id : "");
    const stillQueued2 = await store.getRun(db, owner.scope, seq2.ok ? seq2.run.id : "");
    assert.equal(stillQueued1?.status, "queued");
    assert.equal(stillQueued2?.status, "queued");

    const claimed1 = await store.claimNextRun(db, owner.scope, c.id, "worker-lease-for-order-check", now());
    assert.ok(claimed1);
    assert.equal(claimed1!.id, seq1.ok ? seq1.run.id : "");
    await store.finishRun(db, owner.scope, claimed1!.id, "worker-lease-for-order-check", { status: "done", finalText: "ok", errorCode: null, inputTokens: 1, outputTokens: 1, agent: null, now: now() });
    const nowClaimable = await store.claimComputerRun(db, owner.pairing, "computer-claim-after-seq1-done", now());
    assert.ok(nowClaimable);
    assert.equal(nowClaimable!.id, seq2.ok ? seq2.run.id : "");
  });

  console.log("idempotent retry vs. claim_already_started");
  await check("a lost claim answer retried with the same claim_id returns the same run again", async () => {
    const owner = await person();
    const c = await conv(owner.scope);
    const q = await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "retry me", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(q.ok);
    const first = await store.claimComputerRun(db, owner.pairing, "retry-claim-1", now());
    assert.ok(first);
    // The CAS matches nothing the second time (already running): the claim
    // route falls back to the idempotent lookup.
    const second = await store.claimComputerRun(db, owner.pairing, "retry-claim-1", now());
    assert.equal(second, null);
    const found = await store.findClaimedComputerRun(db, owner.pairing, "retry-claim-1");
    assert.equal(found?.id, first?.id);
    assert.equal(await store.producerEventsExist(db, found!), false, "no events posted yet: a safe retry, not claim_already_started");
  });
  await check("after the first event, the idempotent lookup still finds the run, and producerEventsExist flips true (409 claim_already_started)", async () => {
    const owner = await person();
    const c = await conv(owner.scope);
    const q = await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "started", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(q.ok);
    const claimed = await store.claimComputerRun(db, owner.pairing, "started-claim-1", now());
    assert.ok(claimed);
    await store.appendEvents(db, owner.scope, claimed!.id, [{ seq: 100, kind: "status", data: { phase: "thinking", label: "Working" } }], now());
    const found = await store.findClaimedComputerRun(db, owner.pairing, "started-claim-1");
    assert.ok(found);
    assert.equal(await store.producerEventsExist(db, found!), true);
  });
  await check("findClaimedComputerRun never returns another pairing's claim of the same claim_id", async () => {
    const owner = await person();
    const otherPairingSamePerson = { ...owner.pairing, pairingId: uid() };
    const c = await conv(owner.scope);
    const q = await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "mine", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(q.ok);
    await store.claimComputerRun(db, owner.pairing, "shared-id", now());
    const asOtherPairing = await store.findClaimedComputerRun(db, otherPairingSamePerson, "shared-id");
    assert.equal(asOtherPairing, null);
  });

  console.log("the failure clocks and pre-claim cleanup");
  await check("failQueuedComputerRun fails a queued run closed, and never a running one", async () => {
    const owner = await person();
    const c = await conv(owner.scope);
    const q = await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "timeout me", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(q.ok);
    const ok = await store.failQueuedComputerRun(db, owner.scope, q.ok ? q.run.id : "", "computer_not_answering", now());
    assert.equal(ok, true);
    const failed = await store.getRun(db, owner.scope, q.ok ? q.run.id : "");
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.errorCode, "computer_not_answering");

    const c2 = await conv(owner.scope);
    const q2 = await store.enqueueRun(db, owner.scope, { conversationId: c2.id, text: "running", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(q2.ok);
    await store.claimComputerRun(db, owner.pairing, "cannot-fail-running", now());
    const stillRunning = await store.failQueuedComputerRun(db, owner.scope, q2.ok ? q2.run.id : "", "computer_not_answering", now());
    assert.equal(stillRunning, false, "a running run is never touched by the queued-only CAS");
  });
  await check("failLongQueuedComputerRuns fails only this person's CHAT runs queued past the 10-minute cap", async () => {
    const owner = await person();
    const c = await conv(owner.scope);
    const q = await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "old", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(q.ok);
    advance(types.COMPUTER_MAX_QUEUED_MS + 1_000);
    const fresh = await conv(owner.scope);
    const q2 = await store.enqueueRun(db, owner.scope, { conversationId: fresh.id, text: "fresh", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(q2.ok);
    const timedOut = await store.failLongQueuedComputerRuns(db, owner.scope, now());
    assert.deepEqual(timedOut, q.ok ? [q.run.id] : []);
    assert.equal((await store.getRun(db, owner.scope, q2.ok ? q2.run.id : ""))?.status, "queued", "the fresh run is untouched");
  });
  await check("reapStaleComputerRuns closes a producer that went silent past RUN_STALE_PRODUCER_MS, scoped to this person only", async () => {
    const owner = await person();
    const other = await person();
    const mine = await conv(owner.scope);
    const q = await store.enqueueRun(db, owner.scope, { conversationId: mine.id, text: "going stale", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(q.ok);
    await store.claimComputerRun(db, owner.pairing, "stale-claim", now());

    const othersConv = await conv(other.scope);
    const othersRun = await store.enqueueRun(db, other.scope, { conversationId: othersConv.id, text: "other person, fresh", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(othersRun.ok);
    await store.claimComputerRun(db, other.pairing, "others-claim", now());

    advance(125_000);
    const closed = await store.reapStaleComputerRuns(db, owner.scope, now());
    assert.deepEqual(closed, q.ok ? [q.run.id] : []);
    assert.equal((await store.getRun(db, owner.scope, q.ok ? q.run.id : ""))?.status, "interrupted");
    assert.equal((await store.getRun(db, other.scope, othersRun.ok ? othersRun.run.id : ""))?.status, "running", "another person's run is untouched by this person's reap");
  });
  await check("claimCleanup runs both reapers for this person and leaves other people untouched", async () => {
    const owner = await person();
    const other = await person();
    const mine = await conv(owner.scope);
    const q = await store.enqueueRun(db, owner.scope, { conversationId: mine.id, text: "mine stale", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(q.ok);
    await store.claimComputerRun(db, owner.pairing, "cleanup-claim", now());
    advance(125_000);

    const othersConv = await conv(other.scope);
    const othersRun = await store.enqueueRun(db, other.scope, { conversationId: othersConv.id, text: "others own", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(othersRun.ok);
    await store.claimComputerRun(db, other.pairing, "others-claim-2", now());

    const { reaped } = await store.claimCleanup(db, owner.scope, now());
    assert.deepEqual(reaped, q.ok ? [q.run.id] : []);
    assert.equal((await store.getRun(db, other.scope, othersRun.ok ? othersRun.run.id : ""))?.status, "running", "another person's still-fresh producer run was not touched by this person's cleanup");
  });

  await check("v2 pairing cleanup reaches workspace-default runs requested by members, without touching another pairing", async () => {
    const tenant = uid();
    const owner = await person(tenant);
    const member = await person(tenant);
    const otherOwner = await person(tenant);

    const staleConv = await conv(member.scope);
    const stale = await store.enqueueRun(db, member.scope, {
      conversationId: staleConv.id,
      text: "member request on the workspace owner's Mac",
      chatMode: "build",
      showThinking: false,
      now: now(),
      executor: "computer",
      targetPairingId: owner.pairing.pairingId,
      runtimeEngineKind: "cli",
      runtimeEngineName: "codex",
      runtimeFallbackPolicy: "none",
    });
    assert.ok(stale.ok);
    const claimed = await store.claimComputerRun(db, owner.pairing, "workspace-owner-stale", now(), "department_task_v2");
    assert.equal(claimed?.id, stale.ok ? stale.run.id : "");

    const untouchedConv = await conv(member.scope);
    const untouched = await store.enqueueRun(db, member.scope, {
      conversationId: untouchedConv.id,
      text: "another selected pairing",
      chatMode: "build",
      showThinking: false,
      now: now(),
      executor: "computer",
      targetPairingId: otherOwner.pairing.pairingId,
      runtimeEngineKind: "cli",
      runtimeEngineName: "codex",
      runtimeFallbackPolicy: "none",
    });
    assert.ok(untouched.ok);

    advance(types.RUN_STALE_PRODUCER_MS + 1_000);
    const cleaned = await store.claimCleanupForPairing(
      db,
      { tenantId: tenant, pairingId: owner.pairing.pairingId },
      now(),
    );
    assert.deepEqual(cleaned.reaped, stale.ok ? [stale.run.id] : []);
    assert.equal((await store.getRun(db, member.scope, stale.ok ? stale.run.id : ""))?.status, "interrupted");
    assert.equal((await store.getRun(db, member.scope, untouched.ok ? untouched.run.id : ""))?.status, "queued");
  });

  await check("v2 pairing cleanup preserves queue-time API fallback consent at the absolute timeout", async () => {
    const tenant = uid();
    const owner = await person(tenant);
    const member = await person(tenant);
    const c = await conv(member.scope);
    const queued = await store.enqueueRun(db, member.scope, {
      conversationId: c.id,
      text: "fall back after the owner computer never claims",
      chatMode: "build",
      showThinking: false,
      now: now(),
      executor: "computer",
      targetPairingId: owner.pairing.pairingId,
      runtimeEngineKind: "cli",
      runtimeEngineName: "codex",
      runtimeFallbackPolicy: "workspace_api",
      runtimeApiSnapshot: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    assert.ok(queued.ok);
    advance(types.COMPUTER_MAX_QUEUED_MS + 1_000);
    const cleaned = await store.claimCleanupForPairing(
      db,
      { tenantId: tenant, pairingId: owner.pairing.pairingId },
      now(),
    );
    const row = await store.getRun(db, member.scope, queued.ok ? queued.run.id : "");
    assert.deepEqual(cleaned.fellBack, queued.ok ? [queued.run.id] : [], `cleanup=${JSON.stringify(cleaned)} row=${JSON.stringify(row)}`);
    assert.deepEqual(cleaned.timedOut, []);
    assert.equal(row?.status, "queued");
    assert.equal(row?.executor, "worker");
    assert.equal(row?.runtimeFallbackReason, "computer_not_answering");
  });

  console.log("finishProducerRun writes a usage-ledger row (O4 truthfulness rule 8)");
  await check("a computer-claimed run that finishes 'done' writes one ai_usage_events row: provider bridge, model claude, subscription, cost 0", async () => {
    const owner = await person();
    const c = await conv(owner.scope);
    const q = await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "ledger me", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.ok(q.ok);
    const claimed = await store.claimComputerRun(db, owner.pairing, "ledger-claim", now());
    assert.ok(claimed);
    await store.appendEvents(db, owner.scope, claimed!.id, [{ seq: 100, kind: "delta", data: { text: "hello" } }], now());
    const ok = await store.finishProducerRun(db, claimed!, { status: "done", errorCode: null, message: null, inputTokens: 120, outputTokens: 40, now: now() });
    assert.equal(ok, true);
    const row = await db.execute({
      sql: `SELECT provider, model, billing_mode, auth_kind, cost_micro_usd, outcome, input_tokens, output_tokens FROM ai_usage_events WHERE tenant_id = ? AND user_id = ? ORDER BY occurred_at DESC LIMIT 1`,
      args: [owner.scope.tenantId, owner.scope.userId],
    });
    const r = row.rows[0] as unknown as Record<string, unknown>;
    assert.equal(r.provider, "bridge");
    assert.equal(r.model, "claude");
    assert.equal(r.billing_mode, "subscription");
    assert.equal(r.auth_kind, "subscription");
    assert.equal(Number(r.cost_micro_usd), 0);
    assert.equal(r.outcome, "ok");
    assert.equal(Number(r.input_tokens), 120);
    assert.equal(Number(r.output_tokens), 40);
  });

  // CodeRabbit (PR #589): on the push path the Worker's meter already wrote the
  // turn's usage row before attachProducer handed the run over, so a producer
  // finishing a WORKER run must not write a second row (double-counted usage
  // and monthly run limits). Only computer runs get the producer ledger row.
  await check("a push-path (worker) producer run that finishes writes NO second ai_usage_events row", async () => {
    const owner = await person();
    const c = await conv(owner.scope);
    const q = await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "push path", chatMode: "build", showThinking: false, now: now(), executor: "worker" });
    assert.ok(q.ok);
    const run = q.ok ? q.run : null;
    assert.ok(run && run.executor === "worker");
    await db.execute({ sql: "UPDATE dept_chat_runs SET status = 'running', source = 'producer' WHERE id = ?", args: [run!.id] });
    const count = async () =>
      Number((await db.execute({ sql: "SELECT COUNT(1) AS n FROM ai_usage_events WHERE tenant_id = ? AND user_id = ?", args: [owner.scope.tenantId, owner.scope.userId] })).rows[0].n);
    const before = await count();
    const ok = await store.finishProducerRun(db, run!, { status: "done", errorCode: null, message: null, inputTokens: 10, outputTokens: 5, now: now() });
    assert.equal(ok, true);
    assert.equal(await count(), before, "the push handoff's own meter is the only ledger row");
  });

  console.log("Registered in CI");
  await check("the test group includes this file", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    assert.match(pkg.scripts?.["test:os"] ?? "", /tests\/computer-claim\.test\.ts/);
  });

  console.error = realError;
  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error = realError;
  console.error(err);
  process.exit(1);
});
