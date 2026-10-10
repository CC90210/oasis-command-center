/**
 * /founders/marketing/tools - Content Tools: the hands-on side of the Content
 * hub.
 *
 * FOUNDERS ONLY, same gate as every sibling page: resolveFounder() here and in
 * both layouts above, so a client gets a 404, never the tab bar.
 *
 * This page took the Training tab's slot on 2026-10-06. The flagship tool is
 * the Oasis Whiteboard, ported from the standalone build in
 * Business-Empire-Agent/oasis-whiteboard: the sketching surface for
 * screenshares and quick visuals. The Training page was not deleted:
 * /founders/marketing/train still resolves by direct URL, the Overview's
 * Training card still links to it, and lib/os/match.ts keeps its crumb.
 *
 * The board is kept in the browser tab only (nothing is uploaded or stored),
 * and the line above it says so, so nobody expects to find it again later.
 *
 * Both sections below are collapsible, the same way (components/leads/
 * CollapsibleSection.tsx: a disclosure button with aria-expanded, keyboard-
 * operable because it is a real <button>, open/closed remembered per browser
 * via localStorage) - open by default, since that was this page's behaviour
 * before 2026-10-10.
 *
 * The Tools section (components/tools/ToolsSection.tsx: Repurpose a post,
 * Download a video while the computer that runs downloads is on) sits above
 * the board. "Score a hook" was removed from the product on 2026-10-10 (dead
 * code, including its worker and tests); "Learn from a link" moved the same
 * day to Admin > Agent training (app/admin/agent-training/page.tsx),
 * OASIS-operators-only - this page's catalog (the default "client" audience,
 * lib/tools/catalog.ts) never carries it. Which cards show, and in what
 * state, is still lib/tools/catalog.ts; until the tools' tables exist the
 * section says "Tools are not set up yet." and nothing else.
 */

import { notFound } from "next/navigation";
import { CollapsibleSection } from "@/components/leads/CollapsibleSection";
import { PageFrame } from "@/components/os/PageFrame";
import { resolveFounder } from "@/lib/founders/gate";
import { OasisWhiteboard } from "@/components/founders/OasisWhiteboard";
import { ToolsSection } from "@/components/tools/ToolsSection";

export const dynamic = "force-dynamic";
export const metadata = { title: "Content Tools · Content · OASIS" };

export default async function ContentToolsPage() {
  const founder = await resolveFounder();
  if (!founder) notFound();

  return (
    <PageFrame title="Content Tools">
      <CollapsibleSection title="Tools" storageKey="content-tools:tools" defaultCollapsed={false}>
        <ToolsSection tenantId={founder.tenantId} showCodes showHeading={false} className="" />
      </CollapsibleSection>
      <CollapsibleSection title="Whiteboard" storageKey="content-tools:whiteboard" defaultCollapsed={false}>
        <div className="space-y-3">
          <p className="px-1 text-[13px] leading-5 text-fg-muted">
            Sketch ideas live on a Google Meet call, from a computer or a phone. The board is not saved when you leave this page: Download keeps a picture of it.
          </p>
          <OasisWhiteboard />
        </div>
      </CollapsibleSection>
    </PageFrame>
  );
}
