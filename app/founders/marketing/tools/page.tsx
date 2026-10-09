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
 * and the subtitle says so, so nobody expects to find it again later.
 */

import { notFound } from "next/navigation";
import { PageFrame } from "@/components/os/PageFrame";
import { resolveFounder } from "@/lib/founders/gate";
import { OasisWhiteboard } from "@/components/founders/OasisWhiteboard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Content Tools · Content · OASIS" };

export default async function ContentToolsPage() {
  const founder = await resolveFounder();
  if (!founder) notFound();

  return (
    <PageFrame
      title="Content Tools"
      subtitle="Sketch ideas live on a Google Meet call, from a computer or a phone. The board is not saved when you leave this page: Download keeps a picture of it."
    >
      <OasisWhiteboard />
    </PageFrame>
  );
}
