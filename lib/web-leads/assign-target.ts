/**
 * Is this person a legal destination for a lead or a sheet?
 *
 * Extracted because two routes were answering the same question with two copies
 * of the same four lines: app/api/web-leads/claim/route.ts (per-lead) and
 * app/api/web-leads/territories/[id]/assign/route.ts (whole sheet). Two doors
 * to one decision, and a copy is how they drift.
 *
 * It is a pure function over a roster the caller has already fetched, so the
 * rule with commission attached is directly testable without mocking a route,
 * a session, or a database. The repo's route tests assert on source text
 * (tests/turnkey-access-boundaries.test.ts is the pattern) -- that catches a
 * check being deleted, but not a check being made wrong. This is the half that
 * can be exercised for real.
 *
 * NOT exported as "may X assign to Y": the two callers differ on self-assignment
 * (claim lets a rep take a lead for themselves without consulting the roster;
 * a sheet has no such exemption). That difference is deliberate and stays with
 * each route. This answers membership only.
 */

/** The shape both callers already have from getOasisSalesRepRoster. */
export type RosterMember = { auth_user_id?: string | null };

/**
 * Compared case-insensitively and trimmed on BOTH sides, because the two sides
 * come from different places: the target arrives in a JSON body a client typed
 * or a <select> submitted, the roster comes out of user_profiles. Comparing raw
 * would let a trailing space or a capitalised uuid read as "not on the roster"
 * and refuse a perfectly valid rep.
 *
 * An empty or whitespace-only target is never a member -- a caller wanting to
 * clear an owner passes null and skips this entirely, so a blank string here
 * means a malformed request, not "unassign".
 */
export function isAssignableTarget(roster: readonly RosterMember[], target: string): boolean {
  const want = (target || "").trim().toLowerCase();
  if (!want) return false;
  return roster.some((m) => (m.auth_user_id || "").trim().toLowerCase() === want);
}
