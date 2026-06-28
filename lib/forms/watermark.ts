/**
 * watermark.ts — flatten + brand a bank statement with the SunBiz watermark,
 * server-side. "Owning the lead": every bank statement that lands in our store
 * (and therefore every copy a lender ever receives via shop-out) carries an
 * elegant, unremovable SunBiz mark (CC 2026-06-28).
 *
 * Unremovable = the source is FLATTENED. For PDFs we rasterize each page, paint
 * the watermark into the pixels, and reassemble an image-only PDF — there's no
 * text/vector layer left to select or delete. For images we composite the mark
 * into the bitmap. Either way the watermark is part of the picture, not an
 * overlay anyone can strip in a PDF editor.
 *
 * OCR-friendly by design: our OWN underwriting (statement_parser.py, Anthropic
 * vision) reads the watermarked file (CC chose one-stored-file). So the diagonal
 * tiling sits at low opacity and the seal/provenance band live in the margins —
 * faint enough that vision still reads every transaction, strong enough to own.
 *
 * Reuses the signature pipeline's stack (lib/forms/signature-crop.ts):
 * pdfjs-dist (legacy build) → @napi-rs/canvas → pdf-lib, with the same
 * raster-size safety caps.
 */

import "server-only";

// ── SunBiz brand (mirrors the `sunbiz` block in CEO-Agent/scripts/email_template.py)
const NAVY = "#001F54";
const GOLD = "#D4A843";
const WORDMARK = "SUNBIZ FUNDING";

// Raster + size caps.
const PDF_RENDER_SCALE = 2.0; // ~144 DPI from the 72 DPI PDF user space — legible, bounded
const MAX_PDF_DIM = 3500; // px on the long side after scaling
const MAX_PDF_PIXELS = 24_000_000; // ~24 MP per-page / per-image ceiling
const MAX_PAGES = 50; // statements above this FAIL (never truncate) — see watermarkPdf
const PAGE_JPEG_QUALITY = 80; // raster page encode — bounds output PDF size
const IMAGE_JPEG_QUALITY = 85;

export type WatermarkProvenance = {
  businessName?: string | null;
  leadId?: string | null;
  /** Pre-formatted date string; defaults to today (UTC, YYYY-MM-DD). */
  date?: string | null;
};

export type WatermarkResult =
  | { ok: true; bytes: Buffer; mimeType: string; pages?: number }
  | { ok: false; error: string };

const IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

function shortId(id?: string | null): string {
  const s = (id || "").trim();
  if (!s) return "—";
  // First UUID segment is enough to identify the lead in a footer.
  return s.split("-")[0] || s.slice(0, 8);
}

function provenanceLine(p: WatermarkProvenance): string {
  const biz = (p.businessName || "").trim() || "SunBiz client";
  const date = (p.date || "").trim() || new Date().toISOString().slice(0, 10);
  return `SUNBIZ FUNDING   ·   ${biz}   ·   Lead ${shortId(p.leadId)}   ·   Submitted ${date}`;
}

// Diagonal logo opacity over the white areas — visible (industry-standard, per
// CC's lender examples) but light enough that vision OCR + a human still read
// every transaction.
const LOGO_OPACITY = 0.11;

type WatermarkAssets = {
  /** The SunBiz logo image, tiled across the page. Null → text-wordmark fallback. */
  logo: import("@napi-rs/canvas").Image | null;
  /** Registered font family (canvas has NO system fonts on Vercel — text is
   *  invisible without this; the 2026-06-28 "shapes render, text doesn't" bug). */
  font: string;
};

/**
 * Load the logo + register a real font ONCE per watermark call. @napi-rs/canvas
 * ships no fonts and the Vercel runtime has none, so fillText draws nothing
 * unless we register a TTF — we use LiberationSans-Bold from pdfjs-dist (already
 * bundled + server-external). The logo is public/brand/sunbiz-logo.png (bundled
 * via next.config.js outputFileTracingIncludes). Both are best-effort: a missing
 * logo falls back to a text wordmark, a missing font falls back to sans-serif.
 */
