/**
 * watermark.ts — brand a bank statement with the SunBiz watermark, server-side.
 * Applied ONLY to the lender-facing DERIVED copy at shop-out (lib/lead-documents
 * keeps the clean original untouched); the lead drawer + FundMate read the clean
 * original.
 *
 * NON-DESTRUCTIVE by default (2026-06-29, Adon ask: "don't alter the file"). For
 * PDFs we draw the mark as a LAYER on top of the original page content with
 * pdf-lib (watermarkPdfOverlay) — the text/vector/scan layer is preserved at
 * full quality, the source is never rasterized, and the mark is a separable set
 * of draw operators ("the image in the background"), not baked pixels. Only if
 * pdf-lib can't open/edit a source do we fall back to the legacy FLATTEN path
 * (watermarkPdfRaster: rasterize each page with pdfjs, paint the mark into the
 * pixels, reassemble an image-only PDF). Images have no layer, so they composite
 * — but reversibility is irrelevant there because the clean original is kept.
 *
 * Reversibility note: we never "un-watermark" a branded copy by stripping the
 * overlay — the clean original is preserved separately, so unwatermark = serve
 * the original. The overlay model just keeps the lender copy high-quality.
 *
 * OCR-friendly by design: the diagonal tiling sits at low opacity and the
 * provenance band lives in the bottom margin — faint enough that vision still
 * reads every transaction, strong enough to own.
 *
 * Stack: pdf-lib (overlay + assembly); pdfjs-dist (legacy build) + @napi-rs/canvas
 * for the raster fallback (shared with lib/forms/signature-crop.ts).
 */

import "server-only";

import { loadNativeRaster, loadPdfjs } from "./native-raster";

// ── SunBiz brand (mirrors the `sunbiz` block in CEO-Agent/scripts/email_template.py)
const NAVY = "#001F54";
const GOLD = "#D4A843";
const WORDMARK = "SUNBIZ FUNDING";

// Raster + size caps.
const PDF_RENDER_SCALE = 2.0; // ~144 DPI from the 72 DPI PDF user space — legible, bounded
const MAX_PDF_DIM = 3500; // px on the long side after scaling
const MAX_PDF_PIXELS = 24_000_000; // ~24 MP per-page / per-image ceiling
// PAGE CAPS ARE PER-PATH, because the two paths are not remotely the same price
// (measured 2026-08-07 on this runtime, and against production statements):
//
//   overlay (pdf-lib)  400 pages in  858ms / 332MB RSS  -> ~2ms/page
//   raster  (pdfjs)    ~165ms/page on real scanned statements (production doctor:
//                      10pp/1686ms, 9pp/1480ms, 7pp/1074ms)
//
// A single shared cap of 50 was sized for raster and silently imposed on the
// overlay as well, so ordinary long statements were refused outright by the very
// path that could brand them instantly. Production distribution for tenant
// `submissions` (150 largest statements): p50 13, p90 30, p99 47, max 59 — the
// old cap sat INSIDE the live distribution, and both over-cap statements were
// unencrypted (overlay-eligible). Shop-out refuses the WHOLE send when any one
// statement fails to brand, so each blocked an entire deal on every retry.
//
// Both remain FAIL-CLOSED: over the cap is an error, never a truncation.
//
// This SUPERSEDES the interim single `MAX_PAGES = 250` (d95fccb, 2026-08-10),
// which unblocked the 53-page incident by raising the shared cap. That value
// was still one number for two very different costs: at 165ms/page a 250-page
// encrypted statement would rasterize for ~41s and blow the 120s route budget
// on the path that cannot be made faster. Splitting the cap keeps the overlay
// generous where pages are nearly free and keeps raster inside its time budget.
const MAX_PAGES_OVERLAY = 400; // measured 858ms — bounded by memory, not time
const MAX_PAGES_RASTER = 120; // ~20s at 165ms/page — inside the 120s floor of
// every route that watermarks (shop-out 120s, shop-out/run 300s, thread retries
// 120s, watermark-variant 120s). Raster only runs for encrypted/unreadable
// sources, so this ceiling is reached far less often than the overlay's.
const PAGE_JPEG_QUALITY = 80; // raster page encode — bounds output PDF size
const IMAGE_JPEG_QUALITY = 85;

