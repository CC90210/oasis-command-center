/**
 * lib/bulk-email/recipients.ts — who in a bulk selection can actually be
 * emailed, and WHY the rest can't.
 *
 * The bug this exists to kill (Adon, 2026-08-20): the bulk path used to fold
 * every ineligible record into an anonymous `skipped` counter. An operator who
 * selected a stage and got "3 queued" had no way to learn that the other 57
 * leads have no email address on file — SunBiz leads are phone-first, so in the
 * `uw_sheet` stage exactly 1 of 86 leads is emailable. Indistinguishable from
 * "the button is broken", which is precisely how it was reported.
 *
 * PURE (no `server-only`, no DB) so the SAME function answers both questions:
 *   - preflight  ("60 selected, 3 can be emailed, 57 have no email address")
 *   - the queue write (which rows actually get created)
 * One code path, so the number an operator approves is by construction the
 * number that sends. A separately-implemented preview is a second source of
 * truth that drifts, and a preview that lies is worse than none.
 */

/** Same shape the route's tenant_records fetch returns. */
export type BulkRecord = { id: string; data?: Record<string, unknown> | null };

export type BulkSkipReason =
  /** id wasn't in this tenant / entity_type — also what a no-access record
   *  looks like, deliberately, so the endpoint can't enumerate real UUIDs. */
  | "not_found"
  /** scoping says this viewer may not act on this record */
  | "no_access"
  /** no usable email address on the record */
  | "no_email";

export type BulkRecipient = {
  id: string;
  toEmail: string;
  firstName: string;
  businessName: string;
};

export type BulkSkip = { id: string; reason: BulkSkipReason };

export type BulkClassification = {
  eligible: BulkRecipient[];
  skipped: BulkSkip[];
  counts: {
    selected: number;
    eligible: number;
    not_found: number;
    no_access: number;
    no_email: number;
  };
};

/** Deliberately the same expression the single-send routes use. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Operator-facing wording for each skip reason. Lives here, next to the
 *  reasons themselves, so a new reason can't ship without copy. */
export const SKIP_REASON_LABEL: Record<BulkSkipReason, string> = {
  not_found: "no longer in this list",
  no_access: "assigned to someone else",
  no_email: "no email address on file",
};

/**
 * Partition a selection into sendable recipients and explained skips.
 *
 * @param ids     the selected record ids, in selection order
 * @param byId    records actually found for this tenant + entity_type
 * @param canAct  visibility/authorization predicate for one record's data
 */
export function classifyBulkRecipients(
  ids: string[],
  byId: Map<string, BulkRecord>,
  canAct: (data: Record<string, unknown>) => boolean,
): BulkClassification {
  const eligible: BulkRecipient[] = [];
  const skipped: BulkSkip[] = [];
  const counts = { selected: ids.length, eligible: 0, not_found: 0, no_access: 0, no_email: 0 };

  for (const id of ids) {
    const rec = byId.get(id);
    if (!rec) {
      skipped.push({ id, reason: "not_found" });
      counts.not_found += 1;
      continue;
    }
    const data = rec.data || {};
    if (!canAct(data)) {
      skipped.push({ id, reason: "no_access" });
      counts.no_access += 1;
      continue;
    }
    const toEmail = str(data.email) || str(data.contact_email);
    if (!EMAIL_RE.test(toEmail)) {
      skipped.push({ id, reason: "no_email" });
      counts.no_email += 1;
      continue;
    }
    eligible.push({
      id,
      toEmail,
      firstName: str(data.contact_name) || str(data.owner_name) || str(data.name),
      businessName: str(data.business_name) || str(data.company) || str(data.name),
    });
    counts.eligible += 1;
  }

  return { eligible, skipped, counts };
}

/**
 * One plain-language line an operator reads BEFORE confirming a send. No
 * jargon, no reason codes — the point is that "57 have no email address on
 * file" is instantly actionable where "57 skipped" is not.
 */
export function summarizeClassification(c: BulkClassification, noun = "lead"): string {
  const plural = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  if (c.counts.selected === 0) return "Nothing selected.";
  if (c.counts.eligible === 0) {
    return `None of the ${plural(c.counts.selected)} you selected can be emailed.`;
  }
  const bits = [`${plural(c.counts.selected)} selected`, `${c.counts.eligible} can be emailed`];
  for (const reason of ["no_email", "no_access", "not_found"] as const) {
    const n = c.counts[reason];
    if (n > 0) bits.push(`${n} ${SKIP_REASON_LABEL[reason]}`);
  }
  return bits.join(" · ");
}
