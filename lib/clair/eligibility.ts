/**
 * The CLAIR availability rule, in exactly one place.
 *
 * CLAIR (Thomson Reuters CLEAR) is the MANUAL fallback for merchant contact
 * enrichment; TruePeopleSearch is the automated primary. A CLEAR query is
 * billable and asserts a DPPA/GLB permissible use on the account, so it is
 * always operator-initiated.
 *
 * 2026-07-27 (Adon) — THE PRECONDITIONS WERE REMOVED, DELIBERATELY. This module
 * used to refuse a pull when the lead already had a phone on file, when the
 * automated lookup had not run yet, or when that lookup reported "found". In
 * practice the TruePeopleSearch number is frequently WRONG — a stale landline,
 * a relative, a disconnected cell — and those were exactly the leads on which
 * the operator most needed CLEAR, and exactly the leads where the button
 * disappeared. Gating a manual fallback on the success of the automated step it
 * exists to correct is backwards. An operator may now pull CLEAR at any point
 * in the lead lifecycle, phone on file or not.
 *
 * WHAT THIS DOES NOT RELAX — the compliance boundary is untouched and lives in
 * app/api/leads/[id]/clair-report/route.ts, NOT here:
 *   - every POST authenticates a real signed-in operator (authorizeBridgeRequest),
 *   - the operator's role must be in ALLOWED_ROLES,
 *   - the lead must belong to the caller's tenant,
 *   - the requesting user id + email are stamped on the report row, because a
 *     permissible-use assertion is made on a named person's behalf,
 *   - there is no service-to-service caller, no cron, and no retry-on-failure.
 * Operator discretion about WHEN to spend a lookup is not the same thing as
 * authorization to spend one. Do not re-add an automated caller here or there.
 *
 * Both the API route and the lead UI import this so the rule cannot drift
 * between them. It is a pure module — no server-only guard, no I/O — precisely
 * so the client component can share it rather than re-implement it.
 */

export type ClairEligibility = {
  eligible: boolean;
  /** Why not, in words an operator can act on. Empty when eligible. */
  reason: string;
};

/** True when `phone` holds a real, usable number. Live subs arrive 0-filled, so
 * a run of zeros (or anything under 10 digits) is an absence, not a number.
 *
 * Still used by the automated TruePeopleSearch route (which does skip leads that
 * already have a number — it is free, automatic, and genuinely redundant there)
 * and by the enrichment chips. It no longer has any bearing on CLAIR. */
export function hasUsablePhone(leadData: Record<string, unknown>): boolean {
  const digits = String(leadData.phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 && !/^0+$/.test(digits);
}

/**
 * Whether the CLAIR pull is offered for this lead.
 *
 * Unconditionally yes. The parameter and the return shape are kept so that the
 * route's 409 seam and the panel's render check remain a single named policy
 * decision with one home — if a future rule is ever needed (a spend cap, a
 * tenant entitlement), it belongs here and both callers inherit it at once.
 */
export function clairEligibility(_leadData: Record<string, unknown>): ClairEligibility {
  return { eligible: true, reason: "" };
}
