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

// Raster + size caps (mirror signature-crop.ts).
const PDF_RENDER_SCALE = 2.0; // ~144 DPI from the 72 DPI PDF user space — crisp but bounded
const MAX_PDF_DIM = 4000; // px on the long side after scaling
const MAX_PDF_PIXELS = 24_000_000; // ~24 MP per-page hard ceiling
const MAX_PAGES = 40; // page ceiling so a huge statement can't blow the function budget
const PAGE_JPEG_QUALITY = 78; // raster page encode — bounds output PDF size
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
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const { PDFDocument } = await import("pdf-lib");

  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const srcDoc = await loadingTask.promise;
  try {
    const numPages = Math.min(srcDoc.numPages, MAX_PAGES);
    if (numPages < 1) return { ok: false, error: "pdf_no_pages" };

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
      // White base so a transparent page region rasterizes opaque (not black).
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
      // New page sized to the ORIGINAL physical page (points), raster filled in.
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
