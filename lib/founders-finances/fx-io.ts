/**
 * Bank of Canada rates: fetch, store, look up. See fx.ts for the rules.
 * The Valet API is free and keyless; a failed fetch is logged and surfaced
 * (fx_missing_days / an error to the caller), never replaced by a guess.
 */
import "server-only";

import {
  FX_LOOKBACK_DAYS,
  FX_PAIR_USDCAD,
  addDays,
  isIsoDate,
  parseRateMicro,
  parseValetObservations,
  rateForDate,
  torontoToday,
  valetUrl,
} from "./fx";
import { query, writeBatch } from "./db";
import type { RateLookup } from "./metrics-core";

export async function refreshFxRates(
  from: string,
  to: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ observations: number; stored: number; from: string; to: string }> {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw new Error("fx refresh needs from <= to (YYYY-MM-DD)");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let body: unknown;
  try {
    const res = await fetchImpl(valetUrl(from, to), { cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Bank of Canada Valet returned HTTP ${res.status}`);
    body = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const obs = parseValetObservations(body);
  if (obs.length > 0) {
    await writeBatch(
      obs.map((o) => ({
        sql: `INSERT INTO fin_fx_rates (pair, rate_date, rate, source) VALUES (?, ?, ?, 'bank_of_canada_valet')
              ON CONFLICT(pair, rate_date) DO UPDATE SET rate = excluded.rate, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        args: [FX_PAIR_USDCAD, o.date, o.rate],
      })),
    );
  }
  return { observations: obs.length, stored: obs.length, from, to };
}

/** Rates in [from - lookback, to], as date -> rate string. */
export async function loadRateMap(from: string, to: string): Promise<Map<string, string>> {
  const rows = await query<{ rate_date: string; rate: string }>(
    `SELECT rate_date, rate FROM fin_fx_rates WHERE pair = ? AND rate_date >= ? AND rate_date <= ? ORDER BY rate_date`,
    [FX_PAIR_USDCAD, addDays(from, -FX_LOOKBACK_DAYS), to],
  );
  return new Map(rows.map((r) => [r.rate_date, String(r.rate)]));
}

function lookupFrom(map: ReadonlyMap<string, string>): RateLookup {
  return (date: string) => {
    const hit = rateForDate(map, date);
    return hit ? parseRateMicro(hit.rate) : null;
  };
}

/**
 * A rate lookup for [from, to). When `ensure` is set and any day in `days`
 * has no usable rate, fetch the window from the Bank of Canada ONCE and
 * reload. Network failure is logged; the caller still gets a lookup and
 * reports whatever is still missing.
 */
export async function rateLookupFor(
  from: string,
  to: string,
  opts: { ensureDays?: readonly string[] } = {},
): Promise<RateLookup> {
  let map = await loadRateMap(from, to);
  const lookup = lookupFrom(map);
  const days = opts.ensureDays || [];
  const missing = days.filter((d) => lookup(d) === null && d <= torontoToday());
  if (missing.length > 0) {
    const sorted = [...missing].sort();
    try {
      await refreshFxRates(addDays(sorted[0], -FX_LOOKBACK_DAYS), sorted[sorted.length - 1]);
      map = await loadRateMap(from, to);
    } catch (e) {
      console.error("[finances:fx] refresh failed", e instanceof Error ? e.message : e);
    }
  }
  return lookupFrom(map);
}

/** CAD per 1 USD for `date` (own day or prior business day), fetching if absent. */
export async function usdCadRate(date: string): Promise<{ rate: string; micro: bigint } | null> {
  const lookup = await rateLookupFor(date, addDays(date, 1), { ensureDays: [date] });
  const micro = lookup(date);
  if (micro === null) return null;
  const map = await loadRateMap(date, addDays(date, 1));
  const hit = rateForDate(map, date);
  return hit ? { rate: hit.rate, micro } : null;
}

/** For ledger postings: the CAD-per-unit rate for a currency on a date. */
export async function rateForCurrency(currency: string, date: string): Promise<{ rate: string; micro: bigint } | null> {
  if (currency === "CAD") return { rate: "1", micro: parseRateMicro("1") };
  if (currency !== "USD") return null;
  return usdCadRate(date);
}

export async function latestUsdCadMicro(): Promise<bigint | null> {
  const today = torontoToday();
  const hit = await usdCadRate(today);
  return hit ? hit.micro : null;
}