async function loadWatermarkAssets(
  canvasMod: typeof import("@napi-rs/canvas"),
): Promise<WatermarkAssets> {
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const cm = (canvasMod as { default?: Record<string, unknown> }).default ?? {};
  const ns = canvasMod as unknown as Record<string, unknown>;
  const pick = (k: string): unknown => ns[k] ?? cm[k];
  const GlobalFonts = pick("GlobalFonts") as
    | { registerFromPath?: (p: string, name?: string) => boolean; has?: (n: string) => boolean }
    | undefined;
  const loadImage = pick("loadImage") as
    | ((src: Buffer) => Promise<import("@napi-rs/canvas").Image>)
    | undefined;

  let font = "sans-serif";
  try {
    const fontPath = path.join(
      process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts", "LiberationSans-Bold.ttf",
    );
    if (GlobalFonts?.registerFromPath) {
      GlobalFonts.registerFromPath(fontPath, "WMSans");
      font = "WMSans";
    }
  } catch {
    /* keep sans-serif fallback */
  }

  let logo: WatermarkAssets["logo"] = null;
  try {
    if (loadImage) {
      const logoPath = path.join(process.cwd(), "public", "brand", "sunbiz-logo.png");
      logo = await loadImage(await fs.readFile(logoPath));
    }
  } catch {
    /* fall back to the text wordmark */
  }
  return { logo, font };
}

/**
 * Paint the SunBiz watermark onto a 2D canvas (W×H): the SunBiz LOGO tiled
 * diagonally across the page (over the white areas — the industry-standard look
 * CC asked for), plus a provenance band in the bottom margin. Used for both the
 * PDF page raster and the image-overlay path.
 */
function drawWatermark(
  ctx: import("@napi-rs/canvas").SKRSContext2D,
  W: number,
  H: number,
  prov: WatermarkProvenance,
  assets: WatermarkAssets,
): void {
  const min = Math.min(W, H);

  // 1) Tile the SunBiz logo diagonally across the whole page.
  ctx.save();
  ctx.globalAlpha = LOGO_OPACITY;
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-Math.PI / 7); // ~-26°
  if (assets.logo && assets.logo.width > 0) {
    const lw = min * 0.34;
    const lh = lw * (assets.logo.height / assets.logo.width);
    const stepX = lw * 1.45;
    const stepY = lh * 1.5;
    for (let y = -H; y <= H; y += stepY) {
      const off = (Math.round(y / stepY) % 2) * (stepX / 2);
      for (let x = -W - off; x <= W; x += stepX) {
        ctx.drawImage(assets.logo, x - lw / 2, y - lh / 2, lw, lh);
      }
    }
  } else {
    // Logo unavailable → tile the wordmark text (needs the registered font).
    ctx.fillStyle = NAVY;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(min * 0.05)}px ${assets.font}`;
    const stepX = ctx.measureText(WORDMARK).width + min * 0.12;
    const stepY = min * 0.16;
    for (let y = -H; y <= H; y += stepY) {
      const off = (Math.round(y / stepY) % 2) * (stepX / 2);
      for (let x = -W - off; x <= W; x += stepX) ctx.fillText(WORDMARK, x, y);
    }
  }
  ctx.restore();

  // 2) Provenance band across the bottom margin — navy bar + gold rule + white
  //    text (registered font), so a leaked statement traces back to us.
  ctx.save();
  const bandH = Math.max(18, min * 0.030);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = NAVY;
  ctx.fillRect(0, H - bandH, W, bandH);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = GOLD;
  ctx.fillRect(0, H - bandH, W, Math.max(1, bandH * 0.07));
  ctx.globalAlpha = 0.96;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(bandH * 0.42)}px ${assets.font}`;
  ctx.fillText(provenanceLine(prov), W / 2, H - bandH / 2);
  ctx.restore();
}

