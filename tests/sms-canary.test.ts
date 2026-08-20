/**
 * tests/sms-canary.test.ts — a line is proven by SPACED deliveries, never by a
 * burst.
 *
 * THE EVENT THIS ENCODES. 2026-08-18: the AI Follow-Up wire delivered 8 of 8
 * and we commissioned it. 2026-08-19 17:34 onward: every send from those same
 * two numbers was refused, and stayed refused. A first-day burst is exactly
 * what a number does before the carriers decide about it, so a burst must not
 * be able to clear a line.
 */

import assert from "node:assert/strict";
import { lineVerdict, clearedLines, resumeAllowed, MIN_SPREAD_MS, type CanaryAttempt } from "../lib/sms/canary-core";

const N = "+19703237557";
const at = (iso: string, status: string | null, resolved = true): CanaryAttempt => ({
  number: N, sentAt: iso, carrierStatus: status, resolvedAt: resolved && status ? iso : null,
});

// ── THE 08-18 BURST MUST NOT CLEAR THE LINE ───────────────────────────────
// Eight deliveries inside two hours. Under a naive "did it deliver" rule this
// is a green light; it was the last healthy reading before a 24h outage.
{
  const burst = [
    at("2026-08-18T19:04:06Z", "delivered"), at("2026-08-18T19:19:06Z", "delivered"),
    at("2026-08-18T19:19:08Z", "delivered"), at("2026-08-18T19:25:10Z", "delivered"),
    at("2026-08-18T19:29:05Z", "delivered"), at("2026-08-18T19:29:08Z", "delivered"),
  ];
  const r = lineVerdict(burst);
  assert.equal(r.delivered, 6);
  assert.equal(r.verdict, "insufficient", "6 deliveries inside 25 minutes must NOT clear a line");
  assert.match(r.reason, /apart/);
}
// Spread the same evidence across the required gap and it clears.
{
  const r = lineVerdict([at("2026-08-18T19:04:00Z", "delivered"), at("2026-08-18T19:40:00Z", "delivered")]);
  assert.equal(r.verdict, "cleared");
  assert.equal(r.spreadMs, 36 * 60_000);
}
// Exactly at the boundary counts.
{
  const r = lineVerdict([at("2026-08-18T19:00:00Z", "delivered"), at("2026-08-18T19:30:00Z", "delivered")]);
  assert.equal(r.verdict, "cleared", `${MIN_SPREAD_MS / 60000} minutes exactly is enough`);
}

// ── FAILURE DOMINATES ─────────────────────────────────────────────────────
// The real line was MIXED during the crossover: it delivered, then began
// refusing. A rule that clears on two good sends while ignoring a refusal
// would have re-commissioned the dead numbers on 2026-08-19.
{
  const mixed = [
    at("2026-08-18T19:04:00Z", "delivered"),
    at("2026-08-18T19:40:00Z", "delivered"),
    at("2026-08-19T17:34:00Z", "failed"),
  ];
  const r = lineVerdict(mixed);
  assert.equal(r.verdict, "failed", "any refusal benches the line, even alongside two spaced deliveries");
  assert.equal(r.delivered, 2);
  assert.equal(r.failed, 1);
}

// ── UNRESOLVED IS NOT A PASS ──────────────────────────────────────────────
// Receipts sat unresolved for four days while the reconciler was broken. If
// 'no answer yet' counted toward clearing, a totally blind system would
// commission every line it owns.
{
  const r = lineVerdict([
    at("2026-08-20T16:00:00Z", null, false),
    at("2026-08-20T16:40:00Z", null, false),
  ]);
  assert.equal(r.verdict, "pending");
  assert.equal(r.unresolved, 2);
  assert.equal(r.delivered, 0);
}
// A receipt RETIRED as 'unknown' is resolved but is not evidence of success.
{
  const r = lineVerdict([
    at("2026-08-20T16:00:00Z", "unknown"),
    at("2026-08-20T16:40:00Z", "unknown"),
  ]);
  assert.equal(r.verdict, "insufficient", "'unknown' is an absence of evidence, never a pass");
  assert.equal(r.delivered, 0);
}
// One delivered plus one still waiting is not two.
{
  const r = lineVerdict([at("2026-08-20T16:00:00Z", "delivered"), at("2026-08-20T16:40:00Z", null, false)]);
  assert.equal(r.verdict, "pending");
}

// ── Never tested ──────────────────────────────────────────────────────────
{
  const r = lineVerdict([]);
  assert.equal(r.verdict, "insufficient");
  assert.equal(r.reason, "never tested");
}

// ── clearedLines is an ALLOW-list, and fails closed ───────────────────────
{
  const results = [
    lineVerdict([at("2026-08-18T19:00:00Z", "delivered"), at("2026-08-18T19:40:00Z", "delivered")]),
    { ...lineVerdict([at("2026-08-19T17:34:00Z", "failed")]), number: "+16505977482" },
    { ...lineVerdict([]), number: "+15551234567" },
    { ...lineVerdict([at("2026-08-20T16:00:00Z", null, false)]), number: "+15557654321" },
  ];
  assert.deepEqual(clearedLines(results), [N], "only 'cleared' is permitted; pending and untested are excluded");
}

// ── resumeAllowed refuses to restart into an unproven pool ────────────────
{
  assert.equal(resumeAllowed([]).ok, false, "no evidence at all must never permit a resume");

  const allFailed = [{ ...lineVerdict([at("2026-08-19T17:34:00Z", "failed")]), number: N }];
  const r1 = resumeAllowed(allFailed);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /refused|untested/);

  const stillWaiting = [{ ...lineVerdict([at("2026-08-20T16:00:00Z", null, false)]), number: N }];
  const r2 = resumeAllowed(stillWaiting);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /awaiting/, "pending must read as 'not yet', not as a failure");

  const good = [lineVerdict([at("2026-08-18T19:00:00Z", "delivered"), at("2026-08-18T19:40:00Z", "delivered")])];
  const r3 = resumeAllowed(good);
  assert.equal(r3.ok, true);
  assert.match(r3.reason, /\+19703237557/);
}

console.log("sms-canary.test.ts — all assertions passed");
