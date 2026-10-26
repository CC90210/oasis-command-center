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
 * before 2026-10-10. Both also pass `keepMounted` (Codex review round 2,
 * 2026-10-10): collapsing must never unmount the Whiteboard (its canvas and
 * undo history live only in whiteboard-surface.ts's closures, not in React
 * state - an unmount is permanent data loss) or the Tools cards (an
 * in-progress "Repurpose a post" draft, a card's poll timers while a run is
 * in flight). `keepMounted` hides the closed section with the `hidden`
 * attribute instead of removing it from the tree.
 *
 * The Tools section (components/tools/ToolsSection.tsx) sits above the board.
 * Since 2026-10-17 it leads with the Video extractor (CC: "the first tool ... is a
 * video extractor"): paste a TikTok, YouTube or Instagram link, CMO-Agent's
 * scripts/content_tools_runner.py fetches it on OASIS's PC, and the finished run
 * offers Download, Open in Extracted videos and Done, which clears the card for
 * the next link (components/tools/ToolGrid.tsx). The Extracted videos list is
 * reached from inside that card, not from Content's tab bar (CC, 2026-10-25).
 * RefreshOnToolRun re-reads this page's server data when a run finishes or an
 * offline card asks to check its connection. Repurpose a post is off this page
 * (lib/tools/catalog.ts CONTENT_TOOLS_HIDDEN). More runner tools plug in the same
 * way: a registry entry here and a handler in the runner's TOOLS. "Score a hook" was removed from the product on 2026-10-10 (dead
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
import { RefreshOnToolRun } from "@/components/tools/RefreshOnToolRun";
import { ToolsSection } from "@/components/tools/ToolsSection";

export const dynamic = "force-dynamic";
export const metadata = { title: "Content Tools · Content · OASIS" };

export default async function ContentToolsPage() {
  const founder = await resolveFounder();
  if (!founder) notFound();

  return (
    <PageFrame title="Content Tools" className="space-y-6">
      <CollapsibleSection title="Tools" storageKey="content-tools:tools" defaultCollapsed={false} keepMounted>
        <ToolsSection tenantId={founder.tenantId} showCodes showHeading={false} className="" />
      </CollapsibleSection>
      <CollapsibleSection title="Whiteboard" storageKey="content-tools:whiteboard" defaultCollapsed={false} keepMounted>
        <div className="space-y-3">
          <p className="px-1 text-[13px] leading-5 text-fg-muted">
            Sketch ideas live on a Google Meet call, from a computer or a phone. The board is not saved when you leave this page: Download keeps a picture of it.
          </p>
          <OasisWhiteboard />
        </div>
      </CollapsibleSection>
      <RefreshOnToolRun />
    </PageFrame>
  );
}
