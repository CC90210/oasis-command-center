/**
 * tests/patch-opennext-manifests.test.ts - API-route client maps are shared, and stay exactly equal.
 *
 * scripts/patch-opennext-manifests.mjs widens one condition in @opennextjs/cloudflare's load-manifest
 * plugin so ROUTE client-reference manifests get the same factoring PAGE manifests already get (each API
 * route otherwise carries its own whole ~48 KiB copy into the Worker). This pins three things:
 *   1. the edit itself: applied once, idempotent, and a no-op when the line is not there;
 *   2. the installed plugin is the patched one (postinstall ran);
 *   3. end to end, through OpenNext's own plugin code: two route manifests come back from the generated
 *      evalManifest deep-equal to what Next wrote, while their large shared value is in the code ONCE.
 *
 * Run: node --conditions=react-server --import tsx tests/patch-opennext-manifests.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error - a plain .mjs script with no type declarations
import { ORIGINAL, PATCHED, PLUGIN, patchSource } from "../scripts/patch-opennext-manifests.mjs";

async function main() {
  // ── 1. the edit ───────────────────────────────────────────────────────
  const sample = `const a = 1;\n    ${ORIGINAL}\n        x();\n    }\n`;
  const once = patchSource(sample);
  assert.equal(once.state, "patched");
  assert.ok(once.source.includes(PATCHED) && !once.source.includes(ORIGINAL));
  assert.equal(patchSource(once.source).state, "already", "idempotent");
  assert.equal(patchSource("nothing here").state, "not_found");
  assert.equal(patchSource(`${ORIGINAL}\n${ORIGINAL}`).state, "not_found", "an ambiguous match changes nothing");

  // ── 2. the installed plugin ───────────────────────────────────────────
  const installed = readFileSync(PLUGIN, "utf8");
  assert.ok(installed.includes(PATCHED), "the installed @opennextjs/cloudflare plugin is patched (npm ci runs the postinstall)");

  // ── 3. end to end through OpenNext's own plugin ───────────────────────
  const out = mkdtempSync(join(tmpdir(), "opennext-manifests-"));
  try {
    const app = join(out, "server-functions", "default", ".next", "server", "app");
    // A large shared value (as in a real map: every client module of the app), and a per-route difference.
    const clientModules: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) {
      clientModules[`/repo/components/Widget${i}.tsx`] = { id: 1000 + i, name: "*", chunks: [`chunk-${i}-aaaaaaaaaaaaaaaaaaaaaaaa`, `shared-bbbbbbbbbbbbbbbbbbbbbbbb`], async: false };
    }
    const manifestFor = (key: string) => ({
      moduleLoading: { prefix: "/_next/", crossOrigin: null },
      ssrModuleMapping: {},
      edgeSSRModuleMapping: {},
      clientModules,
      entryCSSFiles: { [`/repo/app${key.replace(/\/route$/, "")}/route`]: [] },
      rscModuleMapping: {},
      edgeRscModuleMapping: {},
    });
    const write = (key: string) => {
      const dir = join(app, ...key.split("/").filter(Boolean).slice(0, -1));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "route_client-reference-manifest.js"),
        `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST[${JSON.stringify(key)}]=${JSON.stringify(manifestFor(key))};`,
      );
    };
    write("/api/alpha/route");
    write("/api/beta/route");

    const plugin = await import(pathToFileURL(PLUGIN).href);
    let updaters: Array<{ callback: (a: { contents: string }) => Promise<string> }> = [];
    plugin.inlineLoadManifest(
      { updateContent: (_name: string, list: typeof updaters) => ((updaters = list), {}) },
      { outputDir: out, monorepoRoot: out, appBuildOutputPath: out },
    );
    assert.equal(updaters.length, 1);
    const source = [
      "function loadManifest(path, shouldCache = true) { return null; }",
      "function evalManifest(path, shouldCache = true) { return null; }",
    ].join("\n");
    const code = await updaters[0].callback({ contents: source });
    assert.ok(!code.includes("require("), "a route manifest is no longer required whole");
    const marker = "/repo/components/Widget7.tsx";
    assert.equal(code.split(marker).length - 1, 1, "the shared value is in the generated code once, not once per route");

    const g = globalThis as unknown as { __RSC_MANIFEST?: Record<string, unknown> };
    delete g.__RSC_MANIFEST;
    const evalManifest = new Function(`${code}\nreturn evalManifest;`)() as (p: string) => { __RSC_MANIFEST: Record<string, unknown> };
    for (const key of ["/api/alpha/route", "/api/beta/route"]) {
      const got = evalManifest(join(app, ...key.split("/").filter(Boolean)) + "_client-reference-manifest.js");
      assert.deepEqual(JSON.parse(JSON.stringify(got.__RSC_MANIFEST[key])), manifestFor(key), `${key}: what Next wrote, exactly`);
    }
    // A route with no manifest (a static metadata route) still gets the empty answer Next expects.
    assert.deepEqual(evalManifest("/x/.next/server/app/robots.txt/route_client-reference-manifest.js"), { __RSC_MANIFEST: {} });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  console.log("patch-opennext-manifests: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
