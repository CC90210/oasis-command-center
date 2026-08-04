/**
 * renewals-derive — the two computed funded-deal fields.
 *
 * The renewal date is what the Renewals tab sorts and buckets on (past due /
 * this week / this month), so an off-by-a-month here silently puts real deals
 * in the wrong column. Worth pinning down properly.
 */
import assert from "node:assert/strict";
import { nextRenewalDate, estCommissionUsd, formatTerm, RENEWAL_TERM_FRACTION } from "../lib/renewals/derive";

// The rule Adon locked on 2026-07-29.
assert.equal(RENEWAL_TERM_FRACTION, 0.5, "renewable at 50% of term");

// ── even terms land on a clean month boundary ────────────────────────────────
assert.equal(nextRenewalDate("2026-01-01", 12), "2026-07-01", "12mo → +6 months");
assert.equal(nextRenewalDate("2026-03-15", 6), "2026-06-15", "6mo → +3 months");
assert.equal(nextRenewalDate("2026-01-10", 4), "2026-03-10", "4mo → +2 months");
assert.equal(nextRenewalDate("2026-06-30", 24), "2027-06-30", "24mo → +12 months, crosses the year");

// ── odd terms keep the half month instead of truncating ──────────────────────
assert.equal(nextRenewalDate("2026-01-01", 9), "2026-05-16", "9mo → +4 months +15 days, not +4");
assert.equal(nextRenewalDate("2026-01-01", 3), "2026-02-16", "3mo → +1 month +15 days");
assert.equal(nextRenewalDate("2026-01-01", 1), "2026-01-16", "1mo → +15 days");

// Week/day terms use calendar days at the same 50% threshold.
assert.equal(nextRenewalDate("2026-01-01", 10, "weeks"), "2026-02-05", "10 weeks → +35 days");
assert.equal(nextRenewalDate("2026-01-01", 30, "days"), "2026-01-16", "30 days → +15 days");
assert.equal(nextRenewalDate("2026-01-01", 1, "week" as never), null, "unknown unit fails closed");
assert.equal(formatTerm(1, "days"), "1 day");
assert.equal(formatTerm(12, "weeks"), "12 weeks");
assert.equal(formatTerm(Number.NaN, "months"), "Unknown term");

// ── month-end clamping: JS would silently roll over ──────────────────────────
{
  // Jan 31 + 1 month is Feb 31, which JS turns into Mar 3. A renewal landing in
  // the wrong MONTH lands in the wrong bucket on the tab.
  assert.equal(nextRenewalDate("2026-01-31", 2), "2026-02-28", "clamps to end of Feb, does not roll into March");
  assert.equal(nextRenewalDate("2024-01-31", 2), "2024-02-29", "leap year gets Feb 29");
  assert.equal(nextRenewalDate("2026-05-31", 2), "2026-06-30", "clamps to a 30-day month");
}

// ── missing / unusable input yields null, never a guessed date ───────────────
for (const bad of [null, undefined, "", "not-a-date", "2026-13-01", "01/01/2026"]) {
  assert.equal(nextRenewalDate(bad as string, 12), null, `bad date ${JSON.stringify(bad)} → null`);
}
for (const bad of [null, undefined, 0, -6, NaN, Infinity]) {
  assert.equal(nextRenewalDate("2026-01-01", bad as number), null, `bad term ${String(bad)} → null`);
}
assert.equal(
  nextRenewalDate("2026-01-01", undefined),
  null,
  "no term means no derivable date — the tab renders that as 'no date', which is honest",
);

// ── commission ───────────────────────────────────────────────────────────────
assert.equal(estCommissionUsd(100_000, 10), 10_000, "10 points on $100k");
assert.equal(estCommissionUsd(50_000, 12.5), 6_250, "fractional points");
assert.equal(estCommissionUsd(75_000, 8), 6_000);
assert.equal(estCommissionUsd(33_333, 7.5), 2_499.98, "rounds to cents");
assert.equal(estCommissionUsd(100_000, 0), 0, "zero points is a real answer, not missing");

// Missing input is null, NOT zero — "$0.00 commission" and "commission unknown"
// mean different things to someone choosing which renewals to chase.
for (const bad of [null, undefined, 0, -1, NaN]) {
  assert.equal(estCommissionUsd(bad as number, 10), null, `bad amount ${String(bad)} → null`);
}
for (const bad of [null, undefined, -5, NaN]) {
  assert.equal(estCommissionUsd(100_000, bad as number), null, `bad points ${String(bad)} → null`);
}

// ── the two together, on a realistic deal ────────────────────────────────────
{
  const fundedAt = "2026-02-10";
  const amount = 85_000;
  const term = 10;
  const points = 11;
  assert.equal(nextRenewalDate(fundedAt, term), "2026-07-10", "10mo → +5 months");
  assert.equal(estCommissionUsd(amount, points), 9_350);
}

// ── the intake's date rule, mirrored ─────────────────────────────────────────
// Kept in step with isRealYmd() in app/api/renewals/route.ts. Date.parse
// NORMALISES ("2026-02-30" → March 2) rather than rejecting, so a shape-only
// check lets an impossible date through, Postgres then rejects the original, and
// the caller gets a 500 where a field-level 400 was promised.
{
  const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
  const isRealYmd = (s: string): boolean => {
    if (!YMD_RE.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  };

  for (const good of ["2026-01-01", "2026-02-28", "2024-02-29", "2026-12-31"]) {
    assert.equal(isRealYmd(good), true, `${good} is a real date`);
  }
  for (const bad of ["2026-02-30", "2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-32"]) {
    assert.equal(isRealYmd(bad), false, `${bad} is not a real date and must be rejected, not normalised`);
  }
  assert.equal(isRealYmd("2026-02-29"), false, "2026 is not a leap year");
  assert.equal(isRealYmd("2024-02-29"), true, "2024 is");

  // Guard the whole point: the naive check would have accepted these.
  for (const bad of ["2026-02-30", "2026-04-31"]) {
    assert.ok(
      YMD_RE.test(bad) && !Number.isNaN(Date.parse(`${bad}T00:00:00Z`)),
      `${bad} passes a shape+parse check — which is exactly why the round-trip exists`,
    );
  }
}

console.log("renewals-derive tests passed");
