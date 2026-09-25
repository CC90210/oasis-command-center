/**
 * Invoice arithmetic, numbering and status rules. PURE.
 *
 * Quantities are stored as integer thousandths (quantity_milli) so "1.5 hours"
 * is exact. A line amount is quantity x unit price rounded half away from zero
 * to the cent; the invoice total is the sum of line amounts plus tax computed
 * ONCE on the taxable subtotal (tax.ts).
 *
 * ONE-TIME vs MONTHLY (migration 185). Every line is billed either once (the
 * implementation price — the default, and every line before 185) or monthly
 * (the retainer). The two are totalled SEPARATELY, each with its own tax:
 * the top-level subtotal/gst/qst/total are the ONE-TIME figures — what the
 * invoice books as a receivable and asks to be paid now — and `monthly` is
 * the retainer the client subscribes to through a Stripe recurring link. The
 * retainer is never part of the receivable: each month's charge is booked
 * when Stripe collects it, so it is counted once.
 */

import { divRoundHalfAwayFromZero, isCurrency, parseMoneyToCents, type Currency } from "./money";
import { computeSalesTax } from "./tax";
import { addDays, isIsoDate } from "./fx";

export const INVOICE_STATUSES = ["draft", "sent", "overdue", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const LINE_BILLINGS = ["one_time", "monthly"] as const;
export type LineBilling = (typeof LINE_BILLINGS)[number];

export const LINE_BILLING_LABEL: Readonly<Record<LineBilling, string>> = {
  one_time: "One-time",
  monthly: "Monthly",
};

export function parseLineBilling(value: unknown): LineBilling | null {
  return typeof value === "string" && (LINE_BILLINGS as readonly string[]).includes(value) ? (value as LineBilling) : null;
}

/** A stored line's billing. Rows from before migration 185 have no column: they are all one-time. */
export function storedLineBilling(value: unknown): LineBilling {
  return parseLineBilling(value) ?? "one_time";
}

export type InvoiceLineInput = {
  description: string;
  quantity: string | number;
  unitPrice: string | number;
  taxable?: boolean;
  /** Omitted = one-time. */
  billing?: LineBilling;
};

export type ComputedLine = {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  amountCents: number;
  taxable: boolean;
  billing: LineBilling;
};

export type GroupTotals = {
  subtotalCents: number;
  taxableSubtotalCents: number;
  gstCents: number;
  qstCents: number;
  totalCents: number;
};

/**
 * Top-level figures are the ONE-TIME part (the receivable, "due now");
 * `monthly` is the retainer per month. With no monthly line, `monthly` is all
 * zeros and the top level is exactly the whole invoice, as before 185.
 */
export type InvoiceTotals = GroupTotals & {
  lines: ComputedLine[];
  monthly: GroupTotals;
};

function groupTotals(lines: readonly ComputedLine[], billing: LineBilling, registered: boolean): GroupTotals {
  const own = lines.filter((l) => l.billing === billing);
  const subtotalCents = own.reduce((a, l) => a + l.amountCents, 0);
  const taxableSubtotalCents = own.filter((l) => l.taxable).reduce((a, l) => a + l.amountCents, 0);
  const tax = computeSalesTax(taxableSubtotalCents, registered);
  const totalCents = subtotalCents + tax.taxCents;
  if (!Number.isSafeInteger(totalCents)) throw new InvoiceError("invoice total overflows");
  return { subtotalCents, taxableSubtotalCents, gstCents: tax.gstCents, qstCents: tax.qstCents, totalCents };
}

function splitTotals(lines: ComputedLine[], registered: boolean): InvoiceTotals {
  return { lines, ...groupTotals(lines, "one_time", registered), monthly: groupTotals(lines, "monthly", registered) };
}

export class InvoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceError";
  }
}

/** "1.5" -> 1500. Up to three decimals; must be > 0. */
export function parseQuantityMilli(q: string | number): number {
  const s = String(q).trim();
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) throw new InvoiceError(`quantity "${q}" must be a positive number with up to 3 decimals`);
  const milli = Number(m[1]) * 1000 + Number((m[2] || "").padEnd(3, "0"));
  if (!Number.isSafeInteger(milli) || milli <= 0) throw new InvoiceError("quantity must be greater than zero");
  return milli;
}

