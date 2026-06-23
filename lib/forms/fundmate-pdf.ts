/**
 * fundmate-pdf.ts — render the FundMate Funding Application PDF.
 *
 * FundMate is a SEPARATE paper-lender brand. This renderer is self-contained and
 * shares NOTHING with the SunBiz application PDF: its own logo, colors, contact,
 * and copy. No SunBiz string may appear here. Layout reproduces the live
 * FundMate JotForm (form.jotform.com/243095318619159) EXACTLY, typos included
 * ("SolePorp"). Dropdown fields (Amount Requested, Monthly Revenue, Estimated
 * Fico) display the FundMate RANGE bucket the deal's exact value falls into.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont } from "pdf-lib";
import { FUNDMATE_LOGO_PNG_BASE64 } from "./fundmate-logo";

export type FundmateFields = {
  businessLegalName: string;
  amountRequested: string; // already a bucket label
  businessStartDate: string;
  ein: string;
  industry: string;
  monthlyRevenue: string; // already a bucket label
  legalEntity: string; // raw entity_type or label
  businessAddress: string;
  ownerFullName: string;
  dateOfBirth: string;
  ssn: string;
  email: string;
  phone: string;
  ownershipPct: string;
  estimatedFico: string; // bucket label, e.g. "600 - 650"
  homeAddress: string;
};

// ---- palette (FundMate brand) ----
const ORANGE = rgb(0.949, 0.475, 0.137); // #F2791F
const PEACH = rgb(0.988, 0.929, 0.882); // #FCEDE1
const LABEL = rgb(0.16, 0.16, 0.18); // bold dark labels
const VALUE = rgb(0.27, 0.27, 0.29);
const GRAYTXT = rgb(0.5, 0.5, 0.52);
const WHITE = rgb(1, 1, 1);
const RULE = rgb(0.82, 0.82, 0.84);

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 40;
const USABLE = PAGE_W - MARGIN * 2; // 532
const COL_W = (USABLE - 16) / 3; // 172
const XS = [MARGIN, MARGIN + COL_W + 8, MARGIN + (COL_W + 8) * 2]; // [40, 220, 400]

const WINANSI_EXTRA = new Set<number>([0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x20ac]);
function safe(s: string): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.has(c)) out += ch;
    else out += "?";
  }
  return out;
}
function wrap(text: string, font: PDFFont, size: number, maxW: number, maxLines = 2): string[] {
  const words = safe(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(t, size) <= maxW || !cur) cur = t;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && font.widthOfTextAtSize(last + "…", size) > maxW) last = last.slice(0, -1);
  kept[maxLines - 1] = last + "…";
  return kept;
}

// FundMate Legal Entity radio options — EXACT label text from the form (typo kept).
const ENTITY_OPTS: Array<{ key: string; label: string }> = [
  { key: "corp", label: "Corp" },
  { key: "sole_prop", label: "SolePorp" },
  { key: "llc", label: "LLC" },
  { key: "partnership", label: "Partnership" },
];
function normalizeEntity(v: string): string {
  const s = String(v || "").toLowerCase().replace(/[^a-z]/g, "");
  if (s.includes("llc")) return "llc";
  if (s.includes("sole") || s.includes("proprietor") || s.includes("soleporp") || s.includes("soleprp")) return "sole_prop";
  if (s.includes("partner")) return "partnership";
  if (s.includes("corp") || s === "scorp" || s === "ccorp" || s === "inc") return "corp";
  return "";
}

export async function renderFundmatePdf(input: { fields: FundmateFields; signedAt?: string }): Promise<Uint8Array> {
  const { fields } = input;
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // ---- header ----
  const contact = ["Yuri@fundmatellc.com", "W: fundmatellc.com", "P : (800) 723 1691"];
  let cy = PAGE_H - 44;
  for (const line of contact) { page.drawText(line, { x: MARGIN, y: cy, size: 7.5, font, color: GRAYTXT }); cy -= 10; }

  try {
    const png = await doc.embedPng(Buffer.from(FUNDMATE_LOGO_PNG_BASE64, "base64"));
    const targetW = 104;
    const scale = targetW / png.width;
    const w = targetW, h = png.height * scale;
    page.drawImage(png, { x: PAGE_W - MARGIN - w, y: PAGE_H - 24 - h, width: w, height: h });
  } catch {
    page.drawText("FundMate", { x: PAGE_W - MARGIN - 110, y: PAGE_H - 56, size: 18, font: bold, color: ORANGE });
  }

  const title = "FUNDMATE FUNDING APPLICATION";
  const tw = bold.widthOfTextAtSize(title, 13);
  page.drawText(title, { x: (PAGE_W - tw) / 2, y: PAGE_H - 52, size: 13, font: bold, color: rgb(0.13, 0.13, 0.14) });
  const sub = "There are no obligations/Fees associated with an Approval.";
  const sw = font.widthOfTextAtSize(sub, 7);
  page.drawText(sub, { x: (PAGE_W - sw) / 2, y: PAGE_H - 64, size: 7, font, color: GRAYTXT });

  // ---- helpers ----
  // Section header = short orange tab on the left over a thin full-width rule.
  const sectionHeader = (y: number, text: string): number => {
    const tw2 = bold.widthOfTextAtSize(text, 8.5);
    const tabW = tw2 + 22;
    page.drawRectangle({ x: MARGIN, y: y - 16, width: USABLE, height: 0.8, color: ORANGE }); // faint full-width line at tab bottom
    page.drawRectangle({ x: MARGIN, y: y - 16, width: tabW, height: 16, color: ORANGE });
    page.drawText(safe(text), { x: MARGIN + 11, y: y - 11.5, size: 8.5, font: bold, color: WHITE });
    return y - 16;
  };
  // Field cell: peach bg; bold title-case label top-left. The value sits INLINE
  // to the right of the label when it fits on one line; otherwise it drops to the
  // line(s) below the label using the full cell width (matches the JotForm PDF,
  // e.g. "Business Legal Name" / "Skyline Roofing of Georgia" / "LLC").
  const cell = (x: number, y: number, w: number, h: number, label: string, value: string) => {
    page.drawRectangle({ x, y: y - h, width: w, height: h, color: PEACH });
    page.drawText(safe(label), { x: x + 12, y: y - 16, size: 8.5, font: bold, color: LABEL });
    const v = safe(value);
    if (!v) return;
    const labelW = bold.widthOfTextAtSize(label, 8.5);
    const inlineX = x + 12 + labelW + 14;
    const inlineMaxW = x + w - 12 - inlineX;
    if (font.widthOfTextAtSize(v, 9.5) <= inlineMaxW) {
      page.drawText(v, { x: inlineX, y: y - 16, size: 9.5, font, color: VALUE });
    } else {
      const belowX = x + 14;
      const belowW = w - 28;
      let vy = y - 30;
      for (const ln of wrap(v, font, 9.5, belowW, 2)) { page.drawText(ln, { x: belowX, y: vy, size: 9.5, font, color: VALUE }); vy -= 12; }
    }
  };

  const RH = 44, VG = 8;

  // ---- BUSINESS INFORMATION ----
  let top = sectionHeader(PAGE_H - 92, "BUSINESS INFORMATION") - 10;
  cell(XS[0], top, COL_W, RH, "Business Legal Name", fields.businessLegalName);
  cell(XS[1], top, COL_W, RH, "Amount Requested", fields.amountRequested);
  cell(XS[2], top, COL_W, RH, "Business Start Date", fields.businessStartDate);
  top -= RH + VG;
  cell(XS[0], top, COL_W, RH, "EIN#", fields.ein);
  cell(XS[1], top, COL_W, RH, "Industry Type", fields.industry);
  top -= RH + VG;
  cell(XS[0], top, COL_W, RH, "Monthly Revenue", fields.monthlyRevenue);
  // Legal Entity spans the right two columns.
  {
    const lx = XS[1], lw = COL_W + 8 + COL_W;
    page.drawRectangle({ x: lx, y: top - RH, width: lw, height: RH, color: PEACH });
    page.drawText("Legal Entity", { x: lx + 11, y: top - 16, size: 8.5, font: bold, color: LABEL });
    const sel = normalizeEntity(fields.legalEntity);
    let ox = lx + 11 + bold.widthOfTextAtSize("Legal Entity", 8.5) + 24;
    const oy = top - 16;
    for (const opt of ENTITY_OPTS) {
      const on = sel === opt.key;
      page.drawText(opt.label, { x: ox, y: oy, size: 9, font, color: VALUE });
      const lw2 = font.widthOfTextAtSize(opt.label, 9);
      if (on) {
        // concentric ring marker to the right of the selected option (matches the form)
        const cx = ox + lw2 + 9, cyy = oy + 3.2;
        page.drawCircle({ x: cx, y: cyy, size: 5, borderWidth: 1.3, borderColor: ORANGE });
        page.drawCircle({ x: cx, y: cyy, size: 2.2, borderWidth: 1, borderColor: ORANGE });
      }
      ox += lw2 + (on ? 26 : 16);
    }
  }
  top -= RH + VG;
  cell(XS[0], top, USABLE, RH, "Business Address", fields.businessAddress);
  top -= RH + VG + 6;

  // ---- OWNER #1 INFORMATION ----
  top = sectionHeader(top, "OWNER #1 INFORMATION") - 10;
  cell(XS[0], top, COL_W, RH, "Full Name", fields.ownerFullName);
  cell(XS[1], top, COL_W, RH, "Date of Birth", fields.dateOfBirth);
  cell(XS[2], top, COL_W, RH, "SSN#", fields.ssn);
  top -= RH + VG;
  cell(XS[0], top, COL_W, RH, "Email", fields.email);
  cell(XS[1], top, COL_W, RH, "Phone Number", fields.phone);
  cell(XS[2], top, COL_W, RH, "Ownership %", fields.ownershipPct);
  top -= RH + VG;
  cell(XS[2], top, COL_W, RH, "Estimated Fico", fields.estimatedFico);
  top -= RH + VG;
  cell(XS[0], top, USABLE, RH, "Home Address", fields.homeAddress);
  top -= RH + VG + 12;

  // ---- attestation + signature ----
  const attest =
    "By signing the Merchant and its owners principals: (1) i certify that all information and documents submitted in connection with this Application is true, And ,correct and complete: (2) i authorize Fundmate LLC, and Our partners, and lenders to receive or obtain credit reports and any other information regarding the Merchant and its owners and principals from third parties, to verify any information provided on the Application.";
  let ay = top;
  for (const ln of wrap(attest, font, 7, USABLE, 6)) { page.drawText(ln, { x: MARGIN, y: ay, size: 7, font, color: GRAYTXT }); ay -= 9.5; }
  ay -= 26;

  const sigCols = [MARGIN, MARGIN + 200, MARGIN + 400];
  const sigW = [180, 180, 132];
  const sigLabels = ["Print Name", "Owner/Principle Signature:", "Date"];
  const sigVals = [fields.ownerFullName, "", input.signedAt ? usDate(input.signedAt) : ""];
  for (let i = 0; i < 3; i++) {
    if (sigVals[i]) page.drawText(sigVals[i], { x: sigCols[i] + 2, y: ay + 4, size: 9, font, color: VALUE });
    page.drawLine({ start: { x: sigCols[i], y: ay }, end: { x: sigCols[i] + sigW[i], y: ay }, thickness: 0.8, color: RULE });
    page.drawText(sigLabels[i], { x: sigCols[i] + 2, y: ay - 11, size: 7.5, font: bold, color: LABEL });
  }

  return await doc.save();
}

function usDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso);
}

// ---- value → FundMate range-bucket mapping (exact dropdown labels) ----
function s(v: unknown): string { return v == null ? "" : (typeof v === "string" ? v : String(v)).trim(); }
function num(v: unknown): number {
  if (v == null || v === "") return NaN;
  return Number(String(v).replace(/[^0-9.\-]/g, ""));
}
export function amountBucket(v: unknown): string {
  const n = num(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 25000) return "$5,000.00 - 25,000.00";
  if (n < 50000) return "$25,000.00 - 50,000.00";
  if (n < 100000) return "$50,000.00 - 100,000.00";
  if (n < 250000) return "$100,000.00 - 250,000.00";
  if (n < 500000) return "$250,000.00 - 500,000.00";
  return "$500,000.00 & Up";
}
export function revenueBucket(v: unknown): string {
  const n = num(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 15000) return "Below 15K";
  if (n < 30000) return "15K - 30K";
  if (n < 50000) return "30K - 50K";
  if (n < 100000) return "50K - 100K";
  if (n < 200000) return "100K - 200K";
  if (n < 350000) return "200K - 350K";
  if (n < 500000) return "350K - 500K";
  return "500K - +";
}

function composeAddress(d: Record<string, unknown>): string {
  // Match the form's address echo style: "Street: ... City: ... State: ... Postal code: ..."
  const street = s(d.business_address) || s(d.address);
  const city = s(d.business_city);
  const state = s(d.state) || s(d.business_state);
  const zip = s(d.business_zip) || s(d.zip);
  const parts: string[] = [];
  if (street) parts.push(`Street: ${street}`);
  if (city) parts.push(`City: ${city}`);
  if (state) parts.push(`State: ${state}`);
  if (zip) parts.push(`Postal code: ${zip}`);
  return parts.join(" ");
}

export function mapAppDataToFundmate(d: Record<string, unknown>): FundmateFields {
  return {
    businessLegalName: s(d.business_legal_name) || s(d.business_name) || s(d.company),
    amountRequested: amountBucket(d.requested_amount ?? d.requested_advance ?? d.amount_requested),
    businessStartDate: s(d.business_start_date) || s(d.time_in_business),
    ein: s(d.ein) || s(d.tax_id_ein) || s(d.business_ein) || s(d.federal_tax_id),
    industry: s(d.industry) || s(d.industry_type),
    monthlyRevenue: revenueBucket(d.monthly_revenue ?? d.average_monthly_revenue),
    legalEntity: s(d.entity_type) || s(d.legal_entity),
    businessAddress: composeAddress(d),
    ownerFullName: s(d.owner_full_name) || s(d.owner_name) || s(d.contact_name) || s(d.name),
    dateOfBirth: s(d.owner_dob) || s(d.date_of_birth),
    ssn: s(d.owner_ssn) || s(d.ssn),
    email: s(d.email) || s(d.owner_email),
    phone: s(d.phone) || s(d.owner_cell) || s(d.business_phone),
    ownershipPct: s(d.ownership_pct) || s(d.owner_ownership_pct),
    estimatedFico: "600 - 650", // Adon: keep within 600-650; matches the form's bucket
    homeAddress: s(d.owner_home_address),
  };
}
