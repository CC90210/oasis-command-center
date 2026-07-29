/**
 * lib/renewals/derive.ts — the two funded-deal fields that are COMPUTED, never
 * typed: when a deal becomes renewable, and what the commission is worth.
 *
 * Pure and dependency-free so it can be unit-tested directly. The renewal date
 * is what the whole Renewals tab sorts and buckets on (past due / this week /
 * this month), so getting it wrong is not a cosmetic error — it is the product.
 *
 * Operators enter: merchant, amount funded, term, rate, points. They do NOT
 * enter a renewal date. Deriving it means nobody has to remember to keep it
 * current, and two deals funded the same day on the same term can never
 * disagree about when they come up.
 */

/**
 * Fraction of the term after which a deal is treated as renewable.
 * Adon, 2026-07-29: 50% — the standard MCA convention. Roughly half paid down
 * is when a renewal conversation is realistic.
 */
export const RENEWAL_TERM_FRACTION = 0.5;

/** Days used for the fractional half-month on an odd term. */
const DAYS_PER_HALF_MONTH = 15;

function isValidYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));
}

/** Last day of the given UTC year/month (month is 0-indexed). */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Add whole months to a UTC date, clamping to the end of the target month.
 *
 * Without the clamp, JS silently rolls over: 2026-01-31 + 1 month becomes
 * 2026-03-03, which would put a renewal in the wrong month and the wrong
 * bucket. Clamping gives 2026-02-28, which is what a human means.
 */
function addMonthsClamped(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const targetMonthIndex = m + months;
  const targetYear = y + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const clampedDay = Math.min(day, lastDayOfMonth(targetYear, targetMonth));
  return new Date(Date.UTC(targetYear, targetMonth, clampedDay));
}

/**
 * When a deal funded on `fundedAt` with a `termMonths` term becomes renewable.
 *
 * Returns null when either input is missing or unusable — a null renewal date
 * is a first-class state the tab already renders ("no date"), and is far better
 * than inventing one from a guess.
 *
 * @param fundedAt  calendar date, "YYYY-MM-DD"
 * @param termMonths whole months, 1..60
 */
export function nextRenewalDate(
  fundedAt: string | null | undefined,
  termMonths: number | null | undefined,
  fraction: number = RENEWAL_TERM_FRACTION,
): string | null {
  if (!fundedAt || !isValidYmd(fundedAt)) return null;
  if (typeof termMonths !== "number" || !Number.isFinite(termMonths) || termMonths <= 0) return null;

  const halfTerm = termMonths * fraction;
  const wholeMonths = Math.floor(halfTerm);
  // An odd term leaves half a month; express it as days rather than letting a
  // fractional month silently truncate (a 9-month term is renewable at 4.5
  // months, not 4).
  const extraDays = Math.round((halfTerm - wholeMonths) * 2 * DAYS_PER_HALF_MONTH);

  const start = new Date(`${fundedAt}T00:00:00Z`);
  const withMonths = addMonthsClamped(start, wholeMonths);
  withMonths.setUTCDate(withMonths.getUTCDate() + extraDays);
  return withMonths.toISOString().slice(0, 10);
}

/**
 * Commission on a funded deal: points are a percentage of the amount funded.
 *
 * Rounded to cents. Returns null when either input is missing, so the tab shows
 * a blank rather than a confident $0.00 — those mean different things to
 * someone deciding which renewals to chase.
 */
export function estCommissionUsd(
  fundedAmountUsd: number | null | undefined,
  pointsPct: number | null | undefined,
): number | null {
  if (typeof fundedAmountUsd !== "number" || !Number.isFinite(fundedAmountUsd) || fundedAmountUsd <= 0) return null;
  if (typeof pointsPct !== "number" || !Number.isFinite(pointsPct) || pointsPct < 0) return null;
  return Math.round(fundedAmountUsd * (pointsPct / 100) * 100) / 100;
}
