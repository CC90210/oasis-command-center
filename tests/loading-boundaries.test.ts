/**
 * Every signed-in page has a loading boundary, and no public page has one.
 *
 * WHY SIGNED-IN PAGES NEED ONE. Between two pages under the same layout, the
 * layout stays mounted and only the page below it changes. Next shows the
 * NEAREST loading.tsx below the shared layout; with none, it keeps the old page
 * on screen until the new one has rendered on the server, so a click looks
 * ignored. That is what made Settings feel slow (CC, 2026-09-29): its section
 * nav had no boundary under it.
 *
 * A layout is covered EITHER by a loading.tsx beside it OR by one beside every
 * page under it. Finances takes the second form on purpose: each tab has its
 * own skeleton, and a loading.tsx directly in finances/ would wrap and hide
 * them (tests/finances-roundtrips.test.ts forbids one there). The root layout
 * takes the second form too: each signed-in section has its own loading.tsx,
 * and the Today screen lives in app/(today) beside its own.
 *
 * WHY PUBLIC PAGES MUST HAVE NONE. A loading.tsx is a Suspense boundary, and
 * React 19.2 streams whatever sits inside one HIDDEN (<div hidden id="S:0">),
 * then reveals it with an inline script that waits 300 ms after the first
 * frame, or until 2.3 s when it lands between 2.0 and 2.3 s. Until 2026-10-16
 * app/loading.tsx wrapped every page, so every public page painted an empty
 * dashboard skeleton first: PageSpeed showed /terms blank for 2.5 s after a
 * 0.7 s load, and the text an anonymous visitor came for depended on that
 * script. A full-bleed page (lib/os/full-bleed.ts: every public page, plus the
 * two signed-in pages that draw their own header) never gets one above it, so
 * its text is in the first frame and notFound() / redirect() keep their real
 * status code instead of the 200 an already-streamed shell commits to.
 *
 * Run: node --import tsx tests/loading-boundaries.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { isFullBleedPath } from "../lib/os/full-bleed";

const ROOT = join(__dirname, "..");
const APP = join(ROOT, "app");
const EXEMPT = new Set(["app/(marketing)"]);
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

function walk(dir: string, name: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, name, out);
    else if (entry === name) out.push(full);
  }
  return out;
}

/** app/(marketing)/terms -> "/terms": route groups and parallel slots take no URL segment. */
function routeOf(pageDir: string): string {
  const segments = rel(pageDir).split("/").slice(1).filter((s) => !/^\(.+\)$/.test(s) && !s.startsWith("@"));
  return "/" + segments.join("/");
}

const layouts = walk(APP, "layout.tsx").map(dirname);
assert.ok(layouts.some((d) => rel(d) === "app"), "precondition: the root layout was found");

const pages = walk(APP, "page.tsx").map(dirname);
// The marketing group counts by folder as well as by URL: next.config.js rewrites
// /pricing, /audit, /command-center and /onboarding to (marketing)/funnel/[funnel].
const isPublic = (pageDir: string) =>
  rel(pageDir).startsWith("app/(marketing)/") || isFullBleedPath(routeOf(pageDir));

// anti-vacuity: the split must find both kinds, or a clean result proves nothing.
const publicPages = pages.filter(isPublic);
for (const must of ["app/(marketing)/terms", "app/(marketing)/about", "app/(marketing)/funnel/[funnel]", "app/login"]) {
  assert.ok(publicPages.some((d) => rel(d) === must), `precondition: ${must} is read as a public page`);
}
assert.ok(!isPublic(join(APP, "(today)")), 'precondition: the Today screen ("/") is read as signed-in');
assert.ok(!isPublic(join(APP, "settings")), "precondition: /settings is read as signed-in");

/** A loading.tsx in the page's folder or any folder between it and the layout covers it. */
function covered(pageDir: string, layoutDir: string): boolean {
  for (let d = pageDir; ; d = dirname(d)) {
    if (existsSync(join(d, "loading.tsx"))) return true;
    if (d === layoutDir || dirname(d) === d) return false;
  }
}

// ── rule 1: no public page sits under a loading boundary ─────────────
const wrapped = publicPages.filter((pageDir) => covered(pageDir, APP)).map(rel);
assert.deepEqual(
  wrapped,
  [],
  `public page(s) under a loading.tsx, so React streams them hidden and reveals them late: ${wrapped.join(", ")}.\n` +
    "Move the boundary down into the signed-in section that needs it (see this file's header).",
);

// ── rule 2: every signed-in page has one under its nearest layout ────
const uncovered: string[] = [];
for (const dir of layouts) {
  if (EXEMPT.has(rel(dir)) || existsSync(join(dir, "loading.tsx"))) continue;
  // No boundary beside the layout: every signed-in page under it needs one on its way up.
  const bare = walk(dir, "page.tsx").map(dirname).filter((pageDir) => !isPublic(pageDir) && !covered(pageDir, dir));
  if (bare.length) uncovered.push(`${rel(dir)} (pages without one: ${bare.map(rel).join(", ")})`);
}
assert.deepEqual(uncovered, [], `layout(s) with signed-in pages that have no loading boundary: ${uncovered.join("; ")}`);
console.log(
  `loading-boundaries: OK — ${publicPages.length} public pages paint without a boundary; every signed-in page under ${layouts.length - EXEMPT.size} layouts has one`,
);
