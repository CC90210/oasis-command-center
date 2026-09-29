/**
 * Every redirect in middleware.ts lands on a page that exists.
 *
 * WHY. A redirect to a missing route converts a working bookmark into a 404,
 * which is worse than leaving the old page up — and it fails silently, because
 * the redirect itself answers a healthy 307. The OASIS OS moves routes around
 * (plan W3), and OASIS's reps open /pipeline, /web-leads and /training from
 * bookmarks every day. So every target is resolved against app/ here, the same
 * way Next's router would: route groups `(x)` are transparent and `[param]`
 * segments match anything.
 *
 * It also pins the two Phase-1 decisions: /feed is a real Team page again (its
 * old redirect to /operations must not come back), and /money is a real page,
 * never a redirect.
 *
 * Run: node --conditions=react-server --import tsx tests/os-redirects.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { OS_REDIRECTS } from "../lib/os/redirects";
import { MARKETING_HOME_PATH } from "../lib/marketing/routes";

const APP = join(process.cwd(), "app");
const PAGE_FILES = ["page.tsx", "page.ts", "page.jsx", "page.js", "page.mdx"];

function hasPage(dir: string): boolean {
  return PAGE_FILES.some((f) => existsSync(join(dir, f)));
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
  } catch {
    return [];
  }
}

/** Does `urlPath` resolve to a page under app/, the way the App Router would? */
function routeExists(urlPath: string): boolean {
  const pathOnly = urlPath.split(/[?#]/)[0];
  const segments = pathOnly.split("/").filter(Boolean);
  const walk = (dir: string, i: number): boolean => {
    if (i === segments.length && hasPage(dir)) return true;
    for (const child of childDirs(dir)) {
      const next = join(dir, child);
      if (/^\(.+\)$/.test(child)) {
        if (walk(next, i)) return true; // route group: consumes no segment
      } else if (i < segments.length && (child === segments[i] || /^\[[^.\]]+\]$/.test(child))) {
        if (walk(next, i + 1)) return true;
      } else if (/^\[\[?\.\.\..+\]?\]$/.test(child)) {
        if (hasPage(next)) return true; // catch-all
      }
    }
    return false;
  };
  return walk(APP, 0);
}

// ── the resolver itself, against routes that certainly exist / do not ─────
assert.equal(routeExists("/"), true, "app/page.tsx");
assert.equal(routeExists("/pipeline"), true);
assert.equal(routeExists("/settings/audit-log"), true);
assert.equal(routeExists("/projects/abc-123"), true, "[id] segment");
assert.equal(routeExists("/privacy"), true, "(marketing) route group is transparent");
assert.equal(routeExists("/definitely-not-a-route"), false);
assert.equal(routeExists("/settings/definitely-not-a-section"), false);

// ── the OS moves ──────────────────────────────────────────────────────────
for (const [from, to] of Object.entries(OS_REDIRECTS)) {
  assert.ok(to.startsWith("/") && !to.startsWith("//"), `${from} must redirect same-origin (got ${to})`);
  assert.notEqual(from, to, `${from} redirects to itself`);
  assert.ok(!(to in OS_REDIRECTS), `${from} → ${to} is a redirect chain`);
  assert.ok(routeExists(to), `${from} → ${to}, but ${to} is not a page under app/`);
}
assert.equal(OS_REDIRECTS["/integrations"], "/settings/connections", "Connections moved into Settings");
assert.ok(!("/feed" in OS_REDIRECTS), "/feed is a real Team page — it no longer redirects to /operations");
assert.ok(!("/money" in OS_REDIRECTS), "/money is a real page, never a redirect");

// ── middleware.ts uses them, and carries no stale literal of its own ──────
const middleware = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");
const block = middleware.match(/const REDIRECT_MAP[^=]*=\s*\{([\s\S]*?)\n\s*\};/);
assert.ok(block, "middleware.ts must declare REDIRECT_MAP");
assert.match(block![1], /\.\.\.OS_REDIRECTS/, "REDIRECT_MAP must spread lib/os/redirects.ts OS_REDIRECTS");
const literals = [...block![1].matchAll(/^\s*"([^"]+)"\s*:\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]] as const);
for (const [from, to] of literals) {
  assert.ok(routeExists(to), `middleware REDIRECT_MAP ${from} → ${to}, but ${to} is not a page`);
}
assert.ok(!literals.some(([from]) => from === "/feed"), "the /feed → /operations redirect must not come back");
assert.ok(!literals.some(([from]) => from === "/money"), "/money must not redirect");
// The one computed entry: the marketing home collapses onto "/".
assert.match(block![1], /\[MARKETING_HOME_PATH\]:\s*"\/"/);
assert.ok(routeExists(MARKETING_HOME_PATH), `${MARKETING_HOME_PATH} must exist for the "/" rewrite to land`);

console.log(
  `os-redirects: OK — ${Object.keys(OS_REDIRECTS).length} OS redirect(s) + ${literals.length} literal(s), every target is a page`,
);
