/**
 * Invoice rows and the two journal shapes every invoice path shares:
 * recognition (issue) and settlement (payment). Used by invoices-io.ts
 * (manual payment, send, void) and stripe-ingest.ts (Stripe payment), so an
 * invoice paid by e-transfer and one paid by card post the same way.
 */
import "server-only";

import { crossCurrencySettlementLines, type JournalLineInput } from "./ledger";
import { accountId, SYS } from "./chart";
import { finDb, query, queryOne, type InStatement } from "./db";
import { buildPosting, type Posting } from "./ledger-io";
import { usdToCadCents, parseRateMicro } from "./fx";
import type { InvoiceStatus } from "./invoice";

export type InvoiceRow = {
  id: string;
  entity_id: string;
  contact_id: string;
  number: string | null;
  status: InvoiceStatus;
  issue_date: string;
  due_date: string;
  currency: "CAD" | "USD";
  subtotal_cents: number;
  gst_cents: number;
  qst_cents: number;
  total_cents: number;
  amount_paid_cents: number;
  tax_registered_snapshot: number;
  notes: string;
  recognition_entry_id: string | null;
  stripe_price_id: string | null;
  stripe_payment_link_id: string | null;
  stripe_payment_link_url: string | null;
  sent_at: string | null;
  sent_to: string | null;
  paid_at: string | null;
  voided_at: string | null;
  last_reminded_at: string | null;
  reminder_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** Migration 184. Absent until it is applied: read it through wise.ts storedPaymentMethod(). */
  payment_method?: string | null;
};

export type InvoiceLineRow = {
  id: string;
  invoice_id: string;
  line_no: number;
  description: string;
  quantity_milli: number;
  unit_price_cents: number;
  amount_cents: number;
  taxable: number;
  revenue_account_id: string;
};

export type ContactRow = {
  id: string;
  entity_id: string;
  kind: string;
  name: string;
  email: string;
  company: string;
  address: string;
  stripe_customer_id: string | null;
};

let methodColumn: { at: number; ok: boolean } | null = null;

/**
 * Is fin_invoices.payment_method there (migration 184)? Code ships before a
 * migration reaches every database, so writers ask first: until it is
 * applied, every invoice reads as "stripe" and behaves exactly as before.
 * A yes is remembered for the isolate's life; a no is re-checked after a
 * minute, so applying the migration takes effect without a redeploy.
 */
export async function paymentMethodColumnReady(): Promise<boolean> {
  if (methodColumn && (methodColumn.ok || Date.now() - methodColumn.at < 60_000)) return methodColumn.ok;
  let ok = true;
  try {
    await finDb().execute(`SELECT payment_method FROM fin_invoices LIMIT 0`);
  } catch (e) {
    if (!/no such column/i.test(e instanceof Error ? e.message : String(e))) throw e;
    ok = false;
  }
  methodColumn = { at: Date.now(), ok };
  return ok;
}

export function resetPaymentMethodColumnMemo(): void {
  methodColumn = null;
}

export async function loadInvoice(id: string): Promise<InvoiceRow | null> {
  return queryOne<InvoiceRow>(`SELECT * FROM fin_invoices WHERE id = ?`, [id]);
}

export async function loadInvoiceLines(id: string): Promise<InvoiceLineRow[]> {
  return query<InvoiceLineRow>(`SELECT * FROM fin_invoice_lines WHERE invoice_id = ? ORDER BY line_no`, [id]);
}

export async function loadContact(id: string): Promise<ContactRow | null> {
  return queryOne<ContactRow>(`SELECT id, entity_id, kind, name, email, company, address, stripe_customer_id FROM fin_contacts WHERE id = ?`, [id]);
}

/** Dr AR / Cr revenue per line / Cr GST, QST payable — in the invoice currency at the issue date's rate. */
export async function buildRecognitionPosting(
  inv: InvoiceRow,
  lines: readonly InvoiceLineRow[],
  createdBy: string,
  gate?: { sql: string; args: Array<string | number | null> },
): Promise<Posting> {
  const e = inv.entity_id;
  const cur = inv.currency;
  const jl: JournalLineInput[] = [
    { accountId: accountId(e, SYS.ar), currency: cur, debitCents: inv.total_cents, contactId: inv.contact_id, memo: `Invoice ${inv.number || inv.id}` },
  ];
  // Merge lines per revenue account so the entry stays small.
  const byAccount = new Map<string, number>();
  for (const l of lines) byAccount.set(l.revenue_account_id, (byAccount.get(l.revenue_account_id) || 0) + l.amount_cents);
  for (const [acct, cents] of byAccount) if (cents > 0) jl.push({ accountId: acct, currency: cur, creditCents: cents, contactId: inv.contact_id });
  if (inv.gst_cents > 0) jl.push({ accountId: accountId(e, SYS.gstPayable), currency: cur, creditCents: inv.gst_cents, memo: "GST collected" });
  if (inv.qst_cents > 0) jl.push({ accountId: accountId(e, SYS.qstPayable), currency: cur, creditCents: inv.qst_cents, memo: "QST collected" });
  return buildPosting({
    entityId: e,
    entryDate: inv.issue_date,
    memo: `Invoice ${inv.number || ""} issued`.trim(),
    source: "invoice",
    sourceRef: inv.id,
    lines: jl,
    createdBy,
    gate,
  });
}