export type WatermarkProvenance = {
  businessName?: string | null;
  leadId?: string | null;
  /** Pre-formatted date string; defaults to today (UTC, YYYY-MM-DD). */
  date?: string | null;
};

export type WatermarkResult =
  | { ok: true; bytes: Buffer; mimeType: string; pages?: number; raster?: boolean }
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

// #001F54 / #D4A843 → pdf-lib rgb() components (0..1).
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

// Helvetica (WinAnsi) can't encode arbitrary Unicode (business names, smart
// punctuation, emoji) and pdf-lib's drawText/widthOfTextAtSize THROW on an
// unencodable char. Map to the WinAnsi-safe subset we use: printable ASCII +
// the Latin-1 supplement (which includes the "·" separator); everything else
// (smart quotes, CJK, emoji) becomes "?". Never throws.
function toWinAnsi(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) || 0;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) out += ch;
    else out += "?";
  }
  return out;
}

/**
 * NON-DESTRUCTIVE PDF watermark (2026-06-29). Draw the SunBiz mark as a LAYER on
 * top of the original page content using pdf-lib — the page's text/vector/scan
 * layer is preserved at full quality and the source is never rasterized. This is
 * "the image in the background" model: the watermark is a separable set of draw
 * operators, not baked pixels. We never reverse this copy (the clean original is
 * kept separately by lib/lead-documents.ts), so reversibility comes from the
 * preserved original, not from stripping the overlay.
 *
 * Encrypted sources are NOT handled here — stock pdf-lib can't decrypt content
 * streams, so overlaying an encrypted PDF yields corrupt output. We detect
 * encryption up front and bail to the raster path (pdfjs decrypts correctly).
 */
