/**
 * Onboarding-gate decision — middleware uses this to decide whether to
 * redirect a signed-in user to an onboarding flow on every page request.
 *
 * Extracted from middleware.ts on 2026-05-29 so the decision is unit-
 * testable. The previous shape (inline conditional in the middleware)
 * silently broke for tenant-attached users with a null
 * onboarding_completed_at — the May 27 → May 29 invitee incident — and
 * we want any future regression to fail a test loudly instead of just
 * routing real invitees through a redundant wizard.
 *
 * Decision matrix:
 *   onboarding_completed_at  tenant_id  invited_by  → return
 *   set                      ANY        ANY         → null  (done, never gate)
 *   null                     set        ANY         → null  (attached via wizard
 *                                                            completion OR invite
 *                                                            redemption — no gate)
 *     ...except the workspace OWNER of a workspace
 *        that is not set up yet                    → /onboarding/wizard
 *                                                     (2026-09-30: the owner may
 *                                                      set it up themselves; a
 *                                                      member never can)
 *   null                     null       set         → /onboarding/welcome
 *                                                     (invitee whose redemption
 *                                                      failed — welcome page runs
 *                                                      orphan recovery on render)
 *   null                     null       null        → null  (2026-09-30 fix pass: this
 *                                                            used to be the wizard,
 *                                                            which now serves only a
 *                                                            workspace OWNER and refuses
 *                                                            anyone with no workspace.
 *                                                            Its only link, "/", was
 *                                                            redirected straight back:
 *                                                            a loop until next login.
 *                                                            "/" says the account is
 *                                                            not linked to a workspace.)
 *   profile is null itself                          → null  (no profile yet — the
 *                                                            calling page handles it
 *                                                            with provisioning)
 *
 * TURSO MODE (2026-09-30). Middleware cannot read the database at the edge, so
 * the decision is made when the session cookie is minted (login, signup, invite
 * redemption, finishing the wizard) and carried in the signed cookie as the
 * `onb` claim (lib/onboarding-claim.ts). A cookie minted before the claim
 * existed carries none and is never gated.
 */

export type OnboardingGateProfile = {
  onboarding_completed_at: string | null;
  invited_by: string | null;
  tenant_id: string | null;
  /** 1/true for the workspace owner. Absent = not the owner. */
  is_owner?: boolean | number | null;
};

export type OnboardingDestination = "/onboarding/welcome" | "/onboarding/wizard";

export function shouldRedirectToOnboarding(
  profile: OnboardingGateProfile | null,
  opts: { workspaceProvisioned?: boolean | null } = {},
): OnboardingDestination | null {
  if (!profile) return null;
  if (profile.onboarding_completed_at != null) return null;
  if (profile.tenant_id != null) {
    // Only a positive "not set up" routes the owner; an unknown answer
    // (null/undefined) never traps anyone on a wizard.
    const owner = profile.is_owner === true || Number(profile.is_owner) === 1;
    return owner && opts.workspaceProvisioned === false ? "/onboarding/wizard" : null;
  }
  return profile.invited_by ? "/onboarding/welcome" : null;
}

/** The claim values a session cookie may carry. "done" = do not gate. */
export type OnboardingClaim = "done" | "wizard" | "welcome";

export function claimForDestination(dest: OnboardingDestination | null): OnboardingClaim {
  if (dest === "/onboarding/wizard") return "wizard";
  if (dest === "/onboarding/welcome") return "welcome";
  return "done";
}

/**
 * Where middleware sends a request carrying `claim`, or null to let it
 * through. Anything that is not a known claim (a legacy cookie, a value this
 * build does not know) is not gated: a gate that cannot read its input must
 * not trap a signed-in person on a wizard.
 */
export function destinationForClaim(claim: unknown): OnboardingDestination | null {
  if (claim === "wizard") return "/onboarding/wizard";
  if (claim === "welcome") return "/onboarding/welcome";
  return null;
}

/**
 * Paths the gate never redirects: the onboarding flows themselves, every API
 * call (the flows' own writes), and the sign-out route. Page requests only.
 */
export function onboardingGateApplies(pathname: string): boolean {
  if (pathname.startsWith("/api/")) return false;
  if (pathname === "/onboarding" || pathname.startsWith("/onboarding/")) return false;
  return true;
}
