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
 * The Tools section (components/tools/ToolsSection.tsx: Score a hook, Repurpose
 * a post, Learn from a link, Download a video while the computer that runs
 * downloads is on) sits above the board, under its own heading; the board keeps
 * its line under a Whiteboard heading. Which cards show, and in what state, is
 * lib/tools/catalog.ts; until the tools' tables exist the section says "Tools
 * are not set up yet." and nothing else.
 */

import { notFound } from "next/navigation";
import { PageFrame } from "@/components/os/PageFrame";
import { resolveFounder } from "@/lib/founders/gate";
import { OasisWhiteboard } from "@/components/founders/OasisWhiteboard";
import { ToolsSection } from "@/components/tools/ToolsSection";

/** The same small heading the Tools section uses, so the two sections read as one page. */
const SECTION_HEADING = "px-1 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted";

export const dynamic = "force-dynamic";
export const metadata = { title: "Content Tools · Content · OASIS" };

export default async function ContentToolsPage() {
  const founder = await resolveFounder();
  if (!founder) notFound();

  return (
    <PageFrame title="Content Tools">
      <ToolsSection tenantId={founder.tenantId} showCodes />
      <section aria-labelledby="whiteboard-heading" className="space-y-3">
        <h2 id="whiteboard-heading" className={SECTION_HEADING}>
          Whiteboard
        </h2>
        <p className="px-1 text-[13px] leading-5 text-fg-muted">
          Sketch ideas live on a Google Meet call, from a computer or a phone. The board is not saved when you leave this page: Download keeps a picture of it.
        </p>
        <OasisWhiteboard />
      </section>
    </PageFrame>
  );
}