export function lineAmountCents(quantityMilli: number, unitPriceCents: number): number {
  return Number(
    divRoundHalfAwayFromZero(BigInt(quantityMilli) * BigInt(unitPriceCents), BigInt(1000)),
  );
}

export function computeInvoiceTotals(
  lines: readonly InvoiceLineInput[],
  opts: { registered: boolean },
): InvoiceTotals {
  if (!Array.isArray(lines) || lines.length === 0) throw new InvoiceError("an invoice needs at least one line");
  if (lines.length > 100) throw new InvoiceError("an invoice may have at most 100 lines");
  const computed = lines.map((l, i) => {
    const description = String(l.description || "").trim();
    if (!description) throw new InvoiceError(`line ${i + 1} needs a description`);
    if (description.length > 500) throw new InvoiceError(`line ${i + 1} description is too long`);
    const quantityMilli = parseQuantityMilli(l.quantity);
    const unitPriceCents = parseMoneyToCents(l.unitPrice);
    if (unitPriceCents === null || unitPriceCents < 0) {
      throw new InvoiceError(`line ${i + 1} unit price must be a non-negative amount`);
    }
    if (l.billing !== undefined && parseLineBilling(l.billing) === null) {
      throw new InvoiceError(`line ${i + 1} must be billed one-time or monthly`);
    }
    return {
      description,
      quantityMilli,
      unitPriceCents,
      amountCents: lineAmountCents(quantityMilli, unitPriceCents),
      taxable: l.taxable !== false,
      billing: storedLineBilling(l.billing),
    };
  });
  return splitTotals(computed, opts.registered);
}

/**
 * Re-total already-stored lines (integers) under the CURRENT registration
 * status — used when a draft is finalised, so a draft written before
 * registration was switched on is issued with the tax that now applies.
 */
export function totalsFromStoredLines(
  lines: ReadonlyArray<{ description: string; quantityMilli: number; unitPriceCents: number; taxable: boolean; billing?: LineBilling }>,
  opts: { registered: boolean },
): InvoiceTotals {
  if (lines.length === 0) throw new InvoiceError("an invoice needs at least one line");
  const computed = lines.map((l) => ({
    description: l.description,
    quantityMilli: l.quantityMilli,
    unitPriceCents: l.unitPriceCents,
    amountCents: lineAmountCents(l.quantityMilli, l.unitPriceCents),
    taxable: l.taxable,
    billing: storedLineBilling(l.billing),
  }));
  return splitTotals(computed, opts.registered);
}

