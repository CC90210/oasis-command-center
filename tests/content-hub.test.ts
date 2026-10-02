/**
 * tests/content-hub.test.ts — the Content hub (/founders/marketing) inside the
 * OS shell (2026-10-01): ContentTabs, its layout, the breadcrumb alias, the
 * hidden founders banner, and one name for the hub.
 *
 *   1. ContentTabs lists Overview · Library · Training · Performance in that
 *      order, each a founders page that gates itself; the active tab is the
 *      longest matching one, Overview only on its exact path (an asset page
 *      lights no tab); every tab is a Link with aria-current on the active one;
 *      the bar scrolls on a phone (overflow-x-auto) and carries no founders
 *      cyan.
 *   2. app/founders/marketing/layout.tsx mounts ContentTabs above its pages,
 *      keeps the founder gate (defence in depth) and has a loading boundary
 *      beside it.
 *   3. lib/os/match.ts PATH_ALIASES carries ContentTabs' labels (plus Asset, a
 *      crumb but not a tab), so the OS header reads "Content › Library" on the
 *      Library page for a viewer whose rail has the Content row, and a plain
 *      crumb for anyone else (their page is a 404). The section crumb is the
 *      rail's own name for the row.
 *   4. The founders portal banner is hidden on every Content path, as on
 *      Finances, and still renders on the Growth preview shell. Stronger: for
 *      every page the file system has under Content and Finances, nothing in
 *      its layout chain or its imports can render the banner or its chips
 *      (the founders layout no longer mounts it; the Growth layout does).
 *   5. One name. FOUNDERS_NAV, the Overview's <h1> and <title>, every <title>
 *      under the hub, the back links and MarketingToday say Content; no hub
 *      file calls it "Studio" or "Marketing" in code (comments may say how it
 *      used to be).
 *   6. app/page.tsx renders MarketingToday only behind canSeeMarketing, the
 *      tenant-narrowed capability; the behavioural case is in
 *      tests/client-route-gating.test.ts.
 *
 * Run: node --conditions=react-server --import tsx tests/content-hub.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import * as ReactNS from "react";

const root = join(__dirname, "..");
const code = (rel: string) => readFileSync(join(root, rel), "utf8");
/** Code only: a comment may say what the hub used to be called, or what colour it is not. */
const stripped = (file: string) => code(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const rel = (p: string) => relative(root, p).split(sep).join("/");

// tsconfig.json sets jsx:"preserve", so tsx compiles component JSX with the
// classic runtime, which expects a global `React`.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

// next/navigation and next/link pull the client router context, which does not
// exist under the react-server condition (same stub as
// tests/finances-roundtrips.test.ts). usePathname answers whatever a check sets.
function stubModule(id: string, exports: Record<string, unknown>) {
  const path = require.resolve(id);
  require.cache[path] = { id: path, filename: path, path: dirname(path), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
let currentPathname = "";
stubModule("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  usePathname: () => currentPathname,
});
const LinkStub = ({ href, children, ...rest }: { href: string; children?: unknown }) =>
  ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode);
stubModule("next/link", { __esModule: true, default: LinkStub });

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const nodes = (n: unknown): El[] =>
  Array.isArray(n) ? n.flatMap(nodes) : n && typeof n === "object" && "props" in n ? [n as El, ...nodes((n as El).props.children)] : [];

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** "app/founders/marketing/asset/[id]/page.tsx" -> "/founders/marketing/asset/[id]" (route groups dropped). */
function routeOf(page: string): string {
  const segs = page.replace(/^app\//, "").split("/").slice(0, -1).filter((s) => !/^\(.*\)$/.test(s));
  return `/${segs.join("/")}`;
}

/**
 * What Next renders around a page: every layout, template, loading, error and
 * not-found file from app/ down to the page's own folder, then the page.
 */
function layoutChain(page: string): string[] {
  const dirs = page.split("/").slice(0, -1);
  const chain: string[] = [];
  for (let i = 1; i <= dirs.length; i += 1) {
    const dir = dirs.slice(0, i).join("/");
    for (const name of ["layout", "template", "loading", "error", "not-found"]) {
      for (const ext of [".tsx", ".ts"]) {
        if (existsSync(join(root, dir, name + ext))) chain.push(`${dir}/${name}${ext}`);
      }
    }
  }
  chain.push(page);
  return chain;
}

/** Repo-relative files reachable through runtime imports (type-only imports are erased, so they are skipped). */
const importsCache = new Map<string, string[]>();
function importsOf(file: string): string[] {
  const hit = importsCache.get(file);
  if (hit) return hit;
  const src = stripped(file);
  const specs: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?["']([^"']+)["']/gm)) {
    if (!m[1]) specs.push(m[2]);
  }
  for (const m of src.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  const out: string[] = [];
  for (const spec of specs) {
    const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? join(dirname(file), spec).split(sep).join("/") : null;
    if (base === null) continue;
    const found = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx"].map((ext) => base + ext).find((p) => /\.(?:[cm]?[jt]sx?)$/.test(p) && existsSync(join(root, p)) && statSync(join(root, p)).isFile());
    if (found) out.push(found);
  }
  importsCache.set(file, out);
  return out;
}
function importClosure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of importsOf(file)) if (!seen.has(next)) stack.push(next);
  }
  return seen;
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function main() {
  console.log("content-hub:");
  const { CONTENT_ROOT, CONTENT_TABS, ContentTabs, activeContentTab } = await import("../components/founders/ContentTabs");
  const { FOUNDERS_NAV, portalForPath } = await import("../lib/portals/registry");
  const { PATH_ALIASES, breadcrumbTrail, breadcrumbLabel, longestPrefixMatch } = await import("../lib/os/match");
  const { OS_NAV_CATALOG } = await import("../lib/os/nav");
  const { foundersBannerHidden } = await import("../components/founders/FoundersPortalBanner");

  // ── 1. the tabs ──────────────────────────────────────────────────────────
  await check("ContentTabs: Overview · Library · Training · Performance, each a founders page that gates itself", () => {
    assert.equal(CONTENT_ROOT, "/founders/marketing");
    // "Training", a noun, since 2026-10-01 ("Train" left CC asking what it did);
    // the route stays /train so no link or bookmark breaks.
    assert.deepEqual(CONTENT_TABS.map((t) => t.label), ["Overview", "Library", "Training", "Performance"]);
    assert.deepEqual(
      CONTENT_TABS.map((t) => t.href),
      [CONTENT_ROOT, `${CONTENT_ROOT}/library`, `${CONTENT_ROOT}/train`, `${CONTENT_ROOT}/performance`],
    );
    for (const t of CONTENT_TABS) {
      const page = `app${t.href}/page.tsx`;
      assert.ok(existsSync(join(root, page)), `${t.href} has a page`);
      assert.equal(portalForPath(page), "founders", `${t.href} stays founders-owned`);
      assert.match(code(page), /resolveFounder\(\)/, `${page} gates itself (clients still 404)`);
    }
    assert.match(code("app/founders/marketing/asset/[id]/page.tsx"), /resolveFounder\(\)/, "the asset page gates itself");
  });

  await check("the active tab: longest prefix wins, and Overview only on its exact path", () => {
    assert.equal(activeContentTab("/founders/marketing"), CONTENT_ROOT);
    assert.equal(activeContentTab("/founders/marketing/library"), `${CONTENT_ROOT}/library`);
    assert.equal(activeContentTab("/founders/marketing/library/anything"), `${CONTENT_ROOT}/library`);
    assert.equal(activeContentTab("/founders/marketing/train"), `${CONTENT_ROOT}/train`);
    assert.equal(activeContentTab("/founders/marketing/performance"), `${CONTENT_ROOT}/performance`);
    for (const p of ["/founders/marketing/asset/a_1", "/founders/marketing/arthrisil", "/founders/marketingx", "/founders/finances", "/money", "/"]) {
      assert.equal(activeContentTab(p), null, `${p} lights no Content tab`);
    }
  });

  await check("renders a scrollable nav of Links, aria-current on the active tab, OS tokens and no founders cyan", () => {
    const render = (path: string) => {
      currentPathname = path;
      return ContentTabs() as unknown as El;
    };
    const bar = render("/founders/marketing/library");
    assert.equal(bar.type, "nav");
    assert.equal(bar.props["aria-label"], "Content");
    assert.match(String(bar.props.className), /overflow-x-auto/, "scrolls on a phone");
    const links = nodes(bar).filter((n) => n.type === LinkStub);
    assert.deepEqual(links.map((l) => l.props.href), CONTENT_TABS.map((t) => t.href), "one Link per tab, in order");
    assert.deepEqual(links.map((l) => l.props.children), CONTENT_TABS.map((t) => t.label));
    assert.deepEqual(
      links.filter((l) => l.props["aria-current"] === "page").map((l) => l.props.href),
      [`${CONTENT_ROOT}/library`],
      "exactly the Library tab is current on the Library page",
    );
    const active = links.find((l) => l.props["aria-current"] === "page")!;
    assert.match(String(active.props.className), /border-fg text-fg/, "the active tab is a foreground underline, like the mode tabs");
    const asset = nodes(render("/founders/marketing/asset/a_1")).filter((n) => n.type === LinkStub);
    assert.equal(asset.filter((l) => l.props["aria-current"] === "page").length, 0, "an asset page lights no tab");
    assert.match(code("components/founders/ContentTabs.tsx"), /^"use client";/, "a client component: it reads the pathname");
    assert.doesNotMatch(stripped("components/founders/ContentTabs.tsx"), /1FE3F0|cyan|rgba\(31,\s*227,\s*240/i, "OS tokens only, no founders cyan");
  });

  // ── 2. the layout ────────────────────────────────────────────────────────
  await check("the layout mounts ContentTabs above its pages, keeps the founder gate, and has a loading boundary beside it", () => {
    const layout = code("app/founders/marketing/layout.tsx");
    assert.match(layout, /import \{ ContentTabs \} from "@\/components\/founders\/ContentTabs";/);
    const tabsAt = layout.indexOf("<ContentTabs />");
    const childrenAt = layout.indexOf("{children}");
    assert.ok(tabsAt > 0 && childrenAt > tabsAt, "ContentTabs renders before the page");
    assert.match(layout, /if \(!\(await resolveFounder\(\)\)\) notFound\(\);/, "defence in depth: the founder gate, as in the Growth and Finances layouts");
    assert.ok(existsSync(join(root, "app/founders/marketing/loading.tsx")), "a loading boundary beside the layout (tests/loading-boundaries.test.ts)");
    assert.match(code("app/founders/marketing/loading.tsx"), /<PageSkeleton variant="section" \/>/);
  });

  // ── 3. the breadcrumb alias ──────────────────────────────────────────────
  await check("match.ts and ContentTabs agree; the header reads 'Content › <tab>' for a viewer whose rail has Content", () => {
    const alias = PATH_ALIASES.find((a) => a.prefix === CONTENT_ROOT);
    assert.ok(alias, "PATH_ALIASES has the Content hub");
    assert.equal(alias!.as, CONTENT_ROOT, "the hub root is its own rail row");
    const rail = OS_NAV_CATALOG.find((e) => e.href === CONTENT_ROOT);
    assert.ok(rail, "the OS rail catalog has the hub");
    assert.equal(alias!.section, rail!.label, "the section crumb is the rail's own name for the row");
    const segs: string[] = [];
    for (const tab of CONTENT_TABS) {
      const seg = tab.href === CONTENT_ROOT ? "" : tab.href.slice(CONTENT_ROOT.length + 1);
      segs.push(seg);
      assert.equal(alias!.tabs[seg], tab.label, `match.ts and ContentTabs agree on ${tab.href}`);
    }
    assert.deepEqual(
      Object.keys(alias!.tabs).filter((k) => !segs.includes(k)),
      ["asset"],
      "Asset is a crumb but not a tab; nothing else is known to only one of them",
    );
    const rows = [
      { id: "today", href: "/", label: "Today" },
      { id: "content", href: CONTENT_ROOT, label: rail!.label },
      { id: "money", href: "/money", label: "Overview" },
    ];
    for (const tab of CONTENT_TABS) {
      assert.equal(longestPrefixMatch(tab.href, rows)?.id, "content", `${tab.href} lights the Content row`);
      assert.deepEqual(breadcrumbTrail(tab.href, rows), ["Content", tab.label], tab.href);
    }
    assert.deepEqual(breadcrumbTrail("/founders/marketing/library", rows), ["Content", "Library"]);
    assert.equal(breadcrumbLabel("/founders/marketing/library", rows), "Library");
    assert.deepEqual(breadcrumbTrail("/founders/marketing/asset/a_1", rows), ["Content", "Asset"], "an asset lives under Content");
    assert.equal(longestPrefixMatch("/founders/marketing/asset/a_1", rows)?.id, "content");
    assert.equal(longestPrefixMatch("/founders/marketingx", rows), null, "a path boundary, not a string prefix");
    // A viewer whose rail has no Content row (their page is a 404) is never shown the section's name.
    const clientRows = rows.filter((r) => r.id !== "content");
    assert.deepEqual(breadcrumbTrail("/founders/marketing/library", clientRows), ["Founders"]);
    assert.equal(longestPrefixMatch("/founders/marketing/library", clientRows), null);
    // Money is untouched.
    assert.deepEqual(breadcrumbTrail("/founders/finances/invoices", rows), ["Money", "Invoices"]);
    assert.deepEqual(breadcrumbTrail("/money", rows), ["Money", "Overview"]);
  });

  // ── 4. the banner ────────────────────────────────────────────────────────
  await check("the founders banner is hidden on every Content path, as on Finances, and still on the Growth shell", () => {
    for (const p of [...CONTENT_TABS.map((t) => t.href), "/founders/marketing/", "/founders/marketing/asset/a_1", "/founders/marketing/arthrisil", "/founders/finances/taxes"]) {
      assert.equal(foundersBannerHidden(p), true, p);
    }
    for (const p of ["/founders/marketingx", "/founders/growth", "/founders/growth/organic", "/founders"]) {
      assert.equal(foundersBannerHidden(p), false, p);
    }
  });

  // CC, 2026-10-01: "there's still that banner at the top. It allows us to
  // switch between finances, and I want to get rid of this." The pathname
  // check above only hides a banner the founders layout still MOUNTED on every
  // Content page. This proves, for every page the file system has under the
  // Content hub (and under Finances), that nothing in its layout chain or its
  // imports can render the banner or its section chips at all.
  await check("no page under Content or Finances has the founders banner or its chips in its layout chain or imports; the Growth shell still does", () => {
    const pagesUnder = (dir: string) => walkFiles(join(root, dir)).map(rel).filter((f) => /\/page\.tsx?$/.test(f));
    const content = pagesUnder("app/founders/marketing");
    const routes = content.map(routeOf);
    for (const must of [CONTENT_ROOT, ...CONTENT_TABS.map((t) => t.href), `${CONTENT_ROOT}/asset/[id]`]) {
      assert.ok(routes.includes(must), `the walk found ${must}: ${routes.join(", ")}`);
    }
    const finances = pagesUnder("app/founders/finances");
    assert.ok(finances.length >= 9, `walked Finances: ${finances.length} pages`);
    const BANNER = ["components/founders/FoundersPortalBanner.tsx", "components/founders/FoundersSectionNav.tsx"];
    for (const page of [...content, ...finances]) {
      const chain = layoutChain(page);
      const reach = importClosure(chain);
      assert.ok(reach.size > chain.length, `${page}: the import walk went past the chain itself`);
      for (const b of BANNER) assert.equal(reach.has(b), false, `${routeOf(page)} reaches ${b} from ${chain.join(" > ")}`);
      assert.equal(foundersBannerHidden(routeOf(page).replace(/\[[^\]]+\]/g, "a_1")), true, `${routeOf(page)}: the second wall`);
    }
    // Not vacuous: the same walk finds the banner where it IS still mounted.
    const growth = pagesUnder("app/founders/growth");
    assert.ok(growth.length >= 1, "walked the Growth preview shell");
    for (const page of growth) {
      assert.ok(importClosure(layoutChain(page)).has(BANNER[0]), `${routeOf(page)} still renders the banner`);
    }
  });

  await check("no Content page puts a log tag or 'server log' on the screen; a failure says it plainly and that the cause is logged for the OASIS team", () => {
    const files = walkFiles(join(root, "app/founders/marketing")).map(rel).filter((f) => /\.tsx?$/.test(f));
    assert.ok(files.length >= 6, `walked the Content pages: ${files.length}`);
    const TAG = /\[(marketing|founders|safe)[:.][^\]]*\]|server log/i;
    for (const f of files) {
      // Code, not comments: a comment may name the tag the server logs under.
      const lines = code(f).split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/?\*)/.test(l));
      for (const l of lines) assert.doesNotMatch(l, TAG, `${f}: ${l.trim().slice(0, 160)}`);
    }
  });

  // ── 5. one name ──────────────────────────────────────────────────────────
  await check("one name: Content in FOUNDERS_NAV, the h1, every <title>, the back links and MarketingToday; no 'Studio', no 'Marketing · OASIS'", () => {
    assert.equal(FOUNDERS_NAV.find((n) => n.href === CONTENT_ROOT)?.label, "Content");
    const overview = code("app/founders/marketing/page.tsx");
    assert.match(overview, /title: "Content · OASIS"/, "the Overview's <title>");
    assert.match(overview, /<PageHeader\s+title="Content"/, "the Overview's <h1>");
    assert.match(code("app/founders/marketing/library/page.tsx"), /title: "Library · Content · OASIS"/);
    assert.match(code("app/founders/marketing/train/page.tsx"), /title: "Training · Content · OASIS"/);
    for (const page of ["app/founders/marketing/library/page.tsx", "app/founders/marketing/performance/page.tsx"]) {
      assert.match(code(page), /href="\/founders\/marketing"[^>]*>\s*Back to Content\s*<\/Link>/, `${page}: the back link says Content`);
    }
    const today = code("components/today/MarketingToday.tsx");
    assert.match(today, /title="Content"/, "MarketingToday's card is Content");
    assert.match(today, />\s*Open Content\s*</, "MarketingToday's button opens Content");
    const hubFiles = walkFiles(join(root, "app/founders/marketing")).map(rel);
    assert.ok(hubFiles.length >= 7, `walked the hub: ${hubFiles.join(", ")}`);
    for (const file of [...hubFiles, "components/today/MarketingToday.tsx", "components/founders/ContentTabs.tsx"]) {
      const src = stripped(file);
      assert.doesNotMatch(src, /\bStudio\b/, `${file} calls the hub Studio`);
      assert.doesNotMatch(src, /Marketing · OASIS|title="Marketing"|Marketing studio|Open Marketing/, `${file} calls the hub Marketing`);
    }
  });

  // ── 6. the Today dispatch ────────────────────────────────────────────────
  await check("app/page.tsx renders MarketingToday only behind the tenant-narrowed capability", () => {
    const dispatcher = code("app/page.tsx");
    assert.match(
      dispatcher,
      /if \(surface\.persona === "marketing"\) \{\s*if \(surface\.capabilities\.canSeeMarketing\) \{\s*return <MarketingToday viewerName=\{viewerName\} \/>;/,
      "the persona alone is tenant-blind; the capability is narrowed to OASIS's slugs",
    );
    assert.doesNotMatch(dispatcher, /persona === "marketing"\) \{\s*return <MarketingToday/, "MarketingToday behind the persona alone");
  });

  if (failures > 0) {
    console.error(`content-hub: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("content-hub: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
