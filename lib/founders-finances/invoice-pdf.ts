/**
 * Invoice PDF (pdf-lib, standard fonts, US Letter). No I/O: takes plain data,
 * returns bytes, so it runs in tests and in any route.
 *
 * Tax lines render ONLY when the invoice was issued while registered
 * (tax_registered_snapshot) — an unregistered small supplier must not show
 * GST/QST, and must not print registration numbers it does not have.
 *
 * Standard PDF fonts are WinAnsi-encoded: any character outside that set
 * (emoji, CJK, some punctuation) would throw at draw time, so every string is
 * passed through winAnsiSafe() first.
 *
 * Bank-transfer details (Wise) print as label/value rows ending in the
 * payment reference — the invoice number — which is what lets a deposit be
 * matched back to this invoice (wise-reconcile.ts). They are omitted once the
 * invoice is paid, like the card link.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatCents } from "./money";
import { quantityMilliToString } from "./invoice";

export type InvoicePdfInput = {
  seller: {
    legalName: string;
    addressLines: string[];
    email: string;
    gstNumber: string;
    qstNumber: string;
  };
  invoice: {
    number: string;
    status: string;
    issueDate: string;
    dueDate: string;
    currency: string;
    subtotalCents: number;
    gstCents: number;
    qstCents: number;
    totalCents: number;
    amountPaidCents: number;
    taxRegistered: boolean;
    notes: string;
    paymentLinkUrl: string | null;
    paymentInstructions: string;
    /** Wise receiving details for the invoice currency, reference last (wise.ts bankTransferLines). */
    bankTransfer?: Array<{ label: string; value: string }> | null;
  };
  customer: { name: string; company: string; email: string; address: string };
  lines: Array<{ description: string; quantityMilli: number; unitPriceCents: number; amountCents: number }>;
};

const INK = rgb(0.09, 0.1, 0.12);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);
const ACCENT = rgb(0.04, 0.49, 0.53); // deep OASIS teal; brand cyan is illegible on white paper

