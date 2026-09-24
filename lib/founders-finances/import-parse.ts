/**
 * Bank statement parsing (CSV, OFX, QFX) and the import dedupe hash. PURE.
 *
 * THE DEDUPE CONTRACT: importing the same file twice adds zero rows. Each row
 * gets a deterministic hash and fin_bank_transactions has
 * UNIQUE(entity_id, account_id, dedupe_hash), so the database refuses a
 * repeat no matter how the import is retried.
 *
 *   - OFX/QFX rows carry a bank-issued FITID; the hash is the FITID alone.
 *   - CSV rows have no id, so the hash is (date, amount, normalised
 *     description, occurrence#). The occurrence number counts identical
 *     tuples within the file, so two genuine $4.50 coffees on the same day
 *     stay two rows, while re-importing (or importing a wider export that
 *     overlaps) maps each one back onto the row it already produced.
 */

import { createHash } from "node:crypto";
import { parseMoneyToCents } from "./money";
import { isIsoDate } from "./fx";
import { normalizeText } from "./rules";

export type ImportFormat = "csv" | "ofx" | "qfx";

export type ParsedTxn = {
  postedDate: string;
  description: string;
  payee: string;
  amountCents: number;
  fitid: string | null;
};

export type ParseResult = {
  format: ImportFormat;
  rows: ParsedTxn[];
  errors: string[];
  currency: string | null;
  notes: string[];
};

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;

export function detectFormat(filename: string, text: string): ImportFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".qfx")) return "qfx";
  if (lower.endsWith(".ofx")) return "ofx";
  const head = text.slice(0, 2000).toUpperCase();
  if (head.includes("<OFX>") || head.includes("OFXHEADER")) return "ofx";
  return "csv";
}

// ── CSV ──────────────────────────────────────────────────────────────────

/** RFC 4180 reader with delimiter sniffing (comma, semicolon, tab). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] || "";
  const counts: Array<[string, number]> = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  const delim = counts[0][1] > 0 ? counts[0][0] : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

export type DateOrder = "ymd" | "mdy" | "dmy";

function parseDateParts(raw: string): [number, number, number] | null {
  const s = raw.trim().split(/[ T]/)[0];
  const m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (compact) return [Number(compact[1]), Number(compact[2]), Number(compact[3])];
  return null;
}

function toIso(y: number, mo: number, d: number): string | null {
  const iso = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

export function parseBankDate(raw: string, order: DateOrder): string | null {
  const p = parseDateParts(raw);
  if (!p) return null;
  const [a, b, c] = p;
  if (a > 31) return toIso(a, b, c); // YYYY-MM-DD regardless of order
  const year = c < 100 ? 2000 + c : c;
  return order === "dmy" ? toIso(year, b, a) : toIso(year, a, b);
}

/**
 * Canadian bank exports disagree: RBC and TD write MM/DD/YYYY, Desjardins
 * YYYY-MM-DD, some DD/MM/YYYY. Decide from the data: a first part > 12 proves
 * day-first, a second part > 12 proves month-first. Ambiguous files default to
 * month-first and SAY SO in the preview notes, with an override available.
 */
export function inferDateOrder(samples: readonly string[]): { order: DateOrder; ambiguous: boolean } {
  let dayFirst = false;
  let monthFirst = false;
  let ymd = false;
  for (const s of samples) {
    const p = parseDateParts(s);
    if (!p) continue;
    if (p[0] > 31) {
      ymd = true;
      continue;
    }
    if (p[0] > 12) dayFirst = true;
    if (p[1] > 12) monthFirst = true;
  }
  if (ymd && !dayFirst && !monthFirst) return { order: "ymd", ambiguous: false };
  if (dayFirst && !monthFirst) return { order: "dmy", ambiguous: false };
  if (monthFirst && !dayFirst) return { order: "mdy", ambiguous: false };
  return { order: "mdy", ambiguous: !ymd };
}

