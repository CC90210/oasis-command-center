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
 *
 * This is the mount client workspaces reach, so it answers the one viewer
 * question AutomationsContent needs: may this person CREATE script
 * automations? Only a verified platform operator may (the create routes
 * enforce the same check, lib/automations/script-access.ts). Everyone else
 * gets a plain sentence instead of the AI box and the New automation button,
 * never a control the API would refuse.
 */

import { AutomationsContent } from "./AutomationsContent";
import { resolvePlatformOperator } from "@/lib/role-surfaces-session";
import { resolveScriptAutomationAccess } from "@/lib/automations/script-access";
import { guidedBuilderAllowed } from "@/lib/automations/guided-access";
import { cloudJobsSwitchableForViewer } from "@/lib/automations/cloud-job-control";

export async function TenantAutomations({
  tenantSlug,
  tenantId,
}: {
  tenantSlug: string;
  tenantId: string | null;
}) {
  // Preview mode mounts nothing that could use it, so it costs no read there.
  // resolveScriptAutomationAccess also requires the viewer's ACTIVE seat to
  // manage this workspace — the same canManageTeam gate the create routes
  // enforce — so a verified operator standing in as a plain member here is
  // never shown a control the API would then answer 403.
  const scriptAccess = tenantId ? await resolveScriptAutomationAccess(await resolvePlatformOperator()) : "not_allowed";
  // The guided builder is any owner's or admin's (the routes enforce it too); preview mode mounts nothing.
  const guidedEnabled = tenantId ? await guidedBuilderAllowed() : false;
  // The cloud jobs' on/off switches, as on /automations: CC only, the toggle route's own verdict.
  const cloudJobsSwitchable = tenantId ? await cloudJobsSwitchableForViewer() : false;
  return (
    <AutomationsContent
      previewMode={!tenantId}
      tenantSlug={tenantSlug}
      hideHeader
      scriptAccess={scriptAccess}
      guidedEnabled={guidedEnabled}
      cloudJobsSwitchable={cloudJobsSwitchable}
    />
  );
}
