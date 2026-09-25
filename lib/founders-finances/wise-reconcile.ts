/**
 * Mark invoices paid from Wise: read recent client deposits, match them to
 * open invoices (wise.ts proposeWiseMatches), record the certain ones.
 *
 * RECORDED AUTOMATICALLY only when the payer's reference names exactly one
 * open invoice AND the amount and currency settle its balance. Everything
 * else — a missing reference, an amount that differs, two invoices named —
 * is returned for a founder to confirm or dismiss. A fuzzy match is never
 * recorded without a person choosing it.
 *
 * HOW A WISE PAYMENT IS STORED. One fin_payments row + one settlement entry
 * (the same shape as a manual mark-paid, so reports treat it identically),
 * plus a "Bank fees" entry when Wise kept a fee. fin_payments.source cannot
 * say 'wise' — its CHECK allows only 'stripe' | 'manual', and SQLite cannot
 * widen a CHECK without rebuilding the table — so the row is source 'manual'
 * with a "Wise <ref>" description, and the IDEMPOTENCY KEY is the settlement
 * entry: fin_journal_entries (entity, source 'wise_payment', source_ref =
 * Wise's transaction reference) is unique (uq_fin_journal_source). The payment
 * row rides in the same atomic batch, so a second run, a double click or a
 * race loses at the unique index and records nothing.
 *
 * The money lands in "Business chequing" (1000): Wise IS the business bank
 * account. A USD deposit's CAD value is estimated at the Bank of Canada rate
 * for its day and flagged settlement_estimated, exactly as a manual USD
 * mark-paid without a CAD amount is — but the USD stays USD on chequing, as it
 * does in the Wise USD balance (see recordWisePayment).
 */
import "server-only";

import { accountId, BUSINESS_ENTITY_ID, SYS } from "./chart";
import { balanceDueCents } from "./invoice";
import { torontoDateOf, usdToCadCents } from "./fx";
import { viewerLabel, type FinanceViewer } from "./access";
import { auditStatement, isUniqueViolation, newId, query, queryOne, writeBatch, type InStatement } from "./db";
import { FinanceInputError, FinanceNotFound, requireEntity } from "./access-io";
import { buildPosting } from "./ledger-io";
import { usdCadRate } from "./fx-io";
import { buildSettlementPosting, loadContact, loadInvoice, recomputeInvoicePaidStatement, type InvoiceRow } from "./invoice-store";
import { deactivatePaymentLinkIfPaid } from "./stripe-ingest";
import { dismissKey, proposeWiseMatches, settlementFor, type OpenInvoiceForMatch, type WiseDeposit } from "./wise";
import { wiseFitid } from "./wise-feed";
import { recentWiseDeposits } from "./wise-io";

export const WISE_PAYMENT_SOURCE = "wise_payment";
const WISE_FEE_SOURCE = "wise_fee";
/** "Bank fees" in BUSINESS_CHART; SYS has no role key for it. */
const BANK_FEES_CODE = "5010";
const DISMISS_ACTION = "wise.match_dismissed";

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const clampDays = (v: unknown, fallback: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(1, Math.min(120, Math.trunc(n))) : fallback;
};

export type WiseDepositView = {
  wise_ref: string;
  date: string;
  currency: string;
  amount_cents: number;
  net_cents: number;
  fee_cents: number;
  kind: string;
  sender: string;
  reference: string;
};

function view(d: WiseDeposit): WiseDepositView {
  return {
    wise_ref: d.ref,
    date: torontoDateOf(d.occurredAt),
    currency: d.currency,
    amount_cents: d.grossCents,
    net_cents: d.netCents,
    fee_cents: d.feeCents,
    kind: d.kind,
    sender: d.sender,
    reference: d.reference,
  };
}

export type WiseMatchView = {
  deposit: WiseDepositView;
  invoice_id: string;
  invoice_number: string;
  customer: string;
  balance_cents: number;
  reason: string;
};

export type WiseReconcileResult = {
  days: number;
  dry_run: boolean;
  deposits_seen: number;
  already_recorded: number;
  /** Exact matches: recorded (payment_id set), or what WOULD be recorded on a dry run. */
  exact: Array<WiseMatchView & { payment_id: string | null }>;
  recorded: number;
  needs_confirmation: WiseMatchView[];
  ignored: Array<{ deposit: WiseDepositView; reason: string }>;
  unmatched: WiseDepositView[];
  errors: Array<{ wise_ref: string; invoice_number: string; message: string }>;
};

