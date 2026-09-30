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
import { CLIENT_STAGES } from "@/components/os/landings/clients-model";
import { stripeSyncLine } from "@/lib/founders-finances/stripe-sync-status";

/**
 * "Won" on /analytics: every lead whose stage means it became a client, the
 * same stages Clients lists (components/os/landings/clients-model.ts
 * CLIENT_STAGES, read-only here): won, onboarding, in build, client review,
 * launched. It counted the literal "won" stage only, so a client that moved on
 * to onboarding stopped being a win (2026-09-30: BreezeAdvance and SunBiz,
 * both "launched", counted 0 won).
 */
export function wonCount(stages: Readonly<Record<string, number>>): number {
  return CLIENT_STAGES.reduce((sum, s) => sum + Number(stages[s] || 0), 0);
}

/**
 * The MRR stat's hint for OASIS: when the books last heard from Stripe
 * (stripe-sync-status.ts, the line Today and Finances print), never a bare
 * "live Stripe" with no time. `sync` null = the sync time could not be read.
 */
export function stripeMrrHint(sync: { lastSyncAt: string | null } | null, nowMs: number, usd: string | null): string {
  const line = sync ? stripeSyncLine(sync.lastSyncAt, nowMs).note : "Stripe sync: couldn't check";
  return `${line}${usd ? ` · ≈ ${usd} USD` : ""}`;
}

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
