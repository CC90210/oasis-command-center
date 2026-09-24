/**
 * Stripe -> books. Webhook events and the API reconcile both land here.
 *
 * ONE PAYMENT, ONE ROW. A single card payment produces several events
 * (payment_intent.succeeded, charge.succeeded, and invoice.paid for a Stripe
 * invoice), may be retried by Stripe for days, and is seen again by every
 * reconcile. fin_payments has unique indexes on the charge id, the payment
 * intent id and the Stripe invoice id; every path looks the payment up by ANY
 * of those keys before inserting and inserts with OR IGNORE, so all of them
 * converge on the same row. revenueCollected reads that table, which is why a
 * Stripe-paid invoice cannot be counted twice.
 *
 * POSTING. Charge (no invoice): Dr Stripe clearing / Cr revenue, gross CAD.
 * Charge for a fin invoice: Dr Stripe clearing / Cr AR (via invoice-store's
 * settlement, with realised FX for USD). Fee: Dr Stripe fees / Cr Stripe
 * clearing, from the charge's balance transaction. Refund: Dr Refunds / Cr
 * Stripe clearing. A charge booked as revenue and matched to an invoice later
 * gets a reclass (Dr revenue / Cr AR) instead of a second income entry.
 *
 * FEES may be unknown when the event arrives (no verified Stripe key, or a
 * balance transaction not yet readable). Then the payment is recorded with
 * fee_status 'pending' and syncPendingStripe() completes it later; a USD
 * charge whose CAD settlement had to be estimated from the Bank of Canada
 * rate is trued up to Stripe's real figure at that point (the gap is FX).
 */
import "server-only";

import { accountId, BUSINESS_ENTITY_ID, SYS } from "./chart";
import { divRoundHalfAwayFromZero } from "./money";
import { torontoDateOfEpochSeconds, usdToCadCents } from "./fx";
import {
  chargeFacts,
  eventEnvelope,
  finMetadata,
  invoicePaidFacts,
  paymentIntentFacts,
  refundFacts,
  subscriptionFacts,
  balanceTxnFacts,
  type BalanceTxnFacts,
  type ChargeFacts,
  type InvoicePaidFacts,
  type RefundFacts,
  type StripeEventEnvelope,
  type SubscriptionFacts,
} from "./stripe-map";
import { subscriptionMonthlyCents } from "./mrr";
import { auditStatement, finDb, isUniqueViolation, newId, query, queryOne, writeBatch, type InStatement } from "./db";
import { buildPosting } from "./ledger-io";
import { usdCadRate } from "./fx-io";
import { buildSettlementPosting, loadInvoice, recomputeInvoicePaidStatement } from "./invoice-store";
import { getStripeClient, listAll, stripeRequest, StripeNotReady } from "./stripe-io";

const ACTOR = "stripe";
const E = BUSINESS_ENTITY_ID;

/** A charge as the recorder needs it; the id may be unknown when only an invoice or intent was seen. */
export type ChargeInput = Omit<ChargeFacts, "chargeId"> & { chargeId: string | null };

export type PaymentRow = {
  id: string;
  entity_id: string;
  kind: "payment" | "refund";
  source: "stripe" | "manual";
  occurred_at: string;
  occurred_on: string;
  amount_cents: number;
  currency: string;
  settlement_cad_cents: number | null;
  fee_cad_cents: number | null;
  fee_status: "none" | "pending" | "posted";
  settlement_estimated: number;
  parent_payment_id: string | null;
  invoice_id: string | null;
  contact_id: string | null;
  customer_name: string;
  customer_email: string;
  stripe_customer_id: string | null;
  stripe_charge_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_invoice_id: string | null;
  stripe_refund_id: string | null;
  stripe_balance_txn_id: string | null;
  deposit_account_id: string | null;
  income_account_id: string | null;
  entry_id: string | null;
  livemode: number;
};

async function loadPayment(id: string): Promise<PaymentRow | null> {
  return queryOne<PaymentRow>(`SELECT * FROM fin_payments WHERE id = ?`, [id]);
}

export async function findPaymentByKeys(keys: {
  chargeId?: string | null;
  paymentIntentId?: string | null;
  stripeInvoiceId?: string | null;
}): Promise<PaymentRow | null> {
  const { chargeId = null, paymentIntentId = null, stripeInvoiceId = null } = keys;
  if (!chargeId && !paymentIntentId && !stripeInvoiceId) return null;
  return queryOne<PaymentRow>(
    `SELECT * FROM fin_payments
      WHERE kind = 'payment'
        AND (stripe_charge_id = ? OR stripe_payment_intent_id = ? OR stripe_invoice_id = ?)
      ORDER BY created_at LIMIT 1`,
    [chargeId, paymentIntentId, stripeInvoiceId],
  );
}

/** The verified Stripe key, or null (never an unpinned key). */
async function readyKey(): Promise<string | null> {
  try {
    return (await getStripeClient()).key;
  } catch (e) {
    if (e instanceof StripeNotReady) return null;
    throw e;
  }
}

async function fetchChargeExpanded(key: string, chargeId: string): Promise<ChargeFacts | null> {
  const u = new URLSearchParams();
  u.append("expand[]", "balance_transaction");
  u.append("expand[]", "payment_intent");
  const raw = await stripeRequest(key, "GET", `/v1/charges/${encodeURIComponent(chargeId)}`, u);
  const facts = chargeFacts(raw);
  if (facts && !facts.metadata.finInvoiceId) {
    const piMeta = finMetadata(raw.payment_intent);
    if (piMeta.finInvoiceId) facts.metadata = piMeta;
  }
  return facts;
}

