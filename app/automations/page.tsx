/**
 * /automations (top-level) — always renders the signed-in user's home
 * tenant automations. Body extracted to components/automations/
 * AutomationsContent.tsx on 2026-05-25 (Option A pattern, matches
 * SettingsContent) so the same surface can also be mounted under
 * /t/<slug>/automations via the manifest catch-all dispatcher
 * (kind="automations"). Single source of truth across both routes.
 */

import { AutomationsContent } from "@/components/automations/AutomationsContent";
import { requireOperator, resolvePlatformOperator } from "@/lib/role-surfaces-session";
import { resolveScriptAutomationAccess } from "@/lib/automations/script-access";
import { guidedBuilderAllowed } from "@/lib/automations/guided-access";
import { cloudJobsSwitchableForViewer } from "@/lib/automations/cloud-job-control";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  // Admin surface — the OASIS platform schedules, background workers and the
  // drafter. Operator only (2026-09-30): requireSystemSurface admitted any
  // client workspace's owner, who could read OASIS's cron names by URL. Gated
  // HERE rather than inside AutomationsContent so the tenant-scoped mount at
  // /t/<slug>/automations, which serves each workspace's own routines, is left
  // exactly as it is.
  await requireOperator();
  // requireOperator() above 404s everyone but a verified platform operator —
  // former platform operators too, before their grants were revoked. Creation is tighter still (O2):
  // resolveScriptAutomationAccess is the SAME agents-owner-or-fallback verdict
  // gateScriptAutomationCreate enforces, in the same order (the viewer's
  // ACTIVE seat must manage this workspace, THEN the agents-owner question).
  // This used to hardcode "allowed" for any operator who could manage the
  // team, which is exactly the bug O2 closes: Adon manages OASIS's team too,
  // but CCPC is CC's computer, so only CC may create a script automation here.
  const scriptAccess = await resolveScriptAutomationAccess(await resolvePlatformOperator());
  // The guided builder (templates, a test run, then Turn on) is for any owner or admin of the workspace:
  // the routes enforce the same rule, so the page never offers a control that would answer 403.
  const guidedEnabled = await guidedBuilderAllowed();
  // The cloud jobs' on/off switches: the same verdict POST /api/automations/cloud-jobs enforces (CC
  // only), so a switch is offered exactly when a flip would be accepted. A failed check offers none.
  const cloudJobsSwitchable = await cloudJobsSwitchableForViewer();
  return (
    <AutomationsContent scriptAccess={scriptAccess} guidedEnabled={guidedEnabled} cloudJobsSwitchable={cloudJobsSwitchable} />
  );
}
