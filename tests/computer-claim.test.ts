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

  const store = await import("../lib/os/runs/store");
  const types = await import("../lib/os/runs/types");

  let clock = Date.now();
  const now = () => new Date(clock);
  const advance = (ms: number) => void (clock += ms);

  /** A fresh (tenant, user) and the matching claim pairing, isolated from every other check. */
  function person(tenantId = uid()) {
    const userId = uid();
    const pairingId = uid();
    return { scope: { tenantId, userId }, pairing: { tenantId, userId, pairingId } };
  }

  async function conv(scope: { tenantId: string; userId: string }, dept = "sales") {
    return store.createConversation(db, scope, { department: dept, agentSlug: "sdr", now: now() });
  }

  console.log("enqueueRun carries executor and origin");
  await check("a 'computer' run enqueues queued, executor 'computer', origin 'chat', and is NOT claimable by the Worker driver", async () => {
    const { scope } = person();
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
    const { scope } = person();
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
    const ann = person(tenant);
    const ben = person(tenant);
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
    const zeta = person();
    const cZ = await conv(zeta.scope);
    await store.enqueueRun(db, zeta.scope, { conversationId: cZ.id, text: "zeta's", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    const wrongTenantSamePairingId = await store.claimComputerRun(db, { tenantId: uid(), userId: zeta.scope.userId, pairingId: zeta.pairing.pairingId }, "claim-x", now());
    assert.equal(wrongTenantSamePairingId, null, "the tenant id differs, so no row matches even with the right user id");
  });
  await check("two concurrent claims for the same person have exactly one winner (compare-and-swap)", async () => {
    const owner = person();
    const otherPairingSamePerson = { ...owner.pairing, pairingId: uid() };
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
  await check("order is kept within a conversation; chats go before automations (origin ordering)", async () => {
    const owner = person();
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
    const owner = person();
    const c = await conv(owner.scope);
    await store.enqueueRun(db, owner.scope, { conversationId: c.id, text: "mine", chatMode: "build", showThinking: false, now: now(), executor: "computer" });
    assert.equal(await store.claimNextRun(db, owner.scope, c.id, "worker-lease-x", now()), null);
  });

  console.log("idempotent retry vs. claim_already_started");
  await check("a lost claim answer retried with the same claim_id returns the same run again", async () => {
    const owner = person();
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
    const owner = person();
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
    const owner = person();
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
    const owner = person();
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
    const owner = person();
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
    const owner = person();
    const other = person();
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
    const owner = person();
    const other = person();
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

  console.log("finishProducerRun writes a usage-ledger row (O4 truthfulness rule 8)");
  await check("a computer-claimed run that finishes 'done' writes one ai_usage_events row: provider bridge, model claude, subscription, cost 0", async () => {
    const owner = person();
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