async function contactForCustomer(customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM fin_contacts WHERE entity_id = ? AND stripe_customer_id = ?`,
    [E, customerId],
  );
  return row?.id ?? null;
}

async function linkableInvoice(invoiceId: string | null, currency: string): Promise<string | null> {
  if (!invoiceId) return null;
  const inv = await loadInvoice(invoiceId);
  if (!inv || inv.entity_id !== E) {
    console.warn("[finances:stripe] payment metadata names an unknown invoice", invoiceId);
    return null;
  }
  if (inv.status === "draft" || inv.status === "void") {
    console.warn("[finances:stripe] payment for an invoice that is", inv.status, invoiceId);
    return null;
  }
  if (inv.currency !== currency) {
    console.warn("[finances:stripe] payment currency does not match invoice", invoiceId, currency, inv.currency);
    return null;
  }
  return inv.id;
}

/** CAD settlement from a balance transaction, or null. */
function cadFromBalanceTxn(bt: BalanceTxnFacts | null): { gross: number; fee: number } | null {
  if (!bt || bt.currency !== "CAD") return null;
  return { gross: bt.amountCents, fee: bt.feeCents };
}

/**
 * Record one succeeded charge (idempotent). Returns the payment row id.
 * `fetchFees`: may call Stripe for the balance transaction when the payload
 * did not carry it expanded.
 */
export async function recordStripeCharge(
  charge: ChargeInput,
  opts: { fetchFees: boolean } = { fetchFees: true },
): Promise<{ paymentId: string | null; created: boolean; reason?: string }> {
  if (!charge.succeeded) return { paymentId: null, created: false, reason: "not_succeeded" };
  if (!charge.livemode) return { paymentId: null, created: false, reason: "test_mode" };

  const existing = await findPaymentByKeys({
    chargeId: charge.chargeId,
    paymentIntentId: charge.paymentIntentId,
    stripeInvoiceId: charge.stripeInvoiceId,
  });
  if (existing) {
    await fillMissingKeys(existing, {
      chargeId: charge.chargeId,
      paymentIntentId: charge.paymentIntentId,
      stripeInvoiceId: charge.stripeInvoiceId,
      balanceTxnId: charge.balanceTxnId,
    });
    if (charge.metadata.finInvoiceId && !existing.invoice_id) await linkPaymentToInvoice(existing.id, charge.metadata.finInvoiceId);
    if (existing.fee_status === "pending" || existing.entry_id === null) {
      const bt = charge.balanceTxn ?? (opts.fetchFees ? await fetchBalanceTxnSafe(charge.balanceTxnId) : null);
      await completeSettlement(existing.id, bt);
    }
    if (charge.amountRefundedCents > 0) await recordRefundsForCharge(existing.id, charge, charge.refunds, opts);
    return { paymentId: existing.id, created: false };
  }

  const bt = charge.balanceTxn ?? (opts.fetchFees ? await fetchBalanceTxnSafe(charge.balanceTxnId) : null);
  const fromBt = cadFromBalanceTxn(bt);
  let settlementCad: number | null = fromBt ? fromBt.gross : charge.currency === "CAD" ? charge.amountCents : null;
  let estimated = 0;
  const occurredOn = torontoDateOfEpochSeconds(charge.created);
  if (settlementCad === null && charge.currency === "USD") {
    const rate = await usdCadRate(occurredOn);
    if (rate) {
      settlementCad = usdToCadCents(charge.amountCents, rate.micro);
      estimated = 1;
    }
  }
  const invoiceId = await linkableInvoice(charge.metadata.finInvoiceId, charge.currency);
  const contactId = invoiceId ? (await loadInvoice(invoiceId))?.contact_id ?? null : await contactForCustomer(charge.customerId);
  const paymentId = newId("pay");
  const incomeCode = charge.stripeInvoiceId ? SYS.subscriptionRevenue : SYS.serviceRevenue;
  const statements: InStatement[] = [
    {
      sql: `INSERT OR IGNORE INTO fin_payments
              (id, entity_id, kind, source, occurred_at, occurred_on, amount_cents, currency, settlement_cad_cents,
               fee_cad_cents, fee_status, settlement_estimated, invoice_id, contact_id, customer_name, customer_email,
               stripe_customer_id, stripe_charge_id, stripe_payment_intent_id, stripe_invoice_id, stripe_balance_txn_id,
               deposit_account_id, income_account_id, description, livemode, created_by)
            VALUES (?, ?, 'payment', 'stripe', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      args: [
        paymentId,
        E,
        new Date(charge.created * 1000).toISOString(),
        occurredOn,
        charge.amountCents,
        charge.currency,
        settlementCad,
        fromBt ? fromBt.fee : null,
        "pending",
        estimated,
        invoiceId,
        contactId,
        charge.customerName.slice(0, 200),
        charge.customerEmail.slice(0, 254),
        charge.customerId,
        charge.chargeId,
        charge.paymentIntentId,
        charge.stripeInvoiceId,
        bt?.id ?? charge.balanceTxnId,
        accountId(E, SYS.stripeClearing),
        accountId(E, incomeCode),
        charge.description.slice(0, 300),
        ACTOR,
      ],
    },
  ];
  if (invoiceId) statements.push(recomputeInvoicePaidStatement(invoiceId, new Date(charge.created * 1000).toISOString()));
  statements.push(auditStatement({ entityId: E, actor: ACTOR, action: "stripe.payment_recorded", objectType: "payment", objectId: paymentId, detail: { charge: charge.chargeId, invoice: invoiceId } }));
  await writeBatch(statements);

  // OR IGNORE may have lost a race to a concurrent delivery: re-read by key.
  const row = await findPaymentByKeys({ chargeId: charge.chargeId, paymentIntentId: charge.paymentIntentId, stripeInvoiceId: charge.stripeInvoiceId });
  if (!row) throw new Error(`payment for ${charge.chargeId ?? charge.paymentIntentId} was neither inserted nor found`);
  const created = row.id === paymentId;
  await postPaymentEntries(row.id);
  if (created && fromBt) await postFeeIfKnown(row.id);
  if (created && invoiceId) await deactivatePaymentLinkIfPaid(invoiceId);
  if (charge.amountRefundedCents > 0) await recordRefundsForCharge(row.id, charge, charge.refunds, opts);
  return { paymentId: row.id, created };
}

