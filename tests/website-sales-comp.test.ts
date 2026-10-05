/**
 * The comp engine's arithmetic, exercised end to end.
 *
 * This file guards MONEY. Every assertion carries the reason it exists, because
 * a wrong number here is not a rendering glitch — it is somebody underpaid, and
 * the person it hurts is the one least able to audit it.
 */
import assert from "node:assert/strict";
import {
  BPS_SCALE,
  COMPANY_TRACK_BPS,
  COMP_VERSION,
  MANAGER_OVERRIDE_BPS,
  MAX_HUMAN_PAYOUT_BPS,
  PRICE_BOOK,
  SELF_TRACK_BPS,
  SPECIALIST_SPLIT_FLOOR_CENTS,
  acceleratorBps,
  applyBps,
  baseRateBps,
  computePayout,
  isFullStackOnly,
  priceAdjustmentBps,
} from "../lib/website-sales-comp";

const line = (plan: ReturnType<typeof computePayout>, role: string) =>
  plan.lines.find((l) => l.role === role);

/* ── 1. integer discipline ─────────────────────────────────────────────────
 * Every amount must be a whole number of cents. A fractional cent means a
 * float crept in, and across a four-way split it compounds. */
function assertAllIntegers(plan: ReturnType<typeof computePayout>, label: string) {
  for (const l of plan.lines) {
    assert.equal(
      Number.isInteger(l.amountCents),
      true,
      `${label}: ${l.role} amount ${l.amountCents} is not whole cents — a float leaked in`,
    );
  }
  assert.equal(Number.isInteger(plan.totalHumanCents), true, `${label}: total must be whole cents`);
  assert.equal(Number.isInteger(plan.oasisRetainedCents), true, `${label}: retained must be whole cents`);
}

assert.equal(applyBps(400_000, 3_000), 120_000, "30% of $4,000 is exactly $1,200");
assert.equal(applyBps(50_000, 7_000), 35_000, "70% of $500 is exactly $350");
assert.equal(applyBps(1, 5_000), 1, "rounds half-up, never truncates toward zero");

/* ── 2. the $500 offer and exact v4 ladder ───────────────────────────
 * $500 is the actual Starter book price, not a discounted exception. It must
 * support either an opener/closer split or one person finding and closing. */
assert.equal(SPECIALIST_SPLIT_FLOOR_CENTS, 50_000, "the split threshold is the Starter book price");
assert.equal(isFullStackOnly(49_999), true, "a founder-approved sub-Starter deal remains full-stack only");
assert.equal(isFullStackOnly(50_000), false, "$500 supports separate opener and closer accruals");
assert.deepEqual(
  COMPANY_TRACK_BPS,
  { opener: 1_500, closer: 2_500 },
  "a company-fed lead never earns the find-and-close premium",
);
assert.equal(SELF_TRACK_BPS.opener, 1_500, "opening is 15% on either provenance track");
assert.equal(SELF_TRACK_BPS.open_close, 3_500, "finding and closing is exactly 35%");
assert.equal(SELF_TRACK_BPS.full_stack, 7_000, "the sourced + closed + built special remains 70%");
assert.equal(PRICE_BOOK.starter.floorCents, 50_000);
assert.equal(PRICE_BOOK.starter.bookCents, 50_000, "$500 is book, so no discount penalty applies");

const starter = computePayout({
  collectedCents: 50_000,
  packageId: "starter",
  track: "self",
  parties: [{ userId: "rep-1", role: "full_stack" }],
});
assertAllIntegers(starter, "$500 self-sourced find-and-close");
assert.equal(
  line(starter, "full_stack")?.amountCents,
  17_500,
  "self-sourced find-and-close on a $500 Starter accrues 35% = $175",
);
assert.equal(starter.oasisRetainedCents, 32_500, "OASIS retains $325 before any builder fee");
assert.ok(starter.totalHumanCents > 0, "the deal BOOKS — this is the whole point of the change");
/* The explicitly retained build special is separate from the three-role ladder. */
const starterAtBook = computePayout({
  collectedCents: PRICE_BOOK.starter.bookCents,
  packageId: "starter",
  track: "self",
  parties: [{ userId: "rep-1", role: "full_stack", builtItToo: true }],
});
assert.equal(
  line(starterAtBook, "full_stack")?.rateBps,
  SELF_TRACK_BPS.full_stack,
  "at book price there is no step-down — the rep earns the full contract rate",
);

/* A Starter ticket may be split: the opener and closer both did payable work. */
const starterSplitAttempt = computePayout({
  collectedCents: 50_000,
  packageId: "starter",
  track: "company",
  parties: [
    { userId: "opener-1", role: "opener" },
    { userId: "closer-1", role: "closer" },
  ],
});
assert.equal(starterSplitAttempt.lines.length, 2, "$500 writes one accrual per credited specialist");
assert.equal(line(starterSplitAttempt, "opener")?.amountCents, 7_500, "15% opener = $75");
assert.equal(line(starterSplitAttempt, "closer")?.amountCents, 12_500, "25% closer = $125");

