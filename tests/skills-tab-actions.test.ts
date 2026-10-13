/**
 * skills-tab-actions.test.ts - the 6-second Undo queue (JARVIS plan 3, Task 8). Fake timers, fake send.
 * PINNED: Undo inside the window sends nothing; the timer sends once; flush (leaving the page)
 * sends once with keepalive and the timer never sends it again; a second edit sends the first at
 * once; a failed send says nothing changed.
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
    assert.deepEqual(h.sent, [{ description: "A", keepalive: false }]);
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
  console.log(`skills-tab-actions: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main();
