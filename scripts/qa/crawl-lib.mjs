/**
 * scripts/qa/crawl-lib.mjs - the PURE half of the signed-in QA crawl.
 *
 * Everything here is a function of plain data: no browser, no server, no
 * database, no clock (listPageFiles reads a directory listing and nothing
 * else). scripts/qa/crawl.mjs gathers the data (Playwright, the local
 * database, the app's own session code) and calls these to decide what is a
 * defect; tests/qa-crawl.test.ts runs them in bare node.
 *
 *   listPageFiles        every app/ page file, as repo-relative paths
 *   deriveRoutes         every OS nav row + every app page file, with dynamic
 *                        segments expanded from seeded ids (never a hand list)
 *   findClippedText      elements whose text is cut off by overflow hidden/clip
 *   findOverlappingBars  fixed/sticky bars drawn on top of each other
 *   horizontalScroll     a page that scrolls sideways, with the widest culprits
 *   personaNamesIn       internal agent and founder names in visible text
 *   visitDefects         one page visit -> its defects
 *   deadTabDefects       a 404 behind a link the viewer's own rail draws
 *   rankDefects / groupDefects / countDefects / renderMarkdown  the report
 */

import { readdirSync } from "node:fs";
import path from "node:path";

// Severity order, most severe first. The four the brief named are in its order
// (error page > failed request > persona leak > clipped text > horizontal
// scroll > slow); console errors sit after persona leaks, and overlapping
// fixed bars with the other layout defects, ahead of horizontal scroll.
export const DEFECT_TYPES = Object.freeze([
  "error_page",
  "failed_request",
  "persona_leak",
  "console_error",
  "clipped_text",
  "overlapping_bars",
  "horizontal_scroll",
  "slow",
]);

export const DEFECT_LABELS = Object.freeze({
  error_page: "Error page",
  failed_request: "Failed request",
  persona_leak: "Persona name leak",
  console_error: "Console error",
  clipped_text: "Clipped text",
  overlapping_bars: "Overlapping fixed bars",
  horizontal_scroll: "Horizontal page scroll",
  slow: "Slow page",
});

/** Internal agent and founder names a client owner or a sales rep must never see. */
export const PERSONA_NAMES = Object.freeze(["Bravo", "Maven", "Atlas", "Aura", "Hermes", "Lex", "Conaugh"]);

export function severityOf(type) {
  const i = DEFECT_TYPES.indexOf(type);
  return i === -1 ? DEFECT_TYPES.length + 1 : i + 1;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Every page file under <root>/app, as "app/..." paths with forward slashes, sorted. */
export function listPageFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/^page\.(tsx|ts|jsx|js|mdx)$/.test(entry.name)) out.push(child);
    }
  };
  walk("app");
  return out.sort();
}

const DYNAMIC_SEGMENT = /^\[\[?(\.\.\.)?([^\]]+)\]\]?$/;

/**
 * The URL pattern an app/ page file serves, or null when it is not directly
 * addressable (a parallel-route slot, an intercepting route, a private folder).
 *   app/page.tsx                              -> /
 *   app/(marketing)/about/page.tsx            -> /about
 *   app/founders/finances/(overview)/page.tsx -> /founders/finances
 *   app/t/[slug]/[...path]/page.tsx           -> /t/[slug]/[...path]
 */