const companyCloserWhoBuilds = computePayout({
  collectedCents: 50_000,
  packageId: "starter",
  track: "company",
  parties: [
    { userId: "closer-builder-1", role: "closer" },
    { userId: "closer-builder-1", role: "builder" },
  ],
});
assert.deepEqual(
  companyCloserWhoBuilds.lines.map((entry) => entry.role).sort(),
  ["builder", "closer"],
  "one person may receive the 25% company-close line and the legitimate flat build line",
);
assert.equal(line(companyCloserWhoBuilds, "closer")?.amountCents, 12_500);
assert.equal(line(companyCloserWhoBuilds, "builder")?.amountCents, 15_000);

/* ── 3. the $8,000 company-sourced deal, four ways ─────────────────────────
 * The worked example from the plan. */
const eightK = computePayout({
  collectedCents: 800_000,
  packageId: "authority",
  track: "company",
  parties: [
    { userId: "opener-1", role: "opener" },
    { userId: "closer-1", role: "closer" },
    { userId: "builder-1", role: "builder" },
  ],
  managerUserId: "mgr-1",
});
assertAllIntegers(eightK, "$8,000 four-way");
assert.equal(line(eightK, "opener")?.amountCents, 120_000, "opener 15% of $8,000 = $1,200");
assert.equal(line(eightK, "closer")?.amountCents, 200_000, "closer 25% of $8,000 = $2,000");
assert.equal(line(eightK, "builder")?.amountCents, 100_000, "builder flat $1,000 for authority");
assert.ok(line(eightK, "manager"), "the manager is paid on a team deal");
assert.equal(
  line(eightK, "manager")!.basisCents,
  eightK.collectedCents - (line(eightK, "opener")!.amountCents + line(eightK, "closer")!.amountCents + 100_000),
  "the manager's basis is what OASIS RETAINS, never gross",
);
assert.ok(
  eightK.oasisRetainedCents > 0,
  "OASIS still keeps something after four payees — if this ever goes negative the model is broken",
);

/* ── 4. THE GUARDRAIL. Nothing may take more than 85% of collected. ────────
 * Every modifier can only add, so without an absolute ceiling four payees plus
 * an override can out-run the margin. */
const stacked = computePayout({
  collectedCents: 300_000,
  packageId: "growth",
  track: "self",
  parties: [
    { userId: "rep-1", role: "full_stack", builtItToo: true, trailing30dCollectedCents: 5_000_00 },
    { userId: "builder-1", role: "builder" },
  ],
  managerUserId: "mgr-1",
});
const stackedWithoutManager = computePayout({
  collectedCents: 300_000,
  packageId: "growth",
  track: "self",
  parties: [
    { userId: "rep-1", role: "full_stack", builtItToo: true, trailing30dCollectedCents: 5_000_00 },
    { userId: "builder-1", role: "builder" },
  ],
});
assertAllIntegers(stacked, "stacked");
assert.ok(
  stacked.oasisRetainedCents >= 0,
  "OASIS must never end a deal owing money — the guardrail exists for exactly this",
);
const humansOnly = stacked.lines
  .filter((l) => l.role !== "manager")
  .reduce((s, l) => s + l.amountCents, 0);
assert.ok(
  humansOnly <= applyBps(stacked.collectedCents, MAX_HUMAN_PAYOUT_BPS),
  "pre-manager payout must respect the 85% ceiling",
);
assert.deepEqual(
  stacked.lines.filter((entry) => entry.role !== "manager").map((entry) => entry.amountCents),
  stackedWithoutManager.lines.map((entry) => entry.amountCents),
  "a clipped manager override never reduces teammate lines to fund itself",
);
assert.ok(
  stacked.totalHumanCents <= applyBps(stacked.collectedCents, MAX_HUMAN_PAYOUT_BPS),
  "the 85% ceiling includes the manager override, not only the lines computed before it",
);
assert.ok(
  stacked.oasisRetainedCents >= applyBps(stacked.collectedCents, BPS_SCALE - MAX_HUMAN_PAYOUT_BPS),
  "OASIS retains at least 15% after the manager override",
);

/* Rounding boundary: teammates take 92,870c of a 114,300c sale. The 85%
 * ceiling is 97,155c, leaving 4,285c of headroom; a literal 20% override rounds
 * to 4,286c. The manager loses that one cent, never the teammates. */
