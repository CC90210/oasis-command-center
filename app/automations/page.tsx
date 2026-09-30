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

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  // Admin surface — the OASIS platform schedules, background workers and the
  // drafter. Operator only (2026-09-30): requireSystemSurface admitted any
  // client workspace's owner, who could read OASIS's cron names by URL. Gated
  // HERE rather than inside AutomationsContent so the tenant-scoped mount at
  // /t/<slug>/automations, which serves each workspace's own routines, is left
  // exactly as it is.
  await requireOperator();
  return <AutomationsContent />;
}
