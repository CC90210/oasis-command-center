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
