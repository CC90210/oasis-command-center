/**
 * skills-tab-actions.test.ts - the 6-second Undo queue (JARVIS plan 3, Task 8). Fake timers, fake send.
 * PINNED: Undo inside the window sends nothing; the timer sends once; flush (leaving the page)
 * sends once with keepalive and the timer never sends it again; a second edit sends the first at
 * once; a failed send says nothing changed.
 * Fix round 1: every queued send carries keepalive:true, whatever triggered it (not only flush).
 * Ruling C4 and the in-flight paths, with a controllable fake send that settles on demand: (a) A
 * in flight, add B, A resolves - re-announces pending B; (b) same but A rejects - pending B
 * carries A's error text; (c) undo while A is in flight returns false and A still settles;
 * (d) flush while A is in flight queues B's send BEHIND A's (Codex fix round: see below) - it no
 * longer starts a concurrent second send the instant flush is called.
 * Codex fix round (P2, wrong data): every real `o.send` call is now serialized through one promise
 * chain in actions.ts, so a later edit cannot reach the network until every earlier edit's send has
 * settled. Before this fix, A's timer, a second/third edit, or flush() could each call `fire()` and
 * reach `o.send` while an earlier send was still in flight - the server timestamps on arrival, so
 * an assign-then-remove could persist as remove-then-assign. The controllable harness below never
 * auto-settles a send, so these tests can prove ordering precisely rather than hope for it from
 * timing. NOTE: because the real send is now reached via a `.then()` on the chain rather than
 * called synchronously inside `fire()`, tests that inspect `controls[i]` must `await tick()` once
 * after the triggering call before that control exists - that extra tick is the ONLY change made to
 * the pre-existing (a)/(b)/(c) tests; (d) is rewritten because the behaviour it pinned (an immediate
 * concurrent second send) was the bug.
 * Run: node --import tsx tests/skills-tab-actions.test.ts
 */
import assert from "node:assert/strict";
import { createPendingQueue, type QueueState } from "../components/playbook/skills/actions";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(fail = false) {
  const timers = new Map<number, () => void>();
  let next = 1;
  const sent: { description: string; keepalive: boolean }[] = [];
  const states: QueueState[] = [];
  const q = createPendingQueue({
    send: async (c, keepalive) => { if (fail) throw new Error("the server answered 500"); sent.push({ description: c.description, keepalive }); },
    onState: (s) => states.push(s),
    timers: { set: (fn) => { const h = next++; timers.set(h, fn); return h; }, clear: (h) => { timers.delete(h as number); } },
  });
  const fire = () => { for (const [h, fn] of [...timers]) { timers.delete(h); fn(); } };
  return { q, sent, states, fire };
}
const ch = (d: string) => ({ description: d, scope: "shared", ops: [{ op: "unassign", skill: "graft", label: "debug" }] });

/**
 * A harness whose `send` does not settle on its own: each call returns a promise the test
 * resolves or rejects on demand, via `controls[i]`, so "A is still in flight when B is queued"
 * can be driven precisely rather than hoped for from timing. Used for Ruling C4 / in-flight pins
 * (fix round 1) and for the Codex fix round's ordering pins: a new `controls` entry only appears
 * once `o.send` is ACTUALLY invoked, which (after the Codex fix) only happens once every earlier
 * send on the chain has settled - so `controls.length` at any point is a precise count of how many
 * sends have actually reached the network so far, independent of which have resolved.
 */
function controllableHarness() {
  const timers = new Map<number, () => void>();
  let next = 1;
  const sent: { description: string; keepalive: boolean }[] = [];
  const states: QueueState[] = [];
  const controls: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const q = createPendingQueue({
    send: (c, keepalive) =>
      new Promise<void>((resolve, reject) => {
        controls.push({
          resolve: () => { sent.push({ description: c.description, keepalive }); resolve(); },
          reject,
        });
      }),
    onState: (s) => states.push(s),
    timers: { set: (fn) => { const h = next++; timers.set(h, fn); return h; }, clear: (h) => { timers.delete(h as number); } },
  });
  const fire = () => { for (const [h, fn] of [...timers]) { timers.delete(h); fn(); } };
  return { q, sent, states, fire, controls };
}

