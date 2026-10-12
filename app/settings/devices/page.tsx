/**
 * /settings/devices — Settings › Devices: machines paired to run the local
 * bridge. Every member manages their own pairings; team-wide/advanced device
 * inventory remains capability-gated inside SettingsContent.
 *
 * The bridge gives an agent a shell, files and every MCP on the paired machine,
 * The page guard follows the shared Settings registry. APIs scope ordinary
 * members to their own computers; only verified operators receive the raw
 * advanced bridge controls.
 */

import { SettingsContent } from "@/components/settings/SettingsContent";
import { requireSettingsSection } from "@/components/settings/settings-viewer";
import { PageFrame } from "@/components/os/PageFrame";

export const dynamic = "force-dynamic";

export default async function SettingsDevicesPage() {
  const viewer = await requireSettingsSection("devices");
  return (
    <PageFrame
      title="Devices"
      subtitle="Machines paired to run the local bridge, which gives agents files, a shell and local tools on that machine."
    >
      <SettingsContent section="devices" viewerAccess={viewer.viewerAccess} />
    </PageFrame>
  );
}
