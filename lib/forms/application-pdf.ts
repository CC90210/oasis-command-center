/**
 * application-pdf.ts — generate the signed SunBiz Funding application PDF.
 *
 * On the full-application's final step, the merchant's submitted data + their
 * drawn signature are rendered into a one/two-page PDF whose layout mirrors the
 * SunBiz Funding application form (header / four sections / signature block /
 * footer). The PDF is then filed to the lead's documents (see
 * lib/forms/application-document.ts).
 *
 * Two layers, split so the field mapping is unit-testable without rendering
 * bytes:
 *   - mapApplicationFields()  pure: merged form payload (+ lead email/phone) ->
 *     labeled rows grouped by section. Fields the 6-step form doesn't collect
 *     render BLANK (CC decision 2026-06-17: keep the form as-is).
 *   - generateApplicationPdf() draws those rows with pdf-lib (pure-JS, runs on
 *     Vercel's nodejs runtime) and embeds the signature PNG.
 *
 * pdf-lib's StandardFonts use WinAnsi encoding and THROW on un-encodable
 * characters -- so every string drawn is run through winAnsiSafe() first, or a
 * merchant's emoji / non-Latin character would crash generation.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont } from "pdf-lib";

export type PdfFieldRow = { label: string; value: string };
export type PdfSection = { heading: string; rows: PdfFieldRow[] };
export type MappedApplication = { sections: PdfSection[]; signatureName: string };

const ELLIPSIS = "…";
const MIDDOT = "·";

// Entity-type select values -> display labels (mirror the form template).
const ENTITY_LABELS: Record<string, string> = {
  llc: "LLC",
  s_corp: "S-Corp",
  c_corp: "C-Corp",
  sole_proprietor: "Sole Proprietor",
  partnership: "Partnership",
  other: "Other",
};

function str(v: unknown): string {
  if (v == null) return "";
  return (typeof v === "string" ? v : String(v)).trim();
}

/** Currency: payload stores these as numbers (FormRenderer currency -> Number). */
function money(v: unknown): string {
  if (v == null || v === "") return "";
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n)) return "";
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** ISO date (YYYY-MM-DD) -> US MM/DD/YYYY. Pass non-ISO through untouched. */
function usDate(v: unknown): string {
  const s = str(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : s;
}

function pct(v: unknown): string {
  const s = str(v);
  if (!s) return "";
  return /%\s*$/.test(s) ? s : `${s}%`;
}

function entity(v: unknown): string {
  const s = str(v).toLowerCase();
  return ENTITY_LABELS[s] || str(v);
}

/** "residential_construction" -> "Residential Construction". */
function titleCaseSlug(v: unknown): string {
  const s = str(v);
  if (!s) return "";
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Map the merged form payload + lead record onto the application's four
 * sections. Uncollected fields (the form doesn't ask for them) render blank so
 * the layout matches the example while staying truthful about what was
 * collected.
 */
export function mapApplicationFields(
  merged: Record<string, unknown>,
  lead: Record<string, unknown>,
): MappedApplication {
  const email = str(lead.email) || str(merged.email);
  const phone = str(lead.phone) || str(merged.phone);

  const sections: PdfSection[] = [
    {
      heading: "BUSINESS INFORMATION",
      rows: [
        { label: "Legal Business Name", value: str(merged.business_legal_name) || str(lead.business_name) },
        { label: "DBA", value: str(merged.dba) },
        { label: "Business Address", value: str(merged.business_address) },
        { label: "Phone", value: phone },
        { label: "Fax", value: "" },
        { label: "Federal Tax ID / EIN", value: str(merged.tax_id_ein) },
        { label: "Date Started", value: usDate(merged.business_start_date) },
        { label: "Length of Ownership", value: "" },
        { label: "Website", value: "" },
        { label: "Email", value: email },
        { label: "Type of Entity", value: entity(merged.entity_type) },
        { label: "Business Type", value: "" },
        { label: "State", value: str(merged.business_state).toUpperCase() },
        { label: "Industry", value: titleCaseSlug(merged.industry) },
        { label: "Product / Service", value: str(merged.product_service_description) },
      ],
    },
    {
      heading: "MERCHANT / OWNER INFORMATION",
      rows: [
        { label: "Name", value: str(merged.owner_full_name) },
        { label: "Title", value: "" },
        { label: "Ownership %", value: pct(merged.owner_ownership_pct) },
        { label: "Home Address", value: str(merged.owner_home_address) },
        { label: "SSN", value: str(merged.owner_ssn) },
        { label: "Date of Birth", value: usDate(merged.owner_dob) },
        { label: "Home Phone", value: "" },
        { label: "Cell Phone", value: str(merged.owner_cell) },
      ],
    },
    {
      heading: "PARTNER INFORMATION",
      rows: [
        { label: "Name", value: str(merged.partner_full_name) },
        { label: "Title", value: "" },
        { label: "Ownership %", value: pct(merged.partner_ownership_pct) },
        { label: "Home Address", value: str(merged.partner_home_address) },
        { label: "SSN", value: str(merged.partner_ssn) },
        { label: "Date of Birth", value: usDate(merged.partner_dob) },
        { label: "Home Phone", value: "" },
        { label: "Cell Phone", value: str(merged.partner_cell) },
      ],
    },
    {
      heading: "FINANCIAL INFORMATION",
      rows: [
        { label: "Average Monthly Revenue", value: money(merged.monthly_revenue) },
        { label: "Monthly CC Processing Revenue", value: "" },
        { label: "Terminal Type", value: "" },
        { label: "Requested Advance", value: money(merged.requested_advance) },
        { label: "Use of Funds", value: "" },
        { label: "Judgments / Bankruptcy", value: "" },
        { label: "Prior Cash Advance Company", value: "" },
        { label: "Outstanding Balance", value: "" },
      ],
    },
  ];

  return { sections, signatureName: str(merged.signature_name) };
}

// Code points pdf-lib's WinAnsi encoding maps beyond ASCII + Latin-1: the
// CP1252 punctuation (en/em dash, curly quotes, bullet, ellipsis, euro).
const WINANSI_EXTRA = new Set<number>([
  0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x20ac,
]);

/**
 * Replace characters pdf-lib's WinAnsi StandardFonts can't encode (emoji,
 * non-Latin scripts) with "?" so a merchant's free-text can't crash PDF
 * generation. Keeps tab/newline/CR, printable ASCII, Latin-1 (U+00A0..U+00FF),
 * and the CP1252 punctuation above.
 */
function winAnsiSafe(s: string): string {
  let out = "";
  for (const ch of s) {
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

/** Truncate text with an ellipsis so a long value can't overrun the page. */
function clip(textIn: string, font: PDFFont, size: number, maxW: number): string {
  const safe = winAnsiSafe(textIn);
  if (!safe) return "";
  if (font.widthOfTextAtSize(safe, size) <= maxW) return safe;
  let t = safe;
  while (t.length > 1 && font.widthOfTextAtSize(t + ELLIPSIS, size) > maxW) {
    t = t.slice(0, -1);
  }
  return t + ELLIPSIS;
}

function formatSignedAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return (
      d.toLocaleString("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }) + " ET"
    );
  } catch {
    return iso;
  }
}

/**
 * Render the application PDF. Returns the raw bytes (Uint8Array) for upload.
 * `signatureDataUri` is an optional PNG data-URI (the drawn signature); when
 * absent or malformed a ruled signature line is drawn instead.
 */
export async function generateApplicationPdf(input: {
  sections: PdfSection[];
  signatureName: string;
  signatureDataUri?: string | null;
  signedAt: string; // ISO timestamp
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 612;
  const PAGE_H = 792; // US Letter
  const MARGIN = 50;
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.4, 0.45, 0.52);
  const rule = rgb(0.8, 0.83, 0.88);
  const brand = rgb(0.055, 0.604, 0.655); // SunBiz teal ~#0E9AA7

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };
  const ensure = (need: number) => {
    if (y - need < MARGIN + 30) newPage();
  };
  const text = (
    s: string,
    x: number,
    yy: number,
    size: number,
    f: PDFFont = font,
    color = ink,
  ) => {
    page.drawText(winAnsiSafe(s), { x, y: yy, size, font: f, color });
  };
  const hline = (yy: number, thickness: number, color = rule) => {
    page.drawLine({ start: { x: MARGIN, y: yy }, end: { x: PAGE_W - MARGIN, y: yy }, thickness, color });
  };

  // Header
  text("SunBiz Funding Submissions", MARGIN, y, 16, fontBold, brand);
  y -= 15;
  text(`+1 754-212-7833   ${MIDDOT}   submissions@sunbizfunding.com`, MARGIN, y, 9, font, muted);
  y -= 9;
  hline(y, 1, brand);
  y -= 22;

  // Sections
  const labelX = MARGIN;
  const valueX = MARGIN + 170;
  const valueMaxW = PAGE_W - MARGIN - valueX;
  const lineH = 15;
  for (const section of input.sections) {
    ensure(lineH * 3);
    text(section.heading, labelX, y, 10.5, fontBold, brand);
    y -= 6;
    hline(y, 0.6);
    y -= 15;
    for (const row of section.rows) {
      ensure(lineH);
      text(row.label, labelX, y, 8.5, fontBold, muted);
      if (row.value) text(clip(row.value, font, 9, valueMaxW), valueX, y, 9, font, ink);
      y -= lineH;
    }
    y -= 8;
  }

  // Signature block -- keep it intact on one page.
  ensure(110);
  y -= 6;
  hline(y, 0.6);
  y -= 20;
  text("APPLICANT'S SIGNATURE", labelX, y, 10.5, fontBold, brand);
  y -= 34;

  const sigBoxW = 220;
  const sigBoxH = 56;
  const uri = input.signatureDataUri || "";
  if (uri.startsWith("data:image")) {
    try {
      const b64 = uri.split(",")[1] || "";
      const bytes = Buffer.from(b64, "base64");
      const png = await doc.embedPng(bytes);
      const fit = png.scaleToFit(sigBoxW, sigBoxH);
      page.drawImage(png, { x: labelX, y: y - 2, width: fit.width, height: fit.height });
    } catch {
      /* malformed image -- fall through to the ruled line */
    }
  }
  page.drawLine({ start: { x: labelX, y: y - 6 }, end: { x: labelX + sigBoxW, y: y - 6 }, thickness: 0.8, color: ink });
  text("Applicant's Signature", labelX, y - 18, 8, font, muted);

  const rightX = labelX + sigBoxW + 40;
  text(input.signatureName || "", rightX, y, 11, font, ink);
  page.drawLine({ start: { x: rightX, y: y - 6 }, end: { x: PAGE_W - MARGIN, y: y - 6 }, thickness: 0.8, color: ink });
  text("Print Name", rightX, y - 18, 8, font, muted);

  y -= 40;
  text(`Signed at: ${formatSignedAt(input.signedAt)}`, labelX, y, 9, font, muted);

  // Footer on every page
  for (const p of doc.getPages()) {
    p.drawText("www.sunbizfunding.com", { x: MARGIN, y: MARGIN - 14, size: 9, font: fontBold, color: brand });
  }

  return await doc.save();
}
