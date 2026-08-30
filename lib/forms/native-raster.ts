/**
 * native-raster.ts — the ONE boundary through which the native raster stack
 * (@napi-rs/canvas, sharp, pdfjs-dist's render path) is loaded.
 *
 * Why (2026-08-30, Cloudflare migration): these packages are native Node
 * addons (.node binaries) that can never run on Cloudflare Workers, and even
 * BUNDLING them breaks the OpenNext build. The specifiers below are runtime
 * variables, so no bundler (webpack on Vercel, esbuild in OpenNext) can
 * statically resolve them:
 *   - On Vercel nothing changes — the packages are serverExternalPackages,
 *     present in node_modules, and import() resolves them at runtime.
 *   - On Workers the import throws, callers get { available: false }, and
 *     every consumer already fails CLOSED with a structured error while the
 *     clean original is preserved (signature pad fallback / overlay-only
 *     watermarking, which is pure pdf-lib and works everywhere).
 *
 * The full port options for the affected paths (encrypted-PDF raster
 * watermark, image watermark, PDF signature crop) are scoped in
 * Business-Empire-Agent brain/WAVE3_OASIS_CC_RUNBOOK.md: Node sidecar on the
 * ops lane vs a CanvasKit-WASM spike. satori/resvg do NOT fit — nothing here
 * renders from SVG, and pdfjs needs a canvas IMPLEMENTATION to draw into.
 */

import "server-only";

/** Bundler-opaque dynamic import: the variable specifier defeats static
 *  resolution in both webpack and esbuild; webpackIgnore silences webpack's
 *  critical-dependency warning and keeps the native import() at runtime. */
async function loadModule(specifier: string): Promise<unknown> {
  return import(/* webpackIgnore: true */ specifier);
}

export type NativeRaster =
  | {
      available: true;
      canvasMod: typeof import("@napi-rs/canvas");
      sharp: typeof import("sharp").default;
    }
  | { available: false; reason: string };

// Cache SUCCESS only (codex audit 2026-08-30): a transient load failure must
// not poison the warm instance — the next request retries the import.
let cached: Extract<NativeRaster, { available: true }> | null = null;

export async function loadNativeRaster(): Promise<NativeRaster> {
  if (cached) return cached;
  try {
    const canvasMod = (await loadModule("@napi-rs/canvas")) as typeof import("@napi-rs/canvas");
    const sharpNs = (await loadModule("sharp")) as { default: typeof import("sharp").default };
    cached = { available: true, canvasMod, sharp: sharpNs.default ?? (sharpNs as never) };
    return cached;
  } catch (e) {
    return {
      available: false,
      reason: "native_raster_unavailable:" + (e instanceof Error ? e.message.slice(0, 120) : "import_failed"),
    };
  }
}

/** pdfjs' legacy build renders through the native canvas stack, so it lives
 *  behind the same boundary (it also drags multi-MB assets into a bundle). */
export async function loadPdfjs(): Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs") | null> {
  try {
    return (await loadModule("pdfjs-dist/legacy/build/pdf.mjs")) as typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    return null;
  }
}