export function routePatternFromPageFile(file) {
  const parts = String(file).replace(/\\/g, "/").replace(/^\.\//, "").split("/");
  if (parts[0] === "app") parts.shift();
  const last = parts.pop();
  if (!/^page\.(tsx|ts|jsx|js|mdx)$/.test(last || "")) return null;
  const segments = [];
  for (const p of parts) {
    if (/^\(\.{1,3}\)/.test(p)) return null; // intercepting route: (.)x, (..)x, (...)x
    if (/^\(.+\)$/.test(p)) continue; // route group: not part of the URL
    if (p.startsWith("@") || p.startsWith("_")) return null; // parallel slot, private folder
    segments.push(p);
  }
  return `/${segments.join("/")}`;
}

export function isDynamicPattern(pattern) {
  return String(pattern).split("/").some((s) => DYNAMIC_SEGMENT.test(s));
}

/**
 * Fill a dynamic pattern from param objects ({ id: "x" }, { slug: "a", path: ["b", "c"] }).
 * A value object missing a required segment yields nothing (never a literal "[id]").
 */
export function expandPattern(pattern, valueList) {
  const out = [];
  for (const values of valueList || []) {
    const segs = [];
    let complete = true;
    for (const seg of String(pattern).split("/").slice(1)) {
      const m = DYNAMIC_SEGMENT.exec(seg);
      if (!m) {
        segs.push(seg);
        continue;
      }
      const optional = seg.startsWith("[[");
      const raw = values ? values[m[2]] : undefined;
      if (raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0)) {
        if (optional) continue;
        complete = false;
        break;
      }
      const list = Array.isArray(raw) ? raw : m[1] ? String(raw).split("/") : [raw];
      segs.push(list.map((v) => encodeURIComponent(String(v))).join("/"));
    }
    if (complete) out.push(`/${segs.join("/")}`);
  }
  return [...new Set(out)];
}

/**
 * The crawl's route list, derived: every OS nav row, plus every app page.
 *
 * Public pages (middleware's isPublic: marketing, login, legal, public forms)
 * are skipped unless a nav row links them, because a signed-in crawl of the
 * marketing site says nothing about the Command Center. A dynamic page is
 * expanded with `paramValues[pattern]`; a pattern with no values is returned
 * in `unexpanded` so the report says what was NOT visited.
 */
export function deriveRoutes({ navHrefs = [], pageFiles = [], paramValues = {}, isPublic = () => false } = {}) {
  const byPath = new Map();
  const add = (path, pattern, source) => {
    const existing = byPath.get(path);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    byPath.set(path, { path, pattern, sources: [source] });
  };
  const nav = [...new Set(navHrefs.map(String))];
  const navSet = new Set(nav);
  for (const href of nav) add(href, href, "nav");

  const skippedPublic = [];
  const unexpanded = [];
  const patterns = [...new Set(pageFiles.map(routePatternFromPageFile).filter(Boolean))].sort();
  for (const pattern of patterns) {
    if (!isDynamicPattern(pattern)) {
      if (isPublic(pattern) && !navSet.has(pattern)) {
        skippedPublic.push(pattern);
        continue;
      }
      add(pattern, pattern, "page");
      continue;
    }
    // A dynamic page under a public prefix (/f/..., /invite/..., /sign/...) is public too.
    const probe = pattern.replace(/\[\[?(\.\.\.)?[^\]]+\]\]?/g, "x");
    if (isPublic(probe)) {
      skippedPublic.push(pattern);
      continue;
    }
    const expanded = expandPattern(pattern, paramValues[pattern]);
    if (expanded.length === 0) {
      unexpanded.push(pattern);
      continue;
    }
    for (const path of expanded) add(path, pattern, "page");
  }
  const routes = [...byPath.values()].sort((a, b) => {
    const an = navSet.has(a.path) ? nav.indexOf(a.path) : Infinity;
    const bn = navSet.has(b.path) ? nav.indexOf(b.path) : Infinity;
    return an - bn || a.path.localeCompare(b.path);
  });
  return { routes, skippedPublic, unexpanded };
}

// ---------------------------------------------------------------------------
// Layout detectors (pure functions over metrics the browser measured)
// ---------------------------------------------------------------------------

const CLIPPING = new Set(["hidden", "clip"]);

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * Elements whose text is clipped: the content is wider (or taller) than the
 * box, the box hides the overflow on that axis (overflow hidden or clip), and
 * the element has text.
 *
 * Each metric: { selector, text, scrollWidth, clientWidth, scrollHeight,
 * clientHeight, overflowX, overflowY, textOverflow?, lineClamp?,
 * textOverflowX?, textOverflowY? }. textOverflowX/Y, when the browser measured
 * them, are how far the element's own text runs past its box: a box that
 * overflows only because of a non-text child (an icon, a shadow, a badge) is
 * then not reported as clipped TEXT.
 *
 * kind: "ellipsis" (cut with an ellipsis), "clamp" (a line clamp) or "cut"
 * (the text simply stops at the edge).
 */