const H_DATE = /^(date|posted|posting date|transaction date|trans\.? date|date posted|date de transaction|date)$/;
const H_DESC = /^(description|details|memo|transaction|narrative|description 1|libelle|name)$/;
const H_DESC2 = /^(description 2|memo 2|notes)$/;
const H_PAYEE = /^(payee|merchant|name|beneficiary)$/;
const H_AMOUNT = /^(amount|montant|cad\$|usd\$|amount \(cad\)|transaction amount)$/;
const H_DEBIT = /^(debit|withdrawal|withdrawals|money out|debits|retrait)$/;
const H_CREDIT = /^(credit|deposit|deposits|money in|credits|depot)$/;

function findCol(header: string[], rx: RegExp, exclude: number[] = []): number {
  return header.findIndex((h, i) => !exclude.includes(i) && rx.test(normalizeText(h)));
}

export function mapCsvRows(
  table: string[][],
  opts: { dateOrder?: DateOrder } = {},
): ParseResult {
  const errors: string[] = [];
  const notes: string[] = [];
  if (table.length === 0) return { format: "csv", rows: [], errors: ["file is empty"], currency: null, notes };

  const first = table[0];
  const headerless = parseDateParts(first[0] || "") !== null;
  let dateCol: number;
  let descCol: number;
  let desc2Col = -1;
  let payeeCol = -1;
  let amountCol = -1;
  let debitCol = -1;
  let creditCol = -1;
  let body: string[][];

  if (headerless) {
    // TD-style: date, description, debit, credit[, balance] — or date, description, amount.
    body = table;
    dateCol = 0;
    descCol = 1;
    if (first.length >= 4) {
      debitCol = 2;
      creditCol = 3;
      notes.push("No header row: read columns as date, description, withdrawal, deposit.");
    } else {
      amountCol = 2;
      notes.push("No header row: read columns as date, description, amount.");
    }
  } else {
    const header = first;
    body = table.slice(1);
    dateCol = findCol(header, H_DATE);
    descCol = findCol(header, H_DESC, [dateCol]);
    desc2Col = findCol(header, H_DESC2, [dateCol, descCol]);
    payeeCol = findCol(header, H_PAYEE, [dateCol, descCol]);
    amountCol = findCol(header, H_AMOUNT);
    debitCol = findCol(header, H_DEBIT);
    creditCol = findCol(header, H_CREDIT);
    if (dateCol < 0) errors.push(`no date column found in header: ${header.join(", ")}`);
    if (descCol < 0 && payeeCol >= 0) descCol = payeeCol;
    if (descCol < 0) errors.push(`no description column found in header: ${header.join(", ")}`);
    if (amountCol < 0 && debitCol < 0 && creditCol < 0) {
      errors.push("no amount (or debit/credit) column found");
    }
    if (errors.length) return { format: "csv", rows: [], errors, currency: null, notes };
  }

  const inferred = inferDateOrder(body.slice(0, 200).map((r) => r[dateCol] || ""));
  const order = opts.dateOrder || inferred.order;
  if (!opts.dateOrder && inferred.ambiguous) {
    notes.push("Dates are ambiguous (every day is 12 or less) — read as month/day/year. Override if your bank writes day first.");
  }

  const rows: ParsedTxn[] = [];
  body.forEach((r, idx) => {
    const lineNo = headerless ? idx + 1 : idx + 2;
    const rawDate = r[dateCol] || "";
    const postedDate = parseBankDate(rawDate, order);
    if (!postedDate) {
      errors.push(`line ${lineNo}: unreadable date "${rawDate}"`);
      return;
    }
    let amount: number | null = null;
    if (amountCol >= 0 && (r[amountCol] || "").trim() !== "") {
      amount = parseMoneyToCents(r[amountCol]);
    } else {
      const debit = debitCol >= 0 && (r[debitCol] || "").trim() ? parseMoneyToCents(r[debitCol]) : 0;
      const credit = creditCol >= 0 && (r[creditCol] || "").trim() ? parseMoneyToCents(r[creditCol]) : 0;
      if (debit === null || credit === null) amount = null;
      else amount = Math.abs(credit) - Math.abs(debit);
    }
    if (amount === null) {
      errors.push(`line ${lineNo}: unreadable amount`);
      return;
    }
    if (amount === 0) return; // zero rows (balance lines, holds) are not transactions
    const description = [r[descCol] || "", desc2Col >= 0 ? r[desc2Col] || "" : ""]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!description) {
      errors.push(`line ${lineNo}: empty description`);
      return;
    }
    rows.push({
      postedDate,
      description: description.slice(0, 300),
      payee: payeeCol >= 0 && payeeCol !== descCol ? (r[payeeCol] || "").slice(0, 200) : "",
      amountCents: amount,
      fitid: null,
    });
  });
  if (rows.length > MAX_IMPORT_ROWS) {
    return { format: "csv", rows: [], errors: [`file has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS}`], currency: null, notes };
  }
  return { format: "csv", rows, errors, currency: null, notes };
}

