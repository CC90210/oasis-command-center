/**
 * lib/esign/pdf.ts — the e-signature PDF engine.
 *
 * MVP signing model (spec, not a drag-drop field-placement editor): the
 * signed PDF = the original source PDF with ONE certificate page APPENDED
 * per completed signer. Each certificate page shows that signer's rendered
 * signature image (or typed name in a script-style font), typed legal name,
 * signed date/time, email, IP, user-agent, consent confirmation, and the
 * source-PDF SHA-256 — ESIGN/UETA-sound regardless of the source PDF's
 * content, and needs no field-placement UI.
 *
 * Reuses the exact primitives already proven elsewhere in this repo:
 *   - doc.embedPng(Buffer.from(b64,'base64')) + page.drawImage — the
 *     signature-image embed pattern from lib/forms/application-pdf.ts:588-597.
 *   - PDFDocument.load(existing bytes) + draw-on-top-of-loaded-doc — the
 *     load-existing-PDF-and-overlay pattern from lib/forms/watermark.ts
 *     (watermarkPdfOverlay).
 *   - winAnsiSafe() — StandardFonts' WinAnsi encoding throws on unsupported
 *     characters (emoji, non-Latin scripts, smart quotes outside the CP1252
 *     subset); every string drawn on the cert page is run through this
 *     first. application-pdf.ts's winAnsiSafe (line ~316) is NOT exported,
 *     so this is a verbatim port of that implementation rather than a new
 *     import — see the reuse note on the function below.
 */

import "server-only";
import { createHash } from "node:crypto";

// ── Ported verbatim from lib/forms/application-pdf.ts:304-334 (private,
// not exported there) — pdf-lib's WinAnsi StandardFonts throw on any
// character outside this subset, and a merchant/signer's free-text (typed
// name, business name embedded in the title) must never crash PDF
// generation. Keep in sync if the source copy changes.
const WINANSI_EXTRA = new Set<number>([
  0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x20ac,
]);

function winAnsiSafe(s: string): string {
  let out = "";
  for (const ch of s || "") {
    const c = ch.codePointAt(0) ?? 0;
    if (
      c === 0x09 ||
      c === 0x0a ||
      c === 0x0d ||
      (c >= 0x20 && c <= 0x7e) ||
      (c >= 0xa0 && c <= 0xff) ||
      WINANSI_EXTRA.has(c)
    ) {
      out += ch;
    } else {
      out += "?";
    }
  }
  return out;
}

/** SHA-256 hex digest of raw PDF bytes — tamper-evidence stamp stored on
 *  esign_envelopes.source_pdf_sha256 / signed_pdf_sha256. */
export function sha256OfBytes(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type SignerCertInfo = {
  name: string;
  email: string;
  /** ISO 8601 signed timestamp (server-generated, never client-supplied). */
  signedAt: string;
  ip: string;
  userAgent: string;
  /** PNG data URI from the draw-signature pad. Mutually exclusive with typedName in practice (UI enforces one), but both are accepted defensively. */
  signatureDataUri?: string | null;
  /** Typed-name fallback — rendered in a script-style font when no drawn signature is present. */
  typedName?: string | null;
  consentDisclosureVersion: string;
};

/**
 * Load + validate a source PDF. Thin wrapper so callers (routes) don't
 * import pdf-lib directly and so a load failure is always the same typed
 * result shape (fail-closed: never partially process a corrupt source).
 */
export async function loadSourcePdf(
  bytes: Uint8Array | Buffer,
): Promise<{ ok: true; pageCount: number } | { ok: false; error: string }> {
  try {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(new Uint8Array(bytes));
    const pageCount = doc.getPageCount();
    if (pageCount < 1) return { ok: false, error: "pdf_no_pages" };
    return { ok: true, pageCount };
  } catch (e) {
    return { ok: false, error: "pdf_load_failed:" + (e instanceof Error ? e.message : "error") };
  }
}

const PAGE_W = 612; // US Letter, points (matches application-pdf.ts)
const PAGE_H = 792;
const MARGIN = 48;

function fmtSignedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }) || iso
  );
}

/**
 * Wrap text to a max width at a given font size — minimal reflow so the
 * user-agent string / long email never overruns the certificate box.
 */
