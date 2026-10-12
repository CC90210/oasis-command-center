/**
 * /settings/ai — Settings › AI brain: which AI account powers the agents,
 * your own device choice, and which agents this workspace has.
 *
 * Jev, the specialist classifier, moved to Settings > Connections under
 * "Specialist models" (AI1 round 2, Adon 2026-10-12): it is a connection
 * (TypeSafe's System One, a vendor OASIS talks to), not an engine choice, and
 * Connections is already the one place every app OASIS talks to is set up.
 *
 * `/settings#providers` and `/settings#agents` (linked from chat failure
 * states) are forwarded here by /settings, and SettingsContent's
 * OpenSectionOnHash opens the section the fragment names.
 */

import { SettingsContent } from "@/components/settings/SettingsContent";
import { requireSettingsSection } from "@/components/settings/settings-viewer";
import { PageFrame } from "@/components/os/PageFrame";

export const dynamic = "force-dynamic";

export default async function SettingsAiPage() {
  const viewer = await requireSettingsSection("ai");
  return (
    <PageFrame
      title="AI brain"
      subtitle="The AI account your agents think with, and which agents this workspace runs."
    >
      <SettingsContent section="ai" viewerAccess={viewer.viewerAccess} />
    </PageFrame>
  );
}
