/**
 * /automations (top-level) — always renders the signed-in user's home
 * tenant automations. Body extracted to components/automations/
 * AutomationsContent.tsx on 2026-05-25 (Option A pattern, matches
 * SettingsContent) so the same surface can also be mounted under
 * /t/<slug>/automations via the manifest catch-all dispatcher
 * (kind="automations"). Single source of truth across both routes.
 */

import { AutomationsContent } from "@/components/automations/AutomationsContent";
import { requireSystemSurface } from "@/lib/role-surfaces-session";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  // System surface — cron jobs, background workers, sequence engines. 404 for
  // an outside contractor. Gated HERE rather than inside AutomationsContent so
  // the tenant-scoped mount at /t/<slug>/automations, which serves other
  // tenants' own operators, is left exactly as it is.
  await requireSystemSurface();
  return <AutomationsContent />;
}
