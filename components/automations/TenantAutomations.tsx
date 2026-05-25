/**
 * TenantAutomations — tenant-scoped Automations surface mounted by the
 * manifest catch-all (kind: "automations").
 *
 * Routed at /t/<slug>/automations (since 2026-05-25). Replaces the
 * prior approach where SUN_SEED's Automations nav pointed at top-level
 * /automations — which conflated tenant routing with operator-home
 * routing. Same Option A pattern as TenantSettings (commit 24fa69b).
 *
 * Render rules:
 *   - tenantId === null  → preview mode (no sub-components mount, no
 *     fetches, no operator data leaks).
 *   - tenantId is set    → tenant owner is signed in; full
 *     AutomationsContent with their data scoped to this tenant.
 */

import { AutomationsContent } from "./AutomationsContent";

export async function TenantAutomations({
  tenantSlug,
  tenantId,
}: {
  tenantSlug: string;
  tenantId: string | null;
}) {
  return (
    <AutomationsContent
      previewMode={!tenantId}
      tenantSlug={tenantSlug}
      hideHeader
    />
  );
}