export function findClippedText(metrics, { tolerance = 1 } = {}) {
  const out = [];
  for (const m of metrics || []) {
    const text = oneLine(m.text);
    if (!text) continue;
    const overX = Number(m.scrollWidth) - Number(m.clientWidth);
    const overY = Number(m.scrollHeight) - Number(m.clientHeight);
    const ellipsis = m.textOverflow === "ellipsis";
    const clamp = Boolean(m.lineClamp) && m.lineClamp !== "none";
    let x = CLIPPING.has(m.overflowX) && overX > tolerance;
    let y = CLIPPING.has(m.overflowY) && overY > tolerance;
    // An ellipsis or a line clamp is truncation by definition; any other box
    // must have its own text running past the edge.
    if (x && !ellipsis && typeof m.textOverflowX === "number") x = m.textOverflowX > tolerance;
    if (y && !clamp && typeof m.textOverflowY === "number") y = m.textOverflowY > tolerance;
    if (!x && !y) continue;
    const kind = x && ellipsis ? "ellipsis" : y && clamp ? "clamp" : "cut";
    out.push({
      ...m,
      text,
      axis: x && y ? "xy" : x ? "x" : "y",
      kind,
      overflowPx: Math.round(Math.max(x ? overX : 0, y ? overY : 0)),
    });
  }
  return out;
}

/**
 * Fixed or sticky elements drawn over each other. A "bar" spans at least 30%
 * of the viewport in one direction (top bar, rail, bottom nav); a pair is
 * reported when at least one of the two is a bar, neither contains the other,
 * and they overlap by at least `minArea` square pixels. A full-screen layer (a
 * backdrop) is not a bar.
 *
 * Each bar: { id, selector, x, y, width, height, ancestorIds?: id[], text? }.
 */
export function findOverlappingBars(bars, { viewportWidth, viewportHeight, minArea = 24 } = {}) {
  const vw = Number(viewportWidth) || 0;
  const vh = Number(viewportHeight) || 0;
  const fullScreen = (b) => vw > 0 && vh > 0 && b.width >= 0.95 * vw && b.height >= 0.95 * vh;
  const isBar = (b) => (vw > 0 && b.width >= 0.3 * vw) || (vh > 0 && b.height >= 0.3 * vh);
  const list = (bars || []).filter((b) => b.width >= 2 && b.height >= 2 && !fullScreen(b));
  const nested = (a, b) => (a.ancestorIds || []).includes(b.id) || (b.ancestorIds || []).includes(a.id);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (!isBar(a) && !isBar(b)) continue;
      if (nested(a, b)) continue;
      const ix = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (ix < 2 || iy < 2 || ix * iy < minArea) continue;
      out.push({ a, b, overlap: { width: Math.round(ix), height: Math.round(iy), area: Math.round(ix * iy) } });
    }
  }
  return out;
}

/**
 * A page that scrolls sideways: the document is wider than the viewport and
 * neither <html> nor <body> clips it. Returns null when it does not scroll.
 * sample: { scrollWidth, clientWidth, htmlOverflowX, bodyOverflowX, offenders: [{ selector, right, text }] }
 */
export function horizontalScroll(sample, { tolerance = 1 } = {}) {
  if (!sample) return null;
  const over = Number(sample.scrollWidth) - Number(sample.clientWidth);
  if (!(over > tolerance)) return null;
  if (CLIPPING.has(sample.htmlOverflowX) || CLIPPING.has(sample.bodyOverflowX)) return null;
  const offenders = [...(sample.offenders || [])].sort((a, b) => b.right - a.right).slice(0, 5);
  return { overflowPx: Math.round(over), offenders };
}

