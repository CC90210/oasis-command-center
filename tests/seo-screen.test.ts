import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

/** Render cases in one child process (plain node, full React). */
export function render(cases: Array<{ view: string; props: unknown }>): string[] {
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/seo.render.ts"], {
    input: JSON.stringify(cases), encoding: "utf8", timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as string[];
}

const header = { display_name: "x", is_test: false, status_detail: null };
const row = (over: Record<string, unknown>) => ({
  id: "oasis", domain: "oasisai.work", ...header, status: "current", settled_through: "2026-10-04",
  current: { start: "2026-09-07", end: "2026-10-04", clicks: 192, impressions: 3993, ctr: 0.048, position: 8.4, complete: true },
  previous: { start: "2026-08-10", end: "2026-09-06", clicks: 160, impressions: 4000, ctr: 0.04, position: 9.1 },
  ...over,
});
const ok = (sites: unknown[]) => ({ state: "ok", data: { generated_at: "2026-10-07T00:00:00Z", sites } });

test("sites list: figures, changes with signs, links and status words", () => {
  // Subtitle text now lives on the page via PageFrame; the toggle and "Add a
  // site" link moved to SitesActions (PageFrame ruling, Adon 2026-10-07), so
  // this renders the body and the actions component separately.
  const props = { loaded: ok([row({})]), includeTest: false };
  const [html, actionsHtml] = render([{ view: "sites", props }, { view: "sites-actions", props }]);
  assert.match(html, /href="\/seo\/oasis"/);
  assert.match(html, />192</);
  assert.match(html, />3,993</);
  assert.match(html, /\+20\.0%/);
  assert.match(html, /Current/);
  assert.match(html, /moved up 0\.7 positions/);
  assert.match(actionsHtml, /href="\/seo\/add"/);
  assert.match(actionsHtml, /Show test sites/);
});

test("sites list: a site with no data prints dashes, never 0", () => {
  const [html] = render([{ view: "sites", props: { loaded: ok([row({ id: "acme-ca", domain: "acme.ca", status: "waiting", settled_through: null, current: null, previous: null })]), includeTest: false } }]);
  assert.doesNotMatch(html, />0</);
  assert.match(html, /—/);
  assert.match(html, /Waiting for client/);
});

test("sites list: a partial 28 days says so and has no comparison", () => {
  const [html] = render([{ view: "sites", props: { loaded: ok([row({ current: { start: "2026-09-07", end: "2026-10-04", clicks: 12, impressions: 300, ctr: 0.04, position: 20, complete: false }, previous: null })]), includeTest: false } }]);
  assert.match(html, /partial/i);
  assert.match(html, /no prior data/);
  assert.doesNotMatch(html, /\+\d/);
});

test("sites list: unavailable shows the banner and no table", () => {
  const [html] = render([{ view: "sites", props: { loaded: { state: "unavailable", reason: "timeout" }, includeTest: false } }]);
  assert.match(html, /SEO data unavailable/);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /<table/);
});

test("sites list: with test sites shown, the toggle hides them and test rows are marked", () => {
  const props = { loaded: ok([row({ id: "fixture-seo-test", is_test: true })]), includeTest: true };
  const [html, actionsHtml] = render([{ view: "sites", props }, { view: "sites-actions", props }]);
  assert.match(actionsHtml, /Hide test sites/);
  assert.match(html, />test</);
});

test("sites list: numeric cells right-aligned with tabular numerals, 36px rows", () => {
  const [html] = render([{ view: "sites", props: { loaded: ok([row({})]), includeTest: false } }]);
  assert.match(html, /<td class="[^"]*text-right[^"]*tabular-nums/);
  assert.match(html, /<th scope="col" class="[^"]*text-right/);
  assert.match(html, /<tr class="[^"]*h-9/);
});

const head = { id: "oasis", domain: "oasisai.work", display_name: "Oasis", is_test: false, status: "current", status_detail: null };
const fresh = { property: "sc-domain:oasisai.work", last_attempt_at: "2026-10-07T16:30:00Z", last_status: "ok", last_error: null, settled_through: "2026-10-04", history_start: "2025-06-07", backfill_done: true, detail_capped: false };
const totals = (clicks: number, impressions: number, position: number) => ({ start: "2026-09-07", end: "2026-10-04", clicks, impressions, ctr: clicks / impressions, position });
const summary = (over: Record<string, unknown> = {}) => ({
  site: head, range: "28d", grain: "day", rollups_pending: false,
  current: { ...totals(192, 3993, 8.4), complete: true }, previous: totals(160, 4000, 9.1), prior_year: null,
  trend: [{ at: "2026-10-03", days: 1, clicks: 7, impressions: 140, ctr: 0.05, position: 8.1 }, { at: "2026-10-04", days: 1, clicks: 9, impressions: 150, ctr: 0.06, position: 7.9 }],
  freshness: fresh, ...over,
});
const top = (over: Record<string, unknown> = {}) => ({
  site: head, range: "28d", period: { start: "2026-09-07", end: "2026-10-04" }, previous_period: { start: "2026-08-10", end: "2026-09-06" },
  approximate: false, rollups_pending: false, note: "Excludes searches Google anonymises.",
  rows: [{ key: "oasis ai montreal", clicks: 40, impressions: 300, ctr: 0.133, position: 2.1, clicks_change: 5 }], ...over,
});
const site = (data: unknown, range = "28d") => ({ view: "site", props: { loaded: { state: "ok", data }, siteId: "oasis", range } });