async function openInvoices(entityId: string): Promise<OpenInvoiceForMatch[]> {
  const rows = await query<{ id: string; number: string; currency: string; total_cents: number; amount_paid_cents: number; contact_name: string }>(
    `SELECT i.id, i.number, i.currency, i.total_cents, i.amount_paid_cents, c.name AS contact_name
       FROM fin_invoices i JOIN fin_contacts c ON c.id = i.contact_id
      WHERE i.entity_id = ? AND i.status IN ('sent', 'overdue') AND i.number IS NOT NULL`,
    [entityId],
  );
  return rows
    .map((r) => ({
      id: r.id,
      number: r.number,
      currency: r.currency,
      balanceCents: balanceDueCents({ totalCents: r.total_cents, amountPaidCents: r.amount_paid_cents }),
      contactName: r.contact_name,
    }))
    .filter((r) => r.balanceCents > 0);
}

/** Which of these Wise transaction references are already recorded as invoice payments. The bank feed asks too. */
export async function recordedRefs(entityId: string, refs: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < refs.length; i += 200) {
    const chunk = refs.slice(i, i + 200);
    const rows = await query<{ source_ref: string }>(
      `SELECT source_ref FROM fin_journal_entries WHERE entity_id = ? AND source = ? AND source_ref IN (${chunk.map(() => "?").join(",")})`,
      [entityId, WISE_PAYMENT_SOURCE, ...chunk],
    );
    for (const r of rows) out.add(r.source_ref);
  }
  return out;
}

async function dismissedMatches(entityId: string): Promise<Set<string>> {
  const rows = await query<{ object_id: string; detail_json: string }>(
    `SELECT object_id, detail_json FROM fin_audit_log WHERE entity_id = ? AND action = ?`,
    [entityId, DISMISS_ACTION],
  );
  const out = new Set<string>();
  for (const r of rows) {
    try {
      const ref = (JSON.parse(r.detail_json) as { wise_ref?: unknown }).wise_ref;
      if (typeof ref === "string") out.add(dismissKey(ref, r.object_id));
    } catch {
      // A malformed detail row dismisses nothing; the suggestion simply shows again.
    }
  }
  return out;
}

/**
 * Record `deposit` against `inv`. Returns the payment id, or null when the
 * deposit was already recorded (lost the unique-index race). Throws
 * FinanceInputError when the invoice cannot take this payment.
 */
