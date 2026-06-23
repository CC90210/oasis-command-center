/**
 * fundmate-pdf.ts — render the FundMate Funding Application PDF.
 *
 * FundMate is a SEPARATE paper-lender brand. This renderer is intentionally
 * self-contained and shares NOTHING with the SunBiz application PDF: its own
 * logo, colors, contact details, and copy. No SunBiz string may appear here.
 *
 * Layout mirrors the supplied FundMate example: logo top-right, contact block
 * top-left, centered title, orange section bars over a 3-column peach grid,
 * Legal Entity option row, attestation + signature footer.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont } from "pdf-lib";
import { FUNDMATE_LOGO_PNG_BASE64 } from "./fundmate-logo";

export type FundmateFields = {
  businessLegalName: string;
  amountRequested: string;
  businessStartDate: string;
  ein: string;
  industry: string;
  monthlyRevenue: string;
  legalEntity: string; // raw entity_type or label
  businessAddress: string;
  ownerFullName: string;
  dateOfBirth: string;
  ssn: string;
  email: string;
  phone: string;
  ownershipPct: string;
  estimatedFico: string;
  homeAddress: string;
};

// ---- palette (FundMate brand) ----
const ORANGE = rgb(0.945, 0.486, 0.137); // #F17C23
const PEACH = rgb(0.992, 0.941, 0.894); // #FDF0E4
const LABEL = rgb(0.34, 0.34, 0.36);
const VALUE = rgb(0.12, 0.12, 0.13);
const GRAYTXT = rgb(0.5, 0.5, 0.52);
const WHITE = rgb(1, 1, 1);
const RULE = rgb(0.82, 0.82, 0.84);

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 40;
const USABLE = PAGE_W - MARGIN * 2; // 532
const COL_W = (USABLE - 16) / 3; // 172 (two 8pt gaps)
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
function wrap(text: string, font: PDFFont, size: number, maxW: number, maxLines = 1): string[] {
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

const ENTITY_OPTS: Array<{ key: string; label: string }> = [
  { key: "corp", label: "Corp" },
  { key: "sole_prop", label: "Sole Prop" },
  { key: "llc", label: "LLC" },
  { key: "partnership", label: "Partnership" },
];
function normalizeEntity(v: string): string {
  const s = String(v || "").toLowerCase().replace(/[^a-z]/g, "");
  if (s.includes("llc")) return "llc";
  if (s.includes("sole") || s.includes("proprietor")) return "sole_prop";
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
  // contact block top-left
  const contact = ["Yuri@fundmatellc.com", "W: fundmatellc.com", "P : (800) 723 1691"];
  let cy = PAGE_H - 44;
  for (const line of contact) { page.drawText(line, { x: MARGIN, y: cy, size: 7.5, font, color: GRAYTXT }); cy -= 10; }

  // logo top-right
  try {
    const png = await doc.embedPng(Buffer.from(FUNDMATE_LOGO_PNG_BASE64, "base64"));
    const targetW = 104;
    const scale = targetW / png.width;
    const w = targetW, h = png.height * scale;
    page.drawImage(png, { x: PAGE_W - MARGIN - w, y: PAGE_H - 24 - h, width: w, height: h });
  } catch {
    page.drawText("FundMate", { x: PAGE_W - MARGIN - 110, y: PAGE_H - 56, size: 18, font: bold, color: ORANGE });
  }

  // centered title
  const title = "FUNDMATE FUNDING APPLICATION";
  const tw = bold.widthOfTextAtSize(title, 13);
  page.drawText(title, { x: (PAGE_W - tw) / 2, y: PAGE_H - 54, size: 13, font: bold, color: VALUE });
  const sub = "There are no obligations/Fees associated with an Approval.";
  const sw = font.widthOfTextAtSize(sub, 7);
  page.drawText(sub, { x: (PAGE_W - sw) / 2, y: PAGE_H - 66, size: 7, font, color: GRAYTXT });

  page.drawRectangle({ x: MARGIN, y: PAGE_H - 94, width: USABLE, height: 1.2, color: ORANGE });

  // ---- helpers ----
  const sectionBar = (y: number, text: string): number => {
    page.drawRectangle({ x: MARGIN, y: y - 16, width: USABLE, height: 16, color: ORANGE });
    page.drawText(safe(text), { x: MARGIN + 8, y: y - 11.5, size: 8.5, font: bold, color: WHITE });
    return y - 16;
  };
  const cell = (x: number, y: number, w: number, h: number, label: string, value: string) => {
    page.drawRectangle({ x, y: y - h, width: w, height: h, color: PEACH });
    page.drawText(safe(label.toUpperCase()), { x: x + 8, y: y - 12, size: 6.5, font: bold, color: LABEL });
    const lines = wrap(value, font, 9.5, w - 16, h > 42 ? 2 : 1);
    let vy = y - 26;
    for (const ln of lines) { page.drawText(ln, { x: x + 8, y: vy, size: 9.5, font, color: VALUE }); vy -= 12; }
  };
  const legalEntityCell = (x: number, y: number, w: number, h: number, selected: string) => {
    page.drawRectangle({ x, y: y - h, width: w, height: h, color: PEACH });
    page.drawText("LEGAL ENTITY", { x: x + 8, y: y - 12, size: 6.5, font: bold, color: LABEL });
    const sel = normalizeEntity(selected);
    let ox = x + 10;
    const oy = y - 28;
    for (const opt of ENTITY_OPTS) {
      const on = sel === opt.key;
      page.drawCircle({ x: ox + 4, y: oy + 3, size: 4, borderWidth: 1, borderColor: on ? ORANGE : rgb(0.6, 0.6, 0.62), color: on ? ORANGE : undefined });
      page.drawText(opt.label, { x: ox + 12, y: oy, size: 8.5, font: on ? bold : font, color: on ? ORANGE : VALUE });
      ox += 12 + font.widthOfTextAtSize(opt.label, 8.5) + 16;
    }
  };

  const RH = 38, VG = 7;

  // ---- BUSINESS INFORMATION ----
  let top = sectionBar(PAGE_H - 104, "BUSINESS INFORMATION") - 8;
  cell(XS[0], top, COL_W, RH, "Business Legal Name", fields.businessLegalName);
  cell(XS[1], top, COL_W, RH, "Amount Requested", fields.amountRequested);
  cell(XS[2], top, COL_W, RH, "Business Start Date", fields.businessStartDate);
  top -= RH + VG;
  cell(XS[0], top, COL_W, RH, "EIN #", fields.ein);
  cell(XS[1], top, COL_W, RH, "Industry Type", fields.industry);
  top -= RH + VG;
  cell(XS[0], top, COL_W, RH, "Monthly Revenue", fields.monthlyRevenue);
  legalEntityCell(XS[1], top, COL_W + 8 + COL_W, RH, fields.legalEntity);
  top -= RH + VG;
  cell(XS[0], top, USABLE, 44, "Business Address", fields.businessAddress);
  top -= 44 + VG + 6;

  // ---- OWNER #1 INFORMATION ----
  top = sectionBar(top, "OWNER #1 INFORMATION") - 8;
  cell(XS[0], top, COL_W, RH, "Full Name", fields.ownerFullName);
  cell(XS[1], top, COL_W, RH, "Date of Birth", fields.dateOfBirth);
  cell(XS[2], top, COL_W, RH, "SSN #", fields.ssn);
  top -= RH + VG;
  cell(XS[0], top, COL_W, RH, "Email", fields.email);
  cell(XS[1], top, COL_W, RH, "Phone Number", fields.phone);
  cell(XS[2], top, COL_W, RH, "Ownership %", fields.ownershipPct);
  top -= RH + VG;
  cell(XS[2], top, COL_W, RH, "Estimated Fico", fields.estimatedFico);
  top -= RH + VG;
  cell(XS[0], top, USABLE, 44, "Home Address", fields.homeAddress);
  top -= 44 + VG + 10;

  // ---- attestation + signature ----
  const attest =
    "By signing the Merchant and its owners principals: (1) i certify that all information and documents submitted in connection with this Application is true, And, correct and complete: (2) i authorize Fundmate LLC, and Our partners, and lenders to receive or obtain credit reports and any other information regarding the Merchant and its owners and principals from third parties, to verify any information provided on the Application.";
  const attestLines = wrap(attest, font, 7, USABLE, 6);
  let ay = top;
  for (const ln of attestLines) { page.drawText(ln, { x: MARGIN, y: ay, size: 7, font, color: GRAYTXT }); ay -= 9.5; }
  ay -= 24;

  const sigCols = [MARGIN, MARGIN + 200, MARGIN + 400];
  const sigW = [180, 180, 130];
  const sigLabels = ["Print Name", "Owner/Principle Signature:", "Date"];
  const sigVals = [fields.ownerFullName, "", input.signedAt ? usDate(input.signedAt) : ""];
  for (let i = 0; i < 3; i++) {
    page.drawText(sigVals[i] || "", { x: sigCols[i] + 2, y: ay + 4, size: 9, font, color: VALUE });
    page.drawLine({ start: { x: sigCols[i], y: ay }, end: { x: sigCols[i] + sigW[i], y: ay }, thickness: 0.8, color: RULE });
    page.drawText(sigLabels[i], { x: sigCols[i] + 2, y: ay - 11, size: 7.5, font: bold, color: LABEL });
  }

  return await doc.save();
}

function usDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  return String(iso);
}

// ---- default field mapping from a SunBiz application record ----
function s(v: unknown): string { return v == null ? "" : (typeof v === "string" ? v : String(v)).trim(); }
function money(v: unknown): string {
  if (v == null || v === "") return "";
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n)) return s(v);
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
function composeAddress(d: Record<string, unknown>): string {
  const street = s(d.business_address) || s(d.address);
  const parts = [street, s(d.business_city), s(d.state) || s(d.business_state), s(d.business_zip) || s(d.zip)].filter(Boolean);
  return parts.join(", ");
}
export function mapAppDataToFundmate(d: Record<string, unknown>, opts?: { estimatedFico?: string }): FundmateFields {
  return {
    businessLegalName: s(d.business_legal_name) || s(d.business_name) || s(d.company),
    amountRequested: money(d.requested_amount ?? d.requested_advance ?? d.amount_requested),
    businessStartDate: s(d.business_start_date) || s(d.time_in_business),
    ein: s(d.ein) || s(d.tax_id_ein) || s(d.business_ein) || s(d.federal_tax_id),
    industry: s(d.industry) || s(d.industry_type),
    monthlyRevenue: money(d.monthly_revenue ?? d.average_monthly_revenue),
    legalEntity: s(d.entity_type) || s(d.legal_entity),
    businessAddress: composeAddress(d),
    ownerFullName: s(d.owner_full_name) || s(d.owner_name) || s(d.contact_name) || s(d.name),
    dateOfBirth: s(d.owner_dob) || s(d.date_of_birth),
    ssn: s(d.owner_ssn) || s(d.ssn),
    email: s(d.email) || s(d.owner_email),
    phone: s(d.phone) || s(d.owner_cell) || s(d.business_phone),
    ownershipPct: s(d.ownership_pct) || s(d.owner_ownership_pct),
    estimatedFico: opts?.estimatedFico || s(d.fundmate_fico) || s(d.estimated_fico),
    homeAddress: s(d.owner_home_address),
  };
}
