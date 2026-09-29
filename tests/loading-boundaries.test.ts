/**
 * Every nested layout has a loading boundary of its own.
 *
 * WHY. Between two pages under the same layout, the layout stays mounted and
 * only the page below it changes. Next shows the NEAREST loading.tsx below the
 * shared layout; with none, it keeps the old page on screen until the new one
 * has rendered on the server, so a click looks ignored. That is what made
 * Settings feel slow (CC, 2026-09-29): its section nav had no boundary under it.
 * The root layout is covered by app/loading.tsx; the public marketing site is
 * exempt (its pages are static).
 *
 * Run: node --import tsx tests/loading-boundaries.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..");
const APP = join(ROOT, "app");
const EXEMPT = new Set(["app/(marketing)"]);

function layoutDirs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) layoutDirs(full, out);
    else if (name === "layout.tsx") out.push(dir);
  }
  return out;
}

const dirs = layoutDirs(APP).map((d) => relative(ROOT, d).split(sep).join("/"));
assert.ok(dirs.includes("app"), "precondition: the root layout was found");
const missing = dirs.filter((d) => !EXEMPT.has(d) && !existsSync(join(ROOT, d, "loading.tsx")));
assert.deepEqual(missing, [], `layout(s) with no loading.tsx beside them: ${missing.join(", ")}`);
console.log(`loading-boundaries: OK — ${dirs.length - EXEMPT.size} layouts each have a loading boundary`);
