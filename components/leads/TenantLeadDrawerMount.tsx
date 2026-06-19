import { LeadDetailDrawer } from "./LeadDetailDrawer";

/**
 * Gated mount for the lead/application detail drawer.
 *
 * Centralizes the SunBiz-only + not-in-preview access gate so EVERY surface
 * that can open the drawer (the tenant catch-all and the bare-root dashboard)
 * applies the SAME rule: only the SunBiz slug has the drawer wired, and a
 * non-owner previewing a slug must never pop a drawer over another tenant's
 * record. Lead takes precedence over application when both params are present.
 *
 * Server component — it only decides whether the client `LeadDetailDrawer` is
 * included in the tree; the drawer itself owns the client interactivity.
 */
export function TenantLeadDrawerMount({
  slug,
  isPreview,
  drawerLeadId,
  drawerAppId,
}: {
  slug: string;
  isPreview: boolean;
  drawerLeadId: string | null;
  drawerAppId: string | null;
}) {
  if (slug !== "sun" || isPreview) return null;
  if (drawerLeadId) {
    return <LeadDetailDrawer tenantSlug={slug} recordId={drawerLeadId} entity="lead" />;
  }
  if (drawerAppId) {
    return <LeadDetailDrawer tenantSlug={slug} recordId={drawerAppId} entity="application" />;
  }
  return null;
}