const managerBoundaryInput = {
  collectedCents: 114_300,
  packageId: "starter",
  track: "company" as const,
  parties: [
    { userId: "opener-boundary", role: "opener" as const },
    { userId: "closer-boundary", role: "closer" as const },
    { userId: "builder-boundary", role: "builder" as const },
  ],
};
const managerBoundaryBase = computePayout(managerBoundaryInput);
const managerBoundary = computePayout({ ...managerBoundaryInput, managerUserId: "manager-boundary" });
const managerBoundaryCeiling = applyBps(managerBoundary.collectedCents, MAX_HUMAN_PAYOUT_BPS);
assert.deepEqual(
  managerBoundary.lines.filter((entry) => entry.role !== "manager").map((entry) => entry.amountCents),
  managerBoundaryBase.lines.map((entry) => entry.amountCents),
  "the manager cap never takes a cent back from teammates",
);
assert.equal(managerBoundary.totalHumanCents, managerBoundaryCeiling);
assert.equal(
  line(managerBoundary, "manager")?.amountCents,
  managerBoundaryCeiling - managerBoundaryBase.totalHumanCents,
);
assert.equal(managerBoundary.guardrailApplied, true, "clipping the manager marks the payout guardrail");
assert.ok(
  line(managerBoundary, "manager")?.notes.some((note) => note.includes("guardrail: manager override clipped")),
  "a clipped override explains why it is below the nominal formula",
);
assert.ok(
  managerBoundary.oasisRetainedCents >= applyBps(managerBoundary.collectedCents, BPS_SCALE - MAX_HUMAN_PAYOUT_BPS),
  "the manager rounding boundary cannot dip below OASIS's 15% floor",
);

/* A case that DEMONSTRABLY breaches the ceiling, not one that merely might.
 *
 * An earlier version of this block asserted the guardrail only `if
 * (plan.guardrailApplied)` — and no case in this file ever tripped it, so
 * raising MAX_HUMAN_PAYOUT_BPS to 200% kept the whole suite green. A guard
 * with no failing case is documentation, so the arithmetic is pinned here:
 *
 *   $1,000 collected on starter (book/floor $500)
 *   external-harness base            8500bps                 = $850
 *   upsell share (50% of $500 over book)                      = $250
 *   builder flat fee (starter)                               = $150
 *   ----------------------------------------------------------------
 *   humans want                                             $1,250
 *   ceiling is 8500bps                                        $850
 *
 * So the guardrail MUST fire, and must scale both lines proportionally. */
const breached = computePayout({
  collectedCents: 100_000,
  packageId: "starter",
  track: "self",
  parties: [
    { userId: "rep-1", role: "full_stack", externalHarness: true, trailing30dCollectedCents: 25_000_00 },
    { userId: "builder-1", role: "builder" },
  ],
});
assertAllIntegers(breached, "guardrail breach");
assert.equal(
  breached.guardrailApplied,
  true,
  "this stack asks for 100% of collected — the guardrail MUST fire",
);
assert.ok(
  breached.totalHumanCents <= applyBps(100_000, MAX_HUMAN_PAYOUT_BPS),
  `humans took ${breached.totalHumanCents}c, ceiling is ${applyBps(100_000, MAX_HUMAN_PAYOUT_BPS)}c`,
);
assert.ok(
  breached.oasisRetainedCents >= applyBps(100_000, BPS_SCALE - MAX_HUMAN_PAYOUT_BPS) - 2,
  "OASIS keeps its 15% floor margin (allowing 2c for rounding across two lines)",
);
assert.ok(
  breached.lines.every((l) => l.notes.some((n) => n.includes("guardrail"))),
  "every scaled line must say so — a rep paid under their contract rate with no " +
    "explanation reads as theft, and the note is the difference",
);
/* Proportional, not first-come: the builder must absorb a share too, rather
 * than the last line in the list eating the entire reduction. */
assert.ok(
  line(breached, "builder")!.amountCents < PRICE_BOOK.starter.builderFeeCents,
  "the builder shares the reduction proportionally",
);
assert.ok(
  line(breached, "full_stack")!.amountCents < 85_000,
  "and so does the rep",
);

/* ── 5. the standard ladder is MONOTONIC — doing more always pays more ───────────
 * Opening is 15%, closing is 25%, and finding + closing is 35%. */
assert.equal(
  SELF_TRACK_BPS.opener,
  COMPANY_TRACK_BPS.opener,
  "opening pays the single published 15% base rate regardless of provenance",
);
assert.ok(
  SELF_TRACK_BPS.open_close > SELF_TRACK_BPS.opener,
  "closing your own deal beats handing it off",
);
assert.ok(
  SELF_TRACK_BPS.full_stack > SELF_TRACK_BPS.open_close,
  "building it too beats not building it",
);
assert.ok(
  SELF_TRACK_BPS.external_harness > SELF_TRACK_BPS.full_stack,
  "your own client on our tooling is the top of the ladder",
);
assert.equal(
  baseRateBps({ track: "company", role: "full_stack" }),
  0,
  "full_stack is reserved for a genuinely self-sourced sale, never a company-fed close",
);

