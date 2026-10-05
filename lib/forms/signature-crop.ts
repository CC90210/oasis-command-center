/**
 * signature-crop.ts — crop a merchant's signature out of a dropped application
 * (photo OR PDF) into a PNG, server-side. Part of "extract the signature from a
 * dropped application and put it on the new SunBiz PDF" (CC 2026-06-25).
 *
 * The crop is driven by a normalized bounding box (0..1) — from Claude vision
 * (ai-document-extractor `_signature`) or operator adjustment. An operator ALWAYS
 * confirms the resulting preview before it lands on the legal PDF, so a slightly
 * off bbox is recoverable (re-crop or fall back to the signature pad).
 *
 *   - Photos (png/jpeg/webp/gif): sharp.extract → png.
 *   - PDFs: pdfjs-dist (legacy build) rasterizes the page onto an @napi-rs/canvas,
 *     then we crop the box. PNG only — the PDF embedder (application-pdf.ts) is
 *     embedPng, so a JPEG would silently fall back to the ruled line.
 */

import "server-only";

import { loadNativeRaster, loadPdfjs } from "./native-raster";

export type NormalizedBBox = { x: number; y: number; width: number; height: number };

export type CropResult =
  | { ok: true; pngBase64: string; width: number; height: number }
  | { ok: false; error: string };

const PDF_RENDER_SCALE = 2; // 2x for a crisp signature crop
const MIN_PX = 4;
// Raster-size ceilings so a malicious/oversized PDF page can't OOM the renderer.
const MAX_PDF_DIM = 4000; // px on the long side after scaling
const MAX_PDF_PIXELS = 24_000_000; // ~24 MP hard ceiling on W*H

function clampBox(box: NormalizedBBox, W: number, H: number) {
  // Pad the box slightly (vision boxes tend to clip) then clamp to the page.
  const padX = box.width * 0.06;
  const padY = box.height * 0.12;
  const x0 = Math.max(0, (box.x - padX) * W);
  const y0 = Math.max(0, (box.y - padY) * H);
  const x1 = Math.min(W, (box.x + box.width + padX) * W);
  const y1 = Math.min(H, (box.y + box.height + padY) * H);
  const left = Math.floor(x0);
  const top = Math.floor(y0);
  const width = Math.max(MIN_PX, Math.min(W - left, Math.ceil(x1 - x0)));
  const height = Math.max(MIN_PX, Math.min(H - top, Math.ceil(y1 - y0)));
  return { left, top, width, height };
}

function validBox(box: NormalizedBBox): boolean {
  return (
    Number.isFinite(box.x) && Number.isFinite(box.y) &&
    Number.isFinite(box.width) && Number.isFinite(box.height) &&
    box.width > 0 && box.height > 0 &&
    box.x >= 0 && box.y >= 0 && box.x + box.width <= 1.0001 && box.y + box.height <= 1.0001
  );
}

async function cropImage(bytes: Buffer, box: NormalizedBBox): Promise<CropResult> {
  const native = await loadNativeRaster();
  if (!native.available) return { ok: false, error: native.reason };
  const sharp = native.sharp;
  const img = sharp(bytes, { failOn: "none" }).rotate(); // honor EXIF orientation
  const meta = await img.metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) return { ok: false, error: "image_dims_unknown" };
  const r = clampBox(box, W, H);
  const png = await img.extract({ left: r.left, top: r.top, width: r.width, height: r.height }).png().toBuffer();
  return { ok: true, pngBase64: png.toString("base64"), width: r.width, height: r.height };
}

async function cropPdf(bytes: Buffer, box: NormalizedBBox, page: number): Promise<CropResult> {
  const native = await loadNativeRaster();
  if (!native.available) return { ok: false, error: native.reason };
  const { createCanvas } = native.canvasMod;
  // Legacy build runs in Node without a separate worker thread.
  const pdfjs = await loadPdfjs();
  if (!pdfjs) return { ok: false, error: "native_raster_unavailable:pdfjs" };
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  });
  const doc = await loadingTask.promise;
  try {
    const pageNum = Math.min(Math.max(1, Math.round(page || 1)), doc.numPages);
    const pdfPage = await doc.getPage(pageNum);
    // Cap the raster size (Codex 2026-06-25): a malicious/oversized page can
    // declare huge dimensions; rendering at scale 2 unbounded would exhaust memory
    // or time out. Fit the long side to MAX_DIM, reject anything still over the
    // pixel ceiling. Returns ok:false (no preview) rather than risking an OOM.
    const base = pdfPage.getViewport({ scale: 1 });
    const fitScale = Math.min(PDF_RENDER_SCALE, MAX_PDF_DIM / Math.max(base.width || 1, base.height || 1));
    const viewport = pdfPage.getViewport({ scale: Math.max(0.1, fitScale) });
    const W = Math.ceil(viewport.width);
    const H = Math.ceil(viewport.height);
    if (W < 1 || H < 1 || W * H > MAX_PDF_PIXELS) {
      return { ok: false, error: "pdf_page_too_large" };
    }
    const full = createCanvas(W, H);
    const fctx = full.getContext("2d");
    // pdfjs draws onto the @napi-rs/canvas 2D context (API-compatible). The
    // `canvas`/`canvasContext` types expect DOM types; @napi-rs/canvas is
    // structurally compatible at runtime (verified in scripts/test-signature-crop).
    await pdfPage.render({
      canvasContext: fctx as unknown as CanvasRenderingContext2D,
      canvas: full as unknown as HTMLCanvasElement,
      viewport,
    }).promise;
    const r = clampBox(box, W, H);
    const crop = createCanvas(r.width, r.height);
    crop.getContext("2d").drawImage(full, r.left, r.top, r.width, r.height, 0, 0, r.width, r.height);
    const png = crop.toBuffer("image/png");
    return { ok: true, pngBase64: png.toString("base64"), width: r.width, height: r.height };
  } finally {
    // Cleanup must never fail the crop (API name varies across pdfjs builds).
    try {
      await loadingTask.destroy();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Crop the signature region from a dropped application. `bbox` is normalized
 * (0..1) on the given 1-based `page`. Returns a base64 PNG (no data: prefix).
 */
export async function cropSignatureFromDocument(args: {
  bytes: Buffer;
  mimeType: string;
  bbox: NormalizedBBox;
  page?: number;
}): Promise<CropResult> {
  const mt = (args.mimeType || "").toLowerCase().split(";")[0].trim();
  if (!args.bytes || args.bytes.length === 0) return { ok: false, error: "empty_file" };
  if (!validBox(args.bbox)) return { ok: false, error: "invalid_bbox" };
  try {
    if (mt === "application/pdf") {
      return await cropPdf(args.bytes, args.bbox, args.page || 1);
    }
    if (mt === "image/png" || mt === "image/jpeg" || mt === "image/webp" || mt === "image/gif") {
      return await cropImage(args.bytes, args.bbox);
    }
    return { ok: false, error: `unsupported_type:${mt || "unknown"}` };
  } catch (e) {
    return { ok: false, error: "crop_failed:" + (e instanceof Error ? e.message : "error") };
  }
}

/** Convenience: base64 PNG → data URI for the existing applicant_signature field. */
export function toPngDataUri(base64: string): string {
  return `data:image/png;base64,${base64}`;
}
