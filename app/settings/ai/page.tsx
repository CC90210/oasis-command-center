/**
 * /settings/ai — Settings › AI brain: which AI account powers the agents, any
 * per-agent override, and which agents this workspace has.
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