/** The persona names that occur as whole, capitalised words in `text`. */
export function personaNamesIn(text, names = PERSONA_NAMES) {
  if (!names.length) return [];
  const re = new RegExp(`\\b(${names.join("|")})\\b`, "g");
  return [...new Set([...String(text ?? "").matchAll(re)].map((m) => m[1]))];
}

// ---------------------------------------------------------------------------
// Defects
// ---------------------------------------------------------------------------

/** Text of the boundary components the app renders when a page fails (app/error.tsx, app/global-error.tsx, app/schedule/error.tsx) and Next's own fallbacks. */
export const ERROR_BOUNDARY_TEXT = [
  "Something went wrong",
  "This page timed out",
  "The interactive calendar could not render",
  "Application error: a client-side exception has occurred",
  "Application error: a server-side exception has occurred",
  "Internal Server Error",
];

/**
 * One page visit -> its defects. `visit` is what crawl.mjs measured:
 * { route, finalPath, viewer, viewport, status, navigationError, signedOut,
 *   errorBoundary: { selector, text } | null, pageErrors: [], consoleErrors: [],
 *   failedRequests: [{ url, method, status, error, resourceType }],
 *   personaHits: [{ name, selector, snippet }], clipCandidates: [],
 *   bars: [], viewportSize: { width, height }, hscroll, mainReadyMs }
 */
export function visitDefects(visit, { slowMs = 3000, checkPersona = false } = {}) {
  const base = {
    route: visit.route,
    finalPath: visit.finalPath ?? visit.route,
    viewer: visit.viewer,
    viewport: visit.viewport,
  };
  const out = [];
  const push = (type, selector, text, detail, extra = {}) =>
    out.push({ ...base, type, severity: severityOf(type), selector: selector || "", text: oneLine(text).slice(0, 300), detail: oneLine(detail).slice(0, 300), ...extra });

  if (visit.navigationError) push("error_page", "document", visit.navigationError, "the page did not load");
  if (typeof visit.status === "number" && visit.status >= 500) push("error_page", "document", `HTTP ${visit.status}`, "server error response");
  if (visit.signedOut) push("error_page", "document", `landed on ${visit.finalPath}`, "a signed-in viewer was sent to sign in");
  if (visit.errorBoundary) push("error_page", visit.errorBoundary.selector, visit.errorBoundary.text, "error boundary rendered");
  for (const e of visit.pageErrors || []) push("error_page", "window", e, "uncaught exception in the browser");

  for (const r of visit.failedRequests || []) {
    push("failed_request", r.url, `${r.status ?? r.error ?? "failed"} ${r.method || "GET"} ${r.url}`, r.resourceType || "", { region: "network" });
  }

  if (checkPersona) {
    for (const h of visit.personaHits || []) push("persona_leak", h.selector, h.snippet, `"${h.name}" is visible`, { region: h.region });
  }

  for (const c of visit.consoleErrors || []) push("console_error", "console", c, "console.error");

  for (const c of findClippedText(visit.clipCandidates)) {
    push("clipped_text", c.selector, c.text, `${c.kind}, ${c.axis === "x" ? "width" : c.axis === "y" ? "height" : "width and height"}, ${c.overflowPx}px hidden`, { region: c.region });
  }

  // Bars are measured twice (at the top, after scrolling). Compare each
  // measurement with itself: one bar at two scroll positions is not two bars.
  const size = visit.viewportSize || {};
  const byMoment = new Map();
  for (const b of visit.bars || []) {
    const key = b.at || "";
    if (!byMoment.has(key)) byMoment.set(key, []);
    byMoment.get(key).push(b);
  }
  const overlaps = [...byMoment.values()].flatMap((bars) => findOverlappingBars(bars, { viewportWidth: size.width, viewportHeight: size.height }));
  for (const o of overlaps) {
    push(
      "overlapping_bars",
      `${o.a.selector}  x  ${o.b.selector}`,
      [o.a.text, o.b.text].filter(Boolean).join(" | "),
      `${o.overlap.width}x${o.overlap.height}px overlap${o.a.at ? ` (${o.a.at})` : ""}`,
      { region: o.a.region || o.b.region },
    );
  }

  const h = horizontalScroll(visit.hscroll);
  if (h) {
    const top = h.offenders[0];
    push(
      "horizontal_scroll",
      top ? top.selector : "html",
      top ? top.text : "",
      `page is ${h.overflowPx}px wider than the screen${h.offenders.length ? `; widest: ${h.offenders.map((o) => `${o.selector} (right edge ${Math.round(o.right)}px)`).join("; ")}` : ""}`,
      { region: top ? top.region : undefined },
    );
  }

  if (!visit.navigationError) {
    if (visit.mainReadyMs === null || visit.mainReadyMs === undefined) {
      push("slow", "main", "main content never appeared", "no content in <main> before the wait ran out");
    } else if (visit.mainReadyMs > slowMs) {
      push("slow", "main", `${Math.round(visit.mainReadyMs)} ms to main content`, `over ${slowMs} ms`);
    }
  }
  return out;
}

