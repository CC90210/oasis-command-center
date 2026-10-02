/**
 * tests/clients-tabs.test.ts — the Clients tabs answer a click (CLI-1, CLI-2).
 *
 * WHY. CC, 2026-10-02: "when I go into clients and try to click from all to
 * prospect, or onboarding, active, paused, or past, they're not clickable" and
 * "I'm still unable to click the actual subbed things inside the clients
 * portal". Both tab bars were server links that change only the query string:
 * Next keeps the old page up during the server render and shows no loading
 * boundary for a query-only change, so nothing moved until the render landed.
 *
 * Pins:
 *   1. OsTabBar (components/os/OsTabBar.tsx): today's look; the clicked tab is
 *      drawn current at once and until the page catches up; a tab that
 *      navigates warms its route on hover and focus and shows its pending
 *      state through useLinkStatus; prefetch is off; a tab that selects
 *      cancels the navigation. No new colour or animation.
 *   2. The status view (components/os/landings/clients-status.tsx): which rows
 *      each status shows; a click writes the address bar with
 *      history.replaceState and never goes to the server; a list cut at its
 *      page size navigates instead and shows the server's rows.
 *   3. Every tab bar under app/clients is OsTabBar, and both pages have a
 *      loading boundary (the list's KPI row and sections are pinned in
 *      tests/clients-hub.test.ts, against a real database).
 *   4. What the components draw and do with a click or a hover, rendered where
 *      React is whole (tests/clients-tabs.render.ts).
 *
 * Run: node --conditions=react-server --import tsx tests/clients-tabs.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

// next/link and next/navigation pull the client router context, which does not
// exist under the react-server condition (the same stand-ins as
// tests/content-hub.test.ts). This half only imports the pure helpers; the
// components are rendered in tests/clients-tabs.render.ts.
function stubModule(id: string, exports: Record<string, unknown>) {
  const path = require.resolve(id);
  require.cache[path] = { id: path, filename: path, path: dirname(path), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stubModule("next/navigation", { useRouter: () => null, useSearchParams: () => new URLSearchParams() });
stubModule("next/link", { __esModule: true, default: () => null, useLinkStatus: () => ({ pending: false }) });

const root = join(__dirname, "..");
const code = (rel: string) => readFileSync(join(root, rel), "utf8");
/** Code only: comments may say what the tabs used to be. */
const stripped = (rel: string) => code(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

async function main() {
  console.log("clients-tabs:");
  const bar = await import("../components/os/OsTabBar");
  const status = await import("../components/os/landings/clients-status");

  // ── 1. OsTabBar ────────────────────────────────────────────────────────────
  await check("OsTabBar: the clicked tab is drawn current at once, until the page it opens names a tab", () => {
    assert.equal(bar.shownTab("overview", null), "overview", "nothing clicked: the page's tab");
    assert.equal(bar.shownTab("overview", { key: "money", from: "overview" }), "money", "clicked: Money, before the server answers");
    assert.equal(bar.shownTab("money", { key: "money", from: "overview" }), "money", "landed");
    assert.equal(bar.shownTab("tickets", { key: "money", from: "overview" }), "tickets", "the page moved on: the page's tab wins");
  });
  await check("OsTabBar: today's tab look, unchanged (-mb-px border-b-2, a foreground underline on the current tab)", () => {
    assert.equal(bar.osTabClass(true), "-mb-px border-b-2 px-3 py-2 text-[13px] border-fg font-medium text-fg");
    assert.equal(bar.osTabClass(false), "-mb-px border-b-2 px-3 py-2 text-[13px] border-transparent text-fg-muted hover:text-fg");
  });
  await check("OsTabBar: prefetch off, warm on hover and focus with the rail's hook, pending from useLinkStatus, a select cancels the navigation", () => {
    const src = code("components/os/OsTabBar.tsx");
    const body = stripped("components/os/OsTabBar.tsx");
    assert.match(src, /^"use client";/, "a client component");
    const links = (body.match(/<Link\s/g) || []).length;
    assert.equal(links, 1, "one Link per tab");
    assert.equal((body.match(/prefetch=\{false\}/g) || []).length, links, "every Link keeps prefetch off (tests/os-nav.test.ts)");
    assert.doesNotMatch(body, /prefetch=\{true\}|router\.push|router\.replace/);
    assert.match(body, /import \{ useWarmOnIntent \} from "@\/components\/os\/RailRow";/, "the rail's own warm-on-intent hook, not a second one");
    assert.match(body, /onMouseEnter=\{navigates \? warm : undefined\}/);
    assert.match(body, /onFocus=\{navigates \? warm : undefined\}/);
    assert.match(body, /import Link, \{ useLinkStatus \} from "next\/link";/);
    assert.match(body, /function OsTabLabel[\s\S]*useLinkStatus\(\)/, "the pending state is read inside the Link, where useLinkStatus sees it");
    assert.match(body, /if \(onSelect\) \{\s*e\.preventDefault\(\);\s*onSelect\(t\.key, t\.href\);/, "a selecting tab cancels Next's navigation");
  });
  await check("OsTabBar: no new visual language (no gradient, glow, animation or literal colour)", () => {
    const body = stripped("components/os/OsTabBar.tsx");
    assert.doesNotMatch(body, /bg-gradient|from-accent|blur-|shadow-glow|animate-|drop-shadow|#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  // ── 2. The status view ─────────────────────────────────────────────────────
  await check("the status view: a lifecycle param names its tab; anything else is All", () => {
    for (const l of ["prospect", "onboarding", "active", "paused", "churned"]) assert.equal(status.clientStatusOf(l), l);
    for (const v of ["", "vip", "Active", null, undefined]) assert.equal(status.clientStatusOf(v), "");
  });
  await check("the status view: All splits current from Past; a status shows only its own rows, in the server's order", () => {
    const l = ["active", "churned", "prospect", "active", "paused"] as const;
    assert.deepEqual(status.rowsForStatus(l, ""), { current: [0, 2, 3, 4], past: [1] });
    assert.deepEqual(status.rowsForStatus(l, "active"), { current: [0, 3], past: [] });
    assert.deepEqual(status.rowsForStatus(l, "churned"), { current: [1], past: [] });
    assert.deepEqual(status.rowsForStatus(l, "onboarding"), { current: [], past: [] });
  });
  await check("the status view: a click writes the address bar with replaceState and asks the server nothing; a cut list navigates", () => {
    const body = stripped("components/os/landings/clients-status.tsx");
    assert.match(body, /window\.history\.replaceState\(null, "", href\);/);
    assert.doesNotMatch(body, /router\.(push|replace|refresh)|useRouter/, "no server round trip on a status click");
    assert.match(body, /onSelect=\{fromServer \? undefined : pick\}/, "a list cut at its page size lets the tabs navigate");
    assert.match(body, /useSearchParams\(\)\.get\("lifecycle"\)/, "the address bar is the source of truth");
  });

  // ── 3. The pages ───────────────────────────────────────────────────────────
  await check("every tab bar under app/clients is OsTabBar: none is hand-rolled", () => {
    for (const f of walk(join(root, "app", "clients"))) {
      assert.doesNotMatch(stripped(f), /-mb-px border-b-2/, `${f} draws its own tab bar`);
      assert.doesNotMatch(stripped(f), /<nav aria-label=/, `${f} draws its own tab bar`);
    }
    assert.match(stripped("app/clients/page.tsx"), /<ClientsByStatus\b/);
    assert.match(stripped("app/clients/[id]/page.tsx"), /<OsTabBar\s+label="Client record"/);
    assert.match(stripped("components/os/landings/clients-status.tsx"), /<OsTabBar label="Client status"/);
  });
  await check("the list reads every status once; only a list cut at its page size reads the status on the server", () => {
    const page = stripped("app/clients/page.tsx");
    assert.match(page, /const filters = \{\s*lifecycle: null,/, "the status is not a read filter");
    assert.match(page, /const statusFromServer = everyStatus\.state === "ok" && everyStatus\.value\.truncated;/);
    assert.match(page, /statusFromServer && status \? await loadCustomerRecords\(cv, \{ \.\.\.filters, lifecycle: status \}\) : everyStatus/);
  });
  await check("both Clients pages have a loading boundary that paints at once", () => {
    for (const [f, variant] of [["app/clients/loading.tsx", "page"], ["app/clients/[id]/loading.tsx", "section"]] as const) {
      assert.ok(existsSync(join(root, f)), `${f} is missing`);
      assert.match(stripped(f), new RegExp(`<PageSkeleton variant="${variant}" />`), `${f} paints the shared skeleton`);
    }
  });

  // ── 4. Rendered where React is whole ───────────────────────────────────────
  await check("rendered: what the tabs draw, and what a click and a hover do (tests/clients-tabs.render.ts)", () => {
    const nodeOptions = (process.env.NODE_OPTIONS || "")
      .split(/\s+/)
      .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
      .join(" ");
    const env = { ...process.env, NODE_OPTIONS: nodeOptions };
    if (!nodeOptions) delete env.NODE_OPTIONS;
    const run = spawnSync(process.execPath, ["--import", "tsx", "tests/clients-tabs.render.ts"], { cwd: root, encoding: "utf8", env });
    assert.equal(run.status, 0, `the render helper exited ${run.status}:\n${run.stderr}`);
    const r = JSON.parse(run.stdout) as Record<string, unknown>;
    const html = (k: string) => String(r[k]);
    const current = (markup: string) => [...markup.matchAll(/<a href="([^"]+)"[^>]*aria-current="page"/g)].map((m) => m[1]);

    // A record's tabs navigate: the page's tab is current, hover and focus warm, a click is not cancelled.
    assert.match(html("record"), /<nav aria-label="Client record"/);
    assert.deepEqual(current(html("record")), ["/clients/c1?tab=money"]);
    assert.deepEqual(r.recordPrefetch, [false, false, false, false]);
    assert.deepEqual(r.recordWarm, ["prefetch /clients/c1?tab=tickets", "prefetch /clients/c1?tab=conversations"]);
    assert.deepEqual(r.recordClick, { cancelled: false, href: "/clients/c1?tab=tickets" });
    assert.doesNotMatch(html("record"), /aria-busy/);
    assert.match(html("recordPending"), /<span aria-busy="true" class="text-fg-muted">Money<\/span>/, "a pending tab says so, in today's muted tone");

    // The list, on ?lifecycle=active: only the Active rows, no Past heading.
    assert.deepEqual(current(html("listActive")), ["/clients?lifecycle=active"]);
    assert.match(html("listActive"), /Alpha Active[\s\S]*Delta Active/);
    assert.doesNotMatch(html("listActive"), /Bravo Past|Charlie Prospect|Past clients/);
    // All: current rows in the server's order, then Past under its heading.
    assert.deepEqual(current(html("listAll")), ["/clients"]);
    assert.match(html("listAll"), /Alpha Active[\s\S]*Charlie Prospect[\s\S]*Delta Active[\s\S]*Past clients[\s\S]*Bravo Past/);
    assert.match(html("listAll"), /<\/nav><form>FILTER-FORM<\/form>/, "the filter form keeps its place under the tabs");
    assert.match(html("listPaused"), /No clients with the status Paused\./);
    assert.match(html("listPausedFiltered"), /No clients match these filters\./);
    assert.match(html("listNone"), /<p>EMPTY-STATE<\/p>/, "no records at all: the page's own empty state");

    // A status click: cancelled navigation, the address bar written, no server and no warming.
    assert.deepEqual(r.localPrefetch, [false, false, false, false, false, false]);
    assert.deepEqual(r.localWarmHandlers, [false, false, false, false, false, false], "nothing to warm: the rows are already here");
    assert.deepEqual(r.localClick, { cancelled: true, href: "/clients?lifecycle=churned" });
    assert.deepEqual(r.localHistory, ["/clients?lifecycle=churned"]);
    assert.deepEqual(r.localRouter, [], "a status click asks the server nothing");

    // A list cut at its page size: the server's rows, and the tabs navigate (warmed on hover).
    assert.match(html("server"), /Charlie Prospect/);
    assert.deepEqual(current(html("server")), ["/clients?lifecycle=prospect"]);
    assert.deepEqual(r.serverClick, { cancelled: false, href: "/clients?lifecycle=active" });
    assert.deepEqual(r.serverHistory, []);
    assert.deepEqual(r.serverWarm, ["prefetch /clients?lifecycle=active"]);

    // The form carries the status; Clear shows while a status or a filter is on.
    assert.equal(html("fieldActive"), '<input type="hidden" name="lifecycle" value="active"/>');
    assert.equal(html("fieldAll"), "");
    assert.equal(html("clearNone"), "");
    assert.match(html("clearStatus"), /<a href="\/clients"[^>]*>Clear<\/a>/);
    assert.match(html("clearForm"), /<a href="\/clients"[^>]*>Clear<\/a>/);
  });

  if (failures) {
    console.log(`clients-tabs: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("clients-tabs: ok");
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
