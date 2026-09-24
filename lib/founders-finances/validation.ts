/**
 * Input validation shared by the UI routes and the internal (Atlas) API.
 * PURE. "Every write validated with the same pure rules the UI uses" — both
 * surfaces call these, so a draft Atlas extracted from an email and a row a
 * founder typed in are held to one standard.
 */

import { isCurrency, parseMoneyToCents, type Currency } from "./money";
import { isIsoDate } from "./fx";

export const MAX_TXN_ABS_CENTS = 100_000_000_00; // CA$100M: far above anything real, below overflow
export const MAX_BULK_TRANSACTIONS = 200;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export type TransactionInput = {
  postedDate: string;
  description: string;
  payee: string;
  amountCents: number;
  currency: Currency;
  accountCode: string | null;
  categoryName: string | null;
  categoryId: string | null;
  memo: string;
  externalRef: string | null;
};

/**
 * `amount` is SIGNED: positive = money in, negative = money out. Accepts
 * `amount_cents` (integer) or `amount` (decimal string/number).
 */
export function validateTransactionInput(raw: unknown): Result<TransactionInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "transaction must be an object" };
  const r = raw as Record<string, unknown>;
  const postedDate = text(r.date ?? r.posted_date ?? r.postedDate, 10);
  if (!isIsoDate(postedDate)) return { ok: false, error: "date must be YYYY-MM-DD" };
  const description = text(r.description, 300);
  if (description.length < 2) return { ok: false, error: "description is required" };
  let amountCents: number | null = null;
  if (r.amount_cents !== undefined) {
    amountCents = typeof r.amount_cents === "number" && Number.isSafeInteger(r.amount_cents) ? r.amount_cents : null;
  } else if (r.amountCents !== undefined) {
    amountCents = typeof r.amountCents === "number" && Number.isSafeInteger(r.amountCents) ? r.amountCents : null;
  } else {
    amountCents = parseMoneyToCents(r.amount as string | number | undefined);
  }
  if (amountCents === null) return { ok: false, error: "amount must be a number (negative = money out)" };
  if (amountCents === 0) return { ok: false, error: "amount must not be zero" };
  if (Math.abs(amountCents) > MAX_TXN_ABS_CENTS) return { ok: false, error: "amount is implausibly large" };
  const currency = text(r.currency, 3).toUpperCase() || "CAD";
  if (!isCurrency(currency)) return { ok: false, error: "currency must be CAD or USD" };
  const externalRef = text(r.external_ref ?? r.externalRef, 200) || null;
  return {
    ok: true,
    value: {
      postedDate,
      description,
      payee: text(r.payee, 200),
      amountCents,
      currency,
      accountCode: text(r.account_code ?? r.accountCode, 20) || null,
      categoryName: text(r.category ?? r.categoryName, 120) || null,
      categoryId: text(r.category_id ?? r.categoryId, 120) || null,
      memo: text(r.memo, 1000),
      externalRef,
    },
  };
}

export function validateBulkTransactions(raw: unknown): {
  valid: Array<{ index: number; value: TransactionInput }>;
  errors: Array<{ index: number; error: string }>;
  fatal: string | null;
} {
  if (!Array.isArray(raw)) return { valid: [], errors: [], fatal: "transactions must be an array" };
  if (raw.length === 0) return { valid: [], errors: [], fatal: "transactions is empty" };
  if (raw.length > MAX_BULK_TRANSACTIONS) {
    return { valid: [], errors: [], fatal: `at most ${MAX_BULK_TRANSACTIONS} transactions per call` };
  }
  const valid: Array<{ index: number; value: TransactionInput }> = [];
  const errors: Array<{ index: number; error: string }> = [];
  raw.forEach((item, index) => {
    const v = validateTransactionInput(item);
    if (v.ok) valid.push({ index, value: v.value });
    else errors.push({ index, error: v.error });
  });
  return { valid, errors, fatal: null };
}

export type BillInput = {
  kind: "bill" | "expense";
  vendorName: string;
  contactId: string | null;
  reference: string;
  billDate: string;
  dueDate: string | null;
  currency: Currency;
  subtotalCents: number;
  gstCents: number;
  qstCents: number;
  categoryId: string;
  paidFromAccountId: string | null;
  memo: string;
};