// WinAnsi (CP1252) printable set: ASCII + Latin-1 + the CP1252 extras.
const CP1252_EXTRAS = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
export function winAnsiSafe(s: string): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    const code = ch.codePointAt(0) || 0;
    if (ch === "\n" || ch === "\t") out += " ";
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || CP1252_EXTRAS.has(ch)) out += ch;
    else out += "?";
  }
  return out;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = winAnsiSafe(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) cur = next;
    else {
      if (cur) lines.push(cur);
      // A single word longer than the column is hard-split.
      let word = w;
      while (font.widthOfTextAtSize(word, size) > maxWidth && word.length > 1) {
        let cut = word.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), size) > maxWidth) cut--;
        lines.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsiSafe(`Invoice ${input.invoice.number}`));
  doc.setAuthor(winAnsiSafe(input.seller.legalName));
  doc.setCreator("OASIS Command Center — Finances");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612;
  const H = 792;
  const M = 48;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const text = (t: string, x: number, yy: number, size = 10, font = regular, color = INK) =>
    page.drawText(winAnsiSafe(t), { x, y: yy, size, font, color });
  const right = (t: string, xRight: number, yy: number, size = 10, font = regular, color = INK) => {
    const safe = winAnsiSafe(t);
    page.drawText(safe, { x: xRight - font.widthOfTextAtSize(safe, size), y: yy, size, font, color });
  };
  const money = (c: number) => formatCents(c, input.invoice.currency);

  // Header: seller left, invoice block right.
  text(input.seller.legalName, M, y - 4, 16, bold);
  let sy = y - 22;
  for (const l of input.seller.addressLines.filter(Boolean)) {
    text(l, M, sy, 9, regular, MUTED);
    sy -= 12;
  }
  if (input.seller.email) {
    text(input.seller.email, M, sy, 9, regular, MUTED);
    sy -= 12;
  }
  right("INVOICE", W - M, y - 4, 20, bold, ACCENT);
  const meta: Array<[string, string]> = [
    ["Invoice", input.invoice.number],
    ["Issued", input.invoice.issueDate],
    ["Due", input.invoice.dueDate],
  ];
  let my = y - 26;
  for (const [k, v] of meta) {
    right(v, W - M, my, 10, bold);
    right(k, W - M - 110, my, 9, regular, MUTED);
    my -= 14;
  }
  if (input.invoice.status === "paid") {
    right("PAID", W - M, my - 4, 14, bold, ACCENT);
    my -= 18;
  }
  y = Math.min(sy, my) - 18;

  // Bill to
  text("BILL TO", M, y, 8, bold, MUTED);
  y -= 14;
  for (const l of [input.customer.name, input.customer.company, input.customer.email, input.customer.address].filter(Boolean)) {
    for (const w of wrap(l, regular, 10, 280)) {
      text(w, M, y, 10);
      y -= 13;
    }
  }
  y -= 14;

  // Line table
  const colDesc = M;
  const colQty = W - M - 230;
  const colUnit = W - M - 110;
  const colAmt = W - M;
  const header = () => {
    page.drawLine({ start: { x: M, y: y + 12 }, end: { x: W - M, y: y + 12 }, thickness: 0.8, color: RULE });
    text("DESCRIPTION", colDesc, y, 8, bold, MUTED);
    right("QTY", colQty + 30, y, 8, bold, MUTED);
    right("UNIT PRICE", colUnit, y, 8, bold, MUTED);
    right("AMOUNT", colAmt, y, 8, bold, MUTED);
    y -= 8;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: RULE });
    y -= 16;
  };
  header();
  for (const l of input.lines) {
    const descLines = wrap(l.description, regular, 10, colQty - colDesc - 20);
    const needed = descLines.length * 13 + 8;
    if (y - needed < 150) {
      page = doc.addPage([W, H]);
      y = H - M - 10;
      header();
    }
    text(descLines[0], colDesc, y, 10);
    right(quantityMilliToString(l.quantityMilli), colQty + 30, y, 10);
    right(money(l.unitPriceCents), colUnit, y, 10);
    right(money(l.amountCents), colAmt, y, 10);
    for (const extra of descLines.slice(1)) {
      y -= 13;
      text(extra, colDesc, y, 10);
    }
    y -= 20;
  }
  page.drawLine({ start: { x: M, y: y + 8 }, end: { x: W - M, y: y + 8 }, thickness: 0.8, color: RULE });

  // Totals
  if (y < 200) {
    page = doc.addPage([W, H]);
    y = H - M - 10;
  }
  y -= 10;
  const totalRow = (label: string, value: string, strong = false) => {
    right(label, W - M - 130, y, strong ? 11 : 10, strong ? bold : regular, strong ? INK : MUTED);
    right(value, W - M, y, strong ? 11 : 10, strong ? bold : regular);
    y -= strong ? 18 : 15;
  };
  totalRow("Subtotal", money(input.invoice.subtotalCents));
  if (input.invoice.taxRegistered) {
    totalRow(`GST 5%${input.seller.gstNumber ? ` (${input.seller.gstNumber})` : ""}`, money(input.invoice.gstCents));
    totalRow(`QST 9.975%${input.seller.qstNumber ? ` (${input.seller.qstNumber})` : ""}`, money(input.invoice.qstCents));
  }
  totalRow(`Total ${input.invoice.currency}`, money(input.invoice.totalCents), true);
  if (input.invoice.amountPaidCents > 0) {
    totalRow("Paid", `-${money(input.invoice.amountPaidCents)}`);
    totalRow("Balance due", money(Math.max(0, input.invoice.totalCents - input.invoice.amountPaidCents)), true);
  }
  y -= 12;

  // Payment + notes
  const block = (title: string, body: string) => {
    if (!body.trim()) return;
    const lines = wrap(body, regular, 10, W - 2 * M);
    if (y - lines.length * 13 - 20 < M) {
      page = doc.addPage([W, H]);
      y = H - M - 10;
    }
    text(title, M, y, 8, bold, MUTED);
    y -= 14;
    for (const l of lines) {
      text(l, M, y, 10);
      y -= 13;
    }
    y -= 10;
  };
  const rows = (title: string, entries: Array<{ label: string; value: string }>) => {
    const labelW = 130;
    const wrapped = entries.map((row) => ({ label: row.label, lines: wrap(row.value, regular, 10, W - 2 * M - labelW) }));
    const height = wrapped.reduce((a, row) => a + row.lines.length * 13, 0);
    if (y - height - 20 < M) {
      page = doc.addPage([W, H]);
      y = H - M - 10;
    }
    text(title, M, y, 8, bold, MUTED);
    y -= 14;
    for (const row of wrapped) {
      text(row.label, M, y, 9, regular, MUTED);
      row.lines.forEach((l, i) => {
        text(l, M + labelW, y, 10, i === 0 && /reference/i.test(row.label) ? bold : regular);
        y -= 13;
      });
    }
    y -= 10;
  };
  if (input.invoice.bankTransfer?.length && input.invoice.status !== "paid") {
    rows("PAY BY BANK TRANSFER (WISE)", input.invoice.bankTransfer);
  }
  if (input.invoice.paymentLinkUrl && input.invoice.status !== "paid") {
    block("PAY ONLINE", input.invoice.paymentLinkUrl);
  }
  block("PAYMENT", input.invoice.paymentInstructions);
  block("NOTES", input.invoice.notes);

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const footer = winAnsiSafe(`${input.seller.legalName} · Invoice ${input.invoice.number} · Page ${i + 1} of ${pages.length}`);
    p.drawText(footer, { x: M, y: 28, size: 8, font: regular, color: MUTED });
  });
  return doc.save();
}
