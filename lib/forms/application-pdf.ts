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
import type { PDFFont, PDFPage } from "pdf-lib";
import { SUNBIZ_LOGO_PNG_BASE64 } from "./sunbiz-logo";
import type { FormField, FormStep } from "./types";
import { getAgents } from "@/lib/config/agents";
// Only the compose rule is used here. Completeness is surfaced to the OPERATOR
// (lead drawer, edit form, shop-out pre-flight), never annotated onto the
// document itself: printing "[ZIP not provided]" tells a funder that SunBiz
// failed to collect basic data, which is worse for the deal than the partial
// line it replaces. The PDF prints the most complete line we honestly have.
import { composeCompleteAddress } from "@/lib/address/us-address";
import { applyDisclosureToSections, isRedactedField } from "./application-disclosure";

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

/**
 * The name printed beside the signature on the APPLICATION must be the
 * MERCHANT's, never a rep's. We sign on the merchant's behalf, so the document
 * shows the merchant (or nothing) — attribution to a rep ("Matt"/"Jordan")
 * belongs only on the lender-submission email, never on the signed application.
 *
 * Source strictly from the merchant owner identity (not the free-form
 * signature_name, which a sign-on-behalf flow can populate with the operator),
 * then GUARD against the agent roster: if the resolved name is a known rep
 * (exact full-name, or a single-token first-name match like "Matt"), print
 * nothing — leaving just the signature image. Fail-open on a roster read error
 * so PDF generation never crashes on it.
 */
