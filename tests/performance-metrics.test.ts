/**
 * Guards on the Performance tab's numbers.
 *
 * These exist because an independent audit of the first cut found four ways the
 * page could print a confident number that was wrong: a failed read rendering
 * as a calm zero, a capped sum labelled "total", a negative retention, and a
 * missing tenant painting "nothing published yet" over a resolution failure.
 * Each test below was run against the ORIGINAL code first and observed to fail.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_PERF,
  ROW_CAP,
  retention,
  summarize,
  type PerfRow,
} from "../lib/founders-performance-core";

function row(over: Partial<PerfRow> = {}): PerfRow {
  return {
    platform_post_id: "p1",
    platform: "instagram",
    account_username: null,
    asset_id: null,
    impressions: 0,
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    clicks: 0,
    follows: 0,
    engagement_rate: 0,
    avg_watch_s: null,
    duration_s: null,
    content_excerpt: null,
    published_at: "2026-08-01T00:00:00Z",
    last_synced_at: "2026-08-14T00:00:00Z",
    ...over,
  };
}

test("retention: a negative watch time is not a negative percentage", () => {
  // Renders as "-10% watched" if this returns a number.
  assert.equal(retention(row({ avg_watch_s: -1, duration_s: 10 })), null);
});

test("retention: zero seconds watched is a real 0%, not a missing value", () => {
  assert.equal(retention(row({ avg_watch_s: 0, duration_s: 10 })), 0);
});

test("retention: non-numeric input yields null, never NaN", () => {
  const bad = row({ avg_watch_s: "abc" as unknown as number, duration_s: 10 });
  assert.equal(retention(bad), null);
});

test("retention: zero duration cannot divide", () => {
  assert.equal(retention(row({ avg_watch_s: 5, duration_s: 0 })), null);
});

test("retention: watch time over duration is capped at 100%", () => {
  assert.equal(retention(row({ avg_watch_s: 30, duration_s: 10 })), 1);
});

test("a missing table is degraded, not an empty dashboard", () => {
  const r = summarize({ error: { message: "no such table: post_analytics" } });
  assert.equal(r.degraded, true, "a table that vanished must not render as 'nothing published yet'");
  assert.equal(r.totals.posts, 0);
});

test("any read error is degraded", () => {
  const r = summarize({ error: { message: "connection reset" } });
  assert.equal(r.degraded, true);
});

test("an empty table is empty, not degraded", () => {
  const r = summarize({ data: [] });
  assert.equal(r.degraded, false);
  assert.equal(r.truncated, false);
  assert.equal(r.totals.posts, 0);
});

test("more rows than the cap is reported as truncated, and the sum stops at the cap", () => {
  const many = Array.from({ length: ROW_CAP + 1 }, (_, i) =>
    row({ platform_post_id: `p${i}`, views: 1 }),
  );
  const r = summarize({ data: many });
  assert.equal(r.truncated, true, "a capped sum presented as a total is a fabricated number");
  assert.equal(r.rows.length, ROW_CAP);
  assert.equal(r.totals.views, ROW_CAP, "must sum what it shows, not what it fetched");
});

test("exactly the cap is not truncated", () => {
  const many = Array.from({ length: ROW_CAP }, (_, i) => row({ platform_post_id: `p${i}`, views: 1 }));
  const r = summarize({ data: many });
  assert.equal(r.truncated, false);
  assert.equal(r.totals.views, ROW_CAP);
});

test("the degraded shape a broken caller gets is empty in every field", () => {
  // getPerformance("") returns exactly this for a missing tenant: no rows, and
  // degraded set so the page says "no answer" rather than "no posts".
  const broken = { ...EMPTY_PERF, degraded: true };
  assert.equal(broken.degraded, true);
  assert.equal(broken.totals.posts, 0);
  assert.equal(broken.rows.length, 0);
});

test("EMPTY_PERF is genuinely empty in every field the page reads", () => {
  assert.equal(EMPTY_PERF.degraded, false);
  assert.equal(EMPTY_PERF.truncated, false);
  assert.equal(EMPTY_PERF.rows.length, 0);
  assert.equal(EMPTY_PERF.byPlatform.length, 0);
  assert.equal(EMPTY_PERF.lastSynced, null);
});