async function recordWisePayment(
  viewer: FinanceViewer,
  inv: InvoiceRow,
  deposit: WiseDeposit,
  settle: { amountCents: number; feeCents: number },
  action: "invoice.paid_wise" | "invoice.paid_wise_confirmed",
): Promise<string | null> {
  if (inv.status !== "sent" && inv.status !== "overdue") throw new FinanceInputError(`invoice ${inv.number || inv.id} is ${inv.status}; it cannot take a payment`);
  if (deposit.currency !== inv.currency) throw new FinanceInputError(`the deposit is ${deposit.currency} but invoice ${inv.number} is ${inv.currency}`);
  const due = balanceDueCents({ totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents });
  if (settle.amountCents <= 0 || settle.amountCents > due) throw new FinanceInputError(`the deposit does not fit the balance due on ${inv.number}`);
  const e = inv.entity_id;
  const date = torontoDateOf(deposit.occurredAt);
  const bank = accountId(e, SYS.chequing);
  let receivedCad = settle.amountCents;
  let estimated = 0;
  if (inv.currency !== "CAD") {
    const rate = await usdCadRate(date);
    if (!rate) throw new FinanceInputError(`no Bank of Canada rate for ${date} yet; refresh FX rates, then check again`);
    receivedCad = usdToCadCents(settle.amountCents, rate.micro);
    estimated = 1;
  }
  // The bank feed (wise-feed-io.ts) may already hold this deposit as a bank line.
  // Unreviewed, it is set aside below; categorised, it already put the money in
  // the books, and recording the invoice payment too would count it twice.
  const fitid = wiseFitid(deposit.currency, "CREDIT", deposit.ref);
  const fed = await queryOne<{ status: string }>(
    `SELECT status FROM fin_bank_transactions WHERE entity_id = ? AND account_id = ? AND fitid = ?`,
    [e, bank, fitid],
  );
  if (fed?.status === "posted") {
    throw new FinanceInputError(`Wise deposit ${deposit.ref} is already categorised in Transactions; exclude it there first, then record it against ${inv.number}`);
  }
  const createdBy = viewerLabel(viewer);
  const memo = `Wise ${deposit.ref} for invoice ${inv.number}`;
  const contact = await loadContact(inv.contact_id);
  const paymentId = newId("pay");
  // A USD payment STAYS USD at Wise, but the settlement (the manual mark-paid
  // shape) books its receipt in CAD. So a foreign-currency settlement lands in
  // FX clearing, and a second entry moves the USD itself onto chequing at the
  // same own-day rate: chequing's USD equals the Wise USD balance, and FX
  // clearing nets to zero in CAD (usdToCadCents and buildPosting round alike).
  const foreign = inv.currency !== "CAD";
  const fxClearing = accountId(e, SYS.fxClearing);
  const settlement = await buildSettlementPosting({
    inv,
    amountCents: settle.amountCents,
    receivedCadCents: receivedCad,
    debitAccountId: foreign ? fxClearing : bank,
    date,
    source: WISE_PAYMENT_SOURCE,
    sourceRef: deposit.ref,
    memo,
    createdBy,
  });
  const statements: InStatement[] = [
    {
      sql: `INSERT INTO fin_payments (id, entity_id, kind, source, occurred_at, occurred_on, amount_cents, currency, settlement_cad_cents,
              fee_status, settlement_estimated, invoice_id, contact_id, customer_name, customer_email, deposit_account_id, description, livemode, created_by)
            VALUES (?, ?, 'payment', 'manual', ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      args: [
        paymentId, e, deposit.occurredAt, date, settle.amountCents, inv.currency, receivedCad, estimated, inv.id, inv.contact_id,
        contact?.name || deposit.sender, contact?.email || "", bank,
        `Wise ${deposit.ref}${deposit.sender ? ` from ${deposit.sender}` : ""}`.slice(0, 200), createdBy,
      ],
    },
    ...settlement.statements,
    { sql: `UPDATE fin_payments SET entry_id = ? WHERE id = ?`, args: [settlement.entryId, paymentId] },
  ];
  if (foreign) {
    const held = await buildPosting({
      entityId: e,
      entryDate: date,
      memo: `${memo} (held in ${inv.currency} at Wise)`,
      source: WISE_PAYMENT_SOURCE,
      sourceRef: `${deposit.ref}:${inv.currency}`,
      createdBy,
      lines: [
        { accountId: bank, currency: inv.currency, debitCents: settle.amountCents, contactId: inv.contact_id, memo },
        { accountId: fxClearing, currency: inv.currency, creditCents: settle.amountCents, memo },
      ],
    });
    statements.push(...held.statements);
  }
  if (settle.feeCents > 0) {
    const fee = await buildPosting({
      entityId: e,
      entryDate: date,
      memo: `Wise fee on ${deposit.ref} (invoice ${inv.number})`,
      source: WISE_FEE_SOURCE,
      sourceRef: deposit.ref,
      createdBy,
      lines: [
        { accountId: accountId(e, BANK_FEES_CODE), currency: inv.currency, debitCents: settle.feeCents, memo: "Wise fee" },
        { accountId: bank, currency: inv.currency, creditCents: settle.feeCents, memo: "Wise fee" },
      ],
    });
    statements.push(...fee.statements);
  }
  statements.push(
    recomputeInvoicePaidStatement(inv.id, deposit.occurredAt),
    {
      sql: `UPDATE fin_bank_transactions SET status = 'excluded', memo = ?
             WHERE entity_id = ? AND account_id = ? AND fitid = ? AND status IN ('unreviewed', 'draft') AND entry_id IS NULL`,
      args: [`Recorded as payment of invoice ${inv.number} (Wise reconcile)`, e, bank, fitid],
    },
    auditStatement({
      entityId: e,
      actor: createdBy,
      action,
      objectType: "invoice",
      objectId: inv.id,
      detail: { wise_ref: deposit.ref, amount: settle.amountCents, fee: settle.feeCents, receivedCad, estimated: estimated === 1 },
    }),
  );
  try {
    await writeBatch(statements);
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
  await deactivatePaymentLinkIfPaid(inv.id).catch((err) => console.error("[finances:wise] link deactivate failed", err instanceof Error ? err.message : err));
  return paymentId;
}

/**
 * Read the last `days` of Wise deposits and match them. Records exact
 * matches only when `dryRun` is exactly false; a dry run returns the same
 * lists and writes nothing.
 */
export async function reconcileWise(viewer: FinanceViewer, opts: { days?: unknown; dryRun: boolean }): Promise<WiseReconcileResult> {
  const entity = await requireEntity(viewer, BUSINESS_ENTITY_ID);
  const days = clampDays(opts.days, 30);
  const deposits = await recentWiseDeposits(days);
  const [invoices, recorded, dismissed] = await Promise.all([
    openInvoices(entity.id),
    recordedRefs(entity.id, deposits.map((d) => d.ref)),
    dismissedMatches(entity.id),
  ]);
  const proposal = proposeWiseMatches(deposits, invoices, { recordedRefs: recorded, dismissed });
  const matchView = (m: { deposit: WiseDeposit; invoice: OpenInvoiceForMatch; reason: string }): WiseMatchView => ({
    deposit: view(m.deposit),
    invoice_id: m.invoice.id,
    invoice_number: m.invoice.number,
    customer: m.invoice.contactName,
    balance_cents: m.invoice.balanceCents,
    reason: m.reason,
  });
  const result: WiseReconcileResult = {
    days,
    dry_run: opts.dryRun !== false,
    deposits_seen: deposits.length,
    already_recorded: proposal.alreadyRecorded,
    exact: [],
    recorded: 0,
    needs_confirmation: proposal.fuzzy.map(matchView),
    ignored: proposal.ignored.map((i) => ({ deposit: view(i.deposit), reason: i.reason })),
    unmatched: proposal.unmatched.map(view),
    errors: [],
  };
  for (const m of proposal.exact) {
    const settle = settlementFor(m.deposit, m.invoice.balanceCents);
    if (!settle) continue; // proposeWiseMatches only calls a match exact when it settles; kept for the type
    if (result.dry_run) {
      result.exact.push({ ...matchView(m), payment_id: null });
      continue;
    }
    try {
      const inv = await loadInvoice(m.invoice.id);
      if (!inv) throw new FinanceNotFound();
      const paymentId = await recordWisePayment(viewer, inv, m.deposit, settle, "invoice.paid_wise");
      if (paymentId) {
        result.recorded += 1;
        result.exact.push({ ...matchView(m), payment_id: paymentId });
      } else {
        result.already_recorded += 1;
      }
    } catch (e) {
      result.errors.push({ wise_ref: m.deposit.ref, invoice_number: m.invoice.number, message: e instanceof Error ? e.message.slice(0, 300) : "failed" });
    }
  }
  return result;
}

/** A founder confirms a suggested match. The deposit is re-read from Wise; nothing the browser sends is trusted as an amount. */
export async function confirmWiseMatch(viewer: FinanceViewer, raw: Record<string, unknown>): Promise<{ paymentId: string; amountCents: number; full: boolean }> {
  const entity = await requireEntity(viewer, BUSINESS_ENTITY_ID);
  const wiseRef = text(raw.wise_ref, 80);
  const inv = await loadInvoice(text(raw.invoice_id, 120));
  if (!wiseRef) throw new FinanceInputError("choose a Wise deposit");
  if (!inv || inv.entity_id !== entity.id) throw new FinanceNotFound();
  const days = clampDays(raw.days, 120);
  const deposit = (await recentWiseDeposits(days)).find((d) => d.ref === wiseRef);
  if (!deposit) throw new FinanceInputError(`Wise deposit ${wiseRef} was not found in the last ${days} days`);
  if ((await recordedRefs(entity.id, [wiseRef])).size > 0) throw new FinanceInputError(`Wise deposit ${wiseRef} is already recorded`);
  if (deposit.currency !== inv.currency) throw new FinanceInputError(`the deposit is ${deposit.currency} but invoice ${inv.number} is ${inv.currency}`);
  const settle = settlementFor(deposit, balanceDueCents({ totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents }));
  if (!settle) throw new FinanceInputError("the deposit is more than the balance due; record it by hand with Mark paid");
  const paymentId = await recordWisePayment(viewer, inv, deposit, settle, "invoice.paid_wise_confirmed");
  if (!paymentId) throw new FinanceInputError(`Wise deposit ${wiseRef} is already recorded`);
  return { paymentId, amountCents: settle.amountCents, full: settle.full };
}

/** Hide a suggested match. Stored as an audit row, so the suggestion stays hidden on every later check. */
export async function dismissWiseMatch(viewer: FinanceViewer, raw: Record<string, unknown>): Promise<void> {
  const entity = await requireEntity(viewer, BUSINESS_ENTITY_ID);
  const wiseRef = text(raw.wise_ref, 80);
  const inv = await loadInvoice(text(raw.invoice_id, 120));
  if (!wiseRef) throw new FinanceInputError("choose a Wise deposit");
  if (!inv || inv.entity_id !== entity.id) throw new FinanceNotFound();
  await writeBatch([
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: DISMISS_ACTION, objectType: "invoice", objectId: inv.id, detail: { wise_ref: wiseRef } }),
  ]);
}
