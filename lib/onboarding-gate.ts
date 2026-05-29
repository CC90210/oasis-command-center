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
 *   null                     null       set         → /onboarding/welcome
 *                                                     (invitee whose redemption
 *                                                      failed — welcome page runs
 *                                                      orphan recovery on render)
 *   null                     null       null        → /onboarding/wizard
 *                                                     (genuine fresh-tenant signup
 *                                                      who never finished scaffolding)
 *   profile is null itself                          → null  (no profile yet — the
 *                                                            calling page handles it
 *                                                            with provisioning)
 */

export type OnboardingGateProfile = {
  onboarding_completed_at: string | null;
  invited_by: string | null;
  tenant_id: string | null;
};

export function shouldRedirectToOnboarding(
  profile: OnboardingGateProfile | null,
): "/onboarding/welcome" | "/onboarding/wizard" | null {
  if (!profile) return null;
  if (profile.onboarding_completed_at != null) return null;
  if (profile.tenant_id != null) return null;
  return profile.invited_by ? "/onboarding/welcome" : "/onboarding/wizard";
}
