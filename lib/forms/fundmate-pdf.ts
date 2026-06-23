/**
 * fundmate-pdf.ts — render the FundMate Funding Application PDF.
 *
 * FundMate is a SEPARATE paper-lender brand. Self-contained; shares NOTHING with
 * the SunBiz application PDF. Reproduces the live FundMate JotForm
 * (form.jotform.com/243095318619159) — section tabs, spacious peach cells with
 * vertically-centered values, range-bucket dropdowns, concentric-ring entity
 * selector, "SolePorp" typo. Embeds the saved e-signature when present.
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
  legalEntity: string;
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
const ORANGE = rgb(0.949, 0.475, 0.137); // #F2791F
const PEACH = rgb(0.988, 0.929, 0.882); // #FCEDE1
const LABEL = rgb(0.16, 0.16, 0.18);
const VALUE = rgb(0.3, 0.3, 0.32);
const GRAYTXT = rgb(0.5, 0.5, 0.52);
const WHITE = rgb(1, 1, 1);
const RULE = rgb(0.78, 0.78, 0.8);

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 40;
const USABLE = PAGE_W - MARGIN * 2; // 532
const COL_W = (USABLE - 16) / 3; // 172
const XS = [MARGIN, MARGIN + COL_W + 8, MARGIN + (COL_W + 8) * 2];

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

export async function renderFundmatePdf(input: {
  fields: FundmateFields;
  signedAt?: string;
  signatureDataUri?: string;
  signatureName?: string;
}): Promise<Uint8Array> {
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
    page.drawImage(png, { x: PAGE_W - MARGIN - targetW, y: PAGE_H - 24 - png.height * scale, width: targetW, height: png.height * scale });
  } catch {
    page.drawText("FundMate", { x: PAGE_W - MARGIN - 110, y: PAGE_H - 56, size: 18, font: bold, color: ORANGE });
  }

  const title = "FUNDMATE FUNDING APPLICATION";
  page.drawText(title, { x: (PAGE_W - bold.widthOfTextAtSize(title, 13)) / 2, y: PAGE_H - 52, size: 13, font: bold, color: rgb(0.13, 0.13, 0.14) });
  const sub = "There are no obligations/Fees associated with an Approval.";
  page.drawText(sub, { x: (PAGE_W - font.widthOfTextAtSize(sub, 7)) / 2, y: PAGE_H - 64, size: 7, font, color: GRAYTXT });

  // ---- helpers ----
  const sectionHeader = (y: number, text: string): number => {
    const tabW = bold.widthOfTextAtSize(text, 8.5) + 22;
    page.drawRectangle({ x: MARGIN, y: y - 17, width: USABLE, height: 0.8, color: ORANGE });
    page.drawRectangle({ x: MARGIN, y: y - 17, width: tabW, height: 17, color: ORANGE });
    page.drawText(safe(text), { x: MARGIN + 11, y: y - 12, size: 8.5, font: bold, color: WHITE });
    return y - 17;
  };

  // Field cell: peach bg; content VERTICALLY CENTERED. Short value → same line as
  // the label; long value → wraps below the label. Mirrors the JotForm PDF.
  const cell = (x: number, y: number, w: number, h: number, label: string, value: string) => {
    page.drawRectangle({ x, y: y - h, width: w, height: h, color: PEACH });
    const cxLabel = x + 14;
    const v = safe(value);
    const labelW = bold.widthOfTextAtSize(label, 8.5);
    const center = y - h / 2;
    if (!v) {
      page.drawText(label, { x: cxLabel, y: center - 3, size: 8.5, font: bold, color: LABEL });
      return;
    }
    const inlineX = cxLabel + labelW + 14;
    const inlineMaxW = x + w - 12 - inlineX;
    if (font.widthOfTextAtSize(v, 9) <= inlineMaxW) {
      page.drawText(label, { x: cxLabel, y: center - 3, size: 8.5, font: bold, color: LABEL });
      page.drawText(v, { x: inlineX, y: center - 3, size: 9, font, color: VALUE });
    } else {
      const lines = wrap(v, font, 9, w - 28, 2);
      const blockH = 13 + lines.length * 11;
      let yy = center + blockH / 2 - 9;
      page.drawText(label, { x: cxLabel, y: yy, size: 8.5, font: bold, color: LABEL });
      yy -= 14;
      for (const ln of lines) { page.drawText(ln, { x: cxLabel, y: yy, size: 9, font, color: VALUE }); yy -= 11; }
    }
  };

  const RH = 50, VG = 9;

  // ---- BUSINESS INFORMATION ----
  let top = sectionHeader(PAGE_H - 92, "BUSINESS INFORMATION") - 12;
  cell(XS[0], top, COL_W, RH, "Business Legal Name", fields.businessLegalName);
  cell(XS[1], top, COL_W, RH, "Amount Requested", fields.amountRequested);
  cell(XS[2], top, COL_W, RH, "Business Start Date", fields.businessStartDate);
  top -= RH + VG;
  cell(XS[0], top, COL_W, RH, "EIN#", fields.ein);
  cell(XS[1], top, COL_W, RH, "Industry Type", fields.industry);
  top -= RH + VG;
  cell(XS[0], top, COL_W, RH, "Monthly Revenue", fields.monthlyRevenue);
  // Legal Entity spans the right two columns — wide gaps + concentric ring marker.
  {
    const lx = XS[1], lw = COL_W + 8 + COL_W;
    page.drawRectangle({ x: lx, y: top - RH, width: lw, height: RH, color: PEACH });
    const center = top - RH / 2;
    page.drawText("Legal Entity", { x: lx + 14, y: center - 3, size: 8.5, font: bold, color: LABEL });
    const sel = normalizeEntity(fields.legalEntity);
    let ox = lx + 14 + bold.widthOfTextAtSize("Legal Entity", 8.5) + 26;
    for (const opt of ENTITY_OPTS) {
      const on = sel === opt.key;
      page.drawText(opt.label, { x: ox, y: center - 3, size: 9, font, color: on ? rgb(0.12, 0.12, 0.13) : VALUE });
      const lw2 = font.widthOfTextAtSize(opt.label, 9);
      if (on) {
        const ccx = ox + lw2 + 11, ccy = center;
        page.drawCircle({ x: ccx, y: ccy, size: 6, borderWidth: 1.5, borderColor: ORANGE });
        page.drawCircle({ x: ccx, y: ccy, size: 2.6, borderWidth: 1.2, borderColor: ORANGE });
      }
      ox += lw2 + (on ? 34 : 24);
    }
  }
  top -= RH + VG;
  cell(XS[0], top, USABLE, RH, "Business Address", fields.businessAddress);
  top -= RH + VG + 6;

  // ---- OWNER #1 INFORMATION ----
  top = sectionHeader(top, "OWNER #1 INFORMATION") - 12;
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
  top -= RH + VG + 14;

  // ---- attestation + signature ----
  const attest =
    "By signing the Merchant and its owners principals: (1) i certify that all information and documents submitted in connection with this Application is true, And ,correct and complete: (2) i authorize Fundmate LLC, and Our partners, and lenders to receive or obtain credit reports and any other information regarding the Merchant and its owners and principals from third parties, to verify any information provided on the Application.";
  let ay = top;
  for (const ln of wrap(attest, font, 7, USABLE, 6)) { page.drawText(ln, { x: MARGIN, y: ay, size: 7, font, color: GRAYTXT }); ay -= 9.5; }
  ay -= 30;

  const sigColX = [MARGIN, MARGIN + 200, MARGIN + 400];
  const sigColW = [180, 180, 132];
  const sigLabels = ["Print Name", "Owner/Principle Signature:", "Date"];
  const printName = safe(input.signatureName || fields.ownerFullName);
  const dateStr = input.signedAt ? usDateISO(input.signedAt) : "";

  // embed the saved e-signature image in the middle column when present
  const uri = input.signatureDataUri || "";
  if (uri.startsWith("data:image")) {
    try {
      const b64 = uri.split(",")[1] || "";
      const buf = Buffer.from(b64, "base64");
      const img = uri.includes("image/jpeg") || uri.includes("image/jpg") ? await doc.embedJpg(buf) : await doc.embedPng(buf);
      const box = img.scaleToFit(sigColW[1] - 6, 30);
      page.drawImage(img, { x: sigColX[1] + 2, y: ay + 3, width: box.width, height: box.height });
    } catch {
      /* malformed image — ruled line only */
    }
  }
  if (printName) page.drawText(printName, { x: sigColX[0] + 2, y: ay + 5, size: 9.5, font, color: VALUE });
  if (dateStr) page.drawText(dateStr, { x: sigColX[2] + 2, y: ay + 5, size: 9.5, font, color: VALUE });
  for (let i = 0; i < 3; i++) {
    page.drawLine({ start: { x: sigColX[i], y: ay }, end: { x: sigColX[i] + sigColW[i], y: ay }, thickness: 0.8, color: RULE });
    page.drawText(sigLabels[i], { x: sigColX[i] + 2, y: ay - 11, size: 7.5, font: bold, color: LABEL });
  }
  if (input.signedAt) page.drawText(`Signed at: ${signedAtStr(input.signedAt)}`, { x: sigColX[1] + 2, y: ay - 22, size: 7, font, color: GRAYTXT });

  return await doc.save();
}

