/**
 * errorSentence - the one plain sentence a person reads for an error code a
 * route sent back.
 *
 * WHY (2026-10-02, LOAD-01 / SALES-04). Commissions printed route codes as
 * they came ("forbidden_commission_role", "commission_listing_unavailable").
 * A code is for the log, and each route logs it with its detail; the screen
 * gets a sentence that says what happened and what to do. A code this file
 * does not know, or raw database text that slipped through, gets the generic
 * sentence: never the code itself.
 *
 * A code may arrive bare ("status_conflict") or behind the name of the
 * function that raised it ("transition_commission_entry: status_conflict");
 * both read the same.
 *
 * PURE: no imports, so a client component can use it.
 */

const SENTENCES = new Map<string, string>([
  ["unauthorized", "Your session ended. Sign in again."],
  ["forbidden_commission_role", "Commissions aren't part of your role."],
  ["founder_only", "Only a founder can approve, pay or void a commission."],
  ["self_approval_forbidden", "Another founder has to approve your own commission."],
  ["verified_payment_required", "This commission needs a verified payment before it can move on."],
  ["commission_entry_immutable", "This entry is final and can't be changed."],
  ["commission_not_found_or_wrong_tenant", "That entry is no longer there. Refresh to see the latest."],
  ["status_conflict", "This entry changed a moment ago. Refresh and try again."],
  ["payout_reference_required", "Add the payout reference (at least 3 characters)."],
  ["void_reason_required", "Add a reason for voiding (at least 8 characters)."],
  ["commission_update_failed", "We couldn't save that change. Try again in a moment."],
]);

const COMMISSIONS_UNAVAILABLE = "We couldn't load commissions just now. Try again in a moment.";
const UNAVAILABLE = "We couldn't load this just now. Try again in a moment.";

/** What any code this file does not know reads as. */
export const GENERIC_ERROR_SENTENCE = "Something went wrong. Try again in a moment.";

export function errorSentence(code: string | null | undefined): string {
  const raw = typeof code === "string" ? code.trim() : "";
  const tail = raw.slice(raw.lastIndexOf(":") + 1).trim();
  const known = SENTENCES.get(raw) ?? SENTENCES.get(tail);
  if (known) return known;
  if (/^commission_[a-z_]+_unavailable$/.test(tail)) return COMMISSIONS_UNAVAILABLE;
  if (/^[a-z_]+_unavailable$/.test(tail)) return UNAVAILABLE;
  return GENERIC_ERROR_SENTENCE;
}
