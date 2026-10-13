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

console.log(`skills-tab-shell: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
