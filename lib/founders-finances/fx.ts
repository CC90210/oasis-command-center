/**
 * FX rules — Bank of Canada daily rates, own-day conversion. PURE.
 *
 * THE RULE (CC's books, 2026-09-24): every payment converts at ITS OWN day's
 * rate. Never a single month-end rate: a month of USD receipts converted at
 * the last day's rate misstates CAD revenue by the whole month's drift.
 *
 * FXUSDCAD from the Valet API is CAD per 1 USD. A day with no observation
 * (weekend, holiday, today before the ~16:30 ET publication) uses the latest
 * PRIOR business day — but only within FX_LOOKBACK_DAYS. Beyond that the rate
 * is reported missing rather than silently borrowed from weeks ago, because a
 * stale-rate table and a real holiday look identical otherwise.
 */

import { divRoundHalfAwayFromZero } from "./money";

export const FX_PAIR_USDCAD = "USDCAD";
export const FX_LOOKBACK_DAYS = 7;
export const RATE_SCALE = BigInt(1_000_000);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every ISO date in [from, to). Empty when to <= from. */
export function isoDateRange(from: string, to: string): string[] {
  const out: string[] = [];
  if (!isIsoDate(from) || !isIsoDate(to)) return out;
  for (let d = from; d < to; d = addDays(d, 1)) {
    out.push(d);
    if (out.length > 3700) break; // ten years; a runaway range is a caller bug
  }
  return out;
}

/** "1.3512" -> 1351200n (rate x 1e6). Throws on anything that is not a positive decimal. */
export function parseRateMicro(rate: string): bigint {
  const s = String(rate).trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new Error(`invalid FX rate "${rate}"`);
  const micro = BigInt(m[1]) * RATE_SCALE + BigInt((m[2] || "").padEnd(6, "0"));
  if (micro <= BigInt(0)) throw new Error(`invalid FX rate "${rate}"`);
  return micro;
}

export type ValetObservation = { date: string; rate: string };

/**
 * Parse a Valet /observations/FXUSDCAD/json body. Rows without a usable value
 * are skipped (the API emits them for some holidays) — never coerced to 0.
 */
export function parseValetObservations(json: unknown, series = "FXUSDCAD"): ValetObservation[] {
  if (!json || typeof json !== "object") throw new Error("valet: body is not an object");
  const obs = (json as { observations?: unknown }).observations;
  if (!Array.isArray(obs)) throw new Error("valet: no observations array");
  const out: ValetObservation[] = [];
  for (const row of obs) {
    if (!row || typeof row !== "object") continue;
    const date = (row as Record<string, unknown>).d;
    const cell = (row as Record<string, unknown>)[series];
    const v = cell && typeof cell === "object" ? (cell as { v?: unknown }).v : undefined;
    if (!isIsoDate(date) || typeof v !== "string") continue;
    try {
      parseRateMicro(v);
    } catch {
      continue;
    }
    out.push({ date, rate: v.trim() });
  }
  return out;
}

export function valetUrl(from: string, to: string, series = "FXUSDCAD"): string {
  return `https://www.bankofcanada.ca/valet/observations/${series}/json?start_date=${from}&end_date=${to}`;
}

export type RateHit = { rate: string; rateDate: string; fallback: boolean };

/**
 * The rate that applies to `date`: that day's observation, else the latest
 * prior observation within `lookbackDays`. Null when none — the caller must
 * report the day as missing, not invent a rate.
 */
export function rateForDate(
  rates: ReadonlyMap<string, string>,
  date: string,
  lookbackDays = FX_LOOKBACK_DAYS,
): RateHit | null {
  if (!isIsoDate(date)) return null;
  for (let i = 0; i <= lookbackDays; i++) {
    const d = addDays(date, -i);
    const r = rates.get(d);
    if (r) return { rate: r, rateDate: d, fallback: i > 0 };
  }
  return null;
}

/** CAD cents -> USD cents at `rateMicro` (CAD per USD x 1e6). */
export function cadToUsdCents(cadCents: number, rateMicro: bigint): number {
  return Number(divRoundHalfAwayFromZero(BigInt(cadCents) * RATE_SCALE, rateMicro));
}

/** USD cents -> CAD cents at `rateMicro` (CAD per USD x 1e6). */
export function usdToCadCents(usdCents: number, rateMicro: bigint): number {
  return Number(divRoundHalfAwayFromZero(BigInt(usdCents) * rateMicro, RATE_SCALE));
}

const TORONTO_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The America/Toronto calendar date of an instant. Montreal shares Toronto's
 * zone. A Stripe payment at 23:30 EST on Jan 31 is a January payment even
 * though it is already Feb 1 in UTC; every day boundary in this suite goes
 * through here so revenueCollected, the per-day series and the per-customer
 * split always agree.
 */
export function torontoDateOf(instant: Date | number | string): string {
  const d =
    instant instanceof Date
      ? instant
      : typeof instant === "number"
        ? new Date(instant)
        : new Date(instant);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid instant ${String(instant)}`);
  const parts = TORONTO_DATE.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function torontoToday(now: Date = new Date()): string {
  return torontoDateOf(now);
}

/** Stripe `created` (unix seconds) -> Toronto date. */
export function torontoDateOfEpochSeconds(seconds: number): string {
  return torontoDateOf(seconds * 1000);
}
