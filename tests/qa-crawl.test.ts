/**
 * tests/qa-crawl.test.ts - the pure rules of the signed-in QA crawl
 * (scripts/qa/crawl-lib.mjs), run in bare node.
 *
 * The crawl itself needs a production build and a browser, so it runs on
 * GitHub (.github/workflows/qa-crawl.yml), not here. What CI can hold cheaply
 * is what decides the findings:
 *   - the route list is DERIVED from lib/os/nav.ts and app/ (every nav row,
 *     every page, public pages skipped by middleware's own rule, dynamic
 *     segments filled from seeded ids, never a literal "[id]");
 *   - the clipped-text detector, over element metrics the browser measures;
 *   - overlapping bars, horizontal scroll, persona names, and the ranking;
 *   - the committed schema fixture is CREATE statements only;
 *   - every harness file parses.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isPublic } from "../middleware";
import { OS_NAV_CATALOG } from "../lib/os/nav";
import {
  DEFECT_TYPES,
  deadTabDefects,
  deriveRoutes,
  expandPattern,
  findClippedText,
  findOverlappingBars,
  groupDefects,
  horizontalScroll,
  listPageFiles,
  personaNamesIn,
  rankDefects,
  renderMarkdown,
  routePatternFromPageFile,
  severityOf,
  visitDefects,
} from "../scripts/qa/crawl-lib.mjs";
import { fixtureProblems } from "../scripts/qa/export-schema.mjs";

const root = path.resolve(__dirname, "..");
let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${String((err as Error).stack || err).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

// -- Route derivation ------------------------------------------------------
check("a page file maps to its URL: groups dropped, slots and intercepts skipped", () => {
  assert.equal(routePatternFromPageFile("app/page.tsx"), "/");
  assert.equal(routePatternFromPageFile("app/(marketing)/about/page.tsx"), "/about");
  assert.equal(routePatternFromPageFile("app/founders/finances/(overview)/page.tsx"), "/founders/finances");
  assert.equal(routePatternFromPageFile("app/t/[slug]/[...path]/page.tsx"), "/t/[slug]/[...path]");
  assert.equal(routePatternFromPageFile("app/feed/@modal/page.tsx"), null);
  assert.equal(routePatternFromPageFile("app/feed/(.)photo/page.tsx"), null);
  assert.equal(routePatternFromPageFile("app/_private/page.tsx"), null);
  assert.equal(routePatternFromPageFile("app/feed/layout.tsx"), null);
});

check("dynamic segments are filled from values, and a missing value yields no route", () => {
  assert.deepEqual(expandPattern("/pipeline/[id]", [{ id: "lead 1" }, { other: "x" }]), ["/pipeline/lead%201"]);
  assert.deepEqual(expandPattern("/t/[slug]/[...path]", [{ slug: "acme", path: ["leads", "board"] }]), ["/t/acme/leads/board"]);
  assert.deepEqual(expandPattern("/docs/[[...path]]", [{}]), ["/docs"]);
  assert.deepEqual(expandPattern("/pipeline/[id]", []), []);
});

const pageFiles = listPageFiles(root);
const navHrefs = OS_NAV_CATALOG.map((e) => e.href);
const derived = deriveRoutes({
  navHrefs,
  pageFiles,
  paramValues: { "/pipeline/[id]": [{ id: "seed-lead-1" }], "/team/[dept]": [{ dept: "sales" }] },
  isPublic,
});
const paths = new Set(derived.routes.map((r) => r.path));

check("the real route list holds every OS nav row and every private page", () => {
  assert.ok(pageFiles.length >= 100, `only ${pageFiles.length} page files found under app/`);
  for (const href of navHrefs) assert.ok(paths.has(href), `nav row ${href} is not crawled`);
  for (const p of ["/", "/settings", "/founders/finances", "/admin/installs", "/settings/connections"]) assert.ok(paths.has(p), `${p} is not crawled`);
  assert.ok(paths.has("/pipeline/seed-lead-1"), "a seeded id fills /pipeline/[id]");
});

check("public pages are skipped by middleware's own rule, and nothing literal leaks into a URL", () => {
  for (const p of ["/about", "/login", "/signup", "/privacy", "/home"]) {
    assert.ok(!paths.has(p), `public page ${p} is crawled`);
    assert.ok(derived.skippedPublic.includes(p), `${p} is not reported as skipped`);
  }
  assert.ok(derived.skippedPublic.includes("/f/[tenant_slug]/[form_slug]"), "a dynamic page under a public prefix is skipped");
  for (const p of paths) {
    assert.ok(!/[[\]()]/.test(p), `a route kept a bracket or group: ${p}`);
  }
});

check("a dynamic page with no seeded value is reported, never guessed", () => {
  assert.ok(derived.unexpanded.includes("/tickets/[id]"), "an unseeded /tickets/[id] is listed as unexpanded");
  assert.ok(![...paths].some((p) => p.startsWith("/tickets/")), "no ticket route is invented");
});

// -- Clipped text ----------------------------------------------------------
const box = { selector: "td.name", text: "Acme Plumbing and Heating of Greater Montreal", scrollWidth: 340, clientWidth: 200, scrollHeight: 20, clientHeight: 20, overflowX: "hidden", overflowY: "hidden" };

check("text wider than a box that hides overflow is clipped; the kind says how", () => {
  const [cut] = findClippedText([box]);
  assert.equal(cut.kind, "cut");
  assert.equal(cut.axis, "x");
  assert.equal(cut.overflowPx, 140);
  assert.equal(findClippedText([{ ...box, textOverflow: "ellipsis" }])[0].kind, "ellipsis");
  assert.equal(findClippedText([{ ...box, overflowX: "clip", overflowY: "clip" }]).length, 1, "overflow: clip clips too");
  const clamp = findClippedText([{ ...box, scrollWidth: 200, scrollHeight: 80, clientHeight: 40, lineClamp: "2" }]);
  assert.equal(clamp[0].kind, "clamp");
  assert.equal(clamp[0].axis, "y");
});

check("a box that scrolls, shows its overflow, has no text, or overflows by a rounding pixel is not clipped", () => {
  assert.deepEqual(findClippedText([{ ...box, overflowX: "auto", overflowY: "auto" }]), [], "a scroll box is not clipped");
  assert.deepEqual(findClippedText([{ ...box, overflowX: "visible", overflowY: "visible" }]), [], "visible overflow is not clipped");
  assert.deepEqual(findClippedText([{ ...box, text: "   " }]), [], "no text, nothing clipped");
  assert.deepEqual(findClippedText([{ ...box, scrollWidth: 201 }]), [], "one pixel is rounding");
});

check("a box that overflows only because of a non-text child is not clipped text", () => {
  assert.deepEqual(findClippedText([{ ...box, textOverflowX: 0 }]), [], "the text itself fits");
  assert.equal(findClippedText([{ ...box, textOverflowX: 140 }]).length, 1, "the text runs 140px past the edge");
  assert.equal(findClippedText([{ ...box, textOverflow: "ellipsis", textOverflowX: 0 }]).length, 1, "an ellipsis is truncation whatever the text rects say");
});

// -- Overlapping bars, horizontal scroll, persona names --------------------
const vp = { viewportWidth: 390, viewportHeight: 844 };
check("two fixed bars that overlap are reported; nested, tiny or full-screen layers are not", () => {
  const top = { id: 1, selector: "div.fixed.top-0", x: 0, y: 0, width: 390, height: 56 };
  const sticky = { id: 2, selector: "header.sticky", x: 0, y: 30, width: 390, height: 44 };
  const [pair] = findOverlappingBars([top, sticky], vp);
  assert.deepEqual(pair.overlap, { width: 390, height: 26, area: 10140 });
  assert.deepEqual(findOverlappingBars([top, { ...sticky, ancestorIds: [1] }], vp), [], "a child of the bar is not an overlap");
  assert.deepEqual(findOverlappingBars([top, { ...sticky, y: 56 }], vp), [], "touching is not overlapping");
  assert.deepEqual(findOverlappingBars([{ id: 3, selector: "a", x: 0, y: 0, width: 30, height: 30 }, { id: 4, selector: "b", x: 10, y: 10, width: 30, height: 30 }], vp), [], "two small floating buttons are not bars");
  assert.deepEqual(findOverlappingBars([top, { id: 5, selector: "div.backdrop", x: 0, y: 0, width: 390, height: 844 }], vp), [], "a full-screen backdrop is not a bar");
});

check("a page wider than the screen scrolls sideways unless html or body clips it", () => {
  const sample = { scrollWidth: 460, clientWidth: 390, htmlOverflowX: "visible", bodyOverflowX: "visible", offenders: [{ selector: "table", right: 460, text: "" }] };
  assert.equal(horizontalScroll(sample)?.overflowPx, 70);
  assert.equal(horizontalScroll({ ...sample, bodyOverflowX: "hidden" }), null);
  assert.equal(horizontalScroll({ ...sample, scrollWidth: 391 }), null);
});

check("persona names match whole capitalised words only", () => {
  assert.deepEqual(personaNamesIn("Bravo drafted this; ask Atlas, or Conaugh."), ["Bravo", "Atlas", "Conaugh"]);
  assert.deepEqual(personaNamesIn("bravo team, Auralia Spa, Atlassian, Lexicon"), []);
});

// -- Defects and ranking ---------------------------------------------------
const visit = {
  route: "/pipeline",
  viewer: "client_owner",
  viewport: "390x844",
  status: 200,
  finalPath: "/pipeline",
  mainReadyMs: 4200,
  consoleErrors: ["TypeError: x is undefined"],
  failedRequests: [{ url: "http://127.0.0.1:3100/api/shell/status", method: "GET", status: 500, resourceType: "fetch" }],
  personaHits: [{ name: "Bravo", selector: "aside span", snippet: "Bravo is online", region: "rail" }],
  clipCandidates: [box],
  bars: [],
  viewportSize: { width: 390, height: 844 },
  hscroll: { scrollWidth: 460, clientWidth: 390, htmlOverflowX: "visible", bodyOverflowX: "visible", offenders: [] },
};

check("a visit yields one defect per finding, and persona names only for the viewers checked", () => {
  const found = visitDefects(visit, { slowMs: 3000, checkPersona: true });
  const types = found.map((d) => d.type).sort();
  assert.deepEqual(types, ["clipped_text", "console_error", "failed_request", "horizontal_scroll", "persona_leak", "slow"]);
  const founder = visitDefects(visit, { slowMs: 3000, checkPersona: false });
  assert.ok(!founder.some((d) => d.type === "persona_leak"), "a founder may see the agents' names");
  assert.ok(visitDefects({ ...visit, mainReadyMs: null }, {}).some((d) => d.type === "slow" && /never/.test(d.text)), "content that never appeared is slow");
  const broken = visitDefects({ ...visit, status: 500, errorBoundary: { selector: "div.rounded-2xl", text: "Something went wrong" } }, {});
  assert.equal(broken.filter((d) => d.type === "error_page").length, 2, "a 500 and the boundary it rendered");
});

check("defects rank: error page, failed request, persona leak, console error, clipped text, bars, sideways scroll, slow", () => {
  assert.deepEqual([...DEFECT_TYPES], ["error_page", "failed_request", "persona_leak", "console_error", "clipped_text", "overlapping_bars", "horizontal_scroll", "slow"]);
  const shuffled = ["slow", "horizontal_scroll", "clipped_text", "persona_leak", "failed_request", "error_page"].map((type) => ({ type, severity: severityOf(type), route: "/x", viewer: "v", viewport: "1440x900", selector: "" }));
  assert.deepEqual(rankDefects(shuffled).map((d) => d.type), ["error_page", "failed_request", "persona_leak", "clipped_text", "horizontal_scroll", "slow"]);
});

check("a 404 behind the viewer's own rail is a dead tab; a gated 404 is not", () => {
  const visits = [
    { route: "/money", viewer: "sales_rep", viewport: "1440x900", status: 404, finalPath: "/money" },
    { route: "/forms", viewer: "sales_rep", viewport: "1440x900", status: 404, finalPath: "/forms" },
  ];
  const dead = deadTabDefects(visits, { sales_rep: new Set(["/forms"]) });
  assert.deepEqual(dead.map((d) => d.route), ["/forms"]);
  assert.equal(dead[0].type, "error_page");
});

check("the same element on several pages groups into one cause, named by its shell region", () => {
  const defects = ["/a", "/b", "/c"].map((route) => ({ type: "clipped_text", severity: severityOf("clipped_text"), route, viewer: "client_owner", viewport: "1440x900", selector: "aside > div.truncate:nth-of-type(2)", text: "Acme", detail: "", region: "rail" }));
  const [g] = groupDefects(defects);
  assert.equal(g.count, 3);
  assert.deepEqual(g.routes, ["/a", "/b", "/c"]);
  assert.match(String(g.component), /Sidebar/);
  const md = renderMarkdown({ meta: { viewers: [{ key: "client_owner", label: "Client owner" }], viewports: ["1440x900"] }, defects: [{ ...defects[0], text: "Acme | Plumbing" }] });
  assert.match(md, /## Defects by type and viewer/);
  assert.ok(md.includes("Acme \\| Plumbing") && !md.includes("Acme | Plumbing"), "a pipe inside a table cell is escaped");
});

// -- The committed fixture and the harness files ---------------------------
check("the schema fixture is CREATE statements only, with no credential in it", () => {
  const fixture = JSON.parse(readFileSync(path.join(root, "scripts/qa/fixtures/production-schema.json"), "utf8")) as { objects: Array<{ type: string; name: string; sql: string }> };
  assert.ok(fixture.objects.length > 100, "the fixture lost its tables");
  assert.deepEqual(fixtureProblems(fixture.objects), []);
  assert.ok(fixture.objects.some((o) => o.name === "user_profiles" && o.type === "table"), "user_profiles is in the schema");
  assert.deepEqual(fixtureProblems([{ type: "table", name: "x", sql: "INSERT INTO x VALUES (1)" }]).length, 1, "a row would be refused");
  assert.deepEqual(fixtureProblems([{ type: "table", name: "x", sql: "CREATE TABLE x (u TEXT DEFAULT 'libsql://db.turso.io')" }]).length, 2, "an address would be refused");
});

check("every harness file parses", () => {
  for (const f of ["crawl.mjs", "crawl-lib.mjs", "build-db.mjs", "seed.mjs", "export-schema.mjs", "egress-guard.cjs"]) {
    const res = spawnSync(process.execPath, ["--check", path.join(root, "scripts/qa", f)], { encoding: "utf8" });
    assert.equal(res.status, 0, `${f}: ${res.stderr}`);
  }
});

console.log(`qa-crawl: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
