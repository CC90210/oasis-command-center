/**
 * lib/os/agent-names-session.ts - who reads OASIS's internal agent names: the
 * viewer half of lib/os/agent-names.ts (which says what a name becomes for
 * everyone else).
 *
 * THE RULE: an OASIS founder. A founder persona (CC, Adon, an owner-granted
 * admin) standing in an OASIS workspace, known by its slug AND its tenant id,
 * the same two tests the Playbook's gate makes (lib/playbook-access.ts
 * isOasisPlaybookWorkspace). The verified operator is one of them. A client of
 * any role is not, and neither is any other OASIS seat: a rep, a manager,
 * marketing, a builder, a member.
 *
 * Fails closed. No session, another workspace, an unresolved workspace slug or
 * a failed read all answer false, so the page shows department names: a
 * department name is never wrong to show, an internal name sometimes is. A
 * failed read is logged with its cause, not hidden.
 */

import "server-only";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import { isOasisSurfaceTenant, type Persona } from "@/lib/role-surfaces";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";

/** Who is looking: the fields lib/role-surfaces-session.ts resolveViewerSurface returns. */
export type AgentNameViewer = {
  persona: Persona | null | undefined;
  tenantId: string | null | undefined;
  tenantSlug: string | null | undefined;
};

/** True only for OASIS's founders. No viewer, any other persona or any other workspace: false. */
export function readsInternalAgentNames(viewer: AgentNameViewer | null | undefined): boolean {
  if (!viewer) return false;
  return viewer.persona === "founder" && isOasisInternalTenant(viewer.tenantId) && isOasisSurfaceTenant(viewer.tenantSlug);
}

/** readsInternalAgentNames for the signed-in viewer. */
export async function viewerReadsInternalAgentNames(): Promise<boolean> {
  try {
    const surface = await resolveViewerSurface();
    return surface.ok && readsInternalAgentNames(surface);
  } catch (err) {
    console.error("[agent-names.viewer]", err);
    return false;
  }
}
