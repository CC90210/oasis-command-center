/**
 * /settings/team — Settings › Team.
 *
 * The people side of the workspace: the link to the Team page (invites, roles,
 * active/inactive — one canonical flow, never a second invite form here), the
 * revenue goal Today counts down to, the sales-team scorecard, and the weekly
 * activity tracker. Every card is SettingsContent's own, with its own gate;
 * this page only picks the section.
 */

import Link from "next/link";
import { SettingsContent } from "@/components/settings/SettingsContent";
import { requireSettingsSection } from "@/components/settings/settings-viewer";
import { PageFrame } from "@/components/os/PageFrame";

export const dynamic = "force-dynamic";

export default async function SettingsTeamPage() {
  const viewer = await requireSettingsSection("team");
  return (
    <PageFrame
      title="Team"
      subtitle="Who works here, the goal the team is chasing, and what everyone did this week."
      actions={
        viewer.access.canManage ? (
          <Link href="/team" prefetch={false} className="btn-secondary">
            Manage people
          </Link>
        ) : null
      }
    >
      <SettingsContent section="team" viewerAccess={viewer.viewerAccess} />
    </PageFrame>
  );
}