async function main() {
  console.log("skills-tab-actions:");
  await check("undo inside the window sends nothing", async () => {
    const h = harness();
    h.q.add("A", ch("A"));
    assert.equal(h.q.undo(), true);
    h.fire(); await tick();
    assert.deepEqual(h.sent, []);
    assert.equal(h.states.at(-1)?.kind, "undone");
  });
  await check("the timer sends once", async () => {
    const h = harness();
    h.q.add("A", ch("A"));
    h.fire(); await tick();
    // Ruling (fix round 1): every queued send carries keepalive:true, not only flush - a
    // non-keepalive in-flight send can be cancelled by the browser on unload and lost with no
    // toast, so there is no safe case for `false` here any more.
    assert.deepEqual(h.sent, [{ description: "A", keepalive: true }]);
    assert.equal(h.q.undo(), false);
  });
  await check("flush sends once with keepalive", async () => {
    const h = harness();
    h.q.add("A", ch("A"));
    h.q.flush(); await tick();
    h.fire(); await tick();
    assert.deepEqual(h.sent, [{ description: "A", keepalive: true }]);
  });
  await check("a second edit sends the first at once and waits on the second", async () => {
    const h = harness();
    h.q.add("A", ch("A"));
    h.q.add("B", ch("B")); await tick();
    assert.deepEqual(h.sent.map((s) => s.description), ["A"]);
    assert.equal(h.states.at(-1)?.description, "B");
  });
  await check("a failed send reports nothing changed", async () => {
    const h = harness(true);
    h.q.add("A", ch("A"));
    h.fire(); await tick();
    const last = h.states.at(-1);
    assert.equal(last?.kind, "error");
    assert.match(String(last?.message), /500/);
  });
  // --- Fix round 1, ruling 3: Ruling C4 and the in-flight paths, with a controllable fake send ---
  await check("(a) A in flight, add B, A resolves: states re-announce pending B", async () => {
    const h = controllableHarness();
    h.q.add("A", ch("A"));
    h.fire(); // A's send is now in flight (not yet settled)
    h.q.add("B", ch("B"));
    assert.equal(h.states.at(-1)?.description, "B"); // B's own pending, announced synchronously
    // Codex fix round: A's real send is reached via the chain's `.then()`, not called synchronously
    // inside `fire()` any more - give it one tick to actually land on `controls` before resolving.
    await tick();
    h.controls[0].resolve(); // A settles now
    await tick();
    assert.deepEqual(h.sent.map((s) => s.description), ["A"]);
    const last = h.states.at(-1);
    assert.deepEqual(last, { kind: "pending", description: "B" });
  });
  await check("(b) same but A rejects: pending B carries A's error text as message", async () => {
    const h = controllableHarness();
    h.q.add("A", ch("A"));
    h.fire();
    h.q.add("B", ch("B"));
    await tick(); // Codex fix round: let A's deferred send actually reach `controls` first.
    h.controls[0].reject(new Error("the server answered 500"));
    await tick();
    const last = h.states.at(-1);
    assert.equal(last?.kind, "pending");
    assert.equal(last?.description, "B");
    assert.match(String(last?.message), /500/);
  });
  await check("(c) undo while A is in flight returns false and A still settles", async () => {
    const h = controllableHarness();
    h.q.add("A", ch("A"));
    h.fire(); // current is now null: A's send is captured and queued on the chain
    assert.equal(h.q.undo(), false);
    await tick(); // Codex fix round: let A's deferred send actually reach `controls` first.
    h.controls[0].resolve();
    await tick();
    assert.deepEqual(h.sent, [{ description: "A", keepalive: true }]);
    assert.equal(h.states.at(-1)?.kind, "sent");
  });
  await check(
    "(d) flush while A is in flight starts B's send at once (teardown exception) - nothing lost",
    async () => {
      // Codex re-review (P2): an earlier version of this test pinned flush() QUEUING B's send
      // behind A's still-in-flight one - that was itself a bug (a deferred send queued behind an
      // earlier one never gets the chance to start once the document is destroyed, so the edit
      // would be lost outright, not merely reordered). This pins the corrected behaviour: flush()
      // starts B's send immediately, even while A is still in flight, so it is never lost.
      const h = controllableHarness();
      h.q.add("A", ch("A"));
      h.fire(); // A in flight, unresolved
      await tick(); // let A's own (always chain-deferred) send actually reach the network first
      assert.equal(h.controls.length, 1, "sanity: only A has reached the network so far");
      h.q.add("B", ch("B"));
      h.q.flush(); // flushes the CURRENT edit (B) immediately - the page-teardown exception
      assert.equal(h.controls.length, 2, "flush must start B's send at once, even while A is in flight");
      h.controls[0].resolve(); // A settles
      h.controls[1].resolve(); // B settles
      await tick();
      assert.deepEqual(h.sent.map((s) => s.description).sort(), ["A", "B"]);
    },
  );
  await check(
    "Codex re-review: flush on teardown starts B's send synchronously, before A resolves, with keepalive true",
    async () => {
      const h = controllableHarness();
      h.q.add("A", ch("A"));
      h.fire(); // A's timer fires -> A's own send is queued on the (initially empty) chain
      await tick(); // let A's send actually reach the network; controls[0] now exists, unresolved
      assert.equal(h.controls.length, 1, "sanity: A's send has reached the network");
      h.q.add("B", ch("B")); // B queued behind A, with its own timer
      h.q.flush(); // must start B's fetch SYNCHRONOUSLY, inside this very call - no await anywhere above
      assert.equal(h.controls.length, 2, "flush must invoke B's send synchronously, before any await");
      // A has not been resolved at all yet - proves B's send started WHILE A was still in flight,
      // not merely "soon after". A deferred-but-not-yet-invoked send could not pass this check.
      assert.equal(h.sent.length, 0, "neither send has settled yet; reaching the network is what's under test here, not finishing");
      h.controls[0].resolve(); // A settles
      h.controls[1].resolve(); // B settles
      await tick();
      assert.deepEqual(h.sent.find((s) => s.description === "B"), { description: "B", keepalive: true });
    },
  );

  // --- Codex fix round (P2): every send is serialized through one promise chain ---
  await check(
    "serialized sends (a): A in flight, B added and its timer fires: B's send waits for A, order A then B",
    async () => {
      const h = controllableHarness();
      h.q.add("A", ch("A"));
      h.fire(); // A's timer fires -> A's send is reached, in flight
      h.q.add("B", ch("B")); // B queued behind A, with its own timer
      h.fire(); // B's timer fires too -> B is captured, but must wait its turn on the chain
      await tick();
      assert.equal(h.controls.length, 1, "B's send must not be invoked while A is still in flight");
      h.controls[0].resolve(); // A settles
      await tick();
      assert.equal(h.controls.length, 2, "B's send is invoked only once A has settled");
      h.controls[1].resolve(); // B settles
      await tick();
      assert.deepEqual(h.sent.map((s) => s.description), ["A", "B"]);
    },
  );
  await check(
    "serialized sends (b): A in flight, then B added, then C added: the order is A, B, C",
    async () => {
      const h = controllableHarness();
      h.q.add("A", ch("A"));
      h.fire(); // A in flight
      h.q.add("B", ch("B")); // current was null (A already taken) - B just starts its own timer
      h.q.add("C", ch("C")); // add() sees current=B, fires B right away (still queued behind A); C is current
      h.fire(); // C's own timer fires -> C is captured too (queued behind B)
      await tick();
      assert.equal(h.controls.length, 1, "only A may have reached the network while it is still in flight");
      h.controls[0].resolve(); // A settles
      await tick();
      assert.equal(h.controls.length, 2, "B reaches the network only once A has settled");
      h.controls[1].resolve(); // B settles
      await tick();
      assert.equal(h.controls.length, 3, "C reaches the network only once B has settled too");
      h.controls[2].resolve(); // C settles
      await tick();
      assert.deepEqual(h.sent.map((s) => s.description), ["A", "B", "C"]);
    },
  );
  await check("serialized sends (c): A fails, B still sends after it, and the error state is reported", async () => {
    const h = controllableHarness();
    h.q.add("A", ch("A"));
    h.fire(); // A in flight
    h.q.add("B", ch("B"));
    h.fire(); // B's timer fires too -> queued behind A's chain
    await tick();
    h.controls[0].reject(new Error("the server answered 500")); // A fails
    await tick();
    const errState = h.states.find((s) => s.kind === "error");
    assert.ok(errState, "A's failure must be reported as an error state");
    assert.match(String(errState?.message), /500/);
    assert.equal(h.controls.length, 2, "B's send must still be invoked after A's failure");
    h.controls[1].resolve(); // B settles
    await tick();
    assert.deepEqual(h.sent.map((s) => s.description), ["B"]); // A rejected, so it never pushed into `sent`
  });

  console.log(`skills-tab-actions: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main();
