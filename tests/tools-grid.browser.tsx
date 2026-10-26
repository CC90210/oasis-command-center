/**
 * tests/tools-grid.browser.tsx - the browser fixture scripts/test-content-tools-browser.mjs
 * bundles: the real ToolGrid, ContentTabs and RefreshOnToolRun with the real
 * Video extractor definition, mounted the way the Content Tools page mounts
 * them. No session, no credentials, no provider calls: tests/tools-grid.browser.py
 * answers every API request itself.
 *
 * ?offline draws the card in its runner_offline state. The page's router.refresh()
 * is a window event here (see the bundler's stub); its count is window.__refreshes.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { ContentTabs } from "../components/founders/ContentTabs";
import { RefreshOnToolRun } from "../components/tools/RefreshOnToolRun";
import { ToolGrid } from "../components/tools/ToolGrid";
import { TOOL_REGISTRY } from "../lib/tools/registry";
import type { CatalogTool } from "../lib/tools/types";

declare global {
  interface Window {
    __refreshes: number;
  }
}

window.__refreshes = 0;
window.addEventListener("fixture:refresh", () => {
  window.__refreshes += 1;
});

const definition = TOOL_REGISTRY.find((tool) => tool.key === "video_download")!;
const offline = new URLSearchParams(location.search).has("offline");
const tool: CatalogTool = {
  key: definition.key,
  title: definition.title,
  description: definition.description,
  runLabel: definition.runLabel,
  runsOn: definition.runsOn,
  fields: definition.fields,
  state: offline ? "runner_offline" : "ready",
  ...(offline ? {} : { runner: { label: "CC's PC", lastSeenAt: new Date().toISOString() } }),
};

createRoot(document.getElementById("root")!).render(
  <main style={{ maxWidth: 1000, margin: "auto", padding: 16 }}>
    <ContentTabs />
    <ToolGrid
      catalog={{ installed: true, tools: [tool] }}
      assetHrefPrefix="/founders/marketing/extracted?video="
      assetDownloadPrefix="/api/founders/marketing/assets/"
      extractedVideosHref="/founders/marketing/extracted"
      showCodes
    />
    <RefreshOnToolRun />
  </main>,
);