// ── OFX / QFX ────────────────────────────────────────────────────────────

function ofxTag(block: string, tag: string): string | null {
  // SGML OFX omits closing tags; XML OFX has them. Read up to the next "<" either way.
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
  return m ? m[1].trim() : null;
}

export function parseOfx(text: string, format: "ofx" | "qfx" = "ofx"): ParseResult {
  const errors: string[] = [];
  const rows: ParsedTxn[] = [];
  const currency = ofxTag(text, "CURDEF");
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  blocks.forEach((raw, i) => {
    const block = raw.split(/<\/STMTTRN>/i)[0];
    const amt = ofxTag(block, "TRNAMT");
    const dt = ofxTag(block, "DTPOSTED");
    const fitid = ofxTag(block, "FITID");
    const name = ofxTag(block, "NAME") || "";
    const memo = ofxTag(block, "MEMO") || "";
    const amountCents = amt === null ? null : parseMoneyToCents(amt.replace(",", "."));
    const postedDate = dt ? toIsoFromOfx(dt) : null;
    if (amountCents === null || postedDate === null) {
      errors.push(`transaction ${i + 1}: unreadable ${amountCents === null ? "amount" : "date"}`);
      return;
    }
    if (amountCents === 0) return;
    const description = [name, memo && memo !== name ? memo : ""].filter(Boolean).join(" — ").trim() || "(no description)";
    rows.push({
      postedDate,
      description: description.slice(0, 300),
      payee: name.slice(0, 200),
      amountCents,
      fitid: fitid && fitid.length > 0 ? fitid.slice(0, 120) : null,
    });
  });
  if (blocks.length === 0) errors.push("no <STMTTRN> transactions found");
  if (rows.length > MAX_IMPORT_ROWS) {
    return { format, rows: [], errors: [`file has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS}`], currency, notes: [] };
  }
  return { format, rows, errors, currency: currency ? currency.toUpperCase() : null, notes: [] };
}

function toIsoFromOfx(dt: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(dt.trim());
  return m ? toIso(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

export function parseStatement(
  filename: string,
  text: string,
  opts: { dateOrder?: DateOrder } = {},
): ParseResult {
  const format = detectFormat(filename, text);
  if (format === "csv") return mapCsvRows(parseCsv(text), opts);
  return parseOfx(text, format);
}

// ── dedupe ───────────────────────────────────────────────────────────────

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** One hash per row, same order. See the contract at the top of this file. */
export function dedupeHashes(rows: readonly ParsedTxn[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    if (r.fitid) return sha256Hex(`fitid|${r.fitid}`);
    const tuple = `${r.postedDate}|${r.amountCents}|${normalizeText(r.description)}`;
    const n = (seen.get(tuple) || 0) + 1;
    seen.set(tuple, n);
    return sha256Hex(`row|${tuple}|${n}`);
  });
}

/** Hash for a manually entered or Atlas-drafted transaction (no file). */
export function manualDedupeHash(input: {
  postedDate: string;
  amountCents: number;
  description: string;
  sourceRef?: string | null;
  nonce?: string;
}): string {
  if (input.sourceRef) return sha256Hex(`ref|${input.sourceRef}`);
  return sha256Hex(`manual|${input.postedDate}|${input.amountCents}|${normalizeText(input.description)}|${input.nonce || ""}`);
}
