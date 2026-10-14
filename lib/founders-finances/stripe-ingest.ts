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
 * POSTING. Charge (no fin invoice): Dr Stripe clearing / Cr revenue, gross
 * CAD — 4010 Subscription revenue when the charge paid a Stripe invoice FOR A
 * SUBSCRIPTION, 4000 Service revenue otherwise (a one-off charge or a one-off
 * Stripe invoice). Charge for a fin invoice: Dr Stripe clearing / Cr AR (via
 * invoice-store's settlement, with realised FX for USD). Fee: Dr Stripe fees
 * / Cr Stripe clearing, from the charge's balance transaction, in ITS
 * currency (the settlement currency — USD for OASIS's account) on the day the
 * balance moved. Refund of an invoice settlement: Dr AR / Cr Stripe clearing,
 * reopening the receivable until a credit note or void cancels the sale. A
 * refund of an unlinked charge remains Dr Refunds / Cr Stripe clearing. A
 * charge booked as revenue and matched to an invoice later gets both its gross
 * reclass (Dr revenue / Cr AR) and any refund reclass (Dr AR / Cr Refunds).
 *
 * SUBSCRIPTION OR NOT. From API 2025-03-31 (basil; the account default) a
 * charge no longer names its invoice, so a new payment asks Stripe which
 * invoice its payment intent paid (GET /v1/invoice_payments, read-only).
 * Only NEW payment rows are classified; a row already in the books keeps the
 * account it was posted to.
 *
 * FEES may be unknown when the event arrives (no verified Stripe key, a
 * balance transaction not yet readable, or no Bank of Canada rate yet for the
 * fee's day). Then the payment is recorded with fee_status 'pending' and
 * syncPendingStripe() completes it later — card (ch_) and non-card (py_)
 * charges alike; a USD charge whose CAD settlement had to be estimated from
 * the Bank of Canada rate is trued up to Stripe's real CAD figure when the
 * balance transaction is in CAD (the gap is FX).
 *
 * PAYOUTS (payout.paid / payout.failed / payout.canceled, and every payout the
 * reconcile lists) move money out of Stripe clearing into the bank:
 * stripe-payouts-io.ts.
 *
 * THE BUSINESS LEDGER (lib/ledger, plan §F2). This module is the one writer
 * of payment.received, payment.failed, refund.issued, invoice.paid and
 * subscription.* (lib/ledger/catalog.ts). Each is emitted in the SAME batch
 * as the write that records it, so a failed ledger insert rolls that write
 * back: payment.received and refund.issued right after the fin_payments
 * insert (and only when it inserted: emitIfChanged), subscription.* with the
 * fin_subscriptions upsert, invoice.paid and subscription.renewed with the
 * write that records the invoice's payment (the payment row, the link to a
 * fin invoice, or the key fill on a payment already recorded:
 * applyStripeInvoicePaid), and payment.failed, which records no row, with the
 * fin_stripe_events row that marks the event processed. The workspace is the one OASIS's Stripe account
 * belongs to (stripeLedgerTenant); when it cannot be said, the fact goes to
 * ledger_dead_letters instead, in the same batch. Never a default tenant.
 * payment.received and refund.issued carry the client record the Stripe
 * customer is linked to as the customer_id join (customerRecordFor), when one is.
 *
 * ONLY OASIS'S STRIPE ACCOUNT (2026-09-30). A webhook event writes nothing to
 * the book unless it comes from the Stripe account a founder pinned
 * (stripeEventOrigin): nothing pinned, an event naming another account, no
 * key, a key of another account, or an event the pinned account's key cannot
 * find, is dead-lettered with ids only
 * and never reaches fin_payments, the journal or the ledger. The reconcile and
 * the pending-fee sync already read Stripe only through the pinned account's
 * verified key (stripe-io.ts getStripeClient).
 */
import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { emit, emitIfChanged, assertNoPayloadConflicts, type EmitInput } from "@/lib/ledger/emit";
import { catalogEntry, isLedgerCode, isLedgerId } from "@/lib/ledger/catalog";
import { canonicalJson } from "@/lib/os/approvals/rules";
import { isRetiredTenant } from "@/lib/tenant/retired";
import { accountId, BUSINESS_ENTITY_ID, SYS } from "./chart";
import { divRoundHalfAwayFromZero } from "./money";
import { addDays, torontoDateOfEpochSeconds, usdToCadCents } from "./fx";
import {
  asObj,
  chargeFacts,
  eventEnvelope,
  finMetadata,
  invoiceFromInvoicePayments,
  invoicePaidFacts,
  paymentIntentFacts,
  payoutFacts,
  refundFacts,
  stripeInvoiceFacts,
  subscriptionFacts,
  subscriptionPlanChange,
  balanceTxnFacts,
  type BalanceTxnFacts,
  type ChargeFacts,
  type FinMetadata,
  type InvoicePaidFacts,
  type RefundFacts,
  type StripeEventEnvelope,
  type SubscriptionFacts,
} from "./stripe-map";
import { subscriptionMonthlyCents } from "./mrr";
import { auditStatement, finDb, isUniqueViolation, newId, query, queryOne, writeBatch, type InStatement } from "./db";
import { buildPosting } from "./ledger-io";
import { LedgerError } from "./ledger";
import { rateLookupFor, usdCadRate } from "./fx-io";
import {
  buildSettlementPosting,
  buildSettlementReversalPosting,
  loadInvoice,
  recomputeInvoicePaidStatement,
  type InvoiceRow,
} from "./invoice-store";
import { financeTenantId, getStripeClient, listAll, pinnedStripeAccount, stripeRequest, StripeApiError, StripeNotReady } from "./stripe-io";
import { recordStripePayout, retryUnbookedPayouts, unbookedPayouts } from "./stripe-payouts-io";
import { FinanceInputError } from "./access-io";

const ACTOR = "stripe";
const E = BUSINESS_ENTITY_ID;

// ── Business Ledger ──────────────────────────────────────────────────────

/** outcome_events.producer for every event this module emits: the catalog's owning module. */
const LEDGER_PRODUCER = "lib/founders-finances/stripe-ingest.ts";

export type LedgerTenant = { ok: true; tenantId: string } | { ok: false; reason: string };

/**
 * The workspace a fact from OASIS's Stripe account belongs to: the tenant
 * whose Stripe key Finances reads (stripe-io.ts financeTenantId, the first of
 * FOUNDERS_TENANT_IDS), and only while a founder has pinned the account that
 * key belongs to. Anything short of that is a reason, and the fact is
 * dead-lettered; it is never filed under OASIS by default.
 */
export async function stripeLedgerTenant(): Promise<LedgerTenant> {
  const pinned = await pinnedStripeAccount();
  if (!pinned) return { ok: false, reason: "stripe_account_unpinned" };
  const tenantId = financeTenantId();
  if (!tenantId) return { ok: false, reason: "finance_tenant_unset" };
  if (!isLedgerId(tenantId)) return { ok: false, reason: "finance_tenant_invalid" };
  if (isRetiredTenant(tenantId)) return { ok: false, reason: "finance_tenant_retired" };
  return { ok: true, tenantId };
}

/** One Stripe fact, minus what every Stripe fact shares (actor, source, confidence, producer). */
type StripeFact = Pick<EmitInput, "eventKey" | "occurredAt" | "subject" | "sourceRef" | "idempotencyKey" | "valueCents" | "currency" | "payload" | "customerId">;

/**
 * A refused fact, for ledger_dead_letters: ids, codes and amounts only (every
 * field below is a Stripe id, a catalog code or an integer), so nothing
 * personal is parked there. `conditional` writes it only when the statement
 * just before it changed a row, like emitIfChanged.
 */
function deadLetter(fact: StripeFact, error: string, conditional: boolean): InStatement {
  const occurred = fact.occurredAt instanceof Date ? fact.occurredAt.toISOString() : fact.occurredAt;
  const raw = {
    event_key: fact.eventKey,
    idempotency_key: fact.idempotencyKey,
    occurred_at: occurred,
    subject: fact.subject,
    value_cents: fact.valueCents ?? null,
    currency: fact.currency ?? null,
    payload: fact.payload,
  };
  const now = new Date().toISOString();
  const fingerprint = createHash("sha256").update(`${LEDGER_PRODUCER}\n${canonicalJson(raw)}`, "utf8").digest("hex");
  const values = "?, NULL, ?, ?, ?, ?, ?, ?, 1, ?, ?";
  return {
    sql: `INSERT INTO ledger_dead_letters (id, tenant_hint, producer, event_key, idempotency_key, fingerprint, payload_json,
            error, attempts, first_seen, last_seen)
          ${conditional ? `SELECT ${values} WHERE changes() = 1` : `VALUES (${values})`}
          ON CONFLICT (producer, fingerprint) DO UPDATE SET
            attempts = attempts + 1, last_seen = excluded.last_seen, error = excluded.error, resolved_at = NULL`,
    args: [randomUUID(), LEDGER_PRODUCER, fact.eventKey, fact.idempotencyKey, fingerprint, canonicalJson(raw), error, now, now],
  };
}

/**
 * The ledger statement for one Stripe fact, for the caller's own batch: the
 * event, or its dead letter when no workspace owns it. `ifChanged` = only when
 * the statement right before it inserted a row (a payment or refund row that
 * a concurrent delivery may already have written).
 */
function ledgerStatement(tenant: LedgerTenant, fact: StripeFact, opts: { ifChanged: boolean }): InStatement {
  if (!tenant.ok) return deadLetter(fact, `tenant_unmapped:${tenant.reason}`, opts.ifChanged);
  const input: EmitInput = {
    ...fact,
    tenantId: tenant.tenantId,
    eventVersion: catalogEntry(fact.eventKey)?.version ?? 0,
    actor: { type: "external" },
    source: "stripe",
    confidence: "verified",
    producer: LEDGER_PRODUCER,
  };
  return opts.ifChanged ? emitIfChanged(input) : emit(input);
}

/**
 * Run a batch that carries ledger statements, then refuse loudly a key that
 * already held another fact. A conditional statement whose guarded insert
 * did not happen (a redelivery: the row, and so its fact, was written before)
 * is not checked: it meant to write nothing, and its subject is the fresh row
 * id this attempt minted, not the stored one.
 */
async function writeWithLedger(statements: InStatement[]): Promise<Awaited<ReturnType<typeof writeBatch>>> {
  const out = await writeBatch(statements);
  const written = statements.filter((s, i) => {
    const stamp = (s as { ledger?: { conditional: boolean } }).ledger;
    return !stamp || !stamp.conditional || (i > 0 && out[i - 1]?.rowsAffected === 1);
  });
  await assertNoPayloadConflicts(finDb(), written);
  return out;
}

/** A Stripe code field (failure_code, cancellation reason) as a ledger code, or nothing. */
function stripeCode(v: unknown): string | undefined {
  return isLedgerCode(v) ? v : undefined;
}

/**
 * The client record (customers.id) a Stripe customer is linked to in the
 * workspace the fact is filed under, for the ledger's customer_id join key on
 * payment.received and refund.issued: the Stripe customer id itself is not a
 * client record id, and the catalog's payload has no field for it (it stays on
 * the fin_payments row, the event's subject). Null when the workspace is not
 * known, the payment names no Stripe customer, or no client record carries
 * that Stripe customer yet. Read only; tenant from the pinned account, never
 * a default.
 */
async function customerRecordFor(tenant: LedgerTenant, stripeCustomerId: string | null): Promise<string | null> {
  if (!tenant.ok || !stripeCustomerId) return null;
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM customers WHERE tenant_id = ? AND stripe_customer_id = ? AND archived_at IS NULL ORDER BY created_at LIMIT 1`,
    [tenant.tenantId, stripeCustomerId],
  );
  return row && isLedgerId(row.id) ? row.id : null;
}

// ── contamination guard ──────────────────────────────────────────────────

/**
 * Whose Stripe account an event came from, before anything from it is
 * written to the OASIS book (2026-09-30). Several Stripe accounts sit around
 * this business (OASIS; Trytan's Arthrisil store, which has its own account;
 * PropFlow; the store), and a signing secret or a key pasted into the wrong
 * variable is all it takes for another company's payment to land in OASIS's
 * revenue. So an event reaches the books only when its account is the one a
 * founder pinned in Finances › Settings (fin_settings.stripe_account_id):
 *
 *   - nothing pinned: refused (nothing says whose account this is);
 *   - the event names an account (a Connect-style `account`) other than the
 *     pinned one: refused;
 *   - the configured key belongs to another account (GET /v1/account says so:
 *     stripe_account_mismatch): refused as stripe_key_not_pinned_account. The
 *     variables hold another company's Stripe key, and very likely its
 *     signing secret too, so the signature proves nothing about whose event
 *     this is;
 *   - no key at all: refused as stripe_key_missing. Nothing can compare the
 *     event's account with the pin, and the signature alone is not that proof;
 *   - a key verified against the pinned account is configured: the event must
 *     exist in that account (GET /v1/events/{id}); Stripe answering 404 means
 *     another account sent it: refused. A 5xx, a 429 or a network failure is
 *     thrown, so the webhook answers 500 and Stripe retries: a transient
 *     failure never skips the check, and never refuses a real OASIS event.
 * A refused event is marked ignored and dead-lettered to ledger_dead_letters
 * with ids only: the book, the payments table and the ledger never see it.
 * An OASIS event refused while the key was missing or wrong is not lost: the
 * daily reconcile (reconcileStripe, through the pinned account's verified
 * key) books its charges, refunds, subscriptions and payouts once the key is
 * fixed.
 */
export type StripeEventOrigin = { ok: true; accountId: string; verified: "api" } | { ok: false; reason: string; accountId: string | null };

export async function stripeEventOrigin(env: StripeEventEnvelope): Promise<StripeEventOrigin> {
  const pinned = await pinnedStripeAccount();
  if (!pinned) return { ok: false, reason: "stripe_account_unpinned", accountId: env.account };
  if (env.account && env.account !== pinned) return { ok: false, reason: "stripe_account_mismatch", accountId: env.account };
  let key: string;
  try {
    key = (await getStripeClient()).key;
  } catch (e) {
    if (!(e instanceof StripeNotReady)) throw e;
    // Could not ask Stripe who the key belongs to: try again later, never skip the check.
    if (e.code === "stripe_account_unreachable") throw e;
    // The key is another company's: refused, whatever the signature says.
    if (e.code === "stripe_account_mismatch") return { ok: false, reason: "stripe_key_not_pinned_account", accountId: env.account };
    // No key (or the pin was cleared meanwhile): nothing can prove the event is the pinned account's.
    return { ok: false, reason: e.code, accountId: env.account };
  }
  try {
    await stripeRequest(key, "GET", `/v1/events/${encodeURIComponent(env.id)}`);
  } catch (e) {
    if (e instanceof StripeApiError && e.status === 404) return { ok: false, reason: "event_not_in_pinned_account", accountId: env.account };
    throw e;
  }
  return { ok: true, accountId: pinned, verified: "api" };
}

/** A refused event's dead letter: its Stripe ids and the reason, nothing else (no amount, name or email). */
function foreignEventDeadLetter(env: StripeEventEnvelope, origin: Extract<StripeEventOrigin, { ok: false }>): InStatement {
  const raw = { stripe_event_id: env.id, stripe_event_type: env.type, stripe_account: origin.accountId, reason: origin.reason };
  const now = new Date().toISOString();
  const fingerprint = createHash("sha256").update(`${LEDGER_PRODUCER}\n${canonicalJson(raw)}`, "utf8").digest("hex");
  return {
    sql: `INSERT INTO ledger_dead_letters (id, tenant_hint, producer, event_key, idempotency_key, fingerprint, payload_json,
            error, attempts, first_seen, last_seen)
          VALUES (?, NULL, ?, NULL, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT (producer, fingerprint) DO UPDATE SET
            attempts = attempts + 1, last_seen = excluded.last_seen, error = excluded.error, resolved_at = NULL`,
    args: [randomUUID(), LEDGER_PRODUCER, `stripe:${env.id}`, fingerprint, canonicalJson(raw), `foreign_stripe_account:${origin.reason}`, now, now],
  };
}

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

function mergedFinMetadata(primary: FinMetadata, fallback: FinMetadata): FinMetadata {
  return {
    finInvoiceId: primary.finInvoiceId || fallback.finInvoiceId,
    finEntityId: primary.finEntityId || fallback.finEntityId,
    finInvoicePriceId: primary.finInvoicePriceId || fallback.finInvoicePriceId,
  };
}

/** Turn a Payment Link off, then prove from Stripe's live state that it is off. */
export async function deactivateAndConfirmPaymentLink(key: string, linkId: string): Promise<void> {
  await stripeRequest(key, "POST", `/v1/payment_links/${encodeURIComponent(linkId)}`, { active: "false" });
  const confirmed = await stripeRequest(key, "GET", `/v1/payment_links/${encodeURIComponent(linkId)}`);
  if (confirmed.active !== false) throw new Error(`Stripe still reports payment link ${linkId} as active`);
}

export const EXTERNAL_PAYMENT_LINK_RETIRE_FAILED =
  "Stripe couldn't safely turn off this invoice's card link, so the external payment was not recorded. Check Stripe and try again.";
export const DRAFT_EDIT_LINK_RETIRE_FAILED =
  "Stripe couldn't safely turn off this draft's old card link, so the draft was not changed. Check Stripe and try again.";
export const STRIPE_PAYMENT_LINK_RETIRE_FAILED =
  "Stripe recorded the payment, but the invoice's old card link could not be safely retired. Check Stripe and retry the event before sending the invoice again.";
export const NON_CARD_LINK_RETIRE_FAILED =
  "Stripe couldn't safely retire this invoice's legacy card link, so it was not shown or emailed. Check Stripe and try again.";

/** The exact invoice/link fields an external-payment writer read before touching Stripe. */
export function oneTimeLinkSnapshot(inv: InvoiceRow, alias = "fin_invoices"): { sql: string; args: Array<string | number | null> } {
  return {
    sql: `${alias}.id = ? AND ${alias}.status = ? AND ${alias}.total_cents = ? AND ${alias}.amount_paid_cents = ?
          AND ${alias}.currency = ? AND ${alias}.updated_at = ?
          AND ${alias}.stripe_price_id IS ? AND ${alias}.stripe_payment_link_id IS ? AND ${alias}.stripe_payment_link_url IS ?`,
    args: [
      inv.id,
      inv.status,
      inv.total_cents,
      inv.amount_paid_cents,
      inv.currency,
      inv.updated_at,
      inv.stripe_price_id,
      inv.stripe_payment_link_id,
      inv.stripe_payment_link_url,
    ],
  };
}

/** Clear exactly the one-time fields that were deactivated at Stripe, inside the caller's atomic batch. */
export function clearOneTimePaymentLinkStatement(
  inv: InvoiceRow,
  gate?: { sql: string; args: Array<string | number | null> },
): InStatement {
  const snapshot = oneTimeLinkSnapshot(inv);
  return {
    sql: `UPDATE fin_invoices
             SET stripe_price_id = NULL, stripe_payment_link_id = NULL, stripe_payment_link_url = NULL,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE ${snapshot.sql}${gate ? ` AND (${gate.sql})` : ""}`,
    args: [...snapshot.args, ...(gate?.args || [])],
  };
}

/**
 * Before money received outside Stripe is recorded, retire the exact one-time
 * link seen by the caller. The caller clears the fields in the SAME database
 * batch as the payment/edit it is protecting; Stripe cannot join that local
 * transaction, so its shutdown necessarily happens first.
 */
async function retireOneTimePaymentLink(inv: InvoiceRow, failureMessage: string): Promise<void> {
  if (!inv.stripe_payment_link_id && !inv.stripe_price_id && !inv.stripe_payment_link_url) return;
  try {
    if (!inv.stripe_payment_link_id) throw new Error(`invoice ${inv.id} has stored card-link fields but no Payment Link id`);
    const { key } = await getStripeClient();
    await deactivateAndConfirmPaymentLink(key, inv.stripe_payment_link_id);
  } catch (e) {
    console.error("[finances:stripe] could not safely retire invoice payment link", inv.id, e instanceof Error ? e.message : e);
    throw new FinanceInputError(failureMessage);
  }
}

export async function retireOneTimePaymentLinkForExternalPayment(inv: InvoiceRow): Promise<void> {
  await retireOneTimePaymentLink(inv, EXTERNAL_PAYMENT_LINK_RETIRE_FAILED);
}

/** Editing a draft may change the amount/currency/rail; retire its now-wrong live link before changing those fields. */
export async function retireOneTimePaymentLinkForDraftEdit(inv: InvoiceRow): Promise<void> {
  await retireOneTimePaymentLink(inv, DRAFT_EDIT_LINK_RETIRE_FAILED);
}

/** A Wise/Hybrid document must never expose a legacy one-time card rail. */
export async function retireLegacyOneTimePaymentLink(inv: InvoiceRow): Promise<void> {
  if (!inv.stripe_payment_link_id && !inv.stripe_price_id && !inv.stripe_payment_link_url) return;
  await retireOneTimePaymentLink(inv, NON_CARD_LINK_RETIRE_FAILED);
  const cleared = await finDb().execute(clearOneTimePaymentLinkStatement(inv));
  if (cleared.rowsAffected !== 1) {
    console.error("[finances:stripe] invoice changed while its legacy non-card link fields were being cleared", inv.id);
    throw new FinanceInputError(NON_CARD_LINK_RETIRE_FAILED);
  }
}

async function fetchChargeExpanded(key: string, chargeId: string): Promise<ChargeFacts | null> {
  const u = new URLSearchParams();
  u.append("expand[]", "balance_transaction");
  u.append("expand[]", "payment_intent");
  const raw = await stripeRequest(key, "GET", `/v1/charges/${encodeURIComponent(chargeId)}`, u);
  const facts = chargeFacts(raw);
  if (facts) {
    const piMeta = finMetadata(raw.payment_intent);
    facts.metadata = mergedFinMetadata(facts.metadata, piMeta);
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

function invoiceLinkSnapshot(inv: InvoiceRow): { sql: string; args: Array<string | number | null> } {
  return {
    sql: `EXISTS (
            SELECT 1 FROM fin_invoices
             WHERE id = ? AND status = ? AND total_cents = ? AND amount_paid_cents = ? AND currency = ?
               AND stripe_price_id IS ? AND stripe_payment_link_id IS ?
          )`,
    args: [inv.id, inv.status, inv.total_cents, inv.amount_paid_cents, inv.currency, inv.stripe_price_id, inv.stripe_payment_link_id],
  };
}

/**
 * A metadata link is only a candidate: the write repeats this row snapshot so
 * a concurrent external payment cannot make a formerly-safe charge overpay
 * the invoice. New Payment Links pin their Price id in PaymentIntent metadata.
 * Older Checkout/Payment Link payloads may not expose that marker, so legacy
 * charges fall back to status/currency/balance safety instead of pretending a
 * Checkout Session id is available on Charge or PaymentIntent webhooks.
 */
async function linkableInvoice(invoiceId: string | null, currency: string, amountCents: number, priceId: string | null): Promise<InvoiceRow | null> {
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
    console.error("[finances:stripe] refusing invoice link: payment currency does not match invoice", invoiceId, currency, inv.currency);
    return null;
  }
  const due = Math.max(0, inv.total_cents - inv.amount_paid_cents);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > due) {
    console.error("[finances:stripe] refusing invoice link: payment exceeds the remaining balance", invoiceId, amountCents, due);
    return null;
  }
  if (priceId && priceId !== inv.stripe_price_id) {
    console.error("[finances:stripe] refusing invoice link: payment came from a stale invoice price", invoiceId, priceId, inv.stripe_price_id);
    return null;
  }
  return inv;
}

/** CAD settlement from a balance transaction, or null. */
function cadFromBalanceTxn(bt: BalanceTxnFacts | null): { gross: number; fee: number } | null {
  if (!bt || bt.currency !== "CAD") return null;
  return { gross: bt.amountCents, fee: bt.feeCents };
}

/**
 * Fill in `subscriptionInvoice` (and the Stripe invoice id) when the payload
 * did not carry them, by asking Stripe which invoice the charge paid. Reads
 * only. Stays null without a verified key. A 4xx from Stripe (e.g. a key
 * without invoice read access) is logged and leaves it null; a 5xx/429 or a
 * network failure throws, so the webhook is retried and a reconcile stops
 * loudly instead of booking revenue to a guessed account.
 */
async function classifyCharge(charge: ChargeInput): Promise<void> {
  if (charge.subscriptionInvoice !== null) return;
  const key = await readyKey();
  if (!key) return;
  try {
    let invoiceId = charge.stripeInvoiceId;
    if (!invoiceId) {
      if (!charge.paymentIntentId) {
        // No payment intent: a direct charge, which no Stripe invoice creates.
        charge.subscriptionInvoice = false;
        return;
      }
      const u = new URLSearchParams();
      u.set("payment[type]", "payment_intent");
      u.set("payment[payment_intent]", charge.paymentIntentId);
      u.set("limit", "10");
      u.append("expand[]", "data.invoice");
      const found = invoiceFromInvoicePayments(await stripeRequest(key, "GET", "/v1/invoice_payments", u));
      if (found.kind === "none") {
        charge.subscriptionInvoice = false;
        return;
      }
      if (found.kind === "invoice") {
        charge.stripeInvoiceId = found.invoice.stripeInvoiceId;
        charge.subscriptionInvoice = found.invoice.forSubscription;
        return;
      }
      invoiceId = found.stripeInvoiceId;
      if (!invoiceId) return;
    }
    const inv = stripeInvoiceFacts(await stripeRequest(key, "GET", `/v1/invoices/${encodeURIComponent(invoiceId)}`));
    if (!inv) return;
    charge.stripeInvoiceId = inv.stripeInvoiceId;
    charge.subscriptionInvoice = inv.forSubscription;
  } catch (e) {
    if (e instanceof StripeApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
      console.error("[finances:stripe] could not tell whether the charge paid a subscription invoice", charge.chargeId, e.message);
      return;
    }
    throw e;
  }
}

/**
 * Record one succeeded charge (idempotent). Returns the payment row id.
 * `fetchFees`: may call Stripe for the balance transaction when the payload
 * did not carry it expanded.
 */
export async function recordStripeCharge(
  charge: ChargeInput,
  opts: { fetchFees: boolean; ledger?: InStatement[] } = { fetchFees: true },
): Promise<{ paymentId: string | null; created: boolean; reason?: string }> {
  if (!charge.succeeded) return { paymentId: null, created: false, reason: "not_succeeded" };
  if (!charge.livemode) return { paymentId: null, created: false, reason: "test_mode" };
  // The caller's event facts (applyStripeInvoicePaid), committed with the write that records the payment.
  const facts = opts.ledger ?? [];

  const existing = await findPaymentByKeys({
    chargeId: charge.chargeId,
    paymentIntentId: charge.paymentIntentId,
    stripeInvoiceId: charge.stripeInvoiceId,
  });
  if (existing) {
    await recordOnExistingPayment(
      existing,
      { chargeId: charge.chargeId, paymentIntentId: charge.paymentIntentId, stripeInvoiceId: charge.stripeInvoiceId, balanceTxnId: charge.balanceTxnId },
      charge.metadata,
      facts,
    );
    if (existing.fee_status === "pending" || existing.entry_id === null) {
      const bt = charge.balanceTxn ?? (opts.fetchFees ? await fetchBalanceTxnSafe(charge.balanceTxnId) : null);
      await completeSettlement(existing.id, bt);
    }
    // A prior delivery may have committed the payment before Stripe or the
    // network let us confirm the old full-balance link was off. Every replay
    // retries that strict retirement until the invoice fields are clear.
    const refreshed = await loadPayment(existing.id);
    if (refreshed?.invoice_id) await deactivatePaymentLinkIfPaid(refreshed.invoice_id, true);
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
  const linkedInvoice = await linkableInvoice(
    charge.metadata.finInvoiceId,
    charge.currency,
    charge.amountCents,
    charge.metadata.finInvoicePriceId,
  );
  const invoiceId = linkedInvoice?.id ?? null;
  const contactId = linkedInvoice?.contact_id ?? (await contactForCustomer(charge.customerId));
  const paymentId = newId("pay");
  // Only a payment booked as revenue needs its revenue account; a fin
  // invoice's payment settles AR.
  if (!invoiceId) await classifyCharge(charge);
  if (!invoiceId && charge.subscriptionInvoice === null) {
    console.warn("[finances:stripe] subscription or one-off unknown (no verified key or lookup refused); booked as service revenue", charge.chargeId);
  }
  const incomeCode = charge.subscriptionInvoice === true ? SYS.subscriptionRevenue : SYS.serviceRevenue;
  const tenant = await stripeLedgerTenant();
  // The client record this Stripe customer is (the ledger's customer_id join); the Stripe id rides on the payment row.
  const customerRecord = await customerRecordFor(tenant, charge.customerId);
  const providerPaymentId = charge.chargeId || charge.paymentIntentId || charge.stripeInvoiceId || paymentId;
  const invoiceSnapshot = linkedInvoice ? invoiceLinkSnapshot(linkedInvoice) : null;
  const invoiceValueSql = invoiceSnapshot ? `CASE WHEN ${invoiceSnapshot.sql} THEN ? ELSE NULL END` : "NULL";
  const statements: InStatement[] = [
    {
      sql: `INSERT OR IGNORE INTO fin_payments
              (id, entity_id, kind, source, occurred_at, occurred_on, amount_cents, currency, settlement_cad_cents,
               fee_cad_cents, fee_status, settlement_estimated, invoice_id, contact_id, customer_name, customer_email,
               stripe_customer_id, stripe_charge_id, stripe_payment_intent_id, stripe_invoice_id, stripe_balance_txn_id,
               deposit_account_id, income_account_id, description, livemode, created_by)
            SELECT ?, ?, 'payment', 'stripe', ?, ?, ?, ?, ?, ?, ?, ?, ${invoiceValueSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?`,
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
        ...(invoiceSnapshot && linkedInvoice ? [...invoiceSnapshot.args, linkedInvoice.id] : []),
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
    // Straight after the insert: only the delivery that inserted the row records the money.
    ledgerStatement(
      tenant,
      {
        eventKey: "payment.received",
        occurredAt: new Date(charge.created * 1000),
        subject: { type: "payment", id: paymentId },
        sourceRef: providerPaymentId,
        idempotencyKey: `stripe:${providerPaymentId}`,
        valueCents: charge.amountCents,
        currency: charge.currency,
        customerId: customerRecord,
        payload: { provider_payment_id: providerPaymentId },
      },
      { ifChanged: true },
    ),
  ];
  if (invoiceId) {
    statements.push(
      recomputeInvoicePaidStatement(invoiceId, new Date(charge.created * 1000).toISOString(), {
        sql: `EXISTS (SELECT 1 FROM fin_payments WHERE id = ? AND invoice_id = ?)`,
        args: [paymentId, invoiceId],
      }),
    );
  }
  statements.push({
    sql: `INSERT INTO fin_audit_log (id, entity_id, actor, action, object_type, object_id, detail_json)
          SELECT ?, ?, ?, 'stripe.payment_recorded', 'payment', ?, ? WHERE EXISTS (SELECT 1 FROM fin_payments WHERE id = ?)`,
    args: [
      newId("aud"), E, ACTOR, paymentId,
      JSON.stringify({ charge: charge.chargeId, invoice: invoiceId, income: invoiceId ? null : incomeCode, subscription: charge.subscriptionInvoice }).slice(0, 8000),
      paymentId,
    ],
  });
  await writeWithLedger([...statements, ...facts]);

  // OR IGNORE may have lost a race to a concurrent delivery: re-read by key.
  const row = await findPaymentByKeys({ chargeId: charge.chargeId, paymentIntentId: charge.paymentIntentId, stripeInvoiceId: charge.stripeInvoiceId });
  if (!row) throw new Error(`payment for ${charge.chargeId ?? charge.paymentIntentId} was neither inserted nor found`);
  const created = row.id === paymentId;
  await postPaymentEntries(row.id);
  if (bt) await postFee(row.id, bt);
  // Any linked payment changes the balance. Retire the prior full-balance link
  // even when the charge was partial; resend can create the exact remainder.
  if (row.invoice_id) await deactivatePaymentLinkIfPaid(row.invoice_id, true);
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

type PaymentKeys = { chargeId?: string | null; paymentIntentId?: string | null; stripeInvoiceId?: string | null; balanceTxnId?: string | null };

/** An event's facts committed on their own: the event wrote nothing else they could ride with. */
async function commitFacts(facts: InStatement[]): Promise<void> {
  if (facts.length > 0) await writeWithLedger(facts);
}

/**
 * A payment already in the books, seen again: link it to the fin invoice its
 * metadata names, and fill the Stripe keys it lacks. `facts` (an event's own
 * ledger statements) ride in the batch that records what they describe: the
 * link (the invoice becomes paid) when there is one, else the key fill (the
 * payment now carries this invoice's id), else on their own.
 */
async function recordOnExistingPayment(existing: PaymentRow, keys: PaymentKeys, metadata: FinMetadata, facts: InStatement[]): Promise<void> {
  if (metadata.finInvoiceId && !existing.invoice_id && (await linkPaymentToInvoice(existing.id, metadata.finInvoiceId, facts, metadata.finInvoicePriceId))) {
    await fillMissingKeys(existing, keys);
    return;
  }
  await fillMissingKeys(existing, keys, facts);
}

async function fillMissingKeys(p: PaymentRow, keys: PaymentKeys, facts: InStatement[] = []): Promise<void> {
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
  if (sets.length === 0) return commitFacts(facts);
  const fill: InStatement = { sql: `UPDATE fin_payments SET ${sets.join(", ")} WHERE id = ?`, args: [...args, p.id] };
  try {
    if (facts.length > 0) await writeWithLedger([fill, ...facts]);
    else await finDb().execute(fill);
  } catch (e) {
    // Another row already owns that key (should not happen); keep the payment, log it, and still record the facts.
    if (!isUniqueViolation(e)) throw e;
    console.error("[finances:stripe] key already owned by another payment row", p.id, keys);
    await commitFacts(facts);
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

/**
 * Post a charge's Stripe fee from its balance transaction: Dr 5000 Stripe
 * fees / Cr 1050 Stripe clearing, in the balance transaction's OWN currency
 * (the settlement currency — USD for OASIS, whatever the charge currency),
 * dated the Toronto day the balance moved, CAD equivalent at that day's Bank
 * of Canada rate like every other foreign line. Once per payment
 * (fee_status) and once per charge (source 'stripe_fee' + the charge id is
 * unique), so a re-run posts nothing. fee_cad_cents is set to the CAD the
 * ledger actually booked, read back from the entry in the same batch.
 *
 * Returns true when the fee is in the books (now or before). No rate for the
 * fee's day yet -> false, left pending for the next sync, never guessed.
 */
async function postFee(paymentId: string, bt: BalanceTxnFacts): Promise<boolean> {
  const p = await loadPayment(paymentId);
  if (!p || p.kind !== "payment") return false;
  if (p.fee_status !== "pending") return p.fee_status === "posted";
  const sourceRef = p.stripe_charge_id || p.id;
  const feesAccount = accountId(E, SYS.stripeFees);
  const clearing = p.deposit_account_id || accountId(E, SYS.stripeClearing);
  const markPosted: InStatement = {
    sql: `UPDATE fin_payments
             SET fee_status = 'posted',
                 fee_cad_cents = COALESCE((SELECT SUM(l.cad_debit_cents) - SUM(l.cad_credit_cents)
                                             FROM fin_journal_lines l JOIN fin_journal_entries e ON e.id = l.entry_id
                                            WHERE e.entity_id = ? AND e.source = 'stripe_fee' AND e.source_ref = ? AND l.account_id = ?), 0),
                 stripe_balance_txn_id = COALESCE(stripe_balance_txn_id, ?)
           WHERE id = ? AND fee_status = 'pending'`,
    args: [E, sourceRef, feesAccount, bt.id, p.id],
  };
  const statements: InStatement[] = [];
  if (bt.feeCents !== 0) {
    const amount = Math.abs(bt.feeCents);
    const [dr, cr] = bt.feeCents > 0 ? [feesAccount, clearing] : [clearing, feesAccount];
    try {
      const posting = await buildPosting({
        entityId: E,
        entryDate: bt.created !== null ? torontoDateOfEpochSeconds(bt.created) : p.occurred_on,
        memo: bt.feeCents > 0 ? "Stripe processing fee" : "Stripe fee credit",
        source: "stripe_fee",
        sourceRef,
        createdBy: ACTOR,
        lines: [
          { accountId: dr, currency: bt.currency, debitCents: amount },
          { accountId: cr, currency: bt.currency, creditCents: amount },
        ],
      });
      statements.push(...posting.statements);
    } catch (e) {
      if (e instanceof LedgerError && e.code === "fx_rate_missing") {
        console.error("[finances:stripe] fee left pending: no Bank of Canada rate yet for", bt.currency, "on the fee's day", p.id);
        return false;
      }
      throw e;
    }
  }
  statements.push(markPosted);
  try {
    await writeBatch(statements);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Already posted under this charge by a concurrent run: adopt that entry.
    await finDb().execute(markPosted);
  }
  return true;
}

/**
 * Fill in what a later look at the balance transaction tells us: the fee
 * (any settlement currency), and for an estimated USD settlement the real CAD
 * figure when Stripe settled in CAD (trued up against FX gain/loss if the
 * estimate was already posted). Returns true when the payment is complete:
 * income entry posted and fee in the books. No balance transaction yet ->
 * false, still pending, not an error.
 */
async function completeSettlement(paymentId: string, bt: BalanceTxnFacts | null): Promise<boolean> {
  const p = await loadPayment(paymentId);
  if (!p) return false;
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
  const feeDone = bt ? await postFee(p.id, bt) : false;
  if (!feeDone) return false;
  const after = await loadPayment(p.id);
  return after !== null && after.entry_id !== null;
}

/**
 * Match a recorded payment to a fin invoice (idempotent). If the payment was
 * already booked as revenue, a reclass moves it onto the invoice's AR instead
 * of recognising the revenue a second time. `facts`: ledger statements
 * committed in the same batch as the link; true = linked (and they were
 * written), false = nothing was written (and neither were they).
 */
export async function linkPaymentToInvoice(
  paymentId: string,
  invoiceId: string,
  facts: InStatement[] = [],
  expectedPriceId: string | null = null,
): Promise<boolean> {
  const p = await loadPayment(paymentId);
  if (!p || p.kind !== "payment" || p.invoice_id) return false;
  const inv = await linkableInvoice(invoiceId, p.currency, p.amount_cents, expectedPriceId);
  if (!inv) return false;
  const snapshot = invoiceLinkSnapshot(inv);
  const linkedGate = {
    sql: `(SELECT invoice_id FROM fin_payments WHERE id = ?) = ?`,
    args: [p.id, inv.id],
  };
  const statements: InStatement[] = [
    {
      sql: `UPDATE fin_payments SET invoice_id = ?, contact_id = COALESCE(contact_id, ?)
             WHERE id = ? AND invoice_id IS NULL AND entry_id IS ? AND (${snapshot.sql})`,
      args: [inv.id, inv.contact_id, p.id, p.entry_id, ...snapshot.args],
    },
  ];
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
      gate: linkedGate,
    });
    statements.push(...posting.statements);
  }
  // A refund that arrived before Stripe supplied invoice metadata was booked
  // as contra-revenue. Linking the gross payment must move those refunds onto
  // AR in the same transaction, otherwise the invoice row reopens while the
  // balance sheet still says the customer owes nothing.
  statements.push(...(await refundReclassStatementsForLink(p, inv, linkedGate)));
  statements.push(
    recomputeInvoicePaidStatement(inv.id, p.occurred_at, linkedGate),
    {
      sql: `INSERT INTO fin_audit_log (id, entity_id, actor, action, object_type, object_id, detail_json)
            SELECT ?, ?, ?, 'stripe.payment_linked', 'invoice', ?, ? WHERE ${linkedGate.sql}`,
      args: [newId("aud"), E, ACTOR, inv.id, JSON.stringify({ payment: p.id }), ...linkedGate.args],
    },
    ...facts,
  );
  try {
    const out = await (facts.length > 0 ? writeWithLedger(statements) : writeBatch(statements));
    if (out[0]?.rowsAffected !== 1) return false;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
  // If a concurrent postPaymentEntries lost its gate to this link, nothing
  // posted the income; post the settlement now (a no-op when already posted).
  await postPaymentEntries(p.id);
  // Close the refund/link interleaving where a refund committed immediately
  // after the transaction above took its snapshot.
  await reconcileRefundAccounting(p.id);
  await deactivatePaymentLinkIfPaid(inv.id, true);
  return true;
}

export async function deactivatePaymentLinkIfPaid(invoiceId: string, force = false): Promise<void> {
  const inv = await loadInvoice(invoiceId);
  if (!inv || (!inv.stripe_payment_link_id && !inv.stripe_price_id && !inv.stripe_payment_link_url)) return;
  if (inv.status !== "paid" && !force) return;
  await retireOneTimePaymentLink(inv, STRIPE_PAYMENT_LINK_RETIRE_FAILED);
  const cleared = await finDb().execute(clearOneTimePaymentLinkStatement(inv));
  if (cleared.rowsAffected !== 1) {
    console.error("[finances:stripe] invoice changed while its paid link fields were being cleared", invoiceId);
    throw new FinanceInputError(STRIPE_PAYMENT_LINK_RETIRE_FAILED);
  }
}

// ── refunds ──────────────────────────────────────────────────────────────

/**
 * Record a charge's refunds. Each refund row's insert is capped by SQL so the
 * refunds recorded for a charge can never exceed what Stripe says was
 * refunded, however many events or reconciles report them.
 *
 * When the individual refunds are unknown (payload without refunds.data and
 * no verified key to list them), a single "delta" row is recorded ONLY if the
 * caller supplies `deltaAt` — the charge.refunded event's own timestamp, so
 * the refund lands on the day it happened. Other callers (a charge.succeeded
 * that happens to show amount_refunded, a reconcile that lists refunds
 * separately) must not synthesise one: dated "now", it would move the refund
 * to the wrong day, and it would crowd out the real refund rows by the cap.
 */
export async function recordRefundsForCharge(
  parentPaymentId: string,
  charge: ChargeInput,
  refunds: RefundFacts[] | null,
  opts: { fetchFees: boolean; deltaAt?: number | null },
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
  const tenant = await stripeLedgerTenant();
  if (list) {
    for (const r of list) {
      if (r.status === "failed" || r.status === "canceled") continue;
      if (await insertRefund(parent, { refundId: r.refundId, amountCents: r.amountCents, created: r.created, bt: r.balanceTxn }, cap, tenant)) inserted += 1;
    }
  } else if (opts.deltaAt) {
    const recorded = await refundedSoFar(parent.id);
    const delta = cap - recorded;
    if (delta > 0 && (await insertRefund(parent, { refundId: null, amountCents: delta, created: opts.deltaAt, bt: null }, cap, tenant))) inserted += 1;
  } else if (cap > (await refundedSoFar(parent.id))) {
    console.warn("[finances:stripe] refund amount known but refunds not itemised; left for the charge.refunded event or a reconcile", charge.chargeId);
  }
  // Repair an older delivery that committed the immutable refund fact but
  // failed before its journal entry, and close refund/metadata-link races.
  await reconcileRefundAccounting(parent.id);
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
  tenant: LedgerTenant,
): Promise<boolean> {
  if (r.amountCents <= 0) return false;
  let cad: number | null = null;
  if (r.bt && r.bt.currency === "CAD") cad = Math.abs(r.bt.amountCents);
  else if (parent.settlement_cad_cents !== null && parent.amount_cents > 0) {
    cad = Number(divRoundHalfAwayFromZero(BigInt(parent.settlement_cad_cents) * BigInt(r.amountCents), BigInt(parent.amount_cents)));
  } else if (parent.currency === "CAD") cad = r.amountCents;
  const id = newId("ref");
  const occurredOn = torontoDateOfEpochSeconds(r.created);
  // A refund Stripe itemised is keyed by its re_ id; one known only as an
  // amount (the charge.refunded delta) by the row that records it.
  const providerRefundId = r.refundId || id;
  const refundRow: RefundJournalRow = {
    id,
    entity_id: parent.entity_id,
    occurred_on: occurredOn,
    amount_cents: r.amountCents,
    settlement_cad_cents: cad,
    parent_payment_id: parent.id,
    contact_id: parent.contact_id,
    customer_name: parent.customer_name,
    stripe_refund_id: r.refundId,
    deposit_account_id: parent.deposit_account_id,
    income_account_id: accountId(E, SYS.refunds),
    entry_id: null,
  };
  const customerRecord = await customerRecordFor(tenant, parent.stripe_customer_id);
  const insert: InStatement = {
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
  };
  const statements: InStatement[] = [
    insert,
    ledgerStatement(
      tenant,
      {
        eventKey: "refund.issued",
        occurredAt: new Date(r.created * 1000),
        subject: { type: "refund", id },
        sourceRef: providerRefundId,
        idempotencyKey: `stripe:${providerRefundId}`,
        valueCents: r.amountCents,
        currency: parent.currency,
        customerId: customerRecord,
        payload: {
          provider_refund_id: providerRefundId,
          ...(parent.stripe_charge_id || parent.stripe_payment_intent_id ? { provider_payment_id: parent.stripe_charge_id || parent.stripe_payment_intent_id } : {}),
        },
      },
      { ifChanged: true },
    ),
  ];
  if (parent.invoice_id) {
    statements.push(
      recomputeInvoicePaidStatement(parent.invoice_id, new Date(r.created * 1000).toISOString(), {
        // Recompute on a first delivery and harmlessly repair stale lifecycle
        // truth on a replay. The parent relationship is authoritative, so a
        // refund can never alter an unrelated invoice even if a copied
        // refund.invoice_id were malformed.
        sql: `EXISTS (
                SELECT 1
                  FROM fin_payments refund
                  JOIN fin_payments payment ON payment.id = refund.parent_payment_id
                 WHERE refund.kind = 'refund'
                   AND refund.parent_payment_id = ?
                   AND payment.kind = 'payment'
                   AND payment.invoice_id = ?
              )`,
        args: [parent.id, parent.invoice_id],
      }),
    );
  }
  // The refund row, event, invoice lifecycle and journal land in one write
  // transaction. A replay still runs reconcileRefundAccounting below so rows
  // created by older code with a missing entry can heal.
  const posting = await buildRefundPosting(parent, refundRow);
  if (posting) {
    statements.push(
      ...posting.statements,
      {
        sql: `UPDATE fin_payments SET entry_id = ?
               WHERE id = ? AND entry_id IS NULL
                 AND EXISTS (SELECT 1 FROM fin_journal_entries WHERE id = ?)`,
        args: [posting.entryId, id, posting.entryId],
      },
    );
  }
  const [rs] = await writeWithLedger(statements);
  if (rs.rowsAffected !== 1) return false;
  return true;
}

type RefundJournalRow = Pick<
  PaymentRow,
  | "id"
  | "entity_id"
  | "occurred_on"
  | "amount_cents"
  | "settlement_cad_cents"
  | "parent_payment_id"
  | "contact_id"
  | "customer_name"
  | "stripe_refund_id"
  | "deposit_account_id"
  | "income_account_id"
  | "entry_id"
>;

function refundJournalGate(parent: PaymentRow, refund: RefundJournalRow) {
  return {
    sql: `EXISTS (
            SELECT 1
              FROM fin_payments refund
              JOIN fin_payments payment ON payment.id = refund.parent_payment_id
             WHERE refund.id = ?
               AND refund.kind = 'refund'
               AND refund.entry_id IS NULL
               AND refund.parent_payment_id = ?
               AND payment.kind = 'payment'
               AND payment.invoice_id IS ?
          )`,
    args: [refund.id, parent.id, parent.invoice_id],
  };
}

/** Build the journal shape that agrees with the parent's invoice link. */
async function buildRefundPosting(parent: PaymentRow, refund: RefundJournalRow) {
  if (refund.settlement_cad_cents === null) return null;
  const memo = `Stripe refund${refund.customer_name ? ` — ${refund.customer_name}` : ""}`;
  const sourceRef = refund.stripe_refund_id || refund.id;
  const gate = refundJournalGate(parent, refund);
  if (parent.invoice_id) {
    const inv = await loadInvoice(parent.invoice_id);
    if (!inv) throw new Error(`invoice ${parent.invoice_id} linked to payment ${parent.id} does not exist`);
    return buildSettlementReversalPosting({
      inv,
      amountCents: refund.amount_cents,
      refundedCadCents: refund.settlement_cad_cents,
      creditAccountId: refund.deposit_account_id || accountId(E, SYS.stripeClearing),
      date: refund.occurred_on,
      source: "stripe_refund",
      sourceRef,
      memo: `Refund reopened invoice ${inv.number || inv.id}`,
      createdBy: ACTOR,
      gate,
    });
  }
  return buildPosting({
    entityId: refund.entity_id,
    entryDate: refund.occurred_on,
    memo,
    source: "stripe_refund",
    sourceRef,
    createdBy: ACTOR,
    gate,
    lines: [
      {
        accountId: refund.income_account_id || accountId(E, SYS.refunds),
        currency: "CAD",
        debitCents: refund.settlement_cad_cents,
        contactId: refund.contact_id,
      },
      {
        accountId: refund.deposit_account_id || accountId(E, SYS.stripeClearing),
        currency: "CAD",
        creditCents: refund.settlement_cad_cents,
        contactId: refund.contact_id,
      },
    ],
  });
}

async function refundEntryRestoresAr(entryId: string, inv: InvoiceRow): Promise<boolean> {
  const row = await queryOne<{ present: number }>(
    `SELECT 1 AS present
       FROM fin_journal_lines
      WHERE entry_id = ? AND account_id = ? AND debit_cents > 0
      LIMIT 1`,
    [entryId, accountId(inv.entity_id, SYS.ar)],
  );
  return row !== null;
}

/**
 * An unlinked refund starts as Dr Refunds / Cr clearing. Once its parent is
 * linked to an invoice, Dr AR / Cr Refunds removes the contra-revenue leg and
 * makes the pair the same settlement reversal as a linked-first refund.
 */
async function buildRefundInvoiceReclass(
  parent: PaymentRow,
  refund: RefundJournalRow,
  inv: InvoiceRow,
  gate?: { sql: string; args: Array<string | number | null> },
) {
  if (refund.settlement_cad_cents === null || !refund.entry_id) return null;
  const currentGate = gate ?? {
    sql: `EXISTS (
            SELECT 1 FROM fin_payments payment
             WHERE payment.id = ? AND payment.kind = 'payment' AND payment.invoice_id = ?
          ) AND (SELECT entry_id FROM fin_payments WHERE id = ?) = ?`,
    args: [parent.id, inv.id, refund.id, refund.entry_id],
  };
  return buildSettlementReversalPosting({
    inv,
    amountCents: refund.amount_cents,
    refundedCadCents: refund.settlement_cad_cents,
    creditAccountId: refund.income_account_id || accountId(E, SYS.refunds),
    date: refund.occurred_on,
    source: "stripe_refund_invoice_link",
    sourceRef: refund.stripe_refund_id || refund.id,
    memo: `Reclass refund to invoice ${inv.number || inv.id}`,
    createdBy: ACTOR,
    gate: currentGate,
  });
}

/** Existing refund reclasses ride atomically with a newly linked payment. */
async function refundReclassStatementsForLink(
  parent: PaymentRow,
  inv: InvoiceRow,
  linkedGate: { sql: string; args: Array<string | number | null> },
): Promise<InStatement[]> {
  const refunds = await query<PaymentRow>(
    `SELECT * FROM fin_payments
      WHERE kind = 'refund' AND parent_payment_id = ? AND entry_id IS NOT NULL
      ORDER BY occurred_at, id`,
    [parent.id],
  );
  const statements: InStatement[] = [];
  for (const refund of refunds) {
    if (await refundEntryRestoresAr(refund.entry_id as string, inv)) continue;
    const posting = await buildRefundInvoiceReclass(parent, refund, inv, linkedGate);
    if (posting) statements.push(...posting.statements);
  }
  return statements;
}

async function postRefundEntry(refundRowId: string): Promise<void> {
  const refund = await loadPayment(refundRowId);
  if (!refund || refund.kind !== "refund" || refund.entry_id || refund.settlement_cad_cents === null || !refund.parent_payment_id) return;
  const parent = await loadPayment(refund.parent_payment_id);
  if (!parent || parent.kind !== "payment") return;
  const posting = await buildRefundPosting(parent, refund);
  if (!posting) return;
  try {
    await writeBatch([
      ...posting.statements,
      {
        sql: `UPDATE fin_payments SET entry_id = ?
               WHERE id = ? AND entry_id IS NULL
                 AND EXISTS (SELECT 1 FROM fin_journal_entries WHERE id = ?)`,
        args: [posting.entryId, refund.id, posting.entryId],
      },
    ]);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const sourceRef = refund.stripe_refund_id || refund.id;
    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM fin_journal_entries WHERE entity_id = ? AND source = 'stripe_refund' AND source_ref = ?`,
      [refund.entity_id, sourceRef],
    );
    if (existing) {
      await finDb().execute({
        sql: `UPDATE fin_payments SET entry_id = ? WHERE id = ? AND entry_id IS NULL`,
        args: [existing.id, refund.id],
      });
    }
  }
}

/**
 * Make refund rows, invoice lifecycle and the double-entry books converge
 * after retries and after either ordering of refund vs invoice metadata link.
 */
async function reconcileRefundAccounting(parentPaymentId: string): Promise<void> {
  const firstParent = await loadPayment(parentPaymentId);
  if (!firstParent || firstParent.kind !== "payment") return;
  let refunds = await query<PaymentRow>(
    `SELECT * FROM fin_payments WHERE kind = 'refund' AND parent_payment_id = ? ORDER BY occurred_at, id`,
    [firstParent.id],
  );
  for (const refund of refunds) if (!refund.entry_id) await postRefundEntry(refund.id);

  const parent = await loadPayment(firstParent.id);
  if (!parent || parent.kind !== "payment") return;
  refunds = await query<PaymentRow>(
    `SELECT * FROM fin_payments WHERE kind = 'refund' AND parent_payment_id = ? ORDER BY occurred_at, id`,
    [parent.id],
  );
  if (!parent.invoice_id || refunds.length === 0) return;
  const inv = await loadInvoice(parent.invoice_id);
  if (!inv) throw new Error(`invoice ${parent.invoice_id} linked to payment ${parent.id} does not exist`);

  for (const refund of refunds) {
    if (!refund.entry_id || (await refundEntryRestoresAr(refund.entry_id, inv))) continue;
    const posting = await buildRefundInvoiceReclass(parent, refund, inv);
    if (!posting) continue;
    try {
      await writeBatch(posting.statements);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  const newest = refunds[refunds.length - 1]?.occurred_at || parent.occurred_at;
  await finDb().execute(recomputeInvoicePaidStatement(inv.id, newest));
}

// ── Stripe invoices & subscriptions ─────────────────────────────────────

/**
 * `ledger`: the event's own facts (invoice.paid, subscription.renewed),
 * committed in the SAME batch as the write that records this invoice's
 * payment: the new payment row, the link to a fin invoice, or the key fill on
 * a payment already recorded. So a failed ledger insert leaves the invoice as
 * unpaid in the books as before, and Stripe's retry lands both. Never written
 * for an invoice this returns "ignored" for.
 */
export async function applyStripeInvoicePaid(facts: InvoicePaidFacts, ledger: InStatement[] = []): Promise<string> {
  if (!facts.livemode) return "test_mode";
  if (facts.amountPaidCents <= 0) return "zero_amount";
  const existing = await findPaymentByKeys({ chargeId: facts.chargeId, paymentIntentId: facts.paymentIntentId, stripeInvoiceId: facts.stripeInvoiceId });
  if (existing) {
    await recordOnExistingPayment(existing, { chargeId: facts.chargeId, paymentIntentId: facts.paymentIntentId, stripeInvoiceId: facts.stripeInvoiceId }, facts.metadata, ledger);
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
      subscriptionInvoice: facts.forSubscription,
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
  // This invoice is what the charge paid, so it decides subscription vs one-off.
  charge.subscriptionInvoice = facts.forSubscription;
  charge.metadata = mergedFinMetadata(charge.metadata, facts.metadata);
  const res = await recordStripeCharge(charge, { fetchFees: true, ledger });
  return res.created ? "recorded" : "linked_existing";
}

/**
 * `ledger`: the subscription event's ledger statement, committed with the
 * upsert (a webhook event; a reconcile has no event and passes none, nor does
 * an update that changed nothing the subscription bills). It is
 * not conditional: an older event that no longer moves the row is still a
 * fact that happened.
 */
export async function upsertSubscription(facts: SubscriptionFacts, sourceCreated: number, ledger?: InStatement): Promise<void> {
  const monthly = subscriptionMonthlyCents(facts.items);
  const upsert: InStatement = {
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
  };
  if (ledger) await writeWithLedger([upsert, ledger]);
  else await finDb().execute(upsert);
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

/**
 * Mark the event done. `ledger`: the event-level facts that record no row of
 * their own (payment.failed), committed with the mark, so an event whose
 * ledger row fails stays unprocessed and Stripe retries it.
 */
async function finishEvent(id: string, status: "processed" | "ignored" | "failed", error: string | null, ledger: InStatement[] = []): Promise<void> {
  const mark: InStatement = {
    sql: `UPDATE fin_stripe_events SET status = ?, error = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE event_id = ?`,
    args: [status, error ? error.slice(0, 1000) : null, id],
  };
  if (ledger.length > 0) await writeWithLedger([mark, ...ledger]);
  else await finDb().execute(mark);
}

/**
 * Every event type the handler acts on. The Stripe webhook endpoint must be
 * subscribed to each; one it is not subscribed to never arrives, and only the
 * daily reconcile catches up (payouts, refunds, payments; never a failure).
 */
export const HANDLED_EVENT_TYPES = [
  "payment_intent.succeeded",
  "charge.succeeded",
  "charge.failed",
  "charge.refunded",
  "invoice.paid",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "payout.paid",
  "payout.failed",
  "payout.canceled",
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
    // Another company's Stripe account never writes to the OASIS book (stripeEventOrigin).
    const origin = await stripeEventOrigin(env);
    if (!origin.ok) {
      console.error("[finances:stripe] event refused: not from the pinned Stripe account", env.id, env.type, origin.reason);
      await finishEvent(env.id, "ignored", `foreign_stripe_account:${origin.reason}`, [foreignEventDeadLetter(env, origin)]);
      return { status: "ignored", detail: `ignored: ${origin.reason} — never enters the OASIS books` };
    }
    const ledger: InStatement[] = [];
    const detail = await dispatch(env, ledger);
    const ignored = detail.startsWith("ignored");
    await finishEvent(env.id, ignored ? "ignored" : "processed", ignored ? detail : null, ledger);
    return { status: ignored ? "ignored" : "processed", detail };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishEvent(env.id, "failed", msg).catch(() => undefined);
    throw e;
  }
}

/** A subscription's billing interval as the ledger's code, when it has exactly one. */
function subscriptionInterval(f: SubscriptionFacts): "day" | "week" | "month" | "year" | undefined {
  const intervals = new Set(f.items.map((i) => i.interval));
  return intervals.size === 1 ? [...intervals][0] : undefined;
}

/**
 * `ledger` collects the event-level facts that write no row (payment.failed);
 * handleStripeEvent commits them with the processed mark. Facts that belong
 * to a write (a payment, a refund, a subscription, an invoice's payment) are
 * emitted with that write instead.
 */
async function dispatch(env: StripeEventEnvelope, ledger: InStatement[]): Promise<string> {
  switch (env.type) {
    case "charge.failed": {
      const c = chargeFacts(env.object);
      if (!c) throw new Error("charge.failed without a readable charge");
      if (!c.livemode) return "ignored: test_mode";
      // Nothing enters the books: a failed charge moved no money. It is a fact the ledger keeps.
      const failureCode = stripeCode(env.object.failure_code);
      ledger.push(
        ledgerStatement(
          await stripeLedgerTenant(),
          {
            eventKey: "payment.failed",
            occurredAt: new Date(c.created * 1000),
            subject: { type: "payment", id: c.chargeId },
            sourceRef: env.id,
            idempotencyKey: `stripe:${c.chargeId}:failed`,
            valueCents: c.amountCents,
            currency: c.currency,
            payload: { provider_payment_id: c.chargeId, ...(failureCode ? { failure_code: failureCode } : {}) },
          },
          { ifChanged: false },
        ),
      );
      return `payment failure recorded ${c.chargeId}`;
    }
    case "payout.paid":
    case "payout.failed":
    case "payout.canceled": {
      let f = payoutFacts(env.object);
      if (!f) throw new Error(`${env.type} without a readable payout`);
      // The event carries the balance transaction as a bare id; what the
      // payout took from the Stripe balance (and its current status) needs
      // the payout itself. When Stripe cannot say (a 4xx reading it) it is
      // recorded from the event, held, and the next reconcile (which lists
      // payouts expanded) completes it.
      const key = await readyKey();
      if (key) {
        const u = new URLSearchParams();
        u.append("expand[]", "balance_transaction");
        try {
          const fresh = payoutFacts(await stripeRequest(key, "GET", `/v1/payouts/${encodeURIComponent(f.payoutId)}`, u));
          if (fresh) f = fresh;
        } catch (e) {
          if (!(e instanceof StripeApiError && e.status >= 400 && e.status < 500 && e.status !== 429)) throw e;
          console.error("[finances:stripe] could not read payout", f.payoutId, e.message);
        }
      }
      const out = await recordStripePayout(f, { reportedOn: torontoDateOfEpochSeconds(env.created) });
      return out ? `payout ${f.payoutId} ${out.booking}` : `ignored: payout ${f.payoutId} is ${f.status}`;
    }
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
          subscriptionInvoice: null,
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
      charge.metadata = mergedFinMetadata(charge.metadata, pi.metadata);
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
      const n = await recordRefundsForCharge(parent.id, c, c.refunds, { fetchFees: true, deltaAt: env.created });
      return `refunds recorded: ${n}`;
    }
    case "invoice.paid": {
      const f = invoicePaidFacts(env.object);
      if (!f) throw new Error("invoice.paid without a readable invoice");
      const tenant = await stripeLedgerTenant();
      const paidAt = new Date(f.paidAt * 1000);
      // Committed by applyStripeInvoicePaid in the batch that records the
      // payment, never after it (so not with the processed mark).
      const facts: InStatement[] = [];
      facts.push(
        ledgerStatement(
          tenant,
          {
            eventKey: "invoice.paid",
            occurredAt: paidAt,
            subject: { type: "invoice", id: f.stripeInvoiceId },
            sourceRef: env.id,
            idempotencyKey: `inv:${f.stripeInvoiceId}:paid`,
            valueCents: f.amountPaidCents,
            currency: f.currency,
            payload: { invoice_id: f.stripeInvoiceId, source_system: "stripe" },
          },
          { ifChanged: false },
        ),
      );
      // A subscription's own cycle invoice paid is the renewal.
      if (f.subscriptionId && f.billingReason === "subscription_cycle") {
        facts.push(
          ledgerStatement(
            tenant,
            {
              eventKey: "subscription.renewed",
              occurredAt: paidAt,
              subject: { type: "subscription", id: f.subscriptionId },
              sourceRef: env.id,
              idempotencyKey: `stripe:${env.id}`,
              valueCents: f.amountPaidCents,
              currency: f.currency,
              payload: { provider_subscription_id: f.subscriptionId },
            },
            { ifChanged: false },
          ),
        );
      }
      const out = await applyStripeInvoicePaid(f, facts);
      if (out === "no_charge_on_invoice" || out === "zero_amount" || out === "test_mode") return `ignored: ${out}`;
      return out;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const f = subscriptionFacts(env.object);
      if (!f) throw new Error(`${env.type} without a readable subscription`);
      if (env.type === "customer.subscription.deleted" && f.status !== "canceled") f.status = "canceled";
      const monthly = subscriptionMonthlyCents(f.items);
      const base = { occurredAt: new Date(env.created * 1000), subject: { type: "subscription", id: f.id }, sourceRef: env.id, idempotencyKey: `stripe:${env.id}` };
      const interval = subscriptionInterval(f);
      const cancelReason = stripeCode(asObj(env.object.cancellation_details)?.reason);
      // An update is a subscription.changed only when it changed what the
      // subscription bills; a renewal, a status or payment-method change is not.
      const change = env.type === "customer.subscription.updated" ? subscriptionPlanChange(env.object, env.previousAttributes) : null;
      const fact: StripeFact | null =
        env.type === "customer.subscription.created"
          ? { ...base, eventKey: "subscription.started", valueCents: monthly, currency: f.currency, payload: { provider_subscription_id: f.id, ...(interval ? { interval } : {}) } }
          : env.type === "customer.subscription.updated"
            ? change && {
                ...base,
                eventKey: "subscription.changed",
                valueCents: monthly,
                currency: f.currency,
                payload: {
                  provider_subscription_id: f.id,
                  ...(change.fromPlanCode ? { from_plan_code: change.fromPlanCode } : {}),
                  ...(change.planCode ? { plan_code: change.planCode } : {}),
                },
              }
            : { ...base, eventKey: "subscription.cancelled", payload: { provider_subscription_id: f.id, ...(cancelReason ? { cancel_reason: cancelReason } : {}) } };
      await upsertSubscription(f, env.created, fact ? ledgerStatement(await stripeLedgerTenant(), fact, { ifChanged: false }) : undefined);
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
  payouts_seen: number;
  payouts_booked: number;
  /** Paid payouts still held or unmapped after this run (the cash tile lists them). */
  payouts_unbooked: number;
  truncated: boolean;
};

/** How far back every reconcile looks for payouts, whatever its `days` (the most the reconcile itself accepts). */
const PAYOUT_LOOKBACK_DAYS = 400;

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
    payouts_seen: 0,
    payouts_booked: 0,
    payouts_unbooked: 0,
    truncated: false,
  };

  const charges = await listAll(key, "/v1/charges", { "created[gte]": since }, { expand: ["data.balance_transaction", "data.payment_intent"] });
  summary.truncated ||= charges.truncated;
  for (const raw of charges.items) {
    const c = chargeFacts(raw);
    if (!c || !c.succeeded || !c.livemode) continue;
    summary.charges_seen += 1;
    c.metadata = mergedFinMetadata(c.metadata, finMetadata(raw.payment_intent));
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

  // Payouts last, once the charges, refunds and fees they pay out are in
  // clearing. The window is never shorter than PAYOUT_LOOKBACK_DAYS: a payout
  // missed by the webhook (or paid before payouts were booked at all) is
  // still found by a routine 7-day run, and one already booked costs one read.
  const payoutSince = Math.floor(Date.now() / 1000) - Math.max(days, PAYOUT_LOOKBACK_DAYS) * 86_400;
  const payouts = await listAll(key, "/v1/payouts", { "arrival_date[gte]": payoutSince }, { maxPages: 10, expand: ["data.balance_transaction"] });
  summary.truncated ||= payouts.truncated;
  // Oldest first: each booking uses what clearing holds at that point.
  const facts = payouts.items.map(payoutFacts).filter((p): p is NonNullable<typeof p> => p !== null && p.livemode);
  facts.sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate) || a.payoutId.localeCompare(b.payoutId));
  for (const f of facts) {
    summary.payouts_seen += 1;
    const before = await queryOne<{ booking: string }>(`SELECT booking FROM fin_stripe_payouts WHERE id = ?`, [f.payoutId]);
    const out = await recordStripePayout(f);
    if (out?.booking === "booked" && before?.booking !== "booked") summary.payouts_booked += 1;
  }
  // Payouts held or unmapped earlier (no rate yet, no account chosen) that this run did not list.
  summary.payouts_booked += await retryUnbookedPayouts();
  summary.payouts_unbooked = (await unbookedPayouts()).length;

  // "Last synced" on Today and in Settings reads this row.
  await writeBatch([auditStatement({ entityId: E, actor: ACTOR, action: STRIPE_RECONCILED_ACTION, objectType: "stripe", objectId: null, detail: summary })]);
  return summary;
}

/** The audit action a completed reconcile writes (lastStripeSync reads it). */
export const STRIPE_RECONCILED_ACTION = "stripe.reconciled";

/**
 * When a webhook event last REACHED the books: the newest live event that was
 * processed. Not received_at: every delivery is claimed (and a failed one
 * re-claimed, received_at reset) before the test-mode and type checks, so a
 * test-mode event, an unhandled type or an event failing on every retry would
 * each read as a sync while nothing reached the books.
 */
export const LAST_SYNCED_EVENT_SQL = `SELECT MAX(processed_at) FROM fin_stripe_events WHERE livemode = 1 AND status = 'processed'`;

/**
 * When the books last heard from Stripe: the newest live webhook event that
 * was processed, or the newest completed reconcile, whichever is later.
 * Null = never.
 */
export async function lastStripeSync(): Promise<string | null> {
  const row = await queryOne<{ event_at: string | null; reconcile_at: string | null }>(
    `SELECT (${LAST_SYNCED_EVENT_SQL}) AS event_at,
            (SELECT MAX(created_at) FROM fin_audit_log WHERE entity_id = ? AND action = ?) AS reconcile_at`,
    [E, STRIPE_RECONCILED_ACTION],
  );
  const times = [row?.event_at, row?.reconcile_at].filter((t): t is string => typeof t === "string" && t.length > 0);
  return times.length ? times.sort()[times.length - 1] : null;
}

/**
 * Complete payments recorded without a fee or without a CAD settlement.
 * Card charges (ch_) and non-card payments (py_: Link, pre-authorized debit)
 * are both Charges that GET /v1/charges/{id} returns with their balance
 * transaction. Returns how many became complete; one whose balance
 * transaction is not available yet stays pending and is not counted.
 */
export async function syncPendingStripe(key?: string): Promise<number> {
  const k = key ?? (await readyKey());
  if (!k) return 0;
  const pending = await query<{ id: string; stripe_charge_id: string | null; occurred_on: string }>(
    `SELECT id, stripe_charge_id, occurred_on FROM fin_payments
      WHERE kind = 'payment' AND source = 'stripe' AND (fee_status = 'pending' OR entry_id IS NULL)
      ORDER BY occurred_on LIMIT 100`,
  );
  if (pending.length > 0) {
    // A non-CAD fee needs its day's rate. Fetch any missing days from the Bank
    // of Canada in ONE request up front rather than one per payment.
    const days = [...new Set(pending.map((p) => p.occurred_on))].sort();
    await rateLookupFor(days[0], addDays(days[days.length - 1], 1), { ensureDays: days });
  }
  let done = 0;
  for (const p of pending) {
    if (!p.stripe_charge_id || !/^(ch|py)_/.test(p.stripe_charge_id)) continue;
    try {
      const c = await fetchChargeExpanded(k, p.stripe_charge_id);
      if (!c) continue;
      if (await completeSettlement(p.id, c.balanceTxn)) done += 1;
    } catch (e) {
      console.error("[finances:stripe] pending sync failed", p.id, e instanceof Error ? e.message : e);
    }
  }
  return done;
}
