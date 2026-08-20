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
import { resumePlan, nextRamp, RESTART_DAILY, RESTART_HOURLY } from "../lib/sms/resume-core";
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

// ── It resumes SMALL, regardless of where volume was before ─────────────
// Caps before the halt were 40/day and 7/hour. Going straight back would put a
// full day of volume through lines with two data points each.
{
  const p = resumePlan([cleared("+1")]);
  assert.ok(p.dailyCap <= 10, "restart volume must be small");
  assert.ok(p.dailyCap < 40, "must not return to the pre-halt cap");
  assert.match(p.reason, /10\/day/);
}

// ── The ramp is a ladder, and never skips ───────────────────────────────
assert.equal(nextRamp(0), RESTART_DAILY);
assert.equal(nextRamp(10), 25);
assert.equal(nextRamp(25), 40);
assert.equal(nextRamp(40), 40, "the ladder stops at the pre-halt volume rather than climbing forever");

console.log("sms-resume.test.ts — all assertions passed");
