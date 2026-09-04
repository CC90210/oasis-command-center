/**
 * The per-page prefetch storm must not come back (2026-09-03).
 *
 * MEASURED IN A REAL LOGGED-IN BROWSER, production, manager on the web-dev
 * tenant, loading /pipeline — a page unrelated to the leads list:
 *
 *   first-contentful-paint     808 ms   (fine)
 *   /api/web-leads           3,908 ms   <- idle prefetch, from EVERY page
 *   /settings?_rsc=          1,389 ms   <- Link prefetch={true}
 *   /api/shell/status        1,339 ms
 *   /?_rsc=                    962 ms   <- Link prefetch={true}
 *   /web-leads?_rsc=           916 ms   <- Link prefetch={true}
 *   /playbook?_rsc=            328 ms   <- Link prefetch={true}
 *
 * Six concurrent background requests beginning right after paint. The page
 * looked fast and then the browser and server were busy for four more seconds,
 * so the operator's NEXT click queued behind work nobody asked for.
 *
 * This cost was INVISIBLE to query-level timing and survived three optimization
 * phases because nobody opened a browser. These pins are cheap; re-measuring
 * from a logged-in session is not. Keep both.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sidebar = readFileSync("components/Sidebar.tsx", "utf8");

// 1. No unconditional idle/timeout prefetch of the leads list.
assert.ok(
  !/requestIdleCallback\s*\(/.test(sidebar),
  "Sidebar must not schedule an idle prefetch — it fired /api/web-leads (989-2,647 ms) on every page an operator opened",
);
assert.ok(
  !/setTimeout\(\s*prefetchWebLeads/.test(sidebar),
  "the setTimeout fallback for the idle prefetch must not come back either",
);

// 2. Nav links must not force full-RSC prefetch of every route in the viewport.
assert.ok(
  !/prefetch=\{true\}/.test(sidebar),
  "nav links must use Next's default prefetch, not prefetch={true} — every item is in the viewport, so `true` pulled a full RSC payload per route on every page load",
);

// 3. The intent-driven path is the one that SURVIVES — this is the win we kept.
assert.ok(
  /onMouseEnter=\{onIntent\}/.test(sidebar) && /onFocus=\{onIntent\}/.test(sidebar),
  "hover/focus prefetch must remain: warming on intent is the cheap version of the same idea",
);
assert.ok(
  /prefetchRememberedWebLeads\(\)/.test(sidebar),
  "the leads-list warm must still exist for operators who signal they are heading there",
);

console.log("perf-prefetch: all assertions passed");
