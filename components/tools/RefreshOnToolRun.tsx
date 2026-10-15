"use client";

/**
 * components/tools/RefreshOnToolRun.tsx - re-reads this page's server-rendered data
 * when a tool run on it finishes.
 *
 * Agent training lists what "Learn from a link" has learned, read on the server. The
 * Tools card only updates its own run list, so a note the run just wrote stayed
 * missing until a manual reload while the page said it "appears once it has been
 * read" (Codex review of #612). The card announces a finished run
 * (TOOL_RUN_FINISHED_EVENT); this refreshes the route's server data in response.
 * It renders nothing.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { TOOL_RUN_FINISHED_EVENT } from "@/components/tools/tool-grid-format";

export function RefreshOnToolRun() {
  const router = useRouter();
  useEffect(() => {
    const onFinished = () => router.refresh();
    window.addEventListener(TOOL_RUN_FINISHED_EVENT, onFinished);
    return () => window.removeEventListener(TOOL_RUN_FINISHED_EVENT, onFinished);
  }, [router]);
  return null;
}
