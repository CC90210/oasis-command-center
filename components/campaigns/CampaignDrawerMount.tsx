import { CampaignDetailDrawer } from "./CampaignDetailDrawer";

/**
 * Gated mount for the campaign metrics drawer — mirrors TenantLeadDrawerMount.
 * Only the SunBiz slug has it wired, and never in preview mode (so a non-owner
 * previewing a slug can't pop a drawer over another tenant's data).
 */
export function CampaignDrawerMount({
  slug,
  isPreview,
  drawerCampaignId,
}: {
  slug: string;
  isPreview: boolean;
  drawerCampaignId: string | null;
}) {
  if (slug !== "sun" || isPreview) return null;
  if (drawerCampaignId) {
    return <CampaignDetailDrawer tenantSlug={slug} campaignId={drawerCampaignId} />;
  }
  return null;
}
