/**
 * CLAIR applicability — the shared, non-blocking rule, in exactly one place.
 *
 * CLAIR (Thomson Reuters CLEAR) and TruePeopleSearch are INDEPENDENT contact
 * enrichments on the same lead. TruePeopleSearch is the automated, free one;
 * CLAIR is the manual, billable, permissible-use one. Neither excludes the
 * other: an operator may pull a CLEAR report whether or not the automated
 * lookup has run, and whether or not it already returned a number. Automated
 * matches are routinely stale, partial, or wrong, and a CLEAR pull is how an
 * operator verifies or expands one.
 *
 * This module therefore no longer gates anything — it only produces the
 * advisory copy the UI shows next to the button when a pull would be redundant.
 *
 * WHAT IS NOT RELAXED, and must not be: every CLEAR pull stays MANUAL and
 * operator-attributed (no cron, no service caller, no retry-on-failure),
 * role-gated, tenant-scoped, and its payload stays in `clair_reports` — never
 * merged into the application record. Those constraints live in
 * app/api/leads/[id]/clair-report/route.ts and ClairReportPanel.tsx.
 *
 * Pure module — no server-only guard, no I/O — so the client component and the
 * route can share it without drifting.
 */

/** True when `phone` holds a real, usable number. Live subs arrive 0-filled, so
 * a run of zeros (or anything under 10 digits) is an absence, not a number. */
export function hasUsablePhone(leadData: Record<string, unknown>): boolean {
  const digits = String(leadData.phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 && !/^0+$/.test(digits);
}

/**
 * Context for the operator about to spend a billable query — never a gate.
 * Returns "" when there is nothing worth saying.
 */
export function clairAdvisory(leadData: Record<string, unknown>): string {
  if (hasUsablePhone(leadData)) {
    return "This lead already has a number on file. A CLEAR pull is billable — run it to verify that number or find additional ones, not to duplicate it.";
  }
  if (String(leadData.phone_lookup_status ?? "") === "found") {
    return "The automated lookup already returned a match. A CLEAR pull is billable — run it to verify or expand that result.";
  }
  return "";
}
