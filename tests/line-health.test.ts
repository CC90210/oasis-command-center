/**
 * tests/line-health.test.ts — bench a bad sending number before it burns a cohort.
 *
 * Adon, 2026-08-20, choosing the thresholds: "3 failures in a row on a phone
 * number stops that number. 5 across the whole account stops all texting."
 *
 * WHY PER-LINE AND NOT JUST PER-WIRE. A canary from all twelve of our numbers
 * to ONE handset came back six delivered, six failed. Half the pool was dead.
 * The wire-level breaker (10 consecutive) could never see it, because the
 * healthy half kept resetting the consecutive count. That is the gap this fills.
 */

import assert from "node:assert/strict";
import {
  lineDecision, wireDecision, sendableLines,
  LINE_BENCH_CONSECUTIVE, WIRE_HALT_CONSECUTIVE, type LineSample,
} from "../lib/sms/line-health-core";

let clock = 1_000_000;
const s = (number: string, status: LineSample["status"]): LineSample => ({ number, status, at: clock++ });

// ── Three in a row benches the line ───────────────────────────────────────
{
  const d = lineDecision("+19703237557", [s("+19703237557", "failed"), s("+19703237557", "failed"), s("+19703237557", "failed")]);
  assert.equal(d.bench, true);
  assert.equal(d.consecutiveFailures, 3);
  assert.match(d.reason, /3 consecutive/);
}
// Two is not three.
{
  const d = lineDecision("+1", [s("+1", "failed"), s("+1", "failed")]);
  assert.equal(d.bench, false);
  assert.equal(d.consecutiveFailures, 2);
  assert.match(d.reason, new RegExp(String(LINE_BENCH_CONSECUTIVE)));
}

// ── A DELIVERY RESETS THE RUN ─────────────────────────────────────────────
// The line demonstrably still works; those failures were about the handsets it
// was aimed at, which is destination health's problem and not the line's.
{
  // Samples are created oldest-first (the clock increments), so the LAST two
  // entries are the newest. Newest-first this reads failed, failed, delivered:
  // the run stops at 2 and the line stays in the pool.
  const d = lineDecision("+1", [
    s("+1", "failed"), s("+1", "failed"), s("+1", "failed"), s("+1", "delivered"), s("+1", "failed"), s("+1", "failed"),
  ]);
  assert.equal(d.bench, false);
  assert.equal(d.consecutiveFailures, 2, "the delivery breaks the run even with older failures behind it");
}

// ── 'unknown'/'pending' are skipped, never counted either way ─────────────
// All 15 AI-wire receipts sat unresolved for four days. Counting those as
// successes would have hidden the outage; counting them as failures would bench
// a healthy line the moment reconciliation lagged.
{
  const withGaps = [
    s("+1", "failed"), s("+1", "unknown"), s("+1", "failed"), s("+1", "pending"), s("+1", "failed"),
  ];
  const d = lineDecision("+1", withGaps);
  assert.equal(d.bench, true, "three real failures still bench, with unresolved receipts interleaved");
  assert.equal(d.consecutiveFailures, 3);
  assert.equal(d.sample, 3, "only terminal verdicts count toward the sample");
}
{
  const onlyUnknown = [s("+1", "unknown"), s("+1", "pending"), s("+1", "unknown")];
  const d = lineDecision("+1", onlyUnknown);
  assert.equal(d.bench, false);
  assert.equal(d.sample, 0);
  assert.equal(d.reason, "no terminal receipts yet");
}

// ── Never tested ──────────────────────────────────────────────────────────
assert.equal(lineDecision("+1", []).bench, false);

// ── Wire halt: five spread across DIFFERENT lines still trips ────────────
// A route that is dead everywhere must halt even when no single number has
// reached its own limit.
{
  const w = wireDecision([
    s("+1a", "failed"), s("+1b", "failed"), s("+1c", "failed"), s("+1a", "failed"), s("+1b", "failed"),
  ]);
  assert.equal(w.halt, true);
  assert.equal(w.consecutiveFailures, 5);
  assert.match(w.reason, new RegExp(String(WIRE_HALT_CONSECUTIVE)));
}
// A delivery inside the run keeps the wire up: three newer failures are below
// the limit of five, and the delivery stops the count going further back.
{
  const w = wireDecision([
    s("+1a", "failed"), s("+1b", "failed"), s("+1c", "delivered"), s("+1a", "failed"), s("+1b", "failed"), s("+1c", "failed"),
  ]);
  assert.equal(w.halt, false);
  assert.equal(w.consecutiveFailures, 3);
}
// The wire decision also reports which individual lines are benched.
{
  const w = wireDecision([
    s("+1dead", "failed"), s("+1dead", "failed"), s("+1dead", "failed"),
    s("+1ok", "delivered"),
  ]);
  assert.deepEqual(w.benched, ["+1dead"]);
  assert.equal(w.halt, false, "one dead line is not a dead wire");
}

// ── THE REAL 2026-08-20 SHAPE: half the pool dead ────────────────────────
// Six delivered, six failed, same destination. Per-line benches exactly the
// six; the wire stays up because the healthy six still work.
{
  const DEAD = ["+12173101945", "+18604071050", "+15625505490", "+17857910696", "+13523490263", "+18604527608"];
  const LIVE = ["+19703237557", "+16505977482", "+12396663668", "+16513602924", "+19162461315", "+13802350121"];
  const samples: LineSample[] = [];
  for (const n of DEAD) for (let i = 0; i < 3; i++) samples.push(s(n, "failed"));
  for (const n of LIVE) samples.push(s(n, "delivered"));

  const { lines, blocked } = sendableLines([...DEAD, ...LIVE], samples);
  assert.deepEqual(lines.sort(), [...LIVE].sort(), "only the six proven lines remain sendable");
  assert.equal(blocked.length, 6);
}

// ── sendableLines FAILS CLOSED on an unreadable history ──────────────────
// Sending from every line we own because we could not read their health is the
// exact outage this prevents.
{
  const r = sendableLines(["+1a", "+1b"], null);
  assert.deepEqual(r.lines, [], "an unreadable history yields an EMPTY pool, never the full one");
  assert.match(r.reason, /unreadable/);
}

// An untested line stays usable — that is how a new number gets commissioned.
{
  const r = sendableLines(["+1new"], []);
  assert.deepEqual(r.lines, ["+1new"]);
}

console.log("line-health.test.ts — all assertions passed");