/**
 * A page that answers 404 (or renders "Page not found") behind a link the
 * viewer's own rail draws is a dead tab. railHrefsByViewer: { viewer: Set|array }
 * collected from the rails the crawl actually saw.
 */
export function deadTabDefects(visits, railHrefsByViewer) {
  const out = [];
  for (const v of visits) {
    const rail = railHrefsByViewer[v.viewer];
    const has = rail instanceof Set ? rail.has(v.route) : Array.isArray(rail) && rail.includes(v.route);
    if (!has) continue;
    if (v.status === 404 || v.notFound) {
      out.push({
        route: v.route,
        finalPath: v.finalPath ?? v.route,
        viewer: v.viewer,
        viewport: v.viewport,
        type: "error_page",
        severity: severityOf("error_page"),
        selector: "document",
        text: `HTTP ${v.status ?? "?"}: Page not found`,
        detail: "the viewer's own rail links to this page",
      });
    }
  }
  return out;
}

export function rankDefects(defects, viewerOrder = []) {
  const vi = (v) => {
    const i = viewerOrder.indexOf(v);
    return i === -1 ? viewerOrder.length : i;
  };
  return [...defects].sort(
    (a, b) =>
      a.severity - b.severity ||
      String(a.route).localeCompare(String(b.route)) ||
      vi(a.viewer) - vi(b.viewer) ||
      String(a.viewport).localeCompare(String(b.viewport)) ||
      String(a.selector).localeCompare(String(b.selector)),
  );
}

/** A selector without positions, so the same component on two pages groups together. */
export function selectorSignature(selector) {
  return String(selector || "").replace(/:nth-of-type\(\d+\)/g, "").replace(/\s+/g, " ").trim();
}

function normalizeMessage(s) {
  return oneLine(s)
    .replace(/https?:\/\/[^\s)'"]+/g, (u) => {
      try {
        return new URL(u).pathname;
      } catch {
        return u;
      }
    })
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\d+/g, "#")
    .slice(0, 140);
}

function failedRequestPath(selector) {
  try {
    return new URL(selector).pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
  } catch {
    return String(selector);
  }
}

export function groupKey(d) {
  switch (d.type) {
    case "failed_request":
      return `${d.type}|${String(d.text).split(" ")[0]}|${failedRequestPath(d.selector)}`;
    case "console_error":
      return `${d.type}|${normalizeMessage(d.text)}`;
    case "error_page":
      return `${d.type}|${d.detail}|${normalizeMessage(d.text)}`;
    case "slow":
      return `${d.type}|${d.route}`;
    case "persona_leak":
      return `${d.type}|${d.detail}|${d.region || ""}|${selectorSignature(d.selector)}`;
    default:
      return `${d.type}|${d.region || ""}|${selectorSignature(d.selector)}`;
  }
}

/** Where a region of the shell is drawn, so a group can name its component. */
export const REGION_COMPONENTS = Object.freeze({
  rail: "the rail (components/Sidebar.tsx, components/os/OsRail.tsx)",
  "top-bar": "the phone top bar (components/SidebarShell.tsx)",
  "content-header": "the breadcrumb header (components/os/ContentHeader.tsx)",
  "page-header": "a page title block (components/os/PageFrame.tsx)",
  "shell-footer": "the shell footer (components/MainShell.tsx)",
  dialog: "a dialog",
});