// MM/DD/YYYY from an ISO/Date-ish string (date only).
function usDateISO(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso);
}
// "YYYY-MM-DDTHH:MM:SS…" → "YYYY-MM-DD HH:MM:SS" for the "Signed at:" line.
function signedAtStr(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(String(iso));
  return m ? `${m[1]} ${m[2]}` : usDateISO(iso);
}

// ---- field formatters + range buckets ----
function s(v: unknown): string { return v == null ? "" : (typeof v === "string" ? v : String(v)).trim(); }
function num(v: unknown): number {
  if (v == null || v === "") return NaN;
  return Number(String(v).replace(/[^0-9.\-]/g, ""));
}
function fmtDate(v: unknown): string {
  const str = s(v);
  if (!str) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : str;
}
function fmtEin(v: unknown): string {
  const str = s(v);
  if (!str) return "";
  const d = str.replace(/\D/g, "");
  return d.length === 9 ? `${d.slice(0, 2)} - ${d.slice(2)}` : str;
}
function fmtSsn(v: unknown): string {
  const str = s(v);
  if (!str) return "";
  const d = str.replace(/\D/g, "");
  return d.length === 9 ? `${d.slice(0, 3)} - ${d.slice(3, 5)} - ${d.slice(5)}` : str;
}
function titleCaseSlug(v: unknown): string {
  const str = s(v);
  if (!str) return "";
  // Only normalize slug-style values (lowercase / underscores); leave human text.
  if (!/^[a-z0-9_]+$/.test(str)) return str;
  return str.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function cleanAddress(v: unknown): string {
  return s(v).replace(/\s+/g, " ").trim();
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

export function mapAppDataToFundmate(d: Record<string, unknown>): FundmateFields {
  return {
    businessLegalName: s(d.business_legal_name) || s(d.business_name) || s(d.company),
    amountRequested: amountBucket(d.requested_amount ?? d.requested_advance ?? d.amount_requested),
    businessStartDate: fmtDate(d.business_start_date) || s(d.time_in_business),
    ein: fmtEin(d.ein ?? d.tax_id_ein ?? d.business_ein ?? d.federal_tax_id),
    industry: titleCaseSlug(d.industry ?? d.industry_type),
    monthlyRevenue: revenueBucket(d.monthly_revenue ?? d.average_monthly_revenue),
    legalEntity: s(d.entity_type) || s(d.legal_entity),
    businessAddress: cleanAddress(d.business_address || d.address),
    ownerFullName: s(d.owner_full_name) || s(d.owner_name) || s(d.contact_name) || s(d.name),
    dateOfBirth: fmtDate(d.owner_dob ?? d.date_of_birth),
    ssn: fmtSsn(d.owner_ssn ?? d.ssn),
    // Email + Phone are INTENTIONALLY left blank on every FundMate application.
    // Other people on the shared FundMate account can view these applications, and
    // we will not expose our merchants' contact info to them. (Adon 2026-06-23.)
    email: "",
    phone: "",
    ownershipPct: s(d.ownership_pct) || s(d.owner_ownership_pct),
    estimatedFico: "600 - 650",
    homeAddress: cleanAddress(d.owner_home_address),
  };
}
