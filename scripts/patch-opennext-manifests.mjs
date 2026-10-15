#!/usr/bin/env node
/**
 * scripts/patch-opennext-manifests.mjs - share the client map across API routes in the Worker bundle.
 *
 * WHY. Next writes a `*_client-reference-manifest.js` beside every App Router entry. For an API route
 * (`route_client-reference-manifest.js`) it is the same ~48 KiB map every time. @opennextjs/cloudflare
 * inlines these into the Worker in its load-manifest plugin, and already factors the large repeated
 * values of PAGE manifests into shared variables, but includes each ROUTE manifest whole through
 * `require(path)`. With 350 API routes that is about 16.7 MB of identical text in a Worker Cloudflare
 * caps at 64 MiB, and it is why every new API route cost ~60 KiB (measured 2026-10-15: main at
 * 64,887 KiB of a 65,024 KiB CI budget).
 *
 * WHAT. One condition in the plugin: factor every client-reference manifest, not only page ones. The
 * factoring is OpenNext's own (factorManifestValue / factorObjectValues), unchanged: the values are
 * the same objects, now referenced through shared constants, exactly as page manifests already are.
 *
 * HOW IT RUNS. `postinstall`, so `npm ci` in CI, in the deploy workflow and on a laptop all build the
 * same Worker. Idempotent. If the line is not found (a newer OpenNext changed the code), it says so
 * and changes nothing: the CI bundle-size gate then shows whether the upstream code still needs it.
 *
 * Run: node scripts/patch-opennext-manifests.mjs [--check]
 *   --check  exit 1 unless the installed plugin is patched (used by tests and CI diagnostics)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN = join(ROOT, "node_modules", "@opennextjs", "cloudflare", "dist", "cli", "build", "patches", "plugins", "load-manifest.js");

export const ORIGINAL = 'if (path.endsWith("page_client-reference-manifest.js")) {';
export const PATCHED = 'if (path.endsWith("_client-reference-manifest.js")) { // patched by scripts/patch-opennext-manifests.mjs: factor route manifests too';

/** The plugin source with the condition widened. Returns the state it found. */
export function patchSource(source) {
  if (source.includes(PATCHED)) return { state: "already", source };
  const count = source.split(ORIGINAL).length - 1;
  if (count !== 1) return { state: "not_found", source };
  return { state: "patched", source: source.replace(ORIGINAL, PATCHED) };
}

function main() {
  const check = process.argv.includes("--check");
  if (!existsSync(PLUGIN)) {
    // No OpenNext installed (a production-only install, say): nothing to build, nothing to patch.
    console.log("patch-opennext-manifests: @opennextjs/cloudflare is not installed here, nothing to do");
    process.exit(check ? 1 : 0);
  }
  const before = readFileSync(PLUGIN, "utf8");
  const result = patchSource(before);
  if (check) {
    const ok = result.state === "already";
    console.log(`patch-opennext-manifests: ${ok ? "patched" : "NOT patched"}`);
    process.exit(ok ? 0 : 1);
  }
  if (result.state === "not_found") {
    console.warn("patch-opennext-manifests: the expected line was not found in @opennextjs/cloudflare's load-manifest plugin; nothing was changed. If the Worker grows, check whether the new version still includes route manifests whole.");
    return;
  }
  if (result.state === "patched") writeFileSync(PLUGIN, result.source);
  console.log(`patch-opennext-manifests: ${result.state === "patched" ? "route manifests will be factored" : "already applied"}`);
}

// Run only when executed (`node scripts/patch-opennext-manifests.mjs`), never when a test imports it.
if (process.argv[1] && /patch-opennext-manifests\.mjs$/.test(process.argv[1])) main();
