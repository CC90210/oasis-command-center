/**
 * app/analytics/mrr-state.ts — what /analytics may say about MRR, decided from
 * the session surface alone. PURE, so tests/os-honest-numbers.test.ts runs it.
 *
 * Only an OASIS workspace has a live MRR source (lib/goals/oasis-money: live
 * Stripe and the Finances ledger). Everything else is one of three different
 * facts, and printing the wrong one is a false statement about the business:
 *
 *   oasis          company money is allowed here: the page reads it.
 *   unconfirmed    the workspace could not be confirmed (a failed tenant
 *                  lookup, `degraded`). capabilitiesFor then drops company
 *                  money ("the degraded path loses money"), so the OASIS
 *                  founder would read "Not connected, none feeding it" about
 *                  a Stripe account that is connected. It is "Couldn't
 *                  check", the same answer Today gives (app/page.tsx).
 *   owner_only     an OASIS workspace, and a viewer whose persona does not see
 *                  company money: the source exists, it is not theirs to see.
 *   not_connected  a confirmed workspace that is not OASIS: nothing feeds MRR
 *                  here yet.
 */

import { isOasisSurfaceTenant } from "@/lib/role-surfaces";

export type MrrState = "oasis" | "unconfirmed" | "owner_only" | "not_connected";

export type MrrSurface =
  | { ok: false }
  | { ok: true; degraded: boolean; tenantSlug: string | null; capabilities: { canSeeCompanyFinancials: boolean } };

export function analyticsMrrState(surface: MrrSurface): MrrState {
  if (!surface.ok || surface.degraded) return "unconfirmed";
  if (surface.capabilities.canSeeCompanyFinancials) return "oasis";
  return isOasisSurfaceTenant(surface.tenantSlug) ? "owner_only" : "not_connected";
}

/** The Net MRR stat and the MRR card's words for every state but "oasis" (which prints the live figure). */
export const MRR_COPY: Record<Exclude<MrrState, "oasis">, { value: string; hint: string; card: string }> = {
  unconfirmed: {
    value: "Couldn't check",
    hint: "The workspace could not be confirmed just now",
    card: "Couldn't check: the workspace could not be confirmed just now, so company revenue was not requested. Reload in a minute.",
  },
  owner_only: {
    value: "Owners only",
    hint: "Company revenue is shown to the workspace's owners",
    card: "Company revenue is shown to the workspace's owners.",
  },
  not_connected: {
    value: "Not connected",
    hint: "MRR comes from a live Stripe connection",
    card: "Not connected. MRR here comes from a live Stripe connection, never a typed number, and this workspace has none feeding it yet.",
  },
};
