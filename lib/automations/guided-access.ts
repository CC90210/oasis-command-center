/**
 * lib/automations/guided-access.ts - may this viewer be offered the guided builder?
 *
 * The same rule the routes enforce first (lib/automations/guided-service.ts guidedSession): a signed-in
 * owner or admin of the workspace they are looking at, on a deployment with the database the engine
 * needs. A page asks this before drawing the builder, so nobody is shown a control the API would answer
 * 403 to. A failed read is "no": the builder is never offered on a guess.
 */
import "server-only";
import { canManageTeam, getSessionContext } from "@/lib/team";
import { tursoConfigured } from "@/lib/turso";

export async function guidedBuilderAllowed(): Promise<boolean> {
  if (!tursoConfigured()) return false;
  try {
    const ctx = await getSessionContext();
    return !!ctx && canManageTeam(ctx.teamRole, ctx.adminAccess);
  } catch {
    console.error("[automations.guided_access] session read failed");
    return false;
  }
}
