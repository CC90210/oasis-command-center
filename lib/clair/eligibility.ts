/**
 * The CLAIR strict-fallback rule, in exactly one place.
 *
 * CLAIR (Thomson Reuters CLEAR) is the MANUAL, SECONDARY fallback for merchant
 * contact enrichment. TruePeopleSearch is the automated primary. A CLEAR query
 * is billable and asserts a DPPA/GLB permissible use on the account, so it is
 * only ever appropriate once the automated path has RUN and come up empty.
 *
 * Both the API route (which enforces it, returning 409) and the lead UI (which
 * hides the button) import this. It is a pure module — no server-only guard, no
 * I/O — precisely so the client component can share the rule rather than
 * re-implement it and drift out of sync with the server.
 */

export type ClairEligibility = {
  eligible: boolean;
  /** Why not, in words an operator can act on. Empty when eligible. */
  reason: string;
};

/** True when `phone` holds a real, usable number. Live subs arrive 0-filled, so
 * a run of zeros (or anything under 10 digits) is an absence, not a number. */
export function hasUsablePhone(leadData: Record<string, unknown>): boolean {
  const digits = String(leadData.phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 && !/^0+$/.test(digits);
}

export function clairEligibility(leadData: Record<string, unknown>): ClairEligibility {
  if (hasUsablePhone(leadData)) {
    return { eligible: false, reason: "this lead already has a phone number on file" };
  }
  const status = String(leadData.phone_lookup_status ?? "");
  if (!status) {
    return {
      eligible: false,
      reason: "the automated lookup has not run yet — CLAIR is the fallback, not the first step",
    };
  }
  if (status === "found") {
    return { eligible: false, reason: "the automated lookup already found a number" };
  }
  return { eligible: true, reason: "" };
}
