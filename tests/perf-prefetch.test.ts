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

// 2. Nav links must not prefetch from the viewport AT ALL.
//
// ROUND 2 (2026-09-04). Round 1 dropped the forced prefetch and relied on
// Next's default. Re-measured on production: that was NOT meaningfully
// cheaper (/schedule 805 ms, /web-leads 790 ms, /settings 762 ms, /playbook
// 748 ms) because routes without a loading boundary still render server-side
// to satisfy a partial prefetch. Only prefetch={false} + hover/focus warming
// removes the work. Asserting the explicit value, not merely the absence of
// `true`, so "someone deleted the prop" cannot silently re-enable it.
assert.ok(
  /prefetch=\{false\}/.test(sidebar),
  "nav links must set prefetch={false} — viewport prefetch fires once per link on every page load, and every nav item is in the viewport",
);

// 3. Intent warming must actually warm the ROUTE, not just the data. Without
// router.prefetch here, turning viewport prefetch off would make clicks
// slower rather than the page quieter.
assert.ok(
  /router\.prefetch\(/.test(sidebar),
  "hover/focus must call router.prefetch — it is what pays for turning viewport prefetch off",
);

// 4. The intent-driven path is the one that SURVIVES — this is the win we kept.
assert.ok(
  /onMouseEnter=\{warm\}/.test(sidebar) && /onFocus=\{warm\}/.test(sidebar),
  "hover/focus prefetch must remain: warming on intent is the cheap version of the same idea",
);

// 5. The status dots must be cached, not refetched on every full page load.
// Measured 1,540-2,475 ms on production for two decorative booleans.
assert.ok(
  /sessionStorage/.test(sidebar) && /shell-status/.test(sidebar),
  "shell status must be session-cached — it cost 1.5-2.5 s per page load to render two dots",
);
assert.ok(
  /prefetchRememberedWebLeads\(\)/.test(sidebar),
  "the leads-list warm must still exist for operators who signal they are heading there",
);

console.log("perf-prefetch: all assertions passed");
