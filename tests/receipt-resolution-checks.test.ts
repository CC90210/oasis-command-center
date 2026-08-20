/**
 * tests/receipt-resolution-checks.test.ts — the instrument is now monitored.
 *
 * THE GAP THESE CLOSE. sms.receipt_coverage verified that receipts were
 * CREATED. Nothing verified they were ANSWERED, and that is exactly what broke:
 * from 2026-08-16 the reconciler could not match our message inside the
 * provider's thread, so every receipt was opened, never resolved, and retired
 * as 'unknown' three days later.
 *
 *   real carrier verdicts 2026-08-07 to 08-16:  47
 *   real carrier verdicts 2026-08-16 to 08-20:   0
 *
 * Coverage stayed green throughout, because the receipts existed. They were
 * empty.
 *
 * And it was never only a reporting gap: smsSendAllowed() reads these same
 * receipts, so with nothing resolving the circuit breaker could not open no
 * matter how many sends died. Verified against production on 2026-08-20 by
 * evaluating sms.carrier_verdict_rate at an endMs inside the blind period: 67%,
 * FAILING. Same check now reads 100%.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DRIP_CHECKS } from "../lib/health/drip-checks";

const byId = new Map(DRIP_CHECKS.map((c) => [c.id, c]));

// ── Both checks exist and are registered ─────────────────────────────────
for (const id of ["sms.receipts_unresolved", "sms.carrier_verdict_rate"]) {
  assert.ok(byId.has(id), `${id} must be in DRIP_CHECKS, or it never runs`);
  assert.equal(byId.get(id)!.severity, "high");
}

// ── An unresolved receipt is never acceptable ────────────────────────────
assert.deepEqual(
  byId.get("sms.receipts_unresolved")!.rule,
  { kind: "must_be_zero" },
  "there is no healthy number of receipts that never got an answer",
);

// ── The rate check must have a DEGRADED band ─────────────────────────────
// must_be_above has no degraded verdict, so a rate sliding from 100 to 85 would
// read as plain OK right up until it crossed the floor. must_reach is what
// makes a partial failure visible while it is still partial.
{
  const rule = byId.get("sms.carrier_verdict_rate")!.rule as { kind: string; target: number; failingBelow: number };
  assert.equal(rule.kind, "must_reach", "a rate needs a degraded band, not a bare floor");
  assert.ok(rule.target > rule.failingBelow, "target must sit above the failing threshold");
  // Calibrated against the real event: evaluating this check at an endMs inside
  // the blind period returned 67%. The failing threshold has to sit ABOVE that,
  // or the outage that motivated the check would only have registered as
  // degraded.
  assert.ok(rule.failingBelow > 67, "67% was a real outage and must land in FAILING, not degraded");
}

const src = readFileSync(new URL("../lib/health/drip-checks.ts", import.meta.url), "utf8");
const block = src.slice(src.indexOf('id: "sms.receipts_unresolved"'), src.indexOf('id: "drips.overdue_backlog"'));

// ── 'unknown' must NOT count as an answer ────────────────────────────────
// A retired receipt carries carrier_status 'unknown'. Counting it would let the
// three-day give-up path masquerade as successful reconciliation — the outage
// itself, reported as health.
assert.ok(
  block.includes('.in("carrier_status", ["delivered", "failed", "undelivered"])'),
  "only real verdicts count toward the answered rate",
);
assert.ok(
  !/\.in\("carrier_status", \[[^\]]*"unknown"/.test(block),
  "'unknown' must never be counted as a carrier verdict",
);

// ── The unresolved count must be BOUNDED BELOW by the retirement cutoff ──
// The reconciler force-resolves anything older than three days. Without a lower
// bound the query can only ever see rows inside that window anyway, but stating
// it keeps the check honest if the retirement policy changes: an unbounded
// query would read zero during a total outage once every row had aged out.
assert.ok(
  block.includes("3 * DAY"),
  "the unresolved window must be bounded by the retirement cutoff",
);
assert.ok(block.includes("6 * 3_600_000"), "and must allow a grace window before alarming");

// ── No sample is not a pass ──────────────────────────────────────────────
// Returning 0 for an empty window would report a perfect rate over nothing.
assert.ok(
  block.includes("if (total === 0) return null;"),
  "an empty window must return null (check_broken), never a perfect score",
);

console.log("receipt-resolution-checks.test.ts — all assertions passed");
