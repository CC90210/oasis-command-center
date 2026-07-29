/**
 * lib/active-profile.ts — which user_profiles row is "the active one" when an
 * auth account has more than one.
 *
 * Extracted 2026-07-29 so the page-render path and the API-authorization path
 * agree. They did not: getActiveProfile() has always supported multiple
 * profiles (SELECT ... LIMIT 20, then this chooser), while
 * resolveSessionContext() read the same table with .maybeSingle(), which ERRORS
 * on more than one row. A multi-profile user would therefore render pages fine
 * and then be rejected by every write endpoint — 95 routes authorize through
 * that helper.
 *
 * Deliberately pure and dependency-free: it is the tie-breaker for an
 * authorization decision, so it should be readable and directly testable rather
 * than buried in a query module.
 */

/** The minimum a row needs for the choice. Structural, so both callers' richer row types satisfy it. */
export type ChoosableProfile = {
  email?: string | null;
  is_owner?: boolean | null;
  onboarding_completed_at?: string | null;
};

/**
 * Pick the active profile from an auth account's rows.
 *
 * Precedence, after narrowing to an exact email match when one exists:
 *   1. owner with onboarding complete
 *   2. onboarding complete
 *   3. owner
 *   4. first row
 *
 * The email narrowing matters because a single auth account can carry profiles
 * created under different addresses; the one matching the session's own address
 * is the one the user is actually acting as.
 *
 * Note the ordering deliberately does NOT consider brand. An earlier version
 * tie-broke on brand.includes("oasis"), which pinned any multi-tenant user to
 * OASIS even when their session was a different tenant. Ownership plus
 * onboarding-completion is the right precedence; callers needing a specific
 * tenant should resolve by tenant_id instead of relying on this.
 */
export function chooseActiveProfile<T extends ChoosableProfile>(
  rows: T[],
  email: string | null | undefined,
): T {
  if (rows.length === 1) return rows[0];
  const normalizedEmail = (email || "").trim().toLowerCase();
  const exactEmail = normalizedEmail
    ? rows.filter((row) => (row.email || "").trim().toLowerCase() === normalizedEmail)
    : [];
  const candidates = exactEmail.length > 0 ? exactEmail : rows;
  return (
    candidates.find((row) => row.is_owner && row.onboarding_completed_at) ||
    candidates.find((row) => row.onboarding_completed_at) ||
    candidates.find((row) => row.is_owner) ||
    candidates[0]
  );
}
