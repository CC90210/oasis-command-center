/**
 * lib/notify/alert-access.ts - who may read and resolve a workspace's alert cards.
 *
 * One rule, decided from the session's persona and capabilities, never from a
 * request: the workspace's owners and admins (the founder persona, which an
 * admin_access grant also resolves to) on a surface that may see system
 * surfaces and act. Every place that shows or closes a card asks this:
 *
 *   - Needs you (components/os/today/model.ts todayBriefPlan.alerts),
 *   - the Resolve route (app/api/agent-alerts/[id]/resolve),
 *   - the workspace dashboard's System health card
 *     (components/manifest/dashboard-alerts.ts).
 *
 * Until 2026-10-08 the Resolve route admitted any member of a client workspace
 * (lib/shared-tenant-resource-access.ts), so a rep or a read-only seat could
 * close an outage card its owners had not seen.
 *
 * PURE: no session and no database, so the Needs-you plan can use it in bare node.
 */
import type { Persona, SurfaceCapabilities } from "@/lib/role-surfaces";

export function mayManageWorkspaceAlerts(
  persona: Persona,
  capabilities: Pick<SurfaceCapabilities, "canSeeSystemSurfaces" | "canAct">,
): boolean {
  return persona === "founder" && capabilities.canSeeSystemSurfaces && capabilities.canAct;
}
