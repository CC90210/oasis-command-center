/**
 * lib/offers/community-link.ts - where /go/community sends a visitor who is
 * not ready, has no budget, or stalls (HANDOVER section 1.3, "the save
 * basin"). The ONLY place this URL is decided.
 *
 * SERVER CONFIG ONLY, NEVER THE QUERY STRING. /go/community takes ?form and
 * ?t to resolve WHICH offer is routing someone here (for the community_click
 * event and the save_basin lead interaction), but the destination itself
 * comes from here, not from the request — an open redirect is exactly what
 * happens the moment a query parameter is allowed to pick the target URL.
 *
 * ONE TENANT TODAY. OASIS's own free Telegram lounge (funnel doc §3, 3A). No
 * other workspace has a community configured yet, so `communityUrlForTenant`
 * returns null for everyone else and the route answers 404 — a workspace
 * with no community link set up should never be told it has one.
 */
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";

/** Adon's free Telegram lounge, confirmed in HANDOVER section 1.3. */
const DEFAULT_OASIS_COMMUNITY_URL = "https://t.me/+w_8rgh8YBWg4YmM5";

/**
 * The community URL for this tenant id, or null when this workspace has none
 * configured. `OASIS_COMMUNITY_URL` lets ops repoint OASIS's own link without
 * a code change; every other tenant is null until a future slice adds its own
 * env key here, deliberately — never a generic fallback that could hand one
 * workspace's community to another's visitors.
 */
export function communityUrlForTenant(tenantId: string): string | null {
  if (!isOasisInternalTenant(tenantId)) return null;
  const configured = process.env.OASIS_COMMUNITY_URL?.trim();
  return configured || DEFAULT_OASIS_COMMUNITY_URL;
}
