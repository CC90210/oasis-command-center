/**
 * tests/perf-nav-warm.test.ts - warming a route never renders its data (2026-10-28).
 *
 * router.prefetch(href) with no kind is a FULL prefetch here: the server renders the whole page on
 * every hover and the router keeps it for five minutes, so a click could show a board as it was when
 * the pointer passed (next.config.js refuses a client router cache for exactly that reason). Pinned:
 *   1. warmRoute asks for an AUTO prefetch, swallows a throw, and is the only place that names Next's
 *      internal PrefetchKind; the installed Next still defaults router.prefetch to FULL, which is why
 *      the helper exists;
 *   2. every intent warm in the shell goes through it: no bare router.prefetch( in components/;
 *   3. the board: per-lead links keep viewport prefetch off and are warmed from the board on intent,
 *      the lead page has a loading.tsx for that warm to stop at, and in-page links show a pending state;
 *   4. the root layout's two manifest reads share one stored-row read (keyed on the slug alone).
 *
 * Run: node --conditions=react-server --import tsx tests/perf-nav-warm.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  // 1. The helper, at runtime.
  const { warmRoute } = await import("../lib/perf/warm-route");
  const { PrefetchKind } = await import("next/dist/client/components/router-reducer/router-reducer-types");
  assert.equal(PrefetchKind.AUTO, "auto", "the internal enum still carries AUTO");
  const calls: Array<[string, unknown]> = [];
  warmRoute({ prefetch: (href, options) => calls.push([href, options]) }, "/pipeline");
  assert.deepEqual(calls, [["/pipeline", { kind: "auto" }]], "an AUTO prefetch, never the FULL default");
  assert.doesNotThrow(() => warmRoute({ prefetch: () => { throw new Error("router not ready"); } }, "/x"), "best-effort");

  const nextRouter = read("node_modules/next/dist/client/components/app-router-instance.js");
  assert.match(
    nextRouter,
    /kind: \(_options_kind = options == null \? void 0 : options\.kind\) != null \? _options_kind : _routerreducertypes\.PrefetchKind\.FULL/,
    "the installed Next still defaults router.prefetch to FULL; if this changes, re-check lib/perf/warm-route.ts",
  );

  // 2. Every intent warm goes through the helper.
  const bare = sourceFiles(join(ROOT, "components")).filter((file) => /router\.prefetch\(/.test(readFileSync(file, "utf8")));
  assert.deepEqual(bare.map((file) => relative(ROOT, file)), [], "no component calls router.prefetch directly");
  const internal = [...sourceFiles(join(ROOT, "components")), ...sourceFiles(join(ROOT, "lib")), ...sourceFiles(join(ROOT, "app"))]
    .filter((file) => readFileSync(file, "utf8").includes("router-reducer/router-reducer-types"))
    .map((file) => relative(ROOT, file));
  assert.deepEqual(internal, ["lib/perf/warm-route.ts"], "Next's internal PrefetchKind is named in one place");
  assert.match(read("components/os/RailRow.tsx"), /warmRoute\(router, href\);/);
  assert.match(read("components/Sidebar.tsx"), /warmRoute\(router, href\);/);

  // 3. The board.
  const board = read("components/manifest/LeadPipelineView.tsx");
  const rowLinks = board.match(/href=\{`\$\{basePath\}\/\$\{row\.id\}`\}\n\s*prefetch=\{false\}\n\s*data-warm-route/g) || [];
  assert.equal(rowLinks.length, 2, "the desktop row and the mobile card keep viewport prefetch off and are warmed on intent");
  assert.match(board, /href=\{m\.auditHref\}\n\s*prefetch=\{false\}\n\s*data-warm-route/, "so does the per-row audit link");
  assert.match(board, /<div className="space-y-4" onPointerOver=\{warmRowLink\} onFocus=\{warmRowLink\}>/, "one delegated warm for every row");
  assert.match(board, /closest\?\.\("a\[data-warm-route\]"\)/);
  assert.match(board, /warmRoute\(router, href\);/);
  assert.equal((board.match(/<LinkPendingBar \/>/g) || []).length, 2, "a row being opened says so");
  assert.ok((board.match(/<LinkPending /g) || []).length >= 4, "stage chips, All stages, Previous and Next say so too");
  assert.match(board, /useEffect\(\(\) => \{\n\s*reportBoardVisible\(\);\n\s*\}, \[boardKey\]\);/, "the board reports each redraw for a new view");
  assert.match(board, /const boardKey = `[^`]*resultWindow\?\.page[^`]*resultWindow\?\.allStagesHref[^`]*`;/, "the key changes with every filter: stage, search, page, rep and queue");
  assert.ok(existsSync(join(ROOT, "app/pipeline/[id]/loading.tsx")), "the lead page has a loading boundary for the warm to stop at");
  assert.match(read("app/pipeline/page.tsx"), /<LinkPending/, "the queue and rep links show a pending state");
  const pending = read("components/os/LinkPending.tsx");
  assert.match(pending, /^"use client";/);
  assert.equal((pending.match(/useLinkStatus\(\)/g) || []).length, 2);

  // 4. One stored-row read per slug.
  const loader = read("lib/manifest/loader.ts");
  assert.match(loader, /const readManifestRow = cache\(async \(key: string\)/, "the row read is keyed on the slug alone");
  assert.match(loader, /await readManifestRow\(key\);/, "getManifestRead reads through it");
  assert.equal((loader.match(/\.from\("tenant_manifests"\)\n\s*\.select\("slug, tenant_id, manifest"\)/g) || []).length, 1, "and nowhere else by slug");

  console.log("perf-nav-warm: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
