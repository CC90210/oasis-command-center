/**
 * tests/drip-template-pool.test.ts — the approved template pool.
 *
 * Adon, 2026-08-05: "we have to make sure to be rotating similar approved
 * templates... We can add to your rotation if we have a couple that we came up
 * with or that we generated outside of it."
 *
 * Two properties matter and both are easy to get wrong:
 *
 *   1. APPROVAL IS A GATE, not a label. A draft must be unreachable, not merely
 *      deprioritised. Anyone can add a template; nothing reaches a merchant
 *      until a human approves it.
 *   2. SIMILAR means SAME JOB. Templates only substitute for others playing the
 *      same role in the arc — an opener never stands in for a last call. That is
 *      what makes rotation feel like variation rather than incoherence.
 *
 * Selection reuses the executor's existing stableIndex hash, so a given lead
 * gets the same template across retries and reclaims. A redelivery that picked a
 * different template would read to the merchant as a second, different email.
 */

import assert from "node:assert/strict";
import { selectFromPool, type PoolTemplate } from "../lib/drips/template-pool";

const mk = (over: Partial<PoolTemplate> = {}): PoolTemplate => ({
  id: "t1",
  brand: "sunbiz",
  stage: "follow_up",
  role: "opener",
  subject: "s",
  bodyText: "b",
  status: "approved",
  weight: 1,
  ...over,
});

// ---------------------------------------------------------------------------
// Deterministic per (lead, step)
// ---------------------------------------------------------------------------
const pool = [mk({ id: "a" }), mk({ id: "b" }), mk({ id: "c" })];
const first = selectFromPool(pool, "lead-1", 0);
assert.ok(first, "a pool of approved templates must yield one");
assert.equal(selectFromPool(pool, "lead-1", 0)?.id, first?.id, "stable across calls");
assert.equal(selectFromPool(pool, "lead-1", 0)?.id, first?.id, "stable again — retries must not re-roll");

// Different leads spread across the set.
const spread = new Set(
  ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].map((l) => selectFromPool(pool, l, 0)?.id),
);
assert.ok(spread.size > 1, "the pool must spread across different leads");

// Different steps for one lead vary, so a 3-step sequence is not one template
// three times.
assert.notEqual(
  selectFromPool(pool, "lead-1", 0)?.id,
  selectFromPool(pool, "lead-1", 1)?.id,
  "consecutive steps for one lead should differ",
);

// ---------------------------------------------------------------------------
// THE APPROVAL GATE
// ---------------------------------------------------------------------------
assert.equal(selectFromPool([mk({ status: "draft" })], "lead-1", 0), null, "a draft is unreachable");
assert.equal(selectFromPool([mk({ status: "retired" })], "lead-1", 0), null, "a retired template is unreachable");
assert.equal(
  selectFromPool([mk({ id: "d", status: "draft" }), mk({ id: "ok" })], "lead-1", 0)?.id,
  "ok",
  "drafts are filtered out, not merely ranked below",
);
// Every lead, every step: a pool of nothing but drafts NEVER yields one.
for (let i = 0; i < 25; i++) {
  assert.equal(
    selectFromPool([mk({ id: "d1", status: "draft" }), mk({ id: "d2", status: "retired" })], `lead-${i}`, i),
    null,
    "no seed may reach an unapproved template",
  );
}

// weight 0 is a soft retire — present for the record, never sent.
assert.equal(selectFromPool([mk({ weight: 0 })], "lead-1", 0), null, "weight 0 is unreachable");

// Weighting biases selection without becoming exclusive.
{
  const weighted = [mk({ id: "heavy", weight: 9 }), mk({ id: "light", weight: 1 })];
  const picks: Record<string, number> = { heavy: 0, light: 0 };
  for (let i = 0; i < 200; i++) {
    const p = selectFromPool(weighted, `lead-${i}`, 0);
    if (p) picks[p.id] = (picks[p.id] || 0) + 1;
  }
  assert.ok(picks.heavy > picks.light, "a heavier template is chosen more often");
  assert.ok(picks.light > 0, "but a lighter one is not excluded");
}

// ---------------------------------------------------------------------------
// Empty pool returns null so the caller falls back to the step's own copy.
// This is what keeps every existing sequence working before the pool is filled.
// ---------------------------------------------------------------------------
assert.equal(selectFromPool([], "lead-1", 0), null, "an empty pool falls through to the step copy");

// ---------------------------------------------------------------------------
// Malformed rows must not crash a dispatch run or leak through the gate.
// ---------------------------------------------------------------------------
assert.equal(
  selectFromPool([{ ...mk(), status: "nonsense" as unknown as PoolTemplate["status"] }], "lead-1", 0),
  null,
  "an unrecognised status is not approved",
);
assert.equal(
  selectFromPool([mk({ bodyText: "" })], "lead-1", 0),
  null,
  "a template with no body is unusable however approved it claims to be",
);
assert.equal(
  selectFromPool([mk({ weight: -5 })], "lead-1", 0),
  null,
  "a negative weight cannot resurrect a template",
);

console.log("drip-template-pool.test.ts — all assertions passed ✓");
