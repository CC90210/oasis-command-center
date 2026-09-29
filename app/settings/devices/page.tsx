/**
 * /settings/devices — Settings › Devices: machines paired to run the local
 * bridge. Operators only.
 *
 * The bridge gives an agent a shell, files and every MCP on the paired machine,
 * so this follows the VERIFIED operator check (resolvePlatformOperator), never
 * workspace admin: requireSettingsSection 404s everyone else before any read,
 * and SettingsContent's Devices card carries the same gate of its own.
 * `/settings#devices` (the install wizard's back link) is forwarded here by
 * /settings for operators only.
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
