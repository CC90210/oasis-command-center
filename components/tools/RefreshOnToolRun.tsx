"use client";

/**
 * components/tools/RefreshOnToolRun.tsx - re-reads this page's server-rendered data
 * when a tool card on it asks to.
 *
 * Two asks, both window events the cards dispatch (components/tools/ToolGrid.tsx):
 *
 *   TOOL_RUN_FINISHED_EVENT  a card's last in-flight run finished. Agent training
 *                            lists what "Learn from a link" has learned, read on the
 *                            server; the card only updates its own run list, so a
 *                            note the run just wrote stayed missing until a manual
 *                            reload while the page said it "appears once it has been
 *                            read" (Codex review of #612).
 *   TOOL_RECHECK_EVENT       an offline card's Check connection (2026-10-26). Whether
 *                            the OASIS PC is back is decided on the server
 *                            (lib/tools/catalog.ts), so the page re-renders and hands
 *                            the card its new state; the card itself has no router.
 *
 * The grid dispatches events rather than calling the router so a test can render
 * it outside Next's app router (tests/tools-grid.render.ts). It renders nothing.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { TOOL_RECHECK_EVENT, TOOL_RUN_FINISHED_EVENT } from "@/components/tools/tool-grid-format";

export function RefreshOnToolRun() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => router.refresh();
    window.addEventListener(TOOL_RUN_FINISHED_EVENT, refresh);
    window.addEventListener(TOOL_RECHECK_EVENT, refresh);
    return () => {
      window.removeEventListener(TOOL_RUN_FINISHED_EVENT, refresh);
      window.removeEventListener(TOOL_RECHECK_EVENT, refresh);
    };
  }, [router]);
  return null;
}