test("site: four tiles with both comparisons; no prior year says so", () => {
  const [html] = render([site({ summary: summary(), queries: top(), pages: top() })]);
  for (const label of ["Clicks", "Impressions", "CTR", "Avg position"]) assert.match(html, new RegExp(`>${label}<`));
  assert.match(html, />192</);
  assert.match(html, /\+20\.0%/);
  assert.match(html, /no prior year data/);
  assert.doesNotMatch(html, />0%</);
});

test("site: ranges are links with the current one marked", () => {
  const [html] = render([site({ summary: summary({ range: "3m" }), queries: top(), pages: top() }, "3m")]);
  assert.match(html, /href="\/seo\/oasis\?range=16m"/);
  assert.match(html, /aria-current="page"[^>]*>3 months</);
});

test("site: 16 months has no comparisons and says why, never a fake 0%", () => {
  const [html] = render([site({ summary: summary({ range: "16m", grain: "month", previous: null, prior_year: null }), queries: top({ approximate: true }), pages: top({ approximate: true }) }, "16m")]);
  assert.match(html, /no earlier 16 months to compare/);
  assert.match(html, /Approximate/);
});

test("site: rollups pending shows a message, no numbers", () => {
  const [html] = render([site({ summary: summary({ range: "16m", grain: "month", rollups_pending: true, current: null, previous: null, trend: [] }), queries: top({ rollups_pending: true, rows: null }), pages: top({ rollups_pending: true, rows: null }) }, "16m")]);
  assert.match(html, /Monthly totals are being rebuilt/);
  assert.doesNotMatch(html, />192</);
});

test("site: tables carry the caption note, path-only pages and a change column", () => {
  const pages = top({ rows: [{ key: "https://oasisai.work/services/seo", clicks: 12, impressions: 90, ctr: 0.13, position: 3, clicks_change: null }] });
  const [html] = render([site({ summary: summary(), queries: top(), pages })]);
  assert.match(html, /Excludes searches Google anonymises/);
  assert.match(html, />oasis ai montreal</);
  assert.match(html, />\/services\/seo</);
  assert.match(html, /\+5/);
  assert.match(html, /<caption/);
});

test("site: freshness panel, and the capped badge only when capped", () => {
  const [plain, capped] = render([
    site({ summary: summary(), queries: top(), pages: top() }),
    site({ summary: summary({ freshness: { ...fresh, detail_capped: true } }), queries: top(), pages: top() }),
  ]);
  assert.match(plain, /Oct 4, 2026/);
  assert.match(plain, /Jun 7, 2025/);
  assert.doesNotMatch(plain, /Detail capped/);
  assert.match(capped, /Detail capped/);
});

test("site: the trend has a table view; position axis note says lower is better", () => {
  const [html] = render([site({ summary: summary(), queries: top(), pages: top() })]);
  assert.match(html, /Show as table/);
  assert.match(html, />Oct 3, 2026</);
  assert.match(html, /<fieldset/);
});

test("site: unavailable keeps the header, shows the banner and tiles in their error state", () => {
  const [html] = render([{ view: "site", props: { loaded: { state: "unavailable", reason: "timeout" }, siteId: "oasis", range: "28d" } }]);
  assert.match(html, /SEO data unavailable/);
  assert.match(html, /Couldn.t load/);
  assert.doesNotMatch(html, /<table/);
});

test("site: a site with nothing collected yet says so, with dashes", () => {
  const empty = summary({ site: { ...head, status: "waiting" }, grain: null, current: null, previous: null, trend: [], freshness: { ...fresh, property: null, settled_through: null, history_start: null, backfill_done: null, last_attempt_at: null, last_status: null } });
  const [html] = render([site({ summary: empty, queries: top({ period: null, rows: [] }), pages: top({ period: null, rows: [] }) })]);
  assert.match(html, /No data collected yet/);
  assert.doesNotMatch(html, />0</);
});

test("add: labelled domain field, DPA tick, test tick, the address to share, submit", () => {
  const [html] = render([{ view: "add", props: { serviceAccount: "oasis-seo-measure@oasis-ai-508017.iam.gserviceaccount.com" } }]);
  assert.match(html, /<label[^>]*for="[^"]+"[^>]*>Domain<\/label>/);
  assert.match(html, /type="checkbox"[^>]*required/);
  assert.match(html, /data processing agreement/);
  assert.match(html, /Test site/);
  assert.match(html, /oasis-seo-measure@oasis-ai-508017\.iam\.gserviceaccount\.com/);
  assert.match(html, /<button[^>]*type="submit"[^>]*>Add site<\/button>/);
  assert.match(html, /aria-live="polite"/);
});
