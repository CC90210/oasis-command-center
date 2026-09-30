/**
 * lib/playbook/status.ts - a document's status, DERIVED, never typed.
 *
 *   Missing     no body and no live source (nothing to open, a link-only row
 *               aside).
 *   Draft       a stored text nobody has marked current.
 *   Current     a live source, a bundled file, or a stored text a founder
 *               marked current, within its review window.
 *   Review due  current, but its source date plus review_every_days has
 *               passed.
 *   Superseded  replaced; kept for the record.
 *   Unknown     the stored text could not be read. Never "Missing": an
 *               unreadable row is not an absent one.
 *   Not set up  document storage does not exist yet (bravo__194 not
 *               applied). Never "Missing" either: nobody has looked for the
 *               text, because there is nowhere to keep it (the migration's
 *               own contract).
 *
 * PURE. Callers pass the clock, so tests pin time.
 */

import type { CatalogDoc } from "./catalog";

export type DocStatus = "current" | "review_due" | "draft" | "missing" | "superseded" | "unknown" | "not_set_up";

export const STATUS_LABEL: Readonly<Record<DocStatus, string>> = {
  current: "Current",
  review_due: "Review due",
  draft: "Draft",
  missing: "Missing",
  superseded: "Superseded",
  unknown: "Couldn't check",
  not_set_up: "Not set up yet",
};

export const PLACEHOLDER_OPEN = "[[CC to confirm";

/** The one sentence "Mark current" answers while a placeholder remains. */
export const PLACEHOLDER_REFUSAL =
  "This document still has questions for CC; answer every [[CC to confirm: ...]] and save before marking it current.";

/** True while the text still carries a [[CC to confirm: ...]] placeholder. */
export function hasPlaceholders(body: string | null | undefined): boolean {
  return (body || "").includes(PLACEHOLDER_OPEN);
}

/** Every placeholder's question, in order, for the "what is left" list. */
export function placeholdersIn(body: string | null | undefined): string[] {
  const out: string[] = [];
  const re = /\[\[CC to confirm:?\s*([^\]]*)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body || "")) !== null) out.push(m[1].trim());
  return out;
}

/** The stored fields status needs (a playbook_docs row). */
export type StoredStatusFields = {
  status: string;
  body_md: string | null;
  source_url: string | null;
  source_updated_at: string | null;
  approved_at: string | null;
  review_every_days: number | null;
};

const DAY_MS = 86_400_000;

/** A YYYY-MM-DD or ISO timestamp plus `days`, compared with `now`. Null date: not due (unknown, not overdue). */
export function isReviewDue(sourceDate: string | null, reviewEveryDays: number | null, now: Date): boolean {
  if (!sourceDate || !reviewEveryDays) return false;
  const t = Date.parse(sourceDate.length === 10 ? `${sourceDate}T00:00:00Z` : sourceDate);
  if (!Number.isFinite(t)) return false;
  return t + reviewEveryDays * DAY_MS < now.getTime();
}

export type StatusInput =
  | { kind: "live"; sourceDate: string | null }
  | { kind: "stored"; row: StoredStatusFields | null }
  | { kind: "unreadable" }
  | { kind: "storage_not_ready" };

export function deriveStatus(doc: Pick<CatalogDoc, "reviewEveryDays">, input: StatusInput, now: Date): DocStatus {
  if (input.kind === "unreadable") return "unknown";
  if (input.kind === "storage_not_ready") return "not_set_up";
  if (input.kind === "live") return isReviewDue(input.sourceDate, doc.reviewEveryDays, now) ? "review_due" : "current";
  const row = input.row;
  if (!row) return "missing";
  if (row.status === "superseded") return "superseded";
  if (!row.body_md && !row.source_url) return "missing";
  if (row.status === "draft" || row.status === "drafting") return "draft";
  if (row.status === "current") {
    const days = row.review_every_days ?? doc.reviewEveryDays;
    return isReviewDue(row.source_updated_at ?? row.approved_at, days, now) ? "review_due" : "current";
  }
  return "missing";
}

/** "September 28, 2026" -> "2026-09-28". Null when it is not that shape. */
export function isoFromLongDate(text: string | null | undefined): string | null {
  const m = (text || "").trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const mi = months.indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  const day = Number(m[2]);
  if (day < 1 || day > 31) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
