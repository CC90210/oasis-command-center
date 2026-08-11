/**
 * tests/health-panel.test.ts — how a health verdict is allowed to render.
 *
 * The outcome checks have written to health_check_runs every 15 minutes since
 * 2026-08-07 and nothing ever read the table, so the checks built to catch
 * silent failure were failing silently themselves. These assertions pin the two
 * rules that make the new panel worth having.
 */

import assert from "node:assert/strict";
import {
  verdictTone,
  freshness,
  toPanelRows,
  failingForHours,
  ladderLabel,
} from "../lib/health/panel-core";

// ── check_broken is NOT ok ────────────────────────────────────────────────
// A check that could not run must never render green. Treating an errored
// check as healthy is how a monitor reports fine while the thing it watches is
// dead — named by the 2026-06-30 audit, then demonstrated by a ten-day SMS
// outage during which every surface was green.
assert.equal(verdictTone("check_broken"), "bad");
assert.equal(verdictTone("failing"), "bad");
assert.equal(verdictTone("degraded"), "warn");
assert.equal(verdictTone("ok"), "good");
// An unrecognised verdict must not default into green.
assert.equal(verdictTone("something_new"), "unknown");
assert.equal(verdictTone(""), "unknown");

// ── Silence is not health ─────────────────────────────────────────────────
// The checks tick every 15 minutes, so an hour of quiet means the scheduler is
// down. That is not hypothetical: Vercel's cron stopped firing 2026-08-06 and
// nothing noticed for four days.
assert.equal(freshness({ ranAt: null, nowMs: 1_000 }), "never_run");
assert.equal(freshness({ ranAt: 0, nowMs: 2 * 60 * 60 * 1000 }), "stale");
assert.equal(freshness({ ranAt: 0, nowMs: 5 * 60 * 1000 }), "fresh");
assert.equal(freshness({ ranAt: Number.NaN, nowMs: 0 }), "never_run");

// ── A stale GREEN check still needs attention ─────────────────────────────
// A green verdict from two days ago describes a world that no longer exists.
{
  const now = Date.parse("2026-08-11T12:00:00Z");
  const rows = toPanelRows(
    [
      { checkId: "a.ok_fresh", verdict: "ok", observed: 5, baseline: 5, reason: "fine", ranAt: "2026-08-11T11:55:00Z" },
      { checkId: "b.ok_stale", verdict: "ok", observed: 5, baseline: 5, reason: "fine", ranAt: "2026-08-09T12:00:00Z" },
      { checkId: "c.never", verdict: "ok", observed: null, baseline: null, reason: null, ranAt: null },
      { checkId: "d.failing", verdict: "failing", observed: 0, baseline: 5, reason: "0 vs a normal 5", ranAt: "2026-08-11T11:55:00Z" },
    ],
    now,
  );
  const byId = Object.fromEntries(rows.map((r) => [r.checkId, r]));
  assert.equal(byId["a.ok_fresh"].needsAttention, false);
  assert.equal(byId["b.ok_stale"].needsAttention, true, "a stale green is not a green");
  assert.equal(byId["c.never"].needsAttention, true, "a check that never ran is a problem, not a blank");
  assert.equal(byId["d.failing"].needsAttention, true);

  // Problems sort to the top so a scanning operator sees them first.
  assert.equal(rows[0].checkId, "d.failing");
  assert.equal(rows[rows.length - 1].checkId, "a.ok_fresh");
}

// ── The alert ladder ──────────────────────────────────────────────────────
{
  const now = Date.parse("2026-08-11T12:00:00Z");
  assert.equal(failingForHours({ alertKey: "k", firstFailedAt: "2026-08-11T09:00:00Z", lastAlertedAt: null, repeatN: 3 }, now), 3);
  // Unknown must be null, never 0 — "we don't know" and "just started" are
  // different answers and an operator acts differently on each.
  assert.equal(failingForHours({ alertKey: "k", firstFailedAt: null, lastAlertedAt: null, repeatN: 0 }, now), null);

  const at = (iso: string) => ladderLabel({ alertKey: "k", firstFailedAt: iso, lastAlertedAt: null, repeatN: 0 }, now);
  assert.equal(at("2026-08-11T11:00:00Z"), "hourly");
  assert.equal(at("2026-08-11T02:00:00Z"), "every 6h");
  assert.equal(at("2026-08-09T12:00:00Z"), "daily");
}

console.log("health-panel.test.ts — all assertions passed");