export function validateBillInput(raw: unknown): Result<BillInput> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "bill must be an object" };
  const r = raw as Record<string, unknown>;
  const kind = r.kind === "bill" ? "bill" : r.kind === "expense" ? "expense" : null;
  if (!kind) return { ok: false, error: "kind must be bill or expense" };
  const vendorName = text(r.vendor_name ?? r.vendorName, 200);
  if (!vendorName) return { ok: false, error: "vendor is required" };
  const billDate = text(r.bill_date ?? r.billDate, 10);
  if (!isIsoDate(billDate)) return { ok: false, error: "date must be YYYY-MM-DD" };
  const dueRaw = text(r.due_date ?? r.dueDate, 10);
  const dueDate = dueRaw ? dueRaw : null;
  if (dueDate && !isIsoDate(dueDate)) return { ok: false, error: "due date must be YYYY-MM-DD" };
  const currency = text(r.currency, 3).toUpperCase() || "CAD";
  if (!isCurrency(currency)) return { ok: false, error: "currency must be CAD or USD" };
  const subtotalCents = parseMoneyToCents(r.subtotal as string | number | undefined);
  if (subtotalCents === null || subtotalCents <= 0) return { ok: false, error: "amount must be greater than zero" };
  const gst = r.gst === undefined || r.gst === "" ? 0 : parseMoneyToCents(r.gst as string | number);
  const qst = r.qst === undefined || r.qst === "" ? 0 : parseMoneyToCents(r.qst as string | number);
  if (gst === null || gst < 0 || qst === null || qst < 0) return { ok: false, error: "GST/QST must be non-negative amounts" };
  const categoryId = text(r.category_id ?? r.categoryId, 120);
  if (!categoryId) return { ok: false, error: "category is required" };
  const paidFrom = text(r.paid_from_account_id ?? r.paidFromAccountId, 120) || null;
  if (kind === "expense" && !paidFrom) return { ok: false, error: "an expense needs the account it was paid from" };
  return {
    ok: true,
    value: {
      kind,
      vendorName,
      contactId: text(r.contact_id ?? r.contactId, 120) || null,
      reference: text(r.reference, 120),
      billDate,
      dueDate,
      currency,
      subtotalCents,
      gstCents: gst,
      qstCents: qst,
      categoryId,
      paidFromAccountId: paidFrom,
      memo: text(r.memo, 1000),
    },
  };
}

export type EquityInput = {
  ownerKey: "cc" | "adon";
  kind: "draw" | "contribution";
  amountCents: number;
  currency: Currency;
  eventDate: string;
  cashAccountId: string;
  memo: string;
};

export function validateEquityInput(raw: unknown): Result<EquityInput> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "equity event must be an object" };
  const r = raw as Record<string, unknown>;
  const ownerKey = r.owner_key === "cc" || r.owner_key === "adon" ? r.owner_key : null;
  if (!ownerKey) return { ok: false, error: "owner must be cc or adon" };
  const kind = r.kind === "draw" || r.kind === "contribution" ? r.kind : null;
  if (!kind) return { ok: false, error: "kind must be draw or contribution" };
  const amountCents = parseMoneyToCents(r.amount as string | number | undefined);
  if (amountCents === null || amountCents <= 0) return { ok: false, error: "amount must be greater than zero" };
  const currency = text(r.currency, 3).toUpperCase() || "CAD";
  if (!isCurrency(currency)) return { ok: false, error: "currency must be CAD or USD" };
  const eventDate = text(r.event_date ?? r.date, 10);
  if (!isIsoDate(eventDate)) return { ok: false, error: "date must be YYYY-MM-DD" };
  const cashAccountId = text(r.cash_account_id, 120);
  if (!cashAccountId) return { ok: false, error: "choose the account the money moved through" };
  return { ok: true, value: { ownerKey, kind, amountCents, currency, eventDate, cashAccountId, memo: text(r.memo, 500) } };
}

export function validateEmail(v: unknown): string | null {
  const s = text(v, 254).toLowerCase();
  return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i.test(s) ? s : null;
}