function wrapText(
  text: string,
  font: import("pdf-lib").PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const words = winAnsiSafe(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Append one certificate page per signer to the source PDF and flatten.
 * Returns the completed signed PDF bytes. Fail-closed: any signer whose
 * signature image can't be embedded falls through to the typed-name /
 * ruled-line rendering (mirrors application-pdf.ts:588-597's try/catch)
 * rather than aborting the whole document — a single malformed image must
 * never block every other signer's completed certificate.
 */
export async function appendSignaturePages(
  sourceBytes: Uint8Array | Buffer,
  signers: SignerCertInfo[],
  opts: { sourceSha256: string; envelopeTitle: string },
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  try {
    const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
    const doc = await PDFDocument.load(new Uint8Array(sourceBytes));

    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
    // Closest achievable "script style" using only pdf-lib's 14 Standard
    // Fonts (no cursive/script TTF is bundled in this repo) — italic serif
    // at a larger size for the typed-name fallback.
    const scriptFont = await doc.embedFont(StandardFonts.TimesRomanItalic);

    const navy = rgb(0x00 / 255, 0x1f / 255, 0x54 / 255); // matches SunBiz brand navy (watermark.ts)
    const ink = rgb(0.1, 0.1, 0.12);
    const muted = rgb(0.42, 0.45, 0.5);
    const line = rgb(0.82, 0.84, 0.88);
    const white = rgb(1, 1, 1);

    for (const signer of signers) {
      const page = doc.addPage([PAGE_W, PAGE_H]);
      const contentW = PAGE_W - MARGIN * 2;
      let y = PAGE_H - MARGIN;

      // Header band.
      const headH = 42;
      page.drawRectangle({ x: MARGIN, y: y - headH, width: contentW, height: headH, color: navy });
      page.drawText(winAnsiSafe("CERTIFICATE OF COMPLETION"), {
        x: MARGIN + 12,
        y: y - headH + 14,
        size: 13,
        font: fontBold,
        color: white,
      });
      page.drawText(winAnsiSafe(opts.envelopeTitle).slice(0, 90), {
        x: MARGIN + 12,
        y: y - headH + 2,
        size: 8,
        font,
        color: rgb(0.85, 0.87, 0.92),
      });
      y -= headH + 24;

      // Signature block.
      const sigBoxW = 300;
      const sigBoxH = 70;
      let embedded = false;
      const uri = signer.signatureDataUri || "";
      if (uri.startsWith("data:image")) {
        try {
          const b64 = uri.split(",")[1] || "";
          const png = await doc.embedPng(Buffer.from(b64, "base64"));
          const fit = png.scaleToFit(sigBoxW, sigBoxH);
          page.drawImage(png, { x: MARGIN, y: y - sigBoxH, width: fit.width, height: fit.height });
          embedded = true;
        } catch {
          /* malformed image — fall through to typed-name / ruled line */
        }
      }
      if (!embedded) {
        const typed = winAnsiSafe((signer.typedName || signer.name || "").trim());
        if (typed) {
          page.drawText(typed, {
            x: MARGIN,
            y: y - sigBoxH + 24,
            size: 30,
            font: scriptFont,
            color: ink,
          });
        }
      }
      const sigLineY = y - sigBoxH - 2;
      page.drawLine({ start: { x: MARGIN, y: sigLineY }, end: { x: MARGIN + sigBoxW, y: sigLineY }, thickness: 0.8, color: ink });
      page.drawText(winAnsiSafe("Signature"), { x: MARGIN, y: sigLineY - 12, size: 8, font, color: muted });
      y = sigLineY - 34;

      // Details table.
      const rows: Array<[string, string]> = [
        ["Signer", winAnsiSafe(signer.name)],
        ["Email", winAnsiSafe(signer.email)],
        ["Signed at", fmtSignedAt(signer.signedAt)],
        ["IP address", winAnsiSafe(signer.ip || "unknown")],
        ["User agent", winAnsiSafe(signer.userAgent || "unknown")],
        ["Consent", `Signer affirmatively consented to sign electronically (disclosure ${winAnsiSafe(signer.consentDisclosureVersion)}).`],
        ["Source document SHA-256", opts.sourceSha256],
      ];
      const labelW = 150;
      for (const [label, value] of rows) {
        const valueLines = wrapText(value, font, 9, contentW - labelW - 8);
        const rowH = Math.max(16, valueLines.length * 12 + 4);
        page.drawText(winAnsiSafe(label), { x: MARGIN, y: y - 11, size: 8.5, font: fontBold, color: muted });
        let vy = y - 11;
        for (const vl of valueLines) {
          page.drawText(vl, { x: MARGIN + labelW, y: vy, size: 9, font, color: ink });
          vy -= 12;
        }
        y -= rowH;
        page.drawLine({ start: { x: MARGIN, y: y + 2 }, end: { x: MARGIN + contentW, y: y + 2 }, thickness: 0.5, color: line });
        y -= 8;
      }

      page.drawText(
        winAnsiSafe(
          "This certificate is generated and appended automatically by the OASIS e-signature system as tamper-evident proof of this signer's electronic signature, per the U.S. ESIGN Act and UETA.",
        ),
        { x: MARGIN, y: MARGIN, size: 7, font, color: muted, maxWidth: contentW, lineHeight: 9 },
      );
    }

    const out = await doc.save();
    return { ok: true, bytes: out };
  } catch (e) {
    return { ok: false, error: "append_failed:" + (e instanceof Error ? e.message : "error") };
  }
}
