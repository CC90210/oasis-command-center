/**
 * Display helpers shared by the documents list and the document page. Pure.
 */

import type { DocStatus } from "./status";

/** The fixed banner on every legal document that is a draft (or not yet written). */
export const LEGAL_DRAFT_BANNER = "Draft, not legal advice. Counsel review required.";

export type TagTone ="neutral" | "accent" | "hot" | "warm" | "engaged" | "info";

export const STATUS_TONE: Readonly<Record<DocStatus, TagTone>> = {
  current: "engaged",
  review_due: "warm",
  draft: "info",
  missing: "hot",
  superseded: "neutral",
  unknown: "neutral",
  not_set_up: "neutral",
};

/** "2026-09-28" or an ISO time -> "Sep 28, 2026". Null -> "date not recorded". Unparseable -> the raw text. */
export function formatSourceDate(value: string | null): string {
  if (!value) return "date not recorded";
  const t = Date.parse(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(t)) return value;
  return new Date(t).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function sourceLine(label: string, date: string | null): string {
  return `Source: ${label}, updated ${formatSourceDate(date)}`;
}
