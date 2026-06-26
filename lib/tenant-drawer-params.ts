/**
 * Shared parser for the SunBiz lead/application detail-drawer URL triggers.
 *
 * The drawer (components/leads/LeadDetailDrawer.tsx) is URL-param-driven:
 * `?lead=<uuid>` / `?application=<uuid>` opens it over whatever page is
 * rendering. Both the tenant catch-all (/t/[slug]/[...path]) and the bare
 * tenant root (/t/[slug], where the dashboard renders) parse these the same
 * way, so the UUID validation + lead-takes-precedence rule live HERE — one
 * place to keep consistent across every surface that can pop the drawer.
 * (Previously the catch-all inlined this; the dashboard fix would have been a
 * second copy. A divergent copy of the guard is a latent cross-tenant /
 * malformed-id risk, so it's centralized.)
 */

const UUID_RE_DRAWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// TextTorrent campaign ids are numeric/string (NOT uuids). Constrain to a safe
// charset so the value is path/query-safe before it reaches the metrics route.
const CAMPAIGN_RE_DRAWER = /^[A-Za-z0-9_-]{1,64}$/;

export type TenantDrawerIds = {
  drawerLeadId: string | null;
  drawerAppId: string | null;
  drawerCampaignId: string | null;
};

export function parseTenantDrawerIds(sp: {
  lead?: string;
  application?: string;
  campaign?: string;
}): TenantDrawerIds {
  const rawLead = typeof sp.lead === "string" ? sp.lead : null;
  const rawApp = typeof sp.application === "string" ? sp.application : null;
  const rawCampaign = typeof sp.campaign === "string" ? sp.campaign : null;
  return {
    drawerLeadId: rawLead && UUID_RE_DRAWER.test(rawLead) ? rawLead : null,
    drawerAppId: rawApp && UUID_RE_DRAWER.test(rawApp) ? rawApp : null,
    drawerCampaignId: rawCampaign && CAMPAIGN_RE_DRAWER.test(rawCampaign) ? rawCampaign : null,
  };
}