/* ── 6. price adjustments, both directions ────────────────────────────────
 * "If you can sell higher, things change. Lower is lower, but set terms." */
const tier = PRICE_BOOK.growth;
assert.equal(priceAdjustmentBps(tier.bookCents, tier), 0, "at book there is no penalty");
assert.equal(priceAdjustmentBps(tier.bookCents + 1, tier), 0, "above book there is no penalty");
assert.ok(priceAdjustmentBps(tier.floorCents, tier) < 0, "below book steps the rate down");
assert.ok(
  priceAdjustmentBps(tier.floorCents - 1, tier) < priceAdjustmentBps(tier.floorCents, tier),
  "below FLOOR is a harder step-down than merely below book",
);

/* Selling above book pays a share of the overage, not extra bps on the whole
 * deal — a percentage of everything would over-reward a small beat. */
const atBook = computePayout({
  collectedCents: PRICE_BOOK.growth.bookCents,
  packageId: "growth",
  track: "company",
  parties: [{ userId: "c", role: "closer" }],
});
const aboveBook = computePayout({
  collectedCents: PRICE_BOOK.growth.bookCents + 100_000,
  packageId: "growth",
  track: "company",
  parties: [{ userId: "c", role: "closer" }],
});
const upliftBeyondRate =
  line(aboveBook, "closer")!.amountCents -
  applyBps(aboveBook.collectedCents, line(atBook, "closer")!.rateBps);
assert.equal(upliftBeyondRate, 50_000, "the closer keeps 50% of the $1,000 sold over book");

/* ── 7. the volume accelerator ─────────────────────────────────────────────*/
assert.equal(acceleratorBps(0), 0);
assert.equal(acceleratorBps(9_999_99), 0, "one cent below $10,000 earns nothing extra");
assert.equal(acceleratorBps(10_000_00), 200, "exactly $10,000 earns +2 points");
assert.equal(acceleratorBps(24_999_99), 200, "one cent below $25,000 remains at +2 points");
assert.equal(acceleratorBps(25_000_00), 500, "exactly $25,000 earns +5 points");
assert.equal(acceleratorBps(-5), 0, "a nonsense negative total cannot earn a bonus");

/* It must NOT touch a builder's flat fee or the manager override. */
const accelDeal = computePayout({
  collectedCents: 800_000,
  packageId: "authority",
  track: "company",
  parties: [
    { userId: "c", role: "closer", trailing30dCollectedCents: 25_000_00 },
    { userId: "b", role: "builder", trailing30dCollectedCents: 25_000_00 },
  ],
  managerUserId: "m",
});
assert.equal(
  line(accelDeal, "builder")?.amountCents,
  PRICE_BOOK.authority.builderFeeCents,
  "a builder's flat fee is flat — volume does not move it",
);
assert.equal(
  line(accelDeal, "manager")?.rateBps,
  MANAGER_OVERRIDE_BPS,
  "the override is a fixed share of the retainer, not accelerated",
);

/* ── 8. fail-safe shapes ───────────────────────────────────────────────────*/
const noParties = computePayout({ collectedCents: 500_000, packageId: "growth", track: "company", parties: [] });
assert.equal(noParties.totalHumanCents, 0, "nobody on the deal, nobody paid");
assert.equal(noParties.oasisRetainedCents, 500_000, "OASIS keeps all of it");

const unknownPackage = computePayout({
  collectedCents: 500_000,
  packageId: "not-a-package",
  track: "company",
  parties: [{ userId: "c", role: "closer" }, { userId: "b", role: "builder" }],
});
assert.equal(
  line(unknownPackage, "builder"),
  undefined,
  "an unknown package yields no builder fee rather than a guessed one",
);
assert.ok(
  line(unknownPackage, "closer"),
  "but a rate-based line still computes — the rate does not depend on the price book",
);

const zero = computePayout({ collectedCents: 0, packageId: "starter", track: "self", parties: [{ userId: "r", role: "full_stack" }] });
assert.equal(zero.totalHumanCents, 0, "nothing collected, nothing owed");
assert.ok(zero.oasisRetainedCents >= 0, "and no negative retainer");

assert.equal(COMP_VERSION, 4, "every new ledger row records the v4 arithmetic that produced it");
assert.equal(BPS_SCALE, 10_000);
assert.equal(baseRateBps({ track: "company", role: "builder" }), 0, "builders are flat, not rated");
assert.equal(baseRateBps({ track: "company", role: "manager" }), 0, "managers are paid off the retainer");

console.log(
  `website-sales-comp: OK — ${Object.keys(PRICE_BOOK).length} tiers, comp v${COMP_VERSION}, ` +
    `${MAX_HUMAN_PAYOUT_BPS}bps human ceiling enforced`,
);