async function fetchBalanceTxnSafe(id: string | null): Promise<BalanceTxnFacts | null> {
  if (!id) return null;
  const key = await readyKey();
  if (!key) return null;
  try {
    const raw = await stripeRequest(key, "GET", `/v1/balance_transactions/${encodeURIComponent(id)}`);
    return balanceTxnFacts(raw);
  } catch (e) {
    console.error("[finances:stripe] balance transaction fetch failed", id, e instanceof Error ? e.message : e);
    return null;
  }
}

async function fillMissingKeys(
  p: PaymentRow,
  keys: { chargeId?: string | null; paymentIntentId?: string | null; stripeInvoiceId?: string | null; balanceTxnId?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const args: Array<string | null> = [];
  if (!p.stripe_charge_id && keys.chargeId) {
    sets.push("stripe_charge_id = ?");
    args.push(keys.chargeId);
  }
  if (!p.stripe_payment_intent_id && keys.paymentIntentId) {
    sets.push("stripe_payment_intent_id = ?");
    args.push(keys.paymentIntentId);
  }
  if (!p.stripe_invoice_id && keys.stripeInvoiceId) {
    sets.push("stripe_invoice_id = ?");
    args.push(keys.stripeInvoiceId);
  }
  if (!p.stripe_balance_txn_id && keys.balanceTxnId) {
    sets.push("stripe_balance_txn_id = ?");
    args.push(keys.balanceTxnId);
  }
  if (sets.length === 0) return;
  try {
    await finDb().execute({ sql: `UPDATE fin_payments SET ${sets.join(", ")} WHERE id = ?`, args: [...args, p.id] });
  } catch (e) {
    // Another row already owns that key (should not happen); keep the payment, log it.
    if (!isUniqueViolation(e)) throw e;
    console.error("[finances:stripe] key already owned by another payment row", p.id, keys);
  }
}

/**
 * Post the income (or invoice settlement) entry for a payment if it has not
 * been posted and its CAD value is known. Gated on the payment's invoice link
 * being what this decision saw, so a concurrent link cannot leave revenue
 * booked for an invoiced payment.
 */
export async function postPaymentEntries(paymentId: string): Promise<void> {
  const p = await loadPayment(paymentId);
  if (!p || p.kind !== "payment" || p.entry_id || p.settlement_cad_cents === null) return;
  const sourceRef = p.stripe_charge_id || p.id;
  const gate = {
    sql: `(SELECT invoice_id FROM fin_payments WHERE id = ?) IS ? AND (SELECT entry_id FROM fin_payments WHERE id = ?) IS NULL`,
    args: [p.id, p.invoice_id, p.id],
  };
  let posting;
  if (p.invoice_id) {
    const inv = await loadInvoice(p.invoice_id);
    if (!inv) return;
    posting = await buildSettlementPosting({
      inv,
      amountCents: p.amount_cents,
      receivedCadCents: p.settlement_cad_cents,
      debitAccountId: p.deposit_account_id || accountId(E, SYS.stripeClearing),
      date: p.occurred_on,
      source: p.source === "stripe" ? "stripe_charge" : "invoice_payment",
      sourceRef,
      memo: `Payment for invoice ${inv.number || inv.id}`,
      createdBy: ACTOR,
      gate,
    });
  } else {
    posting = await buildPosting({
      entityId: E,
      entryDate: p.occurred_on,
      memo: `Stripe payment${p.customer_name ? ` — ${p.customer_name}` : ""}`,
      source: "stripe_charge",
      sourceRef,
      createdBy: ACTOR,
      gate,
      lines: [
        { accountId: p.deposit_account_id || accountId(E, SYS.stripeClearing), currency: "CAD", debitCents: p.settlement_cad_cents, contactId: p.contact_id },
        { accountId: p.income_account_id || accountId(E, SYS.serviceRevenue), currency: "CAD", creditCents: p.settlement_cad_cents, contactId: p.contact_id },
      ],
    });
  }
  try {
    await writeBatch([
      ...posting.statements,
      {
        sql: `UPDATE fin_payments SET entry_id = ? WHERE id = ? AND entry_id IS NULL AND EXISTS (SELECT 1 FROM fin_journal_entries WHERE id = ?)`,
        args: [posting.entryId, p.id, posting.entryId],
      },
    ]);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Already posted under this source ref by a concurrent delivery: adopt it.
    const src = p.invoice_id ? (p.source === "stripe" ? "stripe_charge" : "invoice_payment") : "stripe_charge";
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM fin_journal_entries WHERE entity_id = ? AND source = ? AND source_ref = ?`,
      [E, src, sourceRef],
    );
    if (existing) await finDb().execute({ sql: `UPDATE fin_payments SET entry_id = ? WHERE id = ? AND entry_id IS NULL`, args: [existing.id, p.id] });
  }
}

async function postFeeIfKnown(paymentId: string): Promise<void> {
  const p = await loadPayment(paymentId);
  if (!p || p.fee_status === "posted" || p.fee_cad_cents === null) return;
  const statements: InStatement[] = [];
  if (p.fee_cad_cents > 0) {
    const posting = await buildPosting({
      entityId: E,
      entryDate: p.occurred_on,
      memo: "Stripe processing fee",
      source: "stripe_fee",
      sourceRef: p.stripe_charge_id || p.id,
      createdBy: ACTOR,
      lines: [
        { accountId: accountId(E, SYS.stripeFees), currency: "CAD", debitCents: p.fee_cad_cents },
        { accountId: p.deposit_account_id || accountId(E, SYS.stripeClearing), currency: "CAD", creditCents: p.fee_cad_cents },
      ],
    });
    statements.push(...posting.statements);
  }
  statements.push({ sql: `UPDATE fin_payments SET fee_status = 'posted' WHERE id = ?`, args: [p.id] });
  try {
    await writeBatch(statements);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    await finDb().execute({ sql: `UPDATE fin_payments SET fee_status = 'posted' WHERE id = ?`, args: [p.id] });
  }
}

/**
 * Fill in what a later look at the balance transaction tells us: the fee,
 * and for an estimated USD settlement the real CAD figure (trued up against
 * FX gain/loss if the estimate was already posted).
 */
async function completeSettlement(paymentId: string, bt: BalanceTxnFacts | null): Promise<void> {
  const p = await loadPayment(paymentId);
  if (!p) return;
  const fromBt = cadFromBalanceTxn(bt);
  if (fromBt) {
    const wasEstimated = p.settlement_estimated === 1 && p.settlement_cad_cents !== null;
    const diff = wasEstimated ? fromBt.gross - (p.settlement_cad_cents as number) : 0;
    const statements: InStatement[] = [
      {
        sql: `UPDATE fin_payments SET settlement_cad_cents = ?, fee_cad_cents = ?, settlement_estimated = 0,
                     stripe_balance_txn_id = COALESCE(stripe_balance_txn_id, ?) WHERE id = ?`,
        args: [fromBt.gross, fromBt.fee, bt?.id ?? null, p.id],
      },
    ];
    if (wasEstimated && diff !== 0 && p.entry_id) {
      const posting = await buildPosting({
        entityId: E,
        entryDate: p.occurred_on,
        memo: "Stripe settlement true-up (estimated FX -> actual)",
        source: "stripe_settlement_adj",
        sourceRef: p.stripe_charge_id || p.id,
        createdBy: ACTOR,
        lines:
          diff > 0
            ? [
                { accountId: accountId(E, SYS.stripeClearing), currency: "CAD", debitCents: diff },
                { accountId: accountId(E, SYS.fxGainLoss), currency: "CAD", creditCents: diff },
              ]
            : [
                { accountId: accountId(E, SYS.fxGainLoss), currency: "CAD", debitCents: -diff },
                { accountId: accountId(E, SYS.stripeClearing), currency: "CAD", creditCents: -diff },
              ],
      });
      statements.push(...posting.statements);
    }
    try {
      await writeBatch(statements);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  await postPaymentEntries(p.id);
  if (fromBt) await postFeeIfKnown(p.id);
}

/**
 * Match a recorded payment to a fin invoice (idempotent). If the payment was
 * already booked as revenue, a reclass moves it onto the invoice's AR instead
 * of recognising the revenue a second time.
 */
export async function linkPaymentToInvoice(paymentId: string, invoiceId: string): Promise<boolean> {
  const p = await loadPayment(paymentId);
  if (!p || p.kind !== "payment" || p.invoice_id) return false;
  const linkId = await linkableInvoice(invoiceId, p.currency);
  if (!linkId) return false;
  const inv = await loadInvoice(linkId);
  if (!inv) return false;
  const statements: InStatement[] = [];
  if (p.entry_id && p.settlement_cad_cents !== null) {
    const posting = await buildSettlementPosting({
      inv,
      amountCents: p.amount_cents,
      receivedCadCents: p.settlement_cad_cents,
      debitAccountId: p.income_account_id || accountId(E, SYS.serviceRevenue),
      date: p.occurred_on,
      source: "stripe_invoice_link",
      sourceRef: p.id,
      memo: `Reclass Stripe payment to invoice ${inv.number || inv.id}`,
      createdBy: ACTOR,
    });
    statements.push(...posting.statements);
  }
  statements.push(
    {
      sql: `UPDATE fin_payments SET invoice_id = ?, contact_id = COALESCE(contact_id, ?) WHERE id = ? AND invoice_id IS NULL AND entry_id IS ?`,
      args: [inv.id, inv.contact_id, p.id, p.entry_id],
    },
    recomputeInvoicePaidStatement(inv.id, p.occurred_at),
    auditStatement({ entityId: E, actor: ACTOR, action: "stripe.payment_linked", objectType: "invoice", objectId: inv.id, detail: { payment: p.id } }),
  );
  try {
    await writeBatch(statements);
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
  // If a concurrent postPaymentEntries lost its gate to this link, nothing
  // posted the income; post the settlement now (a no-op when already posted).
  await postPaymentEntries(p.id);
  await deactivatePaymentLinkIfPaid(inv.id);
  return true;
}

export async function deactivatePaymentLinkIfPaid(invoiceId: string, force = false): Promise<void> {
  const inv = await loadInvoice(invoiceId);
  if (!inv || !inv.stripe_payment_link_id) return;
  if (inv.status !== "paid" && !force) return;
  const key = await readyKey();
  if (!key) return;
  try {
    await stripeRequest(key, "POST", `/v1/payment_links/${encodeURIComponent(inv.stripe_payment_link_id)}`, { active: "false" });
  } catch (e) {
    console.error("[finances:stripe] could not deactivate paid invoice's payment link", invoiceId, e instanceof Error ? e.message : e);
  }
}

// ── refunds ──────────────────────────────────────────────────────────────

/**
 * Record a charge's refunds. Each refund row's insert is capped by SQL so the
 * refunds recorded for a charge can never exceed what Stripe says was
 * refunded, however many events or reconciles report them.
 */
export async function recordRefundsForCharge(
  parentPaymentId: string,
  charge: ChargeInput,
  refunds: RefundFacts[] | null,
  opts: { fetchFees: boolean },
): Promise<number> {
  const parent = await loadPayment(parentPaymentId);
  if (!parent) return 0;
  let list = refunds;
  if (!list && opts.fetchFees && charge.chargeId) {
    const key = await readyKey();
    if (key) {
      try {
        const u = new URLSearchParams({ charge: charge.chargeId, limit: "100" });
        u.append("expand[]", "data.balance_transaction");
        const res = await stripeRequest(key, "GET", "/v1/refunds", u);
        const data = Array.isArray(res.data) ? (res.data as unknown[]) : [];
        list = data.map(refundFacts).filter((r): r is RefundFacts => r !== null);
      } catch (e) {
        console.error("[finances:stripe] refund list fetch failed", charge.chargeId, e instanceof Error ? e.message : e);
      }
    }
  }
  const cap = charge.amountRefundedCents;
  let inserted = 0;
  if (list) {
    for (const r of list) {
      if (r.status === "failed" || r.status === "canceled") continue;
      if (await insertRefund(parent, { refundId: r.refundId, amountCents: r.amountCents, created: r.created, bt: r.balanceTxn }, cap)) inserted += 1;
    }
  } else {
    const recorded = await refundedSoFar(parent.id);
    const delta = cap - recorded;
    if (delta > 0 && (await insertRefund(parent, { refundId: null, amountCents: delta, created: Math.floor(Date.now() / 1000), bt: null }, cap))) inserted += 1;
  }
  return inserted;
}

async function refundedSoFar(parentId: string): Promise<number> {
  const row = await queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM fin_payments WHERE parent_payment_id = ? AND kind = 'refund'`,
    [parentId],
  );
  return Number(row?.total || 0);
}

async function insertRefund(
  parent: PaymentRow,
  r: { refundId: string | null; amountCents: number; created: number; bt: BalanceTxnFacts | null },
  cap: number,
): Promise<boolean> {
  if (r.amountCents <= 0) return false;
  let cad: number | null = null;
  if (r.bt && r.bt.currency === "CAD") cad = Math.abs(r.bt.amountCents);
  else if (parent.settlement_cad_cents !== null && parent.amount_cents > 0) {
    cad = Number(divRoundHalfAwayFromZero(BigInt(parent.settlement_cad_cents) * BigInt(r.amountCents), BigInt(parent.amount_cents)));
  } else if (parent.currency === "CAD") cad = r.amountCents;
  const id = newId("ref");
  const occurredOn = torontoDateOfEpochSeconds(r.created);
  const rs = await finDb().execute({
    sql: `INSERT OR IGNORE INTO fin_payments
            (id, entity_id, kind, source, occurred_at, occurred_on, amount_cents, currency, settlement_cad_cents,
             fee_status, parent_payment_id, invoice_id, contact_id, customer_name, customer_email, stripe_customer_id,
             stripe_charge_id, stripe_refund_id, stripe_balance_txn_id, deposit_account_id, income_account_id,
             description, livemode, created_by)
          SELECT ?, ?, 'refund', 'stripe', ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'Stripe refund', 1, ?
          WHERE (SELECT COALESCE(SUM(amount_cents), 0) FROM fin_payments WHERE parent_payment_id = ? AND kind = 'refund') + ? <= ?`,
    args: [
      id,
      parent.entity_id,
      new Date(r.created * 1000).toISOString(),
      occurredOn,
      r.amountCents,
      parent.currency,
      cad,
      parent.id,
      parent.invoice_id,
      parent.contact_id,
      parent.customer_name,
      parent.customer_email,
      parent.stripe_customer_id,
      r.refundId,
      r.bt?.id ?? null,
      parent.deposit_account_id,
      accountId(E, SYS.refunds),
      ACTOR,
      parent.id,
      r.amountCents,
      cap,
    ],
  });
  if (rs.rowsAffected !== 1) return false;
  await postRefundEntry(id);
  return true;
}

async function postRefundEntry(refundRowId: string): Promise<void> {
  const r = await loadPayment(refundRowId);
  if (!r || r.kind !== "refund" || r.entry_id || r.settlement_cad_cents === null) return;
  const posting = await buildPosting({
    entityId: r.entity_id,
    entryDate: r.occurred_on,
    memo: `Stripe refund${r.customer_name ? ` — ${r.customer_name}` : ""}`,
    source: "stripe_refund",
    sourceRef: r.stripe_refund_id || r.id,
    createdBy: ACTOR,
    lines: [
      { accountId: r.income_account_id || accountId(E, SYS.refunds), currency: "CAD", debitCents: r.settlement_cad_cents, contactId: r.contact_id },
      { accountId: r.deposit_account_id || accountId(E, SYS.stripeClearing), currency: "CAD", creditCents: r.settlement_cad_cents, contactId: r.contact_id },
    ],
  });
  try {
    await writeBatch([
      ...posting.statements,
      { sql: `UPDATE fin_payments SET entry_id = ? WHERE id = ? AND entry_id IS NULL`, args: [posting.entryId, r.id] },
    ]);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
}

// ── Stripe invoices & subscriptions ─────────────────────────────────────

export async function applyStripeInvoicePaid(facts: InvoicePaidFacts): Promise<string> {
  if (!facts.livemode) return "test_mode";
  if (facts.amountPaidCents <= 0) return "zero_amount";
  const existing = await findPaymentByKeys({ chargeId: facts.chargeId, paymentIntentId: facts.paymentIntentId, stripeInvoiceId: facts.stripeInvoiceId });
  if (existing) {
    await fillMissingKeys(existing, { chargeId: facts.chargeId, paymentIntentId: facts.paymentIntentId, stripeInvoiceId: facts.stripeInvoiceId });
    if (facts.metadata.finInvoiceId && !existing.invoice_id) await linkPaymentToInvoice(existing.id, facts.metadata.finInvoiceId);
    return "linked_existing";
  }
  if (!facts.chargeId && !facts.paymentIntentId) {
    // Paid out of band or from customer credit: no new money moved through
    // Stripe for this invoice, so nothing is collected here.
    return "no_charge_on_invoice";
  }
  const key = await readyKey();
  let charge: ChargeInput | null = null;
  if (key) {
    try {
      let chargeId = facts.chargeId;
      if (!chargeId && facts.paymentIntentId) {
        const pi = paymentIntentFacts(await stripeRequest(key, "GET", `/v1/payment_intents/${encodeURIComponent(facts.paymentIntentId)}`));
        chargeId = pi?.latestChargeId ?? null;
      }
      if (chargeId) charge = await fetchChargeExpanded(key, chargeId);
    } catch (e) {
      console.error("[finances:stripe] could not fetch the charge behind", facts.stripeInvoiceId, e instanceof Error ? e.message : e);
    }
  }
  if (!charge) {
    charge = {
      chargeId: facts.chargeId,
      paymentIntentId: facts.paymentIntentId,
      stripeInvoiceId: facts.stripeInvoiceId,
      customerId: facts.customerId,
      customerName: facts.customerName,
      customerEmail: facts.customerEmail,
      amountCents: facts.amountPaidCents,
      amountRefundedCents: 0,
      currency: facts.currency,
      created: facts.paidAt,
      balanceTxnId: null,
      balanceTxn: null,
      livemode: true,
      succeeded: true,
      description: "Stripe invoice",
      metadata: facts.metadata,
      refunds: [],
    };
  }
  charge.stripeInvoiceId = charge.stripeInvoiceId || facts.stripeInvoiceId;
  if (!charge.metadata.finInvoiceId && facts.metadata.finInvoiceId) charge.metadata = facts.metadata;
  const res = await recordStripeCharge(charge, { fetchFees: true });
  return res.created ? "recorded" : "linked_existing";
}

export async function upsertSubscription(facts: SubscriptionFacts, sourceCreated: number): Promise<void> {
  const monthly = subscriptionMonthlyCents(facts.items);
  await finDb().execute({
    sql: `INSERT INTO fin_subscriptions
            (id, entity_id, stripe_customer_id, customer_name, customer_email, status, currency, monthly_cents, items_json,
             current_period_end, cancel_at_period_end, canceled_at, livemode, source_event_created, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          ON CONFLICT(id) DO UPDATE SET
            stripe_customer_id = excluded.stripe_customer_id,
            customer_name = CASE WHEN excluded.customer_name <> '' THEN excluded.customer_name ELSE fin_subscriptions.customer_name END,
            customer_email = CASE WHEN excluded.customer_email <> '' THEN excluded.customer_email ELSE fin_subscriptions.customer_email END,
            status = excluded.status, currency = excluded.currency, monthly_cents = excluded.monthly_cents,
            items_json = excluded.items_json, current_period_end = excluded.current_period_end,
            cancel_at_period_end = excluded.cancel_at_period_end, canceled_at = excluded.canceled_at,
            livemode = excluded.livemode, source_event_created = excluded.source_event_created,
            updated_at = excluded.updated_at
          WHERE excluded.source_event_created >= fin_subscriptions.source_event_created`,
    args: [
      facts.id,
      E,
      facts.customerId,
      facts.customerName,
      facts.customerEmail,
      facts.status,
      facts.currency,
      monthly,
      JSON.stringify(facts.items),
      facts.currentPeriodEnd,
      facts.cancelAtPeriodEnd ? 1 : 0,
      facts.canceledAt,
      facts.livemode ? 1 : 0,
      sourceCreated,
    ],
  });
}

// ── webhook event dispatch ───────────────────────────────────────────────

export type EventOutcome = { status: "processed" | "ignored" | "duplicate" | "in_flight"; detail: string };

async function claimEvent(env: StripeEventEnvelope): Promise<"claimed" | "duplicate" | "in_flight"> {
  const ins = await finDb().execute({
    sql: `INSERT OR IGNORE INTO fin_stripe_events (event_id, type, livemode, event_created, status) VALUES (?, ?, ?, ?, 'processing')`,
    args: [env.id, env.type, env.livemode ? 1 : 0, env.created],
  });
  if (ins.rowsAffected === 1) return "claimed";
  const row = await queryOne<{ status: string; received_at: string }>(
    `SELECT status, received_at FROM fin_stripe_events WHERE event_id = ?`,
    [env.id],
  );
  if (!row) return "in_flight";
  if (row.status === "processed" || row.status === "ignored") return "duplicate";
  const stale = row.status === "processing" && Date.parse(row.received_at) < Date.now() - 5 * 60_000;
  if (row.status === "failed" || stale) {
    const upd = await finDb().execute({
      sql: `UPDATE fin_stripe_events SET status = 'processing', attempts = attempts + 1, error = NULL,
                   received_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE event_id = ? AND status = ? AND received_at = ?`,
      args: [env.id, row.status, row.received_at],
    });
    return upd.rowsAffected === 1 ? "claimed" : "in_flight";
  }
  return "in_flight";
}

async function finishEvent(id: string, status: "processed" | "ignored" | "failed", error: string | null): Promise<void> {
  await finDb().execute({
    sql: `UPDATE fin_stripe_events SET status = ?, error = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_id = ?`,
    args: [status, error ? error.slice(0, 1000) : null, id],
  });
}

export const HANDLED_EVENT_TYPES = [
  "payment_intent.succeeded",
  "charge.succeeded",
  "charge.refunded",
  "invoice.paid",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

export async function handleStripeEvent(raw: unknown): Promise<EventOutcome> {
  const env = eventEnvelope(raw);
  if (!env) throw new Error("not a Stripe event envelope");
  const claim = await claimEvent(env);
  if (claim === "duplicate") return { status: "duplicate", detail: "already processed" };
  if (claim === "in_flight") return { status: "in_flight", detail: "another delivery is processing this event" };
  if (!env.livemode) {
    await finishEvent(env.id, "ignored", "test_mode");
    return { status: "ignored", detail: "test mode event — never enters the books" };
  }
  try {
    const detail = await dispatch(env);
    const ignored = detail.startsWith("ignored");
    await finishEvent(env.id, ignored ? "ignored" : "processed", ignored ? detail : null);
    return { status: ignored ? "ignored" : "processed", detail };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishEvent(env.id, "failed", msg).catch(() => undefined);
    throw e;
  }
}

async function dispatch(env: StripeEventEnvelope): Promise<string> {
  switch (env.type) {
    case "charge.succeeded": {
      const c = chargeFacts(env.object);
      if (!c) throw new Error("charge.succeeded without a readable charge");
      const r = await recordStripeCharge(c, { fetchFees: true });
      return r.paymentId ? `payment ${r.created ? "recorded" : "matched"} ${r.paymentId}` : `ignored: ${r.reason}`;
    }
    case "payment_intent.succeeded": {
      const pi = paymentIntentFacts(env.object);
      if (!pi) throw new Error("payment_intent.succeeded without a readable payment intent");
      const key = await readyKey();
      let charge: ChargeInput | null = pi.latestCharge;
      if ((!charge || !charge.balanceTxn) && key && pi.latestChargeId) {
        const fallback: ChargeInput | null = charge;
        charge = await fetchChargeExpanded(key, pi.latestChargeId).catch((e) => {
          console.error("[finances:stripe] charge fetch failed", pi.latestChargeId, e instanceof Error ? e.message : e);
          return fallback;
        });
      }
      if (!charge) {
        // No charge object and no way to fetch one: record from the intent.
        if (!pi.latestChargeId) return "ignored: payment intent has no charge yet";
        charge = {
          chargeId: pi.latestChargeId,
          paymentIntentId: pi.paymentIntentId,
          stripeInvoiceId: null,
          customerId: pi.customerId,
          customerName: "",
          customerEmail: "",
          amountCents: pi.amountReceivedCents,
          amountRefundedCents: 0,
          currency: pi.currency,
          created: pi.created,
          balanceTxnId: null,
          balanceTxn: null,
          livemode: pi.livemode,
          succeeded: true,
          description: pi.description,
          metadata: pi.metadata,
          refunds: [],
        };
      }
      charge.paymentIntentId = charge.paymentIntentId || pi.paymentIntentId;
      if (!charge.metadata.finInvoiceId && pi.metadata.finInvoiceId) charge.metadata = pi.metadata;
      const r = await recordStripeCharge(charge, { fetchFees: true });
      return r.paymentId ? `payment ${r.created ? "recorded" : "matched"} ${r.paymentId}` : `ignored: ${r.reason}`;
    }
    case "charge.refunded": {
      const c = chargeFacts(env.object);
      if (!c) throw new Error("charge.refunded without a readable charge");
      let parent = await findPaymentByKeys({ chargeId: c.chargeId, paymentIntentId: c.paymentIntentId });
      if (!parent) {
        await recordStripeCharge(c, { fetchFees: true });
        parent = await findPaymentByKeys({ chargeId: c.chargeId, paymentIntentId: c.paymentIntentId });
      }
      if (!parent) return "ignored: refunded charge was never a succeeded live payment";
      const n = await recordRefundsForCharge(parent.id, c, c.refunds, { fetchFees: true });
      return `refunds recorded: ${n}`;
    }
    case "invoice.paid": {
      const f = invoicePaidFacts(env.object);
      if (!f) throw new Error("invoice.paid without a readable invoice");
      const out = await applyStripeInvoicePaid(f);
      return out === "no_charge_on_invoice" || out === "zero_amount" ? `ignored: ${out}` : out;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const f = subscriptionFacts(env.object);
      if (!f) throw new Error(`${env.type} without a readable subscription`);
      if (env.type === "customer.subscription.deleted" && f.status !== "canceled") f.status = "canceled";
      await upsertSubscription(f, env.created);
      return `subscription ${f.id} -> ${f.status}`;
    }
    default:
      return `ignored: unhandled type ${env.type}`;
  }
}

// ── reconcile ────────────────────────────────────────────────────────────

export type ReconcileSummary = {
  days: number;
  charges_seen: number;
  payments_recorded: number;
  refunds_seen: number;
  refunds_recorded: number;
  subscriptions_upserted: number;
  pending_completed: number;
  truncated: boolean;
};

/** Backfill the last N days from the Stripe API. Requires the pinned account. */
export async function reconcileStripe(args: { days: number }): Promise<ReconcileSummary> {
  const days = Math.max(1, Math.min(400, Math.trunc(args.days || 30)));
  const { key } = await getStripeClient();
  const since = Math.floor(Date.now() / 1000) - days * 86_400;
  const summary: ReconcileSummary = {
    days,
    charges_seen: 0,
    payments_recorded: 0,
    refunds_seen: 0,
    refunds_recorded: 0,
    subscriptions_upserted: 0,
    pending_completed: 0,
    truncated: false,
  };

  const charges = await listAll(key, "/v1/charges", { "created[gte]": since }, { expand: ["data.balance_transaction", "data.payment_intent"] });
  summary.truncated ||= charges.truncated;
  for (const raw of charges.items) {
    const c = chargeFacts(raw);
    if (!c || !c.succeeded || !c.livemode) continue;
    summary.charges_seen += 1;
    if (!c.metadata.finInvoiceId) {
      const piMeta = finMetadata(raw.payment_intent);
      if (piMeta.finInvoiceId) c.metadata = piMeta;
    }
    const r = await recordStripeCharge(c, { fetchFees: false });
    if (r.created) summary.payments_recorded += 1;
  }

  const refunds = await listAll(key, "/v1/refunds", { "created[gte]": since }, { expand: ["data.balance_transaction", "data.charge"] });
  summary.truncated ||= refunds.truncated;
  for (const raw of refunds.items) {
    const r = refundFacts(raw);
    const c = chargeFacts(raw.charge);
    if (!r || !c || !c.livemode) continue;
    summary.refunds_seen += 1;
    let parent = await findPaymentByKeys({ chargeId: c.chargeId, paymentIntentId: c.paymentIntentId });
    if (!parent && c.succeeded) {
      await recordStripeCharge(c, { fetchFees: true });
      parent = await findPaymentByKeys({ chargeId: c.chargeId, paymentIntentId: c.paymentIntentId });
    }
    if (!parent) continue;
    summary.refunds_recorded += await recordRefundsForCharge(parent.id, c, [r], { fetchFees: false });
  }

  // Subscriptions: ALL of them, not just recent — MRR is a state, not a flow.
  const subs = await listAll(key, "/v1/subscriptions", { status: "all" }, { expand: ["data.customer"] });
  summary.truncated ||= subs.truncated;
  const now = Math.floor(Date.now() / 1000);
  for (const raw of subs.items) {
    const f = subscriptionFacts(raw);
    if (!f || !f.livemode) continue;
    await upsertSubscription(f, now);
    summary.subscriptions_upserted += 1;
  }

  summary.pending_completed = await syncPendingStripe(key);
  return summary;
}

/** Complete payments recorded without a fee or without a CAD settlement. */
export async function syncPendingStripe(key?: string): Promise<number> {
  const k = key ?? (await readyKey());
  if (!k) return 0;
  const pending = await query<{ id: string; stripe_charge_id: string | null }>(
    `SELECT id, stripe_charge_id FROM fin_payments
      WHERE kind = 'payment' AND source = 'stripe' AND (fee_status = 'pending' OR entry_id IS NULL)
      ORDER BY occurred_on LIMIT 100`,
  );
  let done = 0;
  for (const p of pending) {
    if (!p.stripe_charge_id || !p.stripe_charge_id.startsWith("ch_")) continue;
    try {
      const c = await fetchChargeExpanded(k, p.stripe_charge_id);
      if (!c) continue;
      await completeSettlement(p.id, c.balanceTxn);
      done += 1;
    } catch (e) {
      console.error("[finances:stripe] pending sync failed", p.id, e instanceof Error ? e.message : e);
    }
  }
  return done;
}
