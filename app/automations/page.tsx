/**
 * /automations (top-level) — always renders the signed-in user's home
 * tenant automations. Body extracted to components/automations/
 * AutomationsContent.tsx on 2026-05-25 (Option A pattern, matches
 * SettingsContent) so the same surface can also be mounted under
 * /t/<slug>/automations via the manifest catch-all dispatcher
 * (kind="automations"). Single source of truth across both routes.
 */

import { AutomationsContent } from "@/components/automations/AutomationsContent";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  return <AutomationsContent />;
}
