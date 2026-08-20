/**
 * tests/sms-resume.test.ts — turning texting back on is a REFUSAL, not a
 * procedure.
 *
 * The failure being designed out is a person deciding "it looks fine now". On
 * 2026-08-18 it did look fine: eight of eight delivered. Twenty-two hours later
 * every send from those numbers was refused and stayed refused for two days.
 *
 * So the gate is code, and it says no by default.
 */

import assert from "node:assert/strict";
import { resumePlan, RESTART_DAILY, RESTART_HOURLY } from "../lib/sms/resume-core";
import { lineVerdict, type CanaryAttempt } from "../lib/sms/canary-core";

const at = (number: string, iso: string, status: string | null): CanaryAttempt =>
  ({ number, sentAt: iso, carrierStatus: status, resolvedAt: status ? iso : null });

const cleared = (n: string) =>
  lineVerdict([at(n, "2026-08-20T17:00:00Z", "delivered"), at(n, "2026-08-20T17:40:00Z", "delivered")]);
const failed = (n: string) => lineVerdict([at(n, "2026-08-20T17:00:00Z", "failed")]);
const waiting = (n: string) => lineVerdict([at(n, "2026-08-20T17:00:00Z", null)]);

// ── The only thing that permits a resume is a proven line ────────────────
{
  const p = resumePlan([cleared("+19703237557")]);
  assert.equal(p.allowed, true);
  assert.deepEqual(p.lines, ["+19703237557"]);
  assert.equal(p.dailyCap, RESTART_DAILY);
  assert.equal(p.hourlyCap, RESTART_HOURLY);
}

// ── FAIL CLOSED in every direction ───────────────────────────────────────
for (const [label, results] of [
  ["no evidence at all", []],
  ["every line refused", [failed("+1a"), failed("+1b")]],
  ["still waiting on verdicts", [waiting("+1a")]],
] as const) {
  const p = resumePlan(results as never);
  assert.equal(p.allowed, false, `${label} must not permit a resume`);
  assert.equal(p.dailyCap, 0, `${label} must not hand back a volume`);
  assert.deepEqual(p.lines, []);
}

// An unreadable history is its own refusal, and says so distinctly: "we cannot
// tell" is not "nothing passed".
{
  const p = resumePlan(null);
  assert.equal(p.allowed, false);
  assert.match(p.reason, /could not be read/);
}

// ── A single burst cannot clear a line, so it cannot resume ──────────────
// This is the 2026-08-18 shape exactly: many deliveries, all inside minutes.
{
  const burst = lineVerdict([
    at("+1", "2026-08-18T19:04:00Z", "delivered"),
    at("+1", "2026-08-18T19:19:00Z", "delivered"),
    at("+1", "2026-08-18T19:29:00Z", "delivered"),
  ]);
  const p = resumePlan([burst]);
  assert.equal(p.allowed, false, "three deliveries inside 25 minutes is the reading that fooled us");
}

// ── A mixed pool resumes on the GOOD lines only ─────────────────────────
{
  const p = resumePlan([cleared("+1good"), failed("+1bad"), waiting("+1unknown")]);
  assert.equal(p.allowed, true);
  assert.deepEqual(p.lines, ["+1good"], "a refused line must never be handed back as sendable");
}

// ── It resumes at the OPERATOR'S number, not a number I picked ──────────
// Adon, 2026-08-20: "it should be at 40 a day."
//
// I had this at 10 and was overruled. Pinning 40 here rather than quietly
// leaving my preference in the code, because the override is defensible and the
// reason matters: on 2026-08-18 a low cap was the only thing between a bad line
// and a burned cohort. It no longer is. A canary-refused line is excluded
// outright, 3 consecutive failures bench a line, 5 halt a wire, landlines are
// skipped before a message is spent, and receipts are verified again so all of
// that actually fires. Those catch a fault in single digits of wasted messages
// whatever the ceiling is, which is what a low cap was crudely substituting for.
{
  const p = resumePlan([cleared("+1")]);
  assert.equal(p.dailyCap, 40, "restart at the operator's target, not a lower one chosen for us");
  assert.equal(p.hourlyCap, 7);
  assert.match(p.reason, /40\/day/);
}

// The cap is still a CEILING, and an override must be able to move it without
// touching this file.
{
  const p = resumePlan([cleared("+1")], { dailyCap: 25, hourlyCap: 4 });
  assert.equal(p.dailyCap, 25);
  assert.equal(p.hourlyCap, 4);
}

// ── A HIGHER CAP MUST NOT WEAKEN THE GATE ───────────────────────────────
// The number only applies once evidence exists. Raising it changes the
// ceiling, never the permission.
{
  assert.equal(resumePlan([failed("+1")], { dailyCap: 40 }).allowed, false);
  assert.equal(resumePlan([], { dailyCap: 40 }).dailyCap, 0, "a blocked resume hands back no volume at all");
}

console.log("sms-resume.test.ts — all assertions passed");