/** "1500" -> "1.5" for form defaults. */
export function quantityMilliToString(milli: number): string {
  const whole = Math.floor(milli / 1000);
  const frac = String(milli % 1000).padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** "OASIS" + 2026 + 1 -> "OASIS-2026-0001". Sequence pads to 4, grows past 9999. */
export function formatInvoiceNumber(prefix: string, year: number, seq: number): string {
  const p = sanitizePrefix(prefix);
  return `${p}-${year}-${String(seq).padStart(4, "0")}`;
}

export function sanitizePrefix(prefix: string): string {
  const p = String(prefix || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!p) return "INV";
  return p.slice(0, 12);
}

/**
 * Allocate the next number for an invoice being SENT in `year`. The sequence
 * resets to 1 when the year moves on. Returns the number and the settings
 * values to persist. The DB unique index is the backstop against a race.
 */
export function allocateInvoiceNumber(
  settings: { prefix: string; nextNumber: number; numberYear: number | null },
  year: number,
): { number: string; nextNumber: number; numberYear: number } {
  const seq = settings.numberYear === year ? Math.max(1, settings.nextNumber) : 1;
  return {
    number: formatInvoiceNumber(settings.prefix, year, seq),
    nextNumber: seq + 1,
    numberYear: year,
  };
}

export function dueDateFor(issueDate: string, termsDays: number): string {
  if (!isIsoDate(issueDate)) throw new InvoiceError("issue date must be YYYY-MM-DD");
  return addDays(issueDate, Math.max(0, Math.min(365, Math.trunc(termsDays))));
}

/**
 * What the invoice IS today. `overdue` is derived, so a stored `sent` invoice
 * whose due date has passed reads as overdue everywhere without a job having
 * to run first; the sweep persists it so lists and the internal API agree.
 *
 * `totalCents` is the ONE-TIME total. An invoice with nothing due now (it only
 * sets up a monthly retainer) is never overdue: there is nothing to chase —
 * the retainer is collected by Stripe, not by the invoice.
 */
export function effectiveInvoiceStatus(
  inv: { status: InvoiceStatus; dueDate: string; totalCents: number; amountPaidCents: number },
  today: string,
): InvoiceStatus {
  if (inv.status === "void" || inv.status === "draft") return inv.status;
  if (inv.amountPaidCents >= inv.totalCents && inv.totalCents > 0) return "paid";
  if (inv.status === "paid") return "paid";
  if (inv.totalCents <= 0) return "sent";
  return inv.dueDate < today ? "overdue" : "sent";
}

/**
 * What an invoice LIST shows (and what "open" means to a founder or Atlas).
 * An issued invoice with nothing due now — it only sets up a monthly retainer —
 * is not an open invoice: nothing is owed on it and nothing can be chased, so
 * it is listed as `retainer`, never counted with sent/overdue. Every other
 * invoice shows its effective status unchanged.
 */
export type InvoiceListStatus = InvoiceStatus | "retainer";

export function invoiceListStatus(effective: InvoiceStatus, hasAmountDueNow: boolean): InvoiceListStatus {
  return !hasAmountDueNow && (effective === "sent" || effective === "overdue") ? "retainer" : effective;
}

/** The statuses that mean "money is owed on this invoice now". */
export function isOpenListStatus(s: InvoiceListStatus): boolean {
  return s === "sent" || s === "overdue";
}

const TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ["sent", "void"],
  sent: ["overdue", "paid", "void"],
  overdue: ["sent", "paid", "void"],
  paid: [],
  void: [],
};

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function balanceDueCents(inv: { totalCents: number; amountPaidCents: number }): number {
  return Math.max(0, inv.totalCents - inv.amountPaidCents);
}

/**
 * Whether an invoice has a one-time part to be paid now. False only for a
 * retainer-only invoice (one-time total 0, retainer > 0); an invoice without a
 * retainer keeps today's behaviour whatever its total.
 */
export function hasAmountDueNow(inv: { totalCents: number; retainerMonthlyCents: number }): boolean {
  return inv.totalCents > 0 || inv.retainerMonthlyCents <= 0;
}

/**
 * Why a taxed retainer is refused. Registered for GST/QST, a taxable monthly
 * line puts GST + QST into the retainer's Stripe price, and the Stripe ingest
 * books every subscription charge entirely as revenue — it has no tax split.
 * The tax the client pays each month would be counted as income and never
 * reach GST/QST payable. Until the ingest splits retainer tax out, a monthly
 * line that carries tax is refused. A monthly line not marked taxable (a
 * zero-rated service, e.g. to a non-resident client) is fine, and nothing
 * changes while the business is not registered (no tax is computed at all).
 */
export const RETAINER_TAX_REFUSED =
  "A monthly retainer can't include GST/QST yet: the Stripe feed books each monthly card charge entirely as revenue, so the tax the client pays would be counted as income instead of tax owed. Leave the retainer off this invoice until the Stripe feed splits out retainer tax (untick Tax on it only if the service really is zero-rated).";

export function retainerTaxRefusal(totals: { monthly: Pick<GroupTotals, "gstCents" | "qstCents"> }): string | null {
  return totals.monthly.gstCents + totals.monthly.qstCents > 0 ? RETAINER_TAX_REFUSED : null;
}

/** How the one-time part can be paid, from what the email / PDF actually carries — "Implementation — … : {this}". */
export function oneTimePayVerb(hasBankTransfer: boolean, hasCardLink: boolean): string {
  if (hasBankTransfer && hasCardLink) return "pay by bank transfer or card";
  if (hasBankTransfer) return "pay by bank transfer";
  if (hasCardLink) return "pay by card";
  return "pay as follows";
}

export function validateInvoiceCurrency(value: unknown): Currency {
  if (!isCurrency(value)) throw new InvoiceError("currency must be CAD or USD");
  return value;
}