async function watermarkPdfOverlay(bytes: Buffer, prov: WatermarkProvenance): Promise<WatermarkResult> {
  try {
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const { PDFDocument, StandardFonts, degrees, rgb } = await import("pdf-lib");

    // ENCRYPTION GUARD (verified 2026-06-29 on real bank statements): permission-
    // encrypted bank PDFs are ~40% of statements, and stock pdf-lib does NOT
    // decrypt their content streams. `ignoreEncryption:true` lets load() succeed
    // but save() then emits the still-encrypted streams WITHOUT the /Encrypt dict
    // → a CORRUPT, mostly-blank PDF (stream-inflate proof: ~5-50% of streams
    // decode). So we must NOT overlay an encrypted source. Load WITHOUT
    // ignoreEncryption (throws on encrypted input) and bail to the raster path,
    // which uses pdfjs and DOES decrypt correctly. Any other load error also
    // bails to raster.
    let doc: import("pdf-lib").PDFDocument;
    try {
      doc = await PDFDocument.load(new Uint8Array(bytes));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: /encrypt/i.test(msg) ? "overlay_encrypted_source" : "overlay_load_failed:" + msg };
    }
    const pages = doc.getPages();
    if (pages.length < 1) return { ok: false, error: "pdf_no_pages" };
    // FAIL CLOSED — never truncate. The cap here is the OVERLAY's own (400), not
    // the raster path's: this path never rasterizes, so its cost per page is
    // ~2ms and a long statement is not a burden. See MAX_PAGES_OVERLAY.
    if (pages.length > MAX_PAGES_OVERLAY) {
      return { ok: false, error: `pdf_too_many_pages:${pages.length}` };
    }

    const font = await doc.embedFont(StandardFonts.HelveticaBold);

    // Embed the SunBiz logo once; fall back to the tiled wordmark if it isn't a
    // readable PNG (best-effort, same contract as the raster path).
    let logo: Awaited<ReturnType<typeof doc.embedPng>> | null = null;
    try {
      const logoBytes = await fs.readFile(
        path.join(process.cwd(), "public", "brand", "sunbiz-logo.png"),
      );
      logo = await doc.embedPng(logoBytes);
    } catch {
      logo = null;
    }

    const navy = hexToRgb(NAVY);
    const gold = hexToRgb(GOLD);
    const line = toWinAnsi(provenanceLine(prov));
    const ROT = -26; // degrees, matches the raster tiling angle

    for (const page of pages) {
      const { width: W, height: H } = page.getSize();
      if (W < 1 || H < 1) continue;
      const min = Math.min(W, H);

      // 1) Tile the mark diagonally across the page, on TOP of the content.
      const d = (ROT * Math.PI) / 180;
      const cos = Math.cos(d);
      const sin = Math.sin(d);
      if (logo && logo.width > 0) {
        const lw = min * 0.34;
        const lh = lw * (logo.height / logo.width);
        const stepX = lw * 1.45;
        const stepY = lh * 1.6;
        for (let cy = -lh; cy <= H + lh; cy += stepY) {
          const off = (Math.round(cy / stepY) % 2) * (stepX / 2);
          for (let cx = -lw + off; cx <= W + lw; cx += stepX) {
            // Place the logo CENTER at (cx, cy): pdf-lib rotates about the draw
            // origin (lower-left), so back out the rotated half-extents.
            const x = cx - (lw / 2) * cos + (lh / 2) * sin;
            const y = cy - (lw / 2) * sin - (lh / 2) * cos;
            page.drawImage(logo, { x, y, width: lw, height: lh, rotate: degrees(ROT), opacity: LOGO_OPACITY });
          }
        }
      } else {
        const size = Math.max(8, Math.round(min * 0.05));
        const tw = font.widthOfTextAtSize(WORDMARK, size);
        const stepX = tw + min * 0.12;
        const stepY = min * 0.16;
        for (let cy = 0; cy <= H + stepY; cy += stepY) {
          const off = (Math.round(cy / stepY) % 2) * (stepX / 2);
          for (let cx = -tw + off; cx <= W + stepX; cx += stepX) {
            page.drawText(WORDMARK, {
              x: cx, y: cy, size, font,
              color: rgb(navy.r, navy.g, navy.b),
              opacity: LOGO_OPACITY, rotate: degrees(ROT),
            });
          }
        }
      }

      // 2) Provenance band across the bottom margin (PDF origin = bottom-left).
      const bandH = Math.max(18, min * 0.03);
      const ruleH = Math.max(1, bandH * 0.07);
      page.drawRectangle({ x: 0, y: 0, width: W, height: bandH, color: rgb(navy.r, navy.g, navy.b), opacity: 0.85 });
      page.drawRectangle({ x: 0, y: bandH - ruleH, width: W, height: ruleH, color: rgb(gold.r, gold.g, gold.b), opacity: 0.9 });
      const fsize = Math.max(6, Math.round(bandH * 0.42));
      const tw = font.widthOfTextAtSize(line, fsize);
      page.drawText(line, {
        x: Math.max(2, (W - tw) / 2),
        y: bandH / 2 - fsize * 0.36, // vertically center cap-height in the band
        size: fsize, font, color: rgb(1, 1, 1), opacity: 0.96,
      });
    }

    const out = await doc.save();
    return { ok: true, bytes: Buffer.from(out), mimeType: "application/pdf", pages: pages.length };
  } catch (e) {
    return { ok: false, error: "overlay_error:" + (e instanceof Error ? e.message : "error") };
  }
}

/**
 * Overlay failures that the raster path enforces IDENTICALLY, so falling
 * through to it can only waste a full re-parse and muddy the reason. Default is
 * to fall through (raster handles sources pdf-lib cannot read); this list is the
 * narrow exception.
 */
const SHARED_POLICY_REFUSAL = ["pdf_too_many_pages", "pdf_no_pages"] as const;

