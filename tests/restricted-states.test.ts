/**
 * restricted-states.test.ts — the SOP §4 restricted-state gate, and the null
 * handling underneath it.
 *
 * WHY. Two defects found by audit 2026-09-07, both invisible from the outside:
 *
 *   1. The Match Lenders PREVIEW route omitted restricted_states from the
 *      LenderProfile it built, so scoreLenderMatch could not raise
 *      `restricted_state` there. Measured against the live catalog, the preview
 *      flagged ZERO lenders for TX/UT/CA/VA/NY/PR when 7/5/5/4/2/1 lenders
 *      respectively refuse those states. An operator saw a lender presented as a
 *      clean match when it does not fund the merchant's state at all. The live
 *      send path was gated the whole time; only the screen humans decide from
 *      was blind.
 *
 *   2. Lender numeric guards used `!== undefined`, which is TRUE for null.
 *      9 of 47 live lenders carry `max_funded_amount: null`, and that branch
 *      called `null.toLocaleString()` -> TypeError. rankLenders maps without a
 *      try/catch, so one such lender takes down an entire ranking.
 *
 * Synthetic fixtures on purpose: the live catalog is operator-maintained data
 * that changes, and a regression guard must not depend on today's rows.
 *
 *   node --experimental-strip-types tests/restricted-states.test.ts
 */

import assert from "node:assert/strict";
import {
  scoreLenderMatch,
  rankLenders,
  complianceProfileInputs,
  type LenderProfile,
  type ApplicationProfile,
} from "../lib/lenders/match-fitness.ts";

const merchant = (state: string): ApplicationProfile =>
  ({
    id: `t-${state}`,
    monthly_revenue: 90_000,
    requested_amount: 50_000,
    time_in_business_months: 48,
    applicant_fico: 700,
    ...complianceProfileInputs({ business_state: state, industry: "retail" }),
  }) as ApplicationProfile;

const lenderRefusing = (states: string[]): LenderProfile =>
  ({ id: "L1", name: "Refuser", restricted_states: states }) as LenderProfile;

const hasRestrictedFlag = (l: LenderProfile, state: string) =>
  scoreLenderMatch(l, merchant(state)).warnings.some(
    (w) => w.code === "restricted_state" && w.severity === "high_risk",
  );

// ── The gate fires for every state a lender actually restricts ──────────────
for (const state of ["TX", "UT", "CA", "VA", "NY", "PR"]) {
  assert.ok(
    hasRestrictedFlag(lenderRefusing([state]), state),
    `gate must fire for a lender that restricts ${state}`,
  );
  assert.ok(
    !hasRestrictedFlag(lenderRefusing([state]), "FL"),
    `gate must NOT fire for FL against a lender that only restricts ${state}`,
  );
}

// ── Case and whitespace in operator-entered data must not defeat it ─────────
assert.ok(hasRestrictedFlag(lenderRefusing([" tx "]), "TX"), "must trim and upper-case");
assert.ok(hasRestrictedFlag(lenderRefusing(["ny"]), "NY"), "lowercase list entry must match");
assert.ok(
  scoreLenderMatch(lenderRefusing(["TX"]), {
    ...merchant("TX"),
    merchant_state: " tx ",
  } as ApplicationProfile).warnings.some((w) => w.code === "restricted_state"),
  "must trim and upper-case the MERCHANT side too",
);

// ── A merchant with no state is a warning, never a silent pass ──────────────
{
  const s = scoreLenderMatch(lenderRefusing(["TX"]), {
    id: "t-none",
    monthly_revenue: 90_000,
  } as ApplicationProfile);
  assert.ok(
    s.warnings.some((w) => w.code === "missing_merchant_state"),
    "a lender with a restricted list and no merchant state must warn, not pass quietly",
  );
}

// ── complianceProfileInputs is the single mapping every path uses ───────────
assert.equal(complianceProfileInputs({ business_state: "TX" }).merchant_state, "TX");
assert.equal(
  complianceProfileInputs({ merchant_state: "NY" }).merchant_state,
  "NY",
  "legacy merchant_state must still be honoured",
);

// ── NULL-VALUED LENDER FIELDS MUST NOT THROW ───────────────────────────────
// This is the exact shape of 9 live lenders. Before the fix this threw
// TypeError: Cannot read properties of null (reading 'toLocaleString').
{
  const nulled = {
    id: "L-null",
    name: "Cleared Fields",
    max_funded_amount: null,
    fico_floor: null,
    min_monthly_revenue: null,
    min_time_in_business_months: null,
    max_negative_days: null,
    restricted_states: ["TX"],
  } as unknown as LenderProfile;

  assert.doesNotThrow(
    () => scoreLenderMatch(nulled, merchant("FL")),
    "a lender with null numeric fields must score without throwing",
  );

  // And a null threshold must not be read as a satisfied one.
  const s = scoreLenderMatch(nulled, merchant("FL"));
  assert.ok(
    !s.reasons.some((r) => /meets revenue floor/i.test(r)),
    "a null revenue floor must not be credited as met (null coerces to 0)",
  );

  // The gate still works on a record whose other fields are null.
  assert.ok(hasRestrictedFlag(nulled, "TX"), "restricted gate must survive null siblings");

  // rankLenders maps without a try/catch: one bad record must not kill the batch.
  assert.doesNotThrow(
    () => rankLenders([nulled, lenderRefusing(["NY"])], merchant("TX")),
    "one lender with null fields must not take down an entire ranking",
  );
  assert.equal(rankLenders([nulled, lenderRefusing(["NY"])], merchant("TX")).length, 2);
}

console.log("restricted-states.test.ts — all assertions passed");
