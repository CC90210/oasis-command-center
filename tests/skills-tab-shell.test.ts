/**
 * tests/skills-tab-shell.test.ts - the Skills tab shell's toast keying (JARVIS plan 3, Task 11).
 * PINNED: toastFor's key identifies WHICH announcement this is (kind + description), not a
 * fresh id per call. Ruling C4: when an older edit's in-flight send settles while a newer edit is
 * still queued, the queue re-announces the newer edit's own "pending" state so its Undo toast
 * stays the last word (never the older edit's "sent"/"error"). That re-announcement must produce
 * the SAME key as the first announcement of the SAME edit, so the rendered toast is never
 * remounted for an edit that was never actually re-queued - a remount would restart any
 * mount-tied countdown or entrance motion, a cosmetic lie about how much time is left before it
 * sends. A genuinely different announcement (a different edit, or the same edit moving to a
 * different kind of state) must get a different key so the toast legitimately swaps.
 * Run: node --conditions=react-server --import tsx tests/skills-tab-shell.test.ts
 */
import assert from "node:assert/strict";
import { toastFor } from "../lib/skills/view";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
  }
}

console.log("skills-tab-shell:");

check("a C4 re-announce of the same pending edit keeps the same toast key", () => {
  const first = toastFor({ kind: "pending", description: "Put graft in Fix something broken as use first" });
  const second = toastFor({ kind: "pending", description: "Put graft in Fix something broken as use first" });
  assert.ok(first && second);
  assert.equal(first!.key, second!.key, "re-announcing the same pending edit must not change its key");
  // The text and Undo affordance must also be identical, not merely the key.
  assert.equal(first!.text, second!.text);
  assert.equal(first!.undo, true);
});

check("a different queued edit gets a different toast key", () => {
  const a = toastFor({ kind: "pending", description: "A" });
  const b = toastFor({ kind: "pending", description: "B" });
  assert.notEqual(a!.key, b!.key);
});

check("sending/sent/error states key off the description too, not a counter", () => {
  const s1 = toastFor({ kind: "sending", description: "A" });
  const s2 = toastFor({ kind: "sending", description: "A" });
  assert.equal(s1!.key, s2!.key);
  const sent1 = toastFor({ kind: "sent", description: "A" });
  const err1 = toastFor({ kind: "error", description: "A", message: "the server answered 500" });
  // Different KIND of state for the same edit must still change the key, so moving from
  // "pending" to "sent" (a real change) is free to remount, just not a same-state re-announce.
  assert.notEqual(s1!.key, sent1!.key);
  assert.notEqual(s1!.key, err1!.key);
  assert.match(err1!.text, /500/);
});

// Fix round 1 (review, IMPORTANT): a C4 re-announce can carry the OLDER edit's own failure as
// `message` on the NEWER edit's "pending" state (actions.ts: the older send settles with an
// error while the newer edit is still queued). Scenario: edit A is waiting, edit B is made, which
// sends A right away; A's save fails, and the queue re-announces B's pending toast carrying A's
// error text. Dropping that text silently (the behaviour before this fix) reads as "A must have
// saved fine" when it did not - wrong data. The fix says so plainly, in the SAME toast, without
// changing the key (no countdown restart for an edit that was never re-queued).
check("a waiting toast carrying a stale send's error says the earlier edit did not save (wrong-data fix)", () => {
  const plain = toastFor({ kind: "pending", description: "B" });
  const withMsg = toastFor({ kind: "pending", description: "B", message: "Could not save (500)" });
  assert.ok(plain && withMsg);
  assert.equal(plain!.key, withMsg!.key, "the stale message must not change the key (no countdown restart)");
  assert.equal(withMsg!.undo, true, "B is still a live, undoable pending edit");
  assert.match(withMsg!.text, /did not save/i);
  assert.match(withMsg!.text, /Could not save \(500\)/, "the earlier edit's own error text must be shown");
  assert.match(withMsg!.text, /Nothing changed/);
  assert.match(withMsg!.text, /Queued: B/, "B's own queued-edit text must still be present");
  assert.doesNotMatch(withMsg!.text, /—/, "no em dash in user-facing copy");
});

console.log(`skills-tab-shell: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
