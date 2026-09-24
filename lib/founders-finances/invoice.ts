/**
 * Invoice arithmetic, numbering and status rules. PURE.
 *
 * Quantities are stored as integer thousandths (quantity_milli) so "1.5 hours"
 * is exact. A line amount is quantity x unit price rounded half away from zero
 * to the cent; the invoice total is the sum of line amounts plus tax computed
 * ONCE on the taxable subtotal (tax.ts).
 */

import { divRoundHalfAwayFromZero, isCurrency, parseMoneyToCents, type Currency } from "./money";
import { computeSalesTax } from "./tax";
import { addDays, isIsoDate } from "./fx";

export const INVOICE_STATUSES = ["draft", "sent", "overdue", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export type InvoiceLineInput = {
  description: string;
  quantity: string | number;
  unitPrice: string | number;
  taxable?: boolean;
};

export type ComputedLine = {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  amountCents: number;
  taxable: boolean;
};

export type InvoiceTotals = {
  lines: ComputedLine[];
  subtotalCents: number;
  taxableSubtotalCents: number;
  gstCents: number;
  qstCents: number;
  totalCents: number;
};

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
    return {
      description,
      quantityMilli,
      unitPriceCents,
      amountCents: lineAmountCents(quantityMilli, unitPriceCents),
      taxable: l.taxable !== false,
    };
  });
  const subtotalCents = computed.reduce((a, l) => a + l.amountCents, 0);
  const taxableSubtotalCents = computed.filter((l) => l.taxable).reduce((a, l) => a + l.amountCents, 0);
  const tax = computeSalesTax(taxableSubtotalCents, opts.registered);
  const totalCents = subtotalCents + tax.taxCents;
  if (!Number.isSafeInteger(totalCents)) throw new InvoiceError("invoice total overflows");
  return {
    lines: computed,
    subtotalCents,
    taxableSubtotalCents,
    gstCents: tax.gstCents,
    qstCents: tax.qstCents,
    totalCents,
  };
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
 */
export function effectiveInvoiceStatus(
  inv: { status: InvoiceStatus; dueDate: string; totalCents: number; amountPaidCents: number },
  today: string,
): InvoiceStatus {
  if (inv.status === "void" || inv.status === "draft") return inv.status;
  if (inv.amountPaidCents >= inv.totalCents && inv.totalCents > 0) return "paid";
  if (inv.status === "paid") return "paid";
  return inv.dueDate < today ? "overdue" : "sent";
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

export function validateInvoiceCurrency(value: unknown): Currency {
  if (!isCurrency(value)) throw new InvoiceError("currency must be CAD or USD");
  return value;
}