async function watermarkPdf(bytes: Buffer, prov: WatermarkProvenance): Promise<WatermarkResult> {
  // Rasterize each page with pdfjs, paint the watermark into the pixels, and
  // reassemble a clean image-only PDF with pdf-lib. This is the only approach
  // that handles REAL bank statements (verified 2026-06-28 on production files):
  //   - pdfjs DECRYPTS permission-encrypted PDFs (bank exports almost always
  //     are) — pdf-lib cannot, it just preserves the /Encrypt dict.
  //   - with the image-decoder WASM wired below, pdfjs decodes JBIG2/JPX SCANNED
  //     pages (which is what these statements are) instead of dropping them.
  //   - the output is flattened + unencrypted → unremovable mark AND universally
  //     openable by every lender.
  // Two things make pdfjs work in the serverless runtime (the 2026-06-28
  // "DOMMatrix is not defined" production failure): the DOM-global polyfill from
  // @napi-rs/canvas, and pointing wasmUrl/standardFontDataUrl/cMapUrl at the
  // pdfjs-dist assets (bundled into the function via next.config.js
  // outputFileTracingIncludes).
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const canvasMod = await import("@napi-rs/canvas");
  const { PDFDocument } = await import("pdf-lib");

  // pdfjs renders through DOM APIs Node lacks (DOMMatrix/Path2D/ImageData);
  // @napi-rs/canvas provides them. CRITICAL ORDER (the 2026-06-28 Vercel
  // failure, proven via /api/wmdiag): pdfjs BINDS `DOMMatrix` at module-init, so
  // the globals MUST be on globalThis BEFORE pdfjs is imported — setting them
  // after the import is too late and pdfjs throws "DOMMatrix is not defined"
  // even though the global is present at render time. Resolve canvas symbols
  // through BOTH the namespace and `.default` (interop-safe), hard-fail if still
  // missing, set the globals, and ONLY THEN import pdfjs.
  const cm = (canvasMod as { default?: Record<string, unknown> }).default ?? {};
  const ns = canvasMod as unknown as Record<string, unknown>;
  const resolve = (k: string): unknown => ns[k] ?? cm[k];
  const createCanvas = resolve("createCanvas") as typeof import("@napi-rs/canvas").createCanvas;
  if (typeof createCanvas !== "function") {
    return { ok: false, error: "canvas_unavailable:createCanvas" };
  }
  const g = globalThis as Record<string, unknown>;
  for (const k of ["DOMMatrix", "Path2D", "ImageData", "DOMPoint"]) {
    if (!g[k]) {
      const v = resolve(k);
      if (v) g[k] = v;
    }
  }
  if (!g.DOMMatrix) return { ok: false, error: "dommatrix_unavailable" };

  // Import pdfjs AFTER the globals are set (see above).
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // wasmUrl points pdfjs at its bundled image-decoder dir. The raw .wasm doesn't
  // instantiate in this Node runtime, but pdfjs then loads the pure-JS fallback
  // decoder (jbig2_nowasm_fallback.js) from the SAME dir — which decodes the
  // JBIG2/JPX scans correctly (verified on real statements). standardFontDataUrl
  // + cMapUrl cover non-embedded fonts. All three dirs are bundled into the
  // function via next.config.js outputFileTracingIncludes.
  const pdfjsRoot = path.join(process.cwd(), "node_modules", "pdfjs-dist");
  const dirUrl = (sub: string) => pathToFileURL(path.join(pdfjsRoot, sub) + path.sep).href;

  // pdfjs uses a main-thread "fake worker" in Node and tries to import its
  // worker module. Next bundles pdf.mjs into a chunk but NOT the worker, so the
  // default lookup hits a non-existent .next/server/chunks/pdf.worker.mjs (the
  // 2026-06-28 Vercel "fake worker failed" error). Point workerSrc at the
  // node_modules worker we bundle via next.config.js outputFileTracingIncludes.
  try {
    (pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
      pathToFileURL(path.join(pdfjsRoot, "legacy", "build", "pdf.worker.mjs")).href;
  } catch {
    /* fall back to pdfjs default if the shape ever changes */
  }

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    wasmUrl: dirUrl("wasm"),
    standardFontDataUrl: dirUrl("standard_fonts"),
    cMapUrl: dirUrl("cmaps"),
    cMapPacked: true,
  });
  const srcDoc = await loadingTask.promise;
  try {
    if (srcDoc.numPages < 1) return { ok: false, error: "pdf_no_pages" };
    if (srcDoc.numPages > MAX_PAGES) {
      // FAIL CLOSED — never truncate-and-overwrite. A watermark result overwrites
      // the stored object, so silently emitting only the first MAX_PAGES would
      // permanently lose a statement's later pages AND ship a partial statement
      // to lenders. An oversized statement (rare) instead surfaces an explicit
      // error at the guard for an operator to handle (e.g. split + re-upload).
      return { ok: false, error: `pdf_too_many_pages:${srcDoc.numPages}` };
    }
    const numPages = srcDoc.numPages;

    const wmAssets = await loadWatermarkAssets(canvasMod);
    const outDoc = await PDFDocument.create();
    for (let p = 1; p <= numPages; p++) {
      const page = await srcDoc.getPage(p);
      const unit = page.getViewport({ scale: 1 }); // PDF points (physical size)
      const fitScale = Math.min(
        PDF_RENDER_SCALE,
        MAX_PDF_DIM / Math.max(unit.width || 1, unit.height || 1),
      );
      const viewport = page.getViewport({ scale: Math.max(0.1, fitScale) });
      const W = Math.ceil(viewport.width);
      const H = Math.ceil(viewport.height);
      if (W < 1 || H < 1 || W * H > MAX_PDF_PIXELS) {
        return { ok: false, error: `pdf_page_too_large:${p}` };
      }
      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext("2d");
      // White base so a transparent region rasterizes opaque (not black).
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      await page.render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport,
      }).promise;
      drawWatermark(ctx, W, H, prov, wmAssets);

      const jpeg = await canvas.encode("jpeg", PAGE_JPEG_QUALITY);
      const img = await outDoc.embedJpg(jpeg);
      const outPage = outDoc.addPage([unit.width || W, unit.height || H]);
      outPage.drawImage(img, { x: 0, y: 0, width: unit.width || W, height: unit.height || H });
    }
    const outBytes = await outDoc.save();
    return { ok: true, bytes: Buffer.from(outBytes), mimeType: "application/pdf", pages: numPages };
  } finally {
    try {
      await loadingTask.destroy();
    } catch {
      /* best-effort */
    }
  }
}

