/**
 * TenantSettings — tenant-scoped Settings surface mounted by the
 * manifest catch-all dispatcher (`kind: "settings"`).
 *
 * Routed at /t/<slug>/settings (since 2026-05-25). Replaces the prior
 * approach where SUN_SEED's Settings nav pointed at top-level /settings
 * — which always rendered the SIGNED-IN user's data regardless of
 * which tenant was being viewed. That was the cross-tenant leak CC
 * flagged: previewing /t/sun/* as the OASIS operator showed OASIS
 * Devices + AI keys + profile inside the Sun Biz shell.
 *
 * Render rules:
 *   - tenantId === null → operator is previewing a tenant they don't
 *     own. SettingsContent renders in previewMode (chrome only, no
 *     sub-components mount, no fetches fire → no operator data leaks).
 *   - tenantId is set → the signed-in user IS the tenant owner (per
 *     resolveDataTenant in the catch-all). Full SettingsContent
 *     render, all sub-components mounted, queries scope to the
 *     signed-in user (who owns this tenant).
 *
 * The tenantId-aware gate happens upstream in
 * app/t/[slug]/[...path]/page.tsx via resolveDataTenant(). When that
 * returns null, the operator is in preview mode for this tenant.
 */

import { SettingsContent } from "./SettingsContent";

export async function TenantSettings({
  tenantSlug,
  tenantId,
}: {
  tenantSlug: string;
  tenantId: string | null;
}) {
  return (
    <SettingsContent
      previewMode={!tenantId}
      tenantSlug={tenantSlug}
      // Catch-all dispatcher renders the PageHeader (kind="settings"
      // case) — suppress the inner one so we don't render two stacked
      // "Settings" headings. Same fix pattern as Offers / Lenders /
      // Shopping Out earlier this week.
      hideHeader
    />
  );
}
