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

/**
 * Paint the SunBiz watermark directly onto a 2D canvas context sized W×H.
 * Three layers, back-to-front: faint diagonal tiling, a gold corner seal, and a
 * provenance band across the bottom margin. Used for both the PDF page raster
 * and the image-overlay path.
 */
function drawWatermark(
  ctx: import("@napi-rs/canvas").SKRSContext2D,
  W: number,
  H: number,
  prov: WatermarkProvenance,
): void {
  const min = Math.min(W, H);

  // 1) Faint diagonal tiled wordmark — low alpha so vision OCR reads through it.
  ctx.save();
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = NAVY;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.round(min * 0.045)}px Arial, Helvetica, sans-serif`;
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-Math.PI / 6); // -30°
  const stepX = ctx.measureText(WORDMARK).width + min * 0.12;
  const stepY = min * 0.16;
  // Tile across a diagonal-safe area (1.4× the page each way to cover corners).
  for (let y = -H * 0.7; y <= H * 0.7; y += stepY) {
    // Stagger alternate rows for a woven, less-griddy look.
    const offset = (Math.round(y / stepY) % 2) * (stepX / 2);
    for (let x = -W * 0.7 - offset; x <= W * 0.7; x += stepX) {
      ctx.fillText(WORDMARK, x, y);
    }
  }
  ctx.restore();

  // 2) Gold corner seal, top-right margin — the "owned" stamp.
  ctx.save();
  const r = Math.max(28, min * 0.075);
  const cx = W - r - min * 0.04;
  const cy = r + min * 0.04;
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = Math.max(2, r * 0.06);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.84, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1, r * 0.02);
  ctx.stroke();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = GOLD;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.round(r * 0.34)}px Arial, Helvetica, sans-serif`;
  ctx.fillText("SUNBIZ", cx, cy - r * 0.18);
  ctx.font = `600 ${Math.round(r * 0.2)}px Arial, Helvetica, sans-serif`;
  ctx.fillText("FUNDING", cx, cy + r * 0.12);
  ctx.font = `700 ${Math.round(r * 0.16)}px Arial, Helvetica, sans-serif`;
  ctx.fillText("· OWNED ·", cx, cy + r * 0.42);
  ctx.restore();

  // 3) Provenance band across the bottom margin — navy bar, white text.
  ctx.save();
  const bandH = Math.max(18, min * 0.032);
  ctx.globalAlpha = 0.86;
  ctx.fillStyle = NAVY;
  ctx.fillRect(0, H - bandH, W, bandH);
  // Thin gold rule on top of the band for a finished edge.
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = GOLD;
  ctx.fillRect(0, H - bandH, W, Math.max(1, bandH * 0.06));
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.round(bandH * 0.42)}px Arial, Helvetica, sans-serif`;
  ctx.fillText(provenanceLine(prov), W / 2, H - bandH / 2 + bandH * 0.03);
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
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const canvasMod = await import("@napi-rs/canvas");
  const { PDFDocument } = await import("pdf-lib");

  // pdfjs renders through DOM APIs Node lacks (DOMMatrix/Path2D/ImageData);
  // @napi-rs/canvas provides them. CRITICAL interop note (the 2026-06-28 Vercel
  // failure): under Next's serverExternalPackages bundling, the CJS module's
  // named exports are NOT reliably exposed as properties of the dynamic-import
  // namespace — they live under `.default`. So resolve every symbol through BOTH
  // the namespace AND `.default`, or the polyfill is a silent no-op on Vercel
  // and pdfjs throws "DOMMatrix is not defined" again. We also hard-fail if a
  // global still can't be resolved, rather than limping into the same error.
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

  // wasmUrl points pdfjs at its bundled image-decoder dir. The raw .wasm doesn't
  // instantiate in this Node runtime, but pdfjs then loads the pure-JS fallback
  // decoder (jbig2_nowasm_fallback.js) from the SAME dir — which decodes the
  // JBIG2/JPX scans correctly (verified on real statements). standardFontDataUrl
  // + cMapUrl cover non-embedded fonts. All three dirs are bundled into the
  // function via next.config.js outputFileTracingIncludes.
  const pdfjsRoot = path.join(process.cwd(), "node_modules", "pdfjs-dist");
  const dirUrl = (sub: string) => pathToFileURL(path.join(pdfjsRoot, sub) + path.sep).href;

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
      drawWatermark(ctx, W, H, prov);

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
  const { createCanvas } = await import("@napi-rs/canvas");

  const base = sharp(bytes, { failOn: "none" }).rotate(); // honor EXIF orientation
  const meta = await base.metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) return { ok: false, error: "image_dims_unknown" };
  if (W * H > MAX_PDF_PIXELS) return { ok: false, error: "image_too_large" };

  const overlay = createCanvas(W, H);
  drawWatermark(overlay.getContext("2d"), W, H, prov);
  const overlayPng = overlay.toBuffer("image/png");

  const composited = base.composite([{ input: overlayPng, left: 0, top: 0 }]);
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
