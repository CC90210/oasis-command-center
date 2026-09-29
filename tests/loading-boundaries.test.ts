/**
 * No page sits under a nested layout without a loading boundary.
 *
 * WHY. Between two pages under the same layout, the layout stays mounted and
 * only the page below it changes. Next shows the NEAREST loading.tsx below the
 * shared layout; with none, it keeps the old page on screen until the new one
 * has rendered on the server, so a click looks ignored. That is what made
 * Settings feel slow (CC, 2026-09-29): its section nav had no boundary under it.
 *
 * A layout is covered EITHER by a loading.tsx beside it OR by one beside every
 * page under it. Finances takes the second form on purpose: each tab has its
 * own skeleton, and a loading.tsx directly in finances/ would wrap and hide
 * them (tests/finances-roundtrips.test.ts forbids one there). The root layout
 * is covered by app/loading.tsx; the public marketing site is exempt (static).
 *
 * Run: node --import tsx tests/loading-boundaries.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

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

const layouts = walk(APP, "layout.tsx").map(dirname);
assert.ok(layouts.some((d) => rel(d) === "app"), "precondition: the root layout was found");

/** A loading.tsx in the page's folder or any folder between it and the layout covers it. */
function covered(pageDir: string, layoutDir: string): boolean {
  for (let d = pageDir; ; d = dirname(d)) {
    if (existsSync(join(d, "loading.tsx"))) return true;
    if (d === layoutDir || dirname(d) === d) return false;
  }
}

const uncovered: string[] = [];
for (const dir of layouts) {
  if (EXEMPT.has(rel(dir)) || existsSync(join(dir, "loading.tsx"))) continue;
  // No boundary beside the layout: every page under it needs one on its way up.
  const bare = walk(dir, "page.tsx").map(dirname).filter((pageDir) => !covered(pageDir, dir));
  if (bare.length) uncovered.push(`${rel(dir)} (pages without one: ${bare.map(rel).join(", ")})`);
}
assert.deepEqual(uncovered, [], `layout(s) with pages that have no loading boundary: ${uncovered.join("; ")}`);
console.log(`loading-boundaries: OK — ${layouts.length - EXEMPT.size} layouts, every page under each has a loading boundary`);