async function watermarkImage(
  bytes: Buffer,
  mimeType: string,
  prov: WatermarkProvenance,
): Promise<WatermarkResult> {
  const sharp = (await import("sharp")).default;
  const canvasMod = await import("@napi-rs/canvas");
  const cm = (canvasMod as { default?: Record<string, unknown> }).default ?? {};
  const ns = canvasMod as unknown as Record<string, unknown>;
  const createCanvas = (ns.createCanvas ?? cm.createCanvas) as typeof import("@napi-rs/canvas").createCanvas;

  // Apply EXIF rotation AND bound the size FIRST, then read the real dimensions
  // from the resulting buffer. metadata() reports PRE-rotation dims, so reading
  // them before .rotate() gives a swapped W/H for portrait photos → the overlay
  // mismatches and sharp throws "Image to composite must have same dimensions"
  // (the 2026-06-28 backfill failures). Downscaling oversized photos here (long
  // side capped) replaces the old hard image_too_large failure — we brand the
  // statement instead of refusing it.
  const MAX_IMG_DIM = 3000;
  let pre = sharp(bytes, { failOn: "none" }).rotate();
  const m0 = await pre.metadata();
  const long = Math.max(m0.width || 0, m0.height || 0);
  if (long > MAX_IMG_DIM) {
    pre = pre.resize({ width: MAX_IMG_DIM, height: MAX_IMG_DIM, fit: "inside" });
  }
  const rotated = await pre.toBuffer();
  const meta = await sharp(rotated).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) return { ok: false, error: "image_dims_unknown" };

  const wmAssets = await loadWatermarkAssets(canvasMod);
  const overlay = createCanvas(W, H);
  drawWatermark(overlay.getContext("2d"), W, H, prov, wmAssets);
  const overlayPng = overlay.toBuffer("image/png");

  const composited = sharp(rotated).composite([{ input: overlayPng, left: 0, top: 0 }]);
  // Preserve the original raster format where sharp can write it; HEIC/HEIF and
  // anything else flatten to JPEG (sharp can't reliably encode HEIC).
  const mt = mimeType.toLowerCase();
  if (mt === "image/png") {
    return { ok: true, bytes: await composited.png().toBuffer(), mimeType: "image/png" };
  }
  if (mt === "image/webp") {
    return { ok: true, bytes: await composited.webp({ quality: 88 }).toBuffer(), mimeType: "image/webp" };
  }
  return {
    ok: true,
    bytes: await composited.jpeg({ quality: IMAGE_JPEG_QUALITY }).toBuffer(),
    mimeType: "image/jpeg",
  };
}

/**
 * Watermark a bank statement (PDF or image). Returns the flattened, branded
 * bytes + the resulting mime type (may differ from input — e.g. HEIC → JPEG).
 * Never throws: any failure returns { ok:false } so the caller can keep the
 * original untouched (we never destroy a document because branding failed).
 */
export async function watermarkBankStatement(args: {
  bytes: Buffer;
  mimeType: string;
  provenance: WatermarkProvenance;
}): Promise<WatermarkResult> {
  const mt = (args.mimeType || "").toLowerCase().split(";")[0].trim();
  if (!args.bytes || args.bytes.length === 0) return { ok: false, error: "empty_file" };
  try {
    if (mt === "application/pdf") return await watermarkPdf(args.bytes, args.provenance);
    if (IMAGE_MIME.has(mt)) return await watermarkImage(args.bytes, mt, args.provenance);
    return { ok: false, error: `unsupported_type:${mt || "unknown"}` };
  } catch (e) {
    return { ok: false, error: "watermark_failed:" + (e instanceof Error ? e.message : "error") };
  }
}
