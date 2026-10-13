/**
 * skills-tab-actions.test.ts - the 6-second Undo queue (JARVIS plan 3, Task 8). Fake timers, fake send.
 * PINNED: Undo inside the window sends nothing; the timer sends once; flush (leaving the page)
 * sends once with keepalive and the timer never sends it again; a second edit sends the first at
 * once; a failed send says nothing changed.
 * Fix round 1: every queued send carries keepalive:true, whatever triggered it (not only flush).
 * Ruling C4 and the in-flight paths, with a controllable fake send that settles on demand: (a) A
 * in flight, add B, A resolves - re-announces pending B; (b) same but A rejects - pending B
 * carries A's error text; (c) undo while A is in flight returns false and A still settles;
 * (d) flush while A is in flight sends only the current edit (B), once, with keepalive.
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
 * (fix round 1): a send only "finishes" when the test says so.
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
    h.fire(); // current is now null: A's send is in flight, nothing left to undo
    assert.equal(h.q.undo(), false);
    h.controls[0].resolve();
    await tick();
    assert.deepEqual(h.sent, [{ description: "A", keepalive: true }]);
    assert.equal(h.states.at(-1)?.kind, "sent");
  });
  await check("(d) flush while A is in flight sends only B, once, with keepalive", async () => {
    const h = controllableHarness();
    h.q.add("A", ch("A"));
    h.fire(); // A in flight, unresolved
    h.q.add("B", ch("B"));
    h.q.flush(); // flushes the CURRENT edit (B); A's own in-flight send is untouched
    h.controls[1].resolve(); // B settles
    await tick();
    assert.deepEqual(h.sent, [{ description: "B", keepalive: true }]);
    assert.equal(h.controls.length, 2, "flush must not start a second send for A");
  });

  console.log(`skills-tab-actions: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main();