/** The CAD-per-unit rate the invoice's AR was booked at (its recognition line). */
export async function recognitionRate(inv: InvoiceRow): Promise<string | null> {
  if (inv.currency === "CAD") return "1";
  if (!inv.recognition_entry_id) return null;
  const row = await queryOne<{ fx_rate: string | null }>(
    `SELECT fx_rate FROM fin_journal_lines WHERE entry_id = ? AND account_id = ? AND debit_cents > 0 LIMIT 1`,
    [inv.recognition_entry_id, accountId(inv.entity_id, SYS.ar)],
  );
  return row?.fx_rate || null;
}

/**
 * Clear `amountCents` (invoice currency) of AR against `debitAccountId`,
 * where `receivedCadCents` is what actually arrived in CAD. For a USD invoice
 * the difference to the AR's carrying value is realised FX gain/loss.
 * `debitAccountId` is Stripe clearing or a bank for a real payment, or the
 * revenue account for a reclass (a Stripe charge first booked as revenue and
 * later matched to this invoice).
 */
export async function buildSettlementPosting(args: {
  inv: InvoiceRow;
  amountCents: number;
  receivedCadCents: number;
  debitAccountId: string;
  date: string;
  source: string;
  sourceRef: string;
  memo: string;
  createdBy: string;
  gate?: { sql: string; args: Array<string | number | null> };
}): Promise<Posting> {
  const { inv } = args;
  const e = inv.entity_id;
  const ar = accountId(e, SYS.ar);
  if (inv.currency === "CAD") {
    return buildPosting({
      entityId: e,
      entryDate: args.date,
      memo: args.memo,
      source: args.source,
      sourceRef: args.sourceRef,
      createdBy: args.createdBy,
      gate: args.gate,
      lines: [
        { accountId: args.debitAccountId, currency: "CAD", debitCents: args.amountCents, contactId: inv.contact_id, memo: args.memo },
        { accountId: ar, currency: "CAD", creditCents: args.amountCents, contactId: inv.contact_id, memo: args.memo },
      ],
    });
  }
  const rate = await recognitionRate(inv);
  if (!rate) throw new Error(`invoice ${inv.id} has no recognition rate; it must be issued before it can be settled`);
  const carrying = usdToCadCents(args.amountCents, parseRateMicro(rate));
  const legs = crossCurrencySettlementLines({
    foreignCurrency: inv.currency,
    foreignCents: args.amountCents,
    arAccountId: ar,
    fxClearingAccountId: accountId(e, SYS.fxClearing),
    depositAccountId: args.debitAccountId,
    fxGainLossAccountId: accountId(e, SYS.fxGainLoss),
    receivedCadCents: args.receivedCadCents,
    arCadCarryingCents: carrying,
    memo: args.memo,
  });
  return buildPosting({
    entityId: e,
    entryDate: args.date,
    memo: args.memo,
    source: args.source,
    sourceRef: args.sourceRef,
    createdBy: args.createdBy,
    gate: args.gate,
    fixedRates: { [inv.currency]: rate },
    lines: [...legs.foreignLeg, ...legs.cadLeg],
  });
}

const PAID_SUM = `(SELECT COALESCE(SUM(p.amount_cents), 0) FROM fin_payments p
                    WHERE p.invoice_id = fin_invoices.id AND p.kind = 'payment' AND p.currency = fin_invoices.currency)`;

/**
 * Recompute amount_paid from the linked payment rows and flip to paid when
 * covered. A RECOMPUTE, not an increment: running it twice (a retried
 * webhook, two events for one charge) cannot count a payment twice.
 */
export function recomputeInvoicePaidStatement(invoiceId: string, paidAtIso: string): InStatement {
  return {
    sql: `UPDATE fin_invoices
             SET amount_paid_cents = ${PAID_SUM},
                 status = CASE WHEN ${PAID_SUM} >= total_cents AND total_cents > 0 THEN 'paid' ELSE status END,
                 paid_at = CASE WHEN ${PAID_SUM} >= total_cents AND total_cents > 0 THEN COALESCE(paid_at, ?) ELSE paid_at END,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ? AND status IN ('sent', 'overdue', 'paid')`,
    args: [paidAtIso, invoiceId],
  };
}
