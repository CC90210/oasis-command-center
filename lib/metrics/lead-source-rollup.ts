/**
 * lead-source-rollup.ts — the pure aggregation behind
 * GET /api/metrics/lead-sources.
 *
 * Split out of the route on purpose: the route is I/O (auth, query, HTTP
 * shape) and this is arithmetic. The arithmetic is where the quiet-wrong bugs
 * live — timezone-shifted day buckets and percentages that do not sum to 100 —
 * so it needs to be reachable from a test without a database or a session.
 *
 * WHY A SCAN-AND-ROLL-UP AT ALL:
 *   Leads live in tenant_records.data (jsonb) behind the PostgREST-compatible
 *   shim over Turso/libSQL. That surface has no GROUP BY, and the alternatives
 *   are an RPC (only 1 of 4 JARVIS RPCs survived the cutover; an unported one
 *   fails closed) or Postgres-only SQL that libSQL rejects. At standard daily
 *   lead volume over a <=90 day window the row count is small enough that a
 *   bounded scan plus an in-memory roll-up is the simplest correct thing on
 *   this backend.
 */

import { readLeadSource, LEAD_SOURCE_ORDER, type LeadSource } from "@/lib/forms/lead-source";

export const DEFAULT_DAYS = 30;
export const MIN_DAYS = 1;
export const MAX_DAYS = 90;

/** Hard ceiling on rows pulled per request. Surfaced in meta when hit. */
export const SCAN_CAP = 5000;

/**
 * Buckets are calendar days in this zone, not UTC. A lead that lands at 21:00
 * ET belongs to that operator's business day; bucketing in UTC would shift
 * every evening lead a day forward and make the bars disagree with what the
 * rep remembers doing.
 */
export const BUCKET_TZ = "America/New_York";

export type Totals = Record<LeadSource, number>;
export type DailyRow = { date: string } & Totals & { total: number };

export type LeadRow = {
  created_at: string | null;
  data: Record<string, unknown> | null;
};

export type Rollup = {
  axis: string[];
  totals: Totals;
  daily: DailyRow[];
  counted: number;
  /** Rows with no usable created_at — bucketable by neither axis nor total. */
  undated: number;
  /** Rows whose day fell outside the requested window (the +1 day DB slack). */
  outOfWindow: number;
};

export const emptyTotals = (): Totals => ({ text: 0, dial: 0, unknown: 0 });

/** en-CA is the locale whose short date IS ISO order, so this yields YYYY-MM-DD. */
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUCKET_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD in BUCKET_TZ, or null when the timestamp is unparseable. */
export function bucketDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return dayFormatter.format(d);
}

/** Clamp an untrusted ?days= to [MIN_DAYS, MAX_DAYS]. Never throws. */
export function clampDays(raw: string | null | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, n));
}

/** Dense, zero-filled day axis (oldest first) so the bar chart has no gaps. */
export function denseDayAxis(days: number, now: number = Date.now()): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(dayFormatter.format(new Date(now - i * 86_400_000)));
  }
  return out;
}

/**
 * Percentages that sum to exactly 100 (largest-remainder apportionment).
 * A donut whose slices read 33.3 / 33.3 / 33.3 looks broken, and naive
 * per-slice rounding produces exactly that. Returns all zeros when the
 * denominator is zero — callers render an empty state instead.
 */
export function percentages(totals: Totals, total: number): Totals {
  const out = emptyTotals();
  if (total <= 0) return out;

  const SCALE = 10; // one decimal place
  const parts = LEAD_SOURCE_ORDER.map((k) => {
    const exact = (totals[k] / total) * 100 * SCALE;
    const floor = Math.floor(exact);
    return { k, floor, remainder: exact - floor };
  });

  let deficit = 100 * SCALE - parts.reduce((s, p) => s + p.floor, 0);
  // Hand the leftover tenths to the largest remainders first.
  for (const p of [...parts].sort((a, b) => b.remainder - a.remainder)) {
    if (deficit <= 0) break;
    p.floor += 1;
    deficit -= 1;
  }

  for (const p of parts) out[p.k] = p.floor / SCALE;
  return out;
}

/**
 * Fold raw lead rows into per-day and total counts over a fixed day axis.
 * Rows outside the axis are dropped (the query deliberately over-fetches by a
 * day to cover the UTC-to-ET boundary) and counted in `outOfWindow` so the
 * caller can tell "filtered" apart from "never there".
 */
export function rollup(rows: LeadRow[], axis: string[]): Rollup {
  const inWindow = new Set(axis);
  const perDay = new Map<string, Totals>(axis.map((d) => [d, emptyTotals()]));
  const totals = emptyTotals();
  let counted = 0;
  let undated = 0;
  let outOfWindow = 0;

  for (const row of rows) {
    if (!row.created_at) {
      undated += 1;
      continue;
    }
    const day = bucketDay(row.created_at);
    if (!day) {
      undated += 1;
      continue;
    }
    if (!inWindow.has(day)) {
      outOfWindow += 1;
      continue;
    }
    const source = readLeadSource(row.data);
    totals[source] += 1;
    const bucket = perDay.get(day);
    if (bucket) bucket[source] += 1;
    counted += 1;
  }

  const daily: DailyRow[] = axis.map((date) => {
    const t = perDay.get(date) ?? emptyTotals();
    return { date, ...t, total: t.text + t.dial + t.unknown };
  });

  return { axis, totals, daily, counted, undated, outOfWindow };
}