async function watermarkPdf(bytes: Buffer, prov: WatermarkProvenance): Promise<WatermarkResult> {
  // Prefer the NON-DESTRUCTIVE overlay: it preserves the original page content
  // (selectable text, full resolution) and is the model Adon asked for. Fall
  // back to the legacy rasterize-and-flatten path ONLY when pdf-lib can't
  // open/edit the source (corrupt structure). Fail-closed: both failing →
  // { ok:false } so the caller refuses the send.
  const overlay = await watermarkPdfOverlay(bytes, prov);
  if (overlay.ok) return overlay;

  // Fall back ONLY when raster could plausibly do better — i.e. the overlay
  // could not READ the source (encrypted, or structurally broken), which is
  // exactly what pdfjs is more tolerant of.
  //
  // A DOCUMENT-POLICY refusal is different: both paths enforce it, so retrying
  // re-parses the whole file just to fail identically. That cost the operator
  // double the latency and produced the compound string
  // `overlay_failed[pdf_too_many_pages:55]|raster_failed[pdf_too_many_pages:55]`,
  // which reads like two separate faults and is what got reported as
  // "Overlay failed ... PDF too many pages". Surface the one real reason.
  if (SHARED_POLICY_REFUSAL.some((code) => overlay.error.includes(code))) {
    return overlay;
  }

  const raster = await watermarkPdfRaster(bytes, prov);
  if (raster.ok) return raster;

  // Same rule on the way out. When RASTER is the one refusing on document
  // policy, that refusal is the terminal, ACTIONABLE reason — the operator has
  // to split the file. The overlay's own failure here is "I could not read this
  // source" (encrypted / broken), which is neither actionable nor the blocker,
  // and pairing them produces
  // `overlay_failed[overlay_encrypted_source]|raster_failed[pdf_too_many_pages:121]`
  // — the same two-faults-in-one-string confusion this function exists to avoid.
  // Any OTHER raster failure keeps the compound string, because then both halves
  // are genuinely diagnostic. Flagged by CodeRabbit on PR #136.
  if (SHARED_POLICY_REFUSAL.some((code) => raster.error.includes(code))) {
    return raster;
  }

  return { ok: false, error: `overlay_failed[${overlay.error}]|raster_failed[${raster.error}]` };
}

async function watermarkPdfRaster(bytes: Buffer, prov: WatermarkProvenance): Promise<WatermarkResult> {
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
  const native = await loadNativeRaster();
  if (!native.available) return { ok: false, error: native.reason };
  const canvasMod = native.canvasMod;
  const { PDFDocument } = await import("pdf-lib");

  // pdfjs renders through DOM APIs Node lacks (DOMMatrix/Path2D/ImageData);
  // @napi-rs/canvas provides them. CRITICAL ORDER (the 2026-06-28 Vercel
  // failure, proven on the live Vercel runtime): pdfjs BINDS `DOMMatrix` at module-init, so
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
  const pdfjs = await loadPdfjs();
  if (!pdfjs) return { ok: false, error: "native_raster_unavailable:pdfjs" };

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
    if (srcDoc.numPages > MAX_PAGES_RASTER) {
      // FAIL CLOSED — never truncate-and-overwrite. A watermark result overwrites
      // the stored object, so silently emitting only the first MAX_PAGES_RASTER
      // would permanently lose a statement's later pages AND ship a partial
      // statement to lenders. An oversized statement instead surfaces an explicit
      // error at the guard for an operator to handle (e.g. split + re-upload).
      //
      // This cap is TIME-bound (rasterizing costs ~165ms/page), unlike the
      // overlay's. Reaching it means the source was also unusable by the overlay
      // — encrypted or structurally broken — so the operator genuinely has to
      // split the file.
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
    // raster:true — this copy is FLATTENED (lossy). Callers stamp it so a
    // rasterized watermark is never silent (e.g. metadata.shopout_wm_raster).
    return { ok: true, bytes: Buffer.from(outBytes), mimeType: "application/pdf", pages: numPages, raster: true };
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
  const native = await loadNativeRaster();
  if (!native.available) return { ok: false, error: native.reason };
  const sharp = native.sharp;
  const canvasMod = native.canvasMod;
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
