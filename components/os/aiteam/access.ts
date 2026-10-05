/**
 * components/os/aiteam/access.ts - does the AI team serve this viewer?
 *
 * The gates /agents/new and /agents/<slug> apply after the viewer resolves
 * (app/agents/page.tsx applies the same ones): system surfaces, a provisioned
 * workspace and the rail's "/agents" row (lib/os/nav.ts "ai-team"). One
 * answer, because the legacy /t/<slug> builder and teammate chat move a viewer
 * to those OS pages only when it is true (lib/os/redirects.ts
 * OS_VIEWER_MOVES): a move must never land on the 404 the OS page gives
 * someone it does not serve (W1a review R1). When the rail opens the AI team
 * to more viewers, the moves follow with no change here.
 */

import "server-only";
import type { OsViewer, OsViewerResult } from "@/components/os/department/viewer";
import { mayOpenOsHref } from "@/lib/os/nav";

/** The AI team's rail row. */
export const AI_TEAM_HREF = "/agents";

export function aiTeamServes(viewer: OsViewerResult): viewer is OsViewer {
  return (
    viewer.ok &&
    viewer.surface.capabilities.canSeeSystemSurfaces &&
    viewer.provisioned &&
    mayOpenOsHref(viewer.navInput, AI_TEAM_HREF)
  );
}