export function merchantSignerName(merged: Record<string, unknown>): string {
  const candidate =
    str(merged.owner_full_name) ||
    str(merged.owner_name) ||
    str(merged.contact_name) ||
    str(merged.signature_name);
  if (!candidate) return "";
  let repNames = new Set<string>();
  let repFirsts = new Set<string>();
  try {
    for (const a of getAgents()) {
      const n = a.name.trim().toLowerCase();
      if (!n) continue;
      repNames.add(n);
      const first = n.split(/\s+/)[0];
      if (first) repFirsts.add(first);
    }
  } catch {
    repNames = new Set();
    repFirsts = new Set();
  }
  const c = candidate.trim().toLowerCase();
  if (repNames.has(c)) return "";
  const tokens = c.split(/\s+/);
  if (tokens.length === 1 && repFirsts.has(tokens[0])) return "";
  return candidate;
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
 * Compose a COMPLETE one-line address.
 *
 * The implementation moved to lib/address/us-address.ts so ONE rule serves every
 * address on the document. It used to live here as a private helper with a
 * single call site — the legacy mapper's business address — which meant the
 * live form-driven mapper never ran it and the shipped PDF never merged the
 * state, while the test suite asserted against the unused path and stayed green.
 * Behaviour is unchanged; `mergeStateIntoAddress` is byte-for-byte the old
 * function and tests/us-address.test.ts pins its exact output.
 */
function composeAddress(addr: unknown, state: unknown): string {
  return composeCompleteAddress(addr, state);
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
  // Ezra 2026-06-24: the merchant's phone is intentionally omitted from the
  // application PDF (lender-facing) — see the blanked Phone/Cell Phone rows below.

  const sections: PdfSection[] = [
    {
      heading: "BUSINESS INFORMATION",
      rows: [
        { label: "Legal Business Name", value: str(merged.business_legal_name) || str(merged.business_name) || str(lead.business_name) },
        { label: "DBA", value: str(merged.dba) },
        { label: "Business Address", value: composeAddress(merged.business_address, merged.business_state ?? merged.state) },
        { label: "Phone", value: "" },
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
        { label: "Name", value: str(merged.owner_full_name) || str(merged.owner_name) || str(merged.contact_name) },
        { label: "Title", value: "" },
        { label: "Ownership %", value: pct(merged.owner_ownership_pct) },
        // Same completeness rule as the business address. There is no owner
        // home-state field to fall back on, so this only normalises what the
        // string already carries — it never invents a state.
        { label: "Home Address", value: composeCompleteAddress(merged.owner_home_address) },
        { label: "SSN", value: str(merged.owner_ssn) },
        { label: "Date of Birth", value: usDate(merged.owner_dob) },
        { label: "Home Phone", value: "" },
        { label: "Cell Phone", value: "" },
      ],
    },
    {
      heading: "PARTNER INFORMATION",
      rows: [
        { label: "Name", value: str(merged.partner_full_name) },
        { label: "Title", value: "" },
        { label: "Ownership %", value: pct(merged.partner_ownership_pct) },
        { label: "Home Address", value: composeCompleteAddress(merged.partner_home_address) },
        { label: "SSN", value: str(merged.partner_ssn) },
        { label: "Date of Birth", value: usDate(merged.partner_dob) },
        { label: "Home Phone", value: "" },
        { label: "Cell Phone", value: "" },
      ],
    },
    {
      heading: "FINANCIAL INFORMATION",
      rows: [
        { label: "Average Monthly Revenue", value: money(merged.monthly_revenue) },
        { label: "Monthly CC Processing Revenue", value: "" },
        { label: "Terminal Type", value: "" },
        { label: "Requested Advance", value: money(merged.requested_advance ?? merged.requested_amount) },
        { label: "Use of Funds", value: "" },
        { label: "Judgments / Bankruptcy", value: "" },
        { label: "Prior Cash Advance Company", value: "" },
        { label: "Outstanding Balance", value: "" },
      ],
    },
  ];

  // Enforce the disclosure registry on the way out. The blanked contact rows
  // above are already correct by hand; this makes them redundant rather than
  // load-bearing, and means a row added later cannot leak a declared-private
  // field just because whoever added it did not know the rule existed.
  return {
    sections: applyDisclosureToSections(sections),
    signatureName: merchantSignerName(merged),
  };
}

/**
 * Format one field's stored answer for display, by field type. select/combobox
 * map the stored value back to its option LABEL (so "llc" → "LLC",
 * "construction" → "Construction"); multiselect joins labels; currency → $,
 * date → US, everything else passes through. Empty/absent → "".
 */
function formatFieldValue(field: FormField, raw: unknown): string {
  if (raw == null || raw === "") return "";
  const labelFor = (v: string): string => {
    const opt = field.options?.find((o) => o.value === v);
    return opt ? opt.label : titleCaseSlug(v);
  };
  switch (field.type) {
    case "currency":
      return money(raw);
    case "number": {
      const s = str(raw);
      if (!s) return "";
      // Percentage fields (ownership %, etc.) read better with a % suffix.
      const isPct = /(percent|pct|ownership)/i.test(field.name) || /percent|%/i.test(field.label);
      return isPct ? pct(s) : s;
    }
    case "date":
      return usDate(raw);
    case "select":
    case "combobox":
      return labelFor(str(raw));
    case "multiselect":
      return (Array.isArray(raw) ? raw : [raw])
        .map((x) => labelFor(str(x)))
        .filter(Boolean)
        .join(", ");
    default:
      return str(raw);
  }
}

/**
 * Form field name → alternate keys an application RECORD may store the same value
 * under. The from-record generation path reads an application record, which keeps
 * canonical aliases (see lib/forms/application-upsert FIELD_ALIASES): the form
 * collects `requested_advance` but the record stores `requested_amount`, etc.
 * Without this, a record-generated PDF would leave those cells blank. Form-submit
 * payloads use the form names directly, so this only kicks in for empties.
 */
const RECORD_ALIASES: Record<string, string[]> = {
  requested_advance: ["requested_amount"],
  owner_full_name: ["owner_name", "contact_name"],
  business_legal_name: ["business_name"],
  // Imported / legacy application records store these under shorter keys than the
  // current full-application form asks for. Map them so a backfilled PDF isn't
  // needlessly blank where the data DOES exist. (Adon backfill button, 2026-06-23.)
  business_state: ["state"],
  product_service_description: ["product_service"],
  owner_ownership_pct: ["ownership_pct"],
};

function resolveAnswer(merged: Record<string, unknown>, name: string): unknown {
  const v = merged[name];
  if (v != null && v !== "") return v;
  for (const alt of RECORD_ALIASES[name] ?? []) {
    const av = merged[alt];
    if (av != null && av !== "") return av;
  }
  return v;
}

/**
 * FORM-DRIVEN mapping (CC 2026-06-22): list EVERY question the form asks, with
 * the merchant's answer filled in — a real filled application form, not a fixed
 * subset. One PDF section per form STEP (heading = step title); one row per
 * field (label = the question, value = the formatted answer). File-upload,
 * signature, and hidden fields are omitted (documents live on the Docs tab; the
 * signature renders in the signature block). The leading APPLICANT contact
 * block (business name / email / phone) was removed per CC 2026-06-23 — those
 * fields already appear under Business Information, so the top block was
 * redundant on the generated PDF.
 *
 * Supersedes the hardcoded mapApplicationFields() — that one left uncollected
 * cells blank AND silently dropped any question whose key wasn't in its map.
 * This drives off the live `forms.steps`, so it can't drift from the form.
 */
/** Form-step keys whose content is represented by the PDF's own
 * AUTHORIZATION & SIGNATURE block and must not be emitted as a section.
 * `signature` is the canonical key on the sunbiz `full-application` template. */
const SIGNATURE_STEP_KEYS = new Set(["signature", "sign_and_submit"]);

export function mapApplicationFieldsFromSteps(
  steps: FormStep[],
  merged: Record<string, unknown>,
  _lead: Record<string, unknown>,
): MappedApplication {
  const sections: PdfSection[] = [];

  // NOTE (CC 2026-06-23): the top "APPLICANT" contact section (business name /
  // email / phone) was intentionally removed — those fields already render under
  // the form's Business Information step, so the leading block was redundant.

  for (const step of steps) {
    // Operator directive 2026-07-21: the "Sign and submit" step must not render
    // as a document section. It duplicated the AUTHORIZATION & SIGNATURE block
    // that generateApplicationPdf() already draws (the authoritative signature
    // component — signature image, printed name, signed-at timestamp), so the
    // PDF asked for the same attestation twice. The step stays in the WEB FORM
    // (it's how the merchant actually signs, and it feeds signature_name +
    // applicant_signature into that block); it is dropped only from the printed
    // document. Matched on step key, not the display title, so retitling the
    // step in the form builder can't silently resurrect the section.
    if (SIGNATURE_STEP_KEYS.has(step.key)) continue;

    const rows: PdfFieldRow[] = [];
    for (const f of step.fields) {
      if (
        f.type === "file_upload" ||
        f.type === "file_upload_multi" ||
        f.type === "signature" ||
        f.type === "hidden"
      ) {
        continue;
      }
      // Contact fields the merchant gave us are never printed on this document
      // — it is lender-facing once shopped out. The labelled cell is kept and
      // only the value is blanked, so the form keeps its shape. Which fields
      // those are is declared in ./application-disclosure, NOT decided here:
      // this used to be an inline `f.type === "phone"` check, and adding email
      // to it meant finding five other hardcoded sites first.
      if (isRedactedField(f)) {
        rows.push({ label: f.label, value: "" });
        continue;
      }
      // Addresses go through the same completeness rule as the legacy mapper's
      // business address. This is the line whose absence was the actual
      // regression: composeAddress lived on the legacy path only, so the PDF
      // production really ships never merged the state back in.
      if (f.type === "address") {
        rows.push({
          label: f.label,
          value: composeCompleteAddress(
            resolveAnswer(merged, f.name),
            f.name === "business_address" ? resolveAnswer(merged, "business_state") : undefined,
          ),
        });
        continue;
      }
      rows.push({ label: f.label, value: formatFieldValue(f, resolveAnswer(merged, f.name)) });
    }
    if (rows.length) sections.push({ heading: step.title.toUpperCase(), rows });
  }

  // Belt and braces: the loop above already withholds declared fields by type,
  // and this catches one declared by LABEL that arrived with an unexpected type
  // (a contact field mistyped as plain text in the form builder).
  return {
    sections: applyDisclosureToSections(sections),
    signatureName: merchantSignerName(merged),
  };
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

/** Wrap a value to up to maxLines at maxW; ellipsis the last line if it still
 *  overflows. Lets address / description cells render 2 lines instead of
 *  truncating a full address (and its ZIP) to a single clipped line. */
function wrapClip(
  textIn: string,
  font: PDFFont,
  size: number,
  maxW: number,
  maxLines: number,
): string[] {
  const lines = wrapText(textIn, font, size, maxW);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && font.widthOfTextAtSize(last + ELLIPSIS, size) > maxW) {
    last = last.slice(0, -1);
  }
  kept[maxLines - 1] = last + ELLIPSIS;
  return kept;
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

/** Greedy word-wrap to a max width; used for the authorization paragraph. */
function wrapText(textIn: string, font: PDFFont, size: number, maxW: number): string[] {
  const words = winAnsiSafe(textIn).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && font.widthOfTextAtSize(t, size) > maxW) {
      lines.push(cur);
      cur = w;
    } else {
      cur = t;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Render the signed application PDF — polished, on-brand layout (SunBiz forest
 * green + gold). Classic official-application layout: logo header, green section
 * heading bars over fully bordered two-column field cells, an authorization +
 * signature block, and a branded footer on every page. Underwriter-readable.
 * Returns raw bytes for upload.
 *
 * `signatureDataUri` is an optional PNG data-URI (the drawn signature); when
 * absent or malformed a ruled signature line is drawn instead. Every drawn
 * string is WinAnsi-sanitized so merchant free-text (emoji / non-Latin) can't
 * crash generation.
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
  const MARGIN = 46;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  // Brand palette — forest green + gold on white (matches the logo).
  const green = rgb(0.094, 0.353, 0.208); // #185A35
  const greenDeep = rgb(0.043, 0.227, 0.129);
  const gold = rgb(0.901, 0.682, 0.153); // #E6AE27
  const ink = rgb(0.11, 0.13, 0.16);
  const muted = rgb(0.42, 0.47, 0.53);
  const line = rgb(0.83, 0.86, 0.89);
  const white = rgb(1, 1, 1);

  let page = doc.addPage([PAGE_W, PAGE_H]);

  // Embed the brand logo once; soft-fail to a text wordmark.
  let logo: Awaited<ReturnType<typeof doc.embedPng>> | null = null;
  try {
    if (SUNBIZ_LOGO_PNG_BASE64) {
      logo = await doc.embedPng(Buffer.from(SUNBIZ_LOGO_PNG_BASE64, "base64"));
    }
  } catch {
    logo = null;
  }

  const text = (
    s: string,
    x: number,
    yy: number,
    size: number,
    f: PDFFont = font,
    color = ink,
  ) => page.drawText(winAnsiSafe(s), { x, y: yy, size, font: f, color });
  const rightText = (
    s: string,
    xRight: number,
    yy: number,
    size: number,
    f: PDFFont = font,
    color = ink,
  ) => {
    const safe = winAnsiSafe(s);
    page.drawText(safe, { x: xRight - f.widthOfTextAtSize(safe, size), y: yy, size, font: f, color });
  };

  const drawFooter = (p: PDFPage) => {
    p.drawLine({ start: { x: MARGIN, y: 42 }, end: { x: PAGE_W - MARGIN, y: 42 }, thickness: 1.4, color: green });
    p.drawRectangle({ x: MARGIN, y: 40.6, width: 84, height: 1.6, color: gold });
    p.drawText("www.sunbizfunding.com", { x: MARGIN, y: 29, size: 8.5, font: fontBold, color: green });
    const conf = "Confidential. For funding review only.";
    p.drawText(conf, {
      x: PAGE_W - MARGIN - font.widthOfTextAtSize(conf, 7.5),
      y: 29,
      size: 7.5,
      font,
      color: muted,
    });
  };

  // ---- Page-1 header: logo left, title + contact right, brand divider ----
  const top = PAGE_H - MARGIN;
  let headerBottom = top - 52;
  if (logo) {
    const fit = logo.scaleToFit(152, 66);
    page.drawImage(logo, { x: MARGIN, y: top - fit.height, width: fit.width, height: fit.height });
    headerBottom = top - fit.height;
  } else {
    text("SUNBIZ FUNDING", MARGIN, top - 22, 18, fontBold, green);
    headerBottom = top - 34;
  }
  rightText("BUSINESS FUNDING APPLICATION", PAGE_W - MARGIN, top - 14, 13, fontBold, greenDeep);
  rightText(`+1 754-212-7833   ${MIDDOT}   submissions@sunbizfunding.com`, PAGE_W - MARGIN, top - 28, 8.5, font, muted);
  rightText("www.sunbizfunding.com", PAGE_W - MARGIN, top - 40, 8.5, font, muted);

  let y = Math.min(headerBottom, top - 52) - 10;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 2, color: green });
  page.drawRectangle({ x: MARGIN, y: y - 1, width: 96, height: 2, color: gold });
  y -= 20;

  drawFooter(page);

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    drawFooter(page);
    y = PAGE_H - MARGIN;
  };

  // ---- Section tables: green heading bar + fully bordered field cells ----
  // Classic official-application layout (Adon's pick): each field is its own
  // bordered cell in a two-column grid; trailing empty slot still drawn so the
  // table reads complete.
  const HEAD_H = 19;
  const CELL_H = 36; // label + up to 2 wrapped value lines (no truncated addresses)
  const colW = CONTENT_W / 2;

  const sectionTable = (heading: string, rows: PdfFieldRow[]) => {
    const gridRows = Math.max(1, Math.ceil(rows.length / 2));
    const bodyH = gridRows * CELL_H;
    if (y - (HEAD_H + bodyH) < 64) newPage();

    const barTop = y;
    page.drawRectangle({ x: MARGIN, y: barTop - HEAD_H, width: CONTENT_W, height: HEAD_H, color: green });
    text(heading, MARGIN + 9, barTop - HEAD_H + 6, 9.5, fontBold, white);

    const bodyTop = barTop - HEAD_H;
    const total = gridRows * 2;
    for (let i = 0; i < total; i++) {
      const col = i % 2;
      const r = Math.floor(i / 2);
      const cellX = MARGIN + col * colW;
      const cellTop = bodyTop - r * CELL_H;
      page.drawRectangle({ x: cellX, y: cellTop - CELL_H, width: colW, height: CELL_H, borderColor: line, borderWidth: 0.8 });
      const row = rows[i];
      if (row) {
        // Wrap the LABEL to up to 2 lines within the cell so a long label (e.g.
        // the consent sentence on the "I agree" field) reads in full instead of
        // running off the page. A 2-line label leaves room for one value line; a
        // 1-line label leaves room for two (full addresses, descriptions). The
        // cell height is fixed, so this can never overflow top or bottom.
        const labelLines = wrapClip(row.label.toUpperCase(), fontBold, 6.6, colW - 16, 2);
        let ly = cellTop - 10;
        for (const ln of labelLines) {
          text(ln, cellX + 8, ly, 6.6, fontBold, muted);
          ly -= 7;
        }
        if (row.value) {
          const twoLineLabel = labelLines.length >= 2;
          let vy = cellTop - (twoLineLabel ? 27 : 21);
          for (const ln of wrapClip(row.value, font, 9, colW - 16, twoLineLabel ? 1 : 2)) {
            text(ln, cellX + 8, vy, 9, font, ink);
            vy -= 10;
          }
        }
      }
    }
    y = bodyTop - bodyH - 12;
  };

  for (const section of input.sections) sectionTable(section.heading, section.rows);

  // ---- Authorization + signature (green bar + bordered box) ----
  const authText =
    "Applicant authorizes SunBiz Funding LLC, its assigns, agents, banks or financial institutions to obtain an investigative or consumer report from a credit bureau or a credit agency and to investigate the references given on any other statement or data obtained from applicant.";
  const authLines = wrapText(authText, font, 7.8, CONTENT_W - 22);
  const blockBodyH = 14 + authLines.length * 10 + 92;
  if (y - (HEAD_H + blockBodyH) < 64) newPage();

  const sBarTop = y;
  page.drawRectangle({ x: MARGIN, y: sBarTop - HEAD_H, width: CONTENT_W, height: HEAD_H, color: green });
  text("AUTHORIZATION & SIGNATURE", MARGIN + 9, sBarTop - HEAD_H + 6, 9.5, fontBold, white);
  const sBodyTop = sBarTop - HEAD_H;
  page.drawRectangle({
    x: MARGIN,
    y: sBodyTop - blockBodyH,
    width: CONTENT_W,
    height: blockBodyH,
    borderColor: line,
    borderWidth: 0.8,
  });
  let ty = sBodyTop - 14;
  for (const ln of authLines) {
    text(ln, MARGIN + 11, ty, 7.8, font, muted);
    ty -= 10;
  }
  ty -= 18;

  const sigBoxW = 232;
  const sigBoxH = 46;
  const sigX = MARGIN + 11;
  const uri = input.signatureDataUri || "";
  if (uri.startsWith("data:image")) {
    try {
      const b64 = uri.split(",")[1] || "";
      const png = await doc.embedPng(Buffer.from(b64, "base64"));
      const fit = png.scaleToFit(sigBoxW, sigBoxH);
      page.drawImage(png, { x: sigX, y: ty - sigBoxH + 8, width: fit.width, height: fit.height });
    } catch {
      /* malformed image — fall through to the ruled line */
    }
  }
  const lineY = ty - sigBoxH + 2;
  page.drawLine({ start: { x: sigX, y: lineY }, end: { x: sigX + sigBoxW, y: lineY }, thickness: 0.8, color: ink });
  text("Applicant's Signature", sigX, lineY - 11, 7.5, font, muted);

  const rX = MARGIN + colW + 16;
  text(input.signatureName || "", rX, ty - sigBoxH + 10, 11, font, ink);
  page.drawLine({ start: { x: rX, y: lineY }, end: { x: PAGE_W - MARGIN - 11, y: lineY }, thickness: 0.8, color: ink });
  text("Print Name", rX, lineY - 11, 7.5, font, muted);
  text(`Signed at: ${formatSignedAt(input.signedAt)}`, rX, lineY - 24, 8, font, muted);

  return await doc.save();
}
