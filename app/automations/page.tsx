/**
 * /automations (top-level) — always renders the signed-in user's home
 * tenant automations. Body extracted to components/automations/
 * AutomationsContent.tsx on 2026-05-25 (Option A pattern, matches
 * SettingsContent) so the same surface can also be mounted under
 * /t/<slug>/automations via the manifest catch-all dispatcher
 * (kind="automations"). Single source of truth across both routes.
 */

import { AutomationsContent } from "@/components/automations/AutomationsContent";
import { requireOperator } from "@/lib/role-surfaces-session";
import { canManageTeam, getSessionContext } from "@/lib/team";
import type { ScriptAutomationAccess } from "@/lib/automations/script-access";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  // Admin surface — the OASIS platform schedules, background workers and the
  // drafter. Operator only (2026-09-30): requireSystemSurface admitted any
  // client workspace's owner, who could read OASIS's cron names by URL. Gated
  // HERE rather than inside AutomationsContent so the tenant-scoped mount at
  // /t/<slug>/automations, which serves each workspace's own routines, is left
  // exactly as it is.
  await requireOperator();
  // requireOperator() above 404s everyone but a verified platform operator, the
  // same check the script-automation create routes enforce
  // (lib/automations/script-access.ts) — but creation ALSO requires the
  // viewer's ACTIVE seat to manage this workspace (gateScriptAutomationCreate's
  // canManageTeam gate, checked before the operator question is even asked).
  // Hardcoding "allowed" here offered the create controls to an operator whose
  // active seat is a plain member, and every one of the three create routes
  // then answered 403.
  const ctx = await getSessionContext();
  const scriptAccess: ScriptAutomationAccess =
    ctx && canManageTeam(ctx.teamRole, ctx.adminAccess) ? "allowed" : "not_allowed";
  return <AutomationsContent scriptAccess={scriptAccess} />;
}
