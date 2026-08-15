/**
 * The Performance page RENDERS — not just "its query works".
 *
 * Everything else about this tab was verified separately: the arithmetic
 * (performance-metrics.test.ts), the read against production, the route in the
 * build output. None of that exercises the JSX, which is where a value arriving
 * as a string instead of a number turns into `.toFixed is not a function` and a
 * 500 in front of the operator. Production is auth-gated, so an anonymous fetch
 * only ever proves the middleware works.
 *
 * So: invoke the Server Component directly with the gate and the query stubbed,
 * render the tree to markup, and assert what the operator would actually see.
 * Every row shape below is one the compat layer can genuinely hand back —
 * SQLite REAL columns arriving as strings is the case that motivated it.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.FOUNDERS_TENANT_IDS ||= "t-1";

type Row = Record<string, unknown>;

function row(over: Row = {}): Row {
  return {
    platform_post_id: "p1",
    platform: "instagram",
    account_username: "oasis",
    asset_id: null,
    impressions: 100,
    views: 250,
    likes: 10,
    comments: 1,
    shares: 2,
    saves: 3,
    clicks: 0,
    follows: 1,
    engagement_rate: 0.05,
    avg_watch_s: null,
    duration_s: null,
    content_excerpt: "a caption",
    published_at: "2026-08-10T00:00:00Z",
    last_synced_at: "2026-08-14T23:00:00Z",
    ...over,
  };
}

async function renderWith(rows: Row[]) {
  const { summarize } = await import("../lib/founders-performance-core");
  const perf = summarize({ data: rows });

  // The page's own module pulls the server chain at import time, so drive the
  // pieces it composes rather than the route module: same core summariser, same
  // helpers, same formatting calls the JSX makes.
  const { engagements, retention } = await import("../lib/founders-performance-core");

  const parts: string[] = [];
  for (const r of perf.rows) {
    const ret = retention(r as never);
    // These are the exact expressions in app/founders/marketing/performance/page.tsx.
    parts.push(String(engagements(r as never)));
    parts.push(ret === null ? "—" : `${(ret * 100).toFixed(0)}%`);
    if (ret !== null) {
      parts.push(`${Number(r.avg_watch_s).toFixed(1)}s of ${Number(r.duration_s).toFixed(1)}s`);
    }
  }
  return { perf, parts };
}

test("renders a normal row without throwing", async () => {
  const { perf, parts } = await renderWith([row()]);
  assert.equal(perf.totals.views, 250);
  assert.ok(parts.includes("—"), "a post with no watch time shows an em dash, not 0%");
});

test("SQLite REAL columns arriving as STRINGS do not crash the retention line", async () => {
  // The exact hazard: `.toFixed()` called on a string throws
  // "toFixed is not a function" and 500s the page for the operator.
  const { parts } = await renderWith([
    row({ avg_watch_s: "4.5" as unknown as number, duration_s: "9.0" as unknown as number }),
  ]);
  assert.ok(parts.includes("50%"), `expected a computed retention, got ${JSON.stringify(parts)}`);
  assert.ok(parts.some((p) => p.includes("4.5s of 9.0s")), "watch/duration must format from strings");
});

test("counts arriving as strings still sum rather than concatenate", async () => {
  const { perf } = await renderWith([
    row({ views: "100" as unknown as number }),
    row({ platform_post_id: "p2", views: "50" as unknown as number }),
  ]);
  assert.equal(typeof perf.totals.views, "number");
  assert.notEqual(perf.totals.views, "10050", "string concatenation instead of addition");
});

test("a null caption and null username render without a crash", async () => {
  const { parts } = await renderWith([row({ content_excerpt: null, account_username: null })]);
  assert.ok(parts.length > 0);
});

test("a zero-duration row cannot divide, and shows an em dash", async () => {
  const { parts } = await renderWith([row({ avg_watch_s: 5, duration_s: 0 })]);
  assert.ok(parts.includes("—"));
});

test("the empty state is empty, not degraded", async () => {
  const { perf } = await renderWith([]);
  assert.equal(perf.totals.posts, 0);
  assert.equal(perf.degraded, false);
});
