/**
 * P2 instant-load pins (2026-09-01) — the data-weight fixes stay fixed.
 *
 * 1. /metrics must never re-grow the unbounded full-blob lead read
 *    (measured 44MB / 3.8-4.9s per visit before the projection).
 * 2. The parked-domain read keeps its two-tier shape: stored-verdict rows
 *    (is_parked = 1, indexed) + the legacy LIKE net over ONLY unstamped
 *    rows — and confirmParked stays the verdict on the union, with
 *    completeness proofs on BOTH tiers. Losing any of those quietly
 *    reopens the parked-at-82 incident.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function src(path: string): string {
  return readFileSync(path, "utf8");
}

const metrics = src("lib/metrics/index.ts");
assert.ok(
  metrics.includes('select("data->stage,data->status")'),
  "metrics lead read stays projected to stage/status",
);
assert.ok(
  !metrics.includes('.select("data")'),
  "metrics must never re-grow a full-blob select on tenant_records (44MB/visit)",
);

// The projection is only safe while the funnel reads NOTHING but stage/status.
// A future edit that reaches for another lead field (industry, city, owner…)
// would read undefined off the projected row and silently miscount, which is
// exactly the quiet-wrong failure this codebase keeps getting bitten by. The
// reducer is pinned to those two fields.
{
  const start = metrics.indexOf("for (const r of (leadsRes.data");
  assert.ok(start > -1, "the funnel reducer must still exist");
  const body = metrics.slice(start, metrics.indexOf("const funnelStages", start));
  const fieldReads = [...body.matchAll(/\br\.([a-zA-Z_][\w]*)/g)].map((m) => m[1]);
  const allowed = new Set(["stage", "status"]);
  for (const f of fieldReads) {
    assert.ok(
      allowed.has(f),
      `the funnel reducer reads r.${f}, which the stage/status projection does not fetch — ` +
        "widen the projection in the same edit or the count silently goes wrong",
    );
  }
  assert.ok(fieldReads.includes("stage") && fieldReads.includes("status"), "both projected fields are still read");
}

// The parked-domain score index (lib/web-leads/scores.ts) retired with the
// Prospects surface on 2026-10-28, and its assertions with it.

console.log("perf-p2: all assertions passed");