export function groupDefects(defects) {
  const groups = new Map();
  for (const d of defects) {
    const key = groupKey(d);
    let g = groups.get(key);
    if (!g) {
      g = { key, type: d.type, severity: d.severity, region: d.region || null, signature: selectorSignature(d.selector), count: 0, routes: new Set(), viewers: new Set(), viewports: new Set(), sample: d };
      groups.set(key, g);
    }
    g.count += 1;
    g.routes.add(d.route);
    g.viewers.add(d.viewer);
    g.viewports.add(d.viewport);
  }
  return [...groups.values()]
    .map((g) => {
      const routes = [...g.routes].sort();
      const component = (g.region && REGION_COMPONENTS[g.region]) || (routes.length >= 3 && g.type !== "slow" ? `shared: the same element on ${routes.length} pages` : null);
      return { ...g, routes, viewers: [...g.viewers], viewports: [...g.viewports], component };
    })
    .sort((a, b) => a.severity - b.severity || b.routes.length - a.routes.length || b.count - a.count || a.key.localeCompare(b.key));
}

export function countDefects(defects, viewers = []) {
  const byType = Object.fromEntries(DEFECT_TYPES.map((t) => [t, 0]));
  const byTypeAndViewer = Object.fromEntries(DEFECT_TYPES.map((t) => [t, Object.fromEntries(viewers.map((v) => [v, 0]))]));
  for (const d of defects) {
    byType[d.type] = (byType[d.type] ?? 0) + 1;
    byTypeAndViewer[d.type] ??= {};
    byTypeAndViewer[d.type][d.viewer] = (byTypeAndViewer[d.type][d.viewer] ?? 0) + 1;
  }
  return { total: defects.length, byType, byTypeAndViewer };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const cell = (s, max = 140) => {
  const t = oneLine(s).replace(/\|/g, "\\|");
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};

export function renderMarkdown(report, { maxDefects = Infinity } = {}) {
  const m = report.meta || {};
  const viewers = (m.viewers || []).map((v) => v.key);
  const lines = [];
  lines.push("# Command Center QA crawl");
  lines.push("");
  lines.push(
    `Signed-in crawl of ${m.routes ?? "?"} routes x ${viewers.length} viewers x ${(m.viewports || []).length} viewports = ${m.visits ?? "?"} page visits` +
      (m.commit ? ` on commit \`${String(m.commit).slice(0, 12)}\`` : "") +
      (m.generatedAt ? `, ${m.generatedAt}` : "") +
      ".",
  );
  if (m.runUrl) lines.push(`Run: ${m.runUrl}`);
  lines.push(`Server: ${m.server || "next start"} against a local database built from the production schema and seeded with synthetic rows; every outbound call blocked.`);
  lines.push("");
  lines.push("Viewers: " + (m.viewers || []).map((v) => `\`${v.key}\` = ${v.label}`).join("; ") + ".");
  lines.push(`Viewports: ${(m.viewports || []).join(", ")}. Slow = more than ${m.slowMs ?? "?"} ms to main content.`);
  lines.push("");

  const counts = report.counts || countDefects(report.defects || [], viewers);
  lines.push("## Defects by type and viewer");
  lines.push("");
  lines.push(`| Severity | Type | ${viewers.map((v) => `\`${v}\``).join(" | ")} | Total |`);
  lines.push(`|---|---|${viewers.map(() => "---:").join("|")}|---:|`);
  for (const t of DEFECT_TYPES) {
    const row = counts.byTypeAndViewer[t] || {};
    lines.push(`| ${severityOf(t)} | ${DEFECT_LABELS[t]} | ${viewers.map((v) => row[v] ?? 0).join(" | ")} | ${counts.byType[t] ?? 0} |`);
  }
  lines.push(`| | **All** | ${viewers.map((v) => DEFECT_TYPES.reduce((n, t) => n + ((counts.byTypeAndViewer[t] || {})[v] ?? 0), 0)).join(" | ")} | **${counts.total}** |`);
  lines.push("");

  const groups = report.groups || groupDefects(report.defects || []);
  lines.push("## Causes, grouped by the element or component that repeats");
  lines.push("");
  lines.push("| # | Type | Where | Pages | Viewers | Viewports | Example route | Selector | Text |");
  lines.push("|---:|---|---|---:|---|---|---|---|---|");
  groups.forEach((g, i) => {
    lines.push(
      `| ${i + 1} | ${DEFECT_LABELS[g.type]} | ${cell(g.component || g.region || "page", 60)} | ${g.routes.length} | ${g.viewers.join(", ")} | ${g.viewports.join(", ")} | \`${cell(g.sample.route, 60)}\` | \`${cell(g.signature || g.sample.selector, 90)}\` | ${cell(g.sample.text || g.sample.detail, 90)} |`,
    );
  });
  lines.push("");

  const defects = report.defects || [];
  lines.push(`## Every defect, most severe first (${defects.length})`);
  lines.push("");
  lines.push("| # | Type | Route | Viewer | Viewport | Selector | Text | Detail |");
  lines.push("|---:|---|---|---|---|---|---|---|");
  defects.slice(0, maxDefects).forEach((d, i) => {
    lines.push(
      `| ${i + 1} | ${DEFECT_LABELS[d.type]} | \`${cell(d.route, 70)}\`${d.finalPath && d.finalPath !== d.route ? ` -> \`${cell(d.finalPath, 50)}\`` : ""} | ${d.viewer} | ${d.viewport} | \`${cell(d.selector, 90)}\` | ${cell(d.text, 110)} | ${cell(d.detail, 90)} |`,
    );
  });
  if (defects.length > maxDefects) lines.push(`| | ... ${defects.length - maxDefects} more in the JSON report | | | | | | |`);
  lines.push("");

  const access = report.access || [];
  if (access.length) {
    lines.push("## What each viewer gets on each route (desktop)");
    lines.push("");
    lines.push("`200` page rendered, `404` not found, `-> /x` redirected, `ERR` failed. A route on the viewer's own rail is marked with `*`.");
    lines.push("");
    lines.push(`| Route | ${viewers.map((v) => `\`${v}\``).join(" | ")} |`);
    lines.push(`|---|${viewers.map(() => "---").join("|")}|`);
    for (const a of access) lines.push(`| \`${cell(a.route, 70)}\` | ${viewers.map((v) => cell(a.cells[v] ?? "", 40)).join(" | ")} |`);
    lines.push("");
  }

  lines.push("## Not crawled");
  lines.push("");
  lines.push(`- Public pages (middleware isPublic, not on any rail): ${(m.skippedPublic || []).map((p) => `\`${p}\``).join(", ") || "none"}.`);
  lines.push(`- Dynamic pages with no seeded value: ${(m.unexpanded || []).map((p) => `\`${p}\``).join(", ") || "none"}.`);
  const egress = m.egress || {};
  const hosts = Object.entries(egress.serverHosts || {});
  const browserHosts = Object.entries(egress.browserHosts || {});
  lines.push(`- Outbound calls the egress guard blocked from the server: ${hosts.map(([h, n]) => `${h} (${n})`).join(", ") || "none"}.`);
  lines.push(`- Outbound requests blocked in the browser: ${browserHosts.map(([h, n]) => `${h} (${n})`).join(", ") || "none"}.`);
  for (const s of (egress.browserSamples || []).slice(0, 20)) lines.push(`  - \`${cell(s, 160)}\``);
  lines.push(
    `- Persona names (${PERSONA_NAMES.join(", ")}) are checked for: ${(m.viewers || []).filter((v) => v.checkPersona).map((v) => `\`${v.key}\` (${v.label})`).join(", ") || "nobody"}.`,
  );
  lines.push("");
  return lines.join("\n");
}
