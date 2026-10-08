/**
 * Formatting and change maths for the SEO screen. Every formatter returns null for an
 * unknown value so the view prints MISSING, never 0. Dates are built by hand, not from the
 * machine's locale, so server and test output is identical everywhere.
 */
import { SEO_RANGES, type SeoRange, type SiteStatus } from "./types";

export const MISSING = "—";
const MINUS = "−";
const INT = new Intl.NumberFormat("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type N = number | null | undefined;

export const fmtInt = (n: N) => (n == null ? null : INT.format(n));
export const fmtSignedInt = (n: N) => (n == null ? null : `${n > 0 ? "+" : n < 0 ? MINUS : ""}${INT.format(Math.abs(n))}`);
export const fmtCtr = (r: N) => (r == null ? null : `${(r * 100).toFixed(1)}%`);
export const fmtPos = (p: N) => (p == null ? null : p.toFixed(1));

/** YYYY-MM-DD -> "Oct 5, 2026". */
export function fmtDate(ymd: string | null | undefined): string | null {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** YYYY-MM -> "Mar 2026". */
export function fmtMonth(ym: string | null | undefined): string | null {
  if (!ym) return null;
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** ISO timestamp -> "Oct 7, 2026, 12:40 PM ET" (Montreal time). */
export function fmtTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : `${ET.format(t)} ET`;
}

export type Tone = "good" | "bad" | "flat";
export type Change = { text: string; tone: Tone; sr: string };

const signed = (r: number, digits: number, unit: string) => `${r > 0 ? "+" : r < 0 ? MINUS : ""}${Math.abs(r).toFixed(digits)}${unit}`;
const round1 = (n: number) => Math.round(n * 10) / 10;
const FLAT = (text: string): Change => ({ text, tone: "flat", sr: "no change" });

/** Percent change of a count. null when either side is unknown. */
export function pctChange(cur: N, prev: N): Change | null {
  if (cur == null || prev == null) return null;
  if (prev === 0) return cur === 0 ? FLAT("0.0%") : { text: "new", tone: "good", sr: "new, none in the earlier period" };
  const r = round1(((cur - prev) / prev) * 100);
  if (r === 0) return FLAT("0.0%");
  return { text: signed(r, 1, "%"), tone: r > 0 ? "good" : "bad", sr: `${r > 0 ? "up" : "down"} ${Math.abs(r).toFixed(1)} percent` };
}

/** CTR change in percentage points. */
export function ppChange(cur: N, prev: N): Change | null {
  if (cur == null || prev == null) return null;
  const r = round1((cur - prev) * 100);
  if (r === 0) return FLAT("0.0 pts");
  return { text: signed(r, 1, " pts"), tone: r > 0 ? "good" : "bad", sr: `${r > 0 ? "up" : "down"} ${Math.abs(r).toFixed(1)} points` };
}

/** Average position change. Position 1 is the top, so going DOWN in number is good. */
export function posChange(cur: N, prev: N): Change | null {
  if (cur == null || prev == null) return null;
  const r = round1(cur - prev);
  if (r === 0) return FLAT("0.0");
  return { text: signed(r, 1, ""), tone: r < 0 ? "good" : "bad", sr: `moved ${r < 0 ? "up" : "down"} ${Math.abs(r).toFixed(1)} positions` };
}

export function parseRange(v: unknown): SeoRange {
  return typeof v === "string" && (SEO_RANGES as readonly string[]).includes(v) ? (v as SeoRange) : "28d";
}

export const RANGE_LABEL: Record<SeoRange, string> = { "28d": "28 days", "3m": "3 months", "16m": "16 months" };
/** What the "previous" comparison is called for each range. 16m has none. */
export const PREV_LABEL: Record<SeoRange, string | null> = { "28d": "previous 28 days", "3m": "previous 3 months", "16m": null };

export const STATUS_LABEL: Record<SiteStatus, string> = {
  current: "Current",
  behind: "Behind",
  waiting: "Waiting for client",
  collecting: "Collecting",
  access_removed: "Access removed",
};

/** Show a page URL as its path; anything that is not a URL is shown as is. */
export function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}
