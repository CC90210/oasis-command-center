/**
 * Stripe object -> plain facts. PURE.
 *
 * Stripe payloads differ by API version (charge.invoice was removed in
 * 2025-03-31, payment_intent.charges in 2022-11-15, invoice.charge moved into
 * invoice.payments). Every reader here accepts the shapes that exist in the
 * wild and returns null for what it cannot find — callers treat a missing id
 * as unknown, never as a match.
 */

import { normalizeCurrencyCode } from "./money";
import type { RecurringInterval, SubscriptionItemFacts } from "./mrr";

type Obj = Record<string, unknown>;

export function asObj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function int(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
}
/** An expandable field: either "ch_123" or { id: "ch_123", ... }. */
function idOf(v: unknown): string | null {
  return str(v) ?? str(asObj(v)?.id);
}

export type FinMetadata = { finInvoiceId: string | null; finEntityId: string | null };

export function finMetadata(obj: unknown): FinMetadata {
  const md = asObj(asObj(obj)?.metadata);
  return { finInvoiceId: str(md?.fin_invoice_id), finEntityId: str(md?.fin_entity_id) };
}

export type ChargeFacts = {
  chargeId: string;
  paymentIntentId: string | null;
  stripeInvoiceId: string | null;
  customerId: string | null;
  customerName: string;
  customerEmail: string;
  amountCents: number;
  amountRefundedCents: number;
  currency: string;
  created: number;
  balanceTxnId: string | null;
  balanceTxn: BalanceTxnFacts | null;
  livemode: boolean;
  succeeded: boolean;
  description: string;
  metadata: FinMetadata;
  refunds: RefundFacts[] | null;
};

export function chargeFacts(raw: unknown): ChargeFacts | null {
  const c = asObj(raw);
  const chargeId = str(c?.id);
  const amount = int(c?.amount);
  const currency = normalizeCurrencyCode(c?.currency);
  const created = int(c?.created);
  if (!c || !chargeId || (!chargeId.startsWith("ch_") && !chargeId.startsWith("py_"))) return null;
  if (amount === null || !currency || created === null) return null;
  const billing = asObj(c.billing_details);
  const customerObj = asObj(c.customer);
  const refundsList = asObj(c.refunds);
  const refundsData = Array.isArray(refundsList?.data) ? (refundsList!.data as unknown[]) : null;
  return {
    chargeId,
    paymentIntentId: idOf(c.payment_intent),
    stripeInvoiceId: idOf(c.invoice),
    customerId: idOf(c.customer),
    customerName: str(billing?.name) || str(customerObj?.name) || "",
    customerEmail: str(billing?.email) || str(c.receipt_email) || str(customerObj?.email) || "",
    amountCents: amount,
    amountRefundedCents: int(c.amount_refunded) ?? 0,
    currency,
    created,
    balanceTxnId: idOf(c.balance_transaction),
    balanceTxn: balanceTxnFacts(c.balance_transaction),
    livemode: c.livemode === true,
    succeeded: c.status === "succeeded" && c.paid !== false,
    description: str(c.description) || "",
    metadata: finMetadata(c),
    refunds: refundsData ? refundsData.map(refundFacts).filter((r): r is RefundFacts => r !== null) : null,
  };
}

export type PaymentIntentFacts = {
  paymentIntentId: string;
  latestChargeId: string | null;
  latestCharge: ChargeFacts | null;
  customerId: string | null;
  amountReceivedCents: number;
  currency: string;
  created: number;
  livemode: boolean;
  metadata: FinMetadata;
  description: string;
};

export function paymentIntentFacts(raw: unknown): PaymentIntentFacts | null {
  const pi = asObj(raw);
  const id = str(pi?.id);
  const currency = normalizeCurrencyCode(pi?.currency);
  const created = int(pi?.created);
  if (!pi || !id || !id.startsWith("pi_") || !currency || created === null) return null;
  // latest_charge (2022-11-15+) or charges.data[0] (older versions).
  let latestCharge: ChargeFacts | null = chargeFacts(pi.latest_charge);
  let latestChargeId = idOf(pi.latest_charge);
  const legacy = asObj(pi.charges);
  if (!latestChargeId && Array.isArray(legacy?.data) && legacy!.data.length > 0) {
    const last = (legacy!.data as unknown[])[0];
    latestCharge = chargeFacts(last);
    latestChargeId = idOf(last);
  }
  return {
    paymentIntentId: id,
    latestChargeId,
    latestCharge,
    customerId: idOf(pi.customer),
    amountReceivedCents: int(pi.amount_received) ?? int(pi.amount) ?? 0,
    currency,
    created,
    livemode: pi.livemode === true,
    metadata: finMetadata(pi),
    description: str(pi.description) || "",
  };
}

export type RefundFacts = {
  refundId: string;
  chargeId: string | null;
  amountCents: number;
  currency: string;
  created: number;
  balanceTxnId: string | null;
  balanceTxn: BalanceTxnFacts | null;
  status: string;
};

export function refundFacts(raw: unknown): RefundFacts | null {
  const r = asObj(raw);
  const refundId = str(r?.id);
  const amount = int(r?.amount);
  const currency = normalizeCurrencyCode(r?.currency);
  const created = int(r?.created);
  if (!r || !refundId || amount === null || !currency || created === null) return null;
  return {
    refundId,
    chargeId: idOf(r.charge),
    amountCents: amount,
    currency,
    created,
    balanceTxnId: idOf(r.balance_transaction),
    balanceTxn: balanceTxnFacts(r.balance_transaction),
    status: str(r.status) || "unknown",
  };
}

export type BalanceTxnFacts = {
  id: string;
  amountCents: number;
  feeCents: number;
  netCents: number;
  currency: string;
};

/** Only an EXPANDED balance transaction yields facts; a bare id yields null. */
export function balanceTxnFacts(raw: unknown): BalanceTxnFacts | null {
  const b = asObj(raw);
  const id = str(b?.id);
  const amount = int(b?.amount);
  const fee = int(b?.fee);
  const net = int(b?.net);
  const currency = normalizeCurrencyCode(b?.currency);
  if (!b || !id || amount === null || fee === null || net === null || !currency) return null;
  return { id, amountCents: amount, feeCents: fee, netCents: net, currency };
}

export type InvoicePaidFacts = {
  stripeInvoiceId: string;
  chargeId: string | null;
  paymentIntentId: string | null;
  customerId: string | null;
  customerName: string;
  customerEmail: string;
  amountPaidCents: number;
  currency: string;
  paidAt: number;
  livemode: boolean;
  metadata: FinMetadata;
  subscriptionId: string | null;
};

export function invoicePaidFacts(raw: unknown): InvoicePaidFacts | null {
  const inv = asObj(raw);
  const id = str(inv?.id);
  const currency = normalizeCurrencyCode(inv?.currency);
  if (!inv || !id || !id.startsWith("in_") || !currency) return null;
  const transitions = asObj(inv.status_transitions);
  const paidAt = int(transitions?.paid_at) ?? int(inv.created) ?? 0;
  // 2025-03-31+: invoice.payments.data[].payment.{payment_intent,charge}
  let chargeId = idOf(inv.charge);
  let paymentIntentId = idOf(inv.payment_intent);
  const payments = asObj(inv.payments);
  if ((!chargeId || !paymentIntentId) && Array.isArray(payments?.data)) {
    for (const p of payments!.data as unknown[]) {
      const pay = asObj(asObj(p)?.payment);
      chargeId = chargeId || idOf(pay?.charge);
      paymentIntentId = paymentIntentId || idOf(pay?.payment_intent);
    }
  }
  const parent = asObj(asObj(inv.parent)?.subscription_details);
  return {
    stripeInvoiceId: id,
    chargeId,
    paymentIntentId,
    customerId: idOf(inv.customer),
    customerName: str(inv.customer_name) || "",
    customerEmail: str(inv.customer_email) || "",
    amountPaidCents: int(inv.amount_paid) ?? 0,
    currency,
    paidAt,
    livemode: inv.livemode === true,
    metadata: finMetadata(inv),
    subscriptionId: idOf(inv.subscription) || idOf(parent?.subscription),
  };
}

export type SubscriptionFacts = {
  id: string;
  customerId: string | null;
  customerName: string;
  customerEmail: string;
  status: string;
  currency: string;
  items: SubscriptionItemFacts[];
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: number | null;
  livemode: boolean;
};

const INTERVALS: ReadonlySet<string> = new Set(["day", "week", "month", "year"]);

export function subscriptionFacts(raw: unknown): SubscriptionFacts | null {
  const s = asObj(raw);
  const id = str(s?.id);
  const status = str(s?.status);
  if (!s || !id || !id.startsWith("sub_") || !status) return null;
  const itemsList = asObj(s.items);
  const itemsData = Array.isArray(itemsList?.data) ? (itemsList!.data as unknown[]) : [];
  const items: SubscriptionItemFacts[] = [];
  let currency = normalizeCurrencyCode(s.currency);
  let periodEnd = int(s.current_period_end);
  for (const raw of itemsData) {
    const it = asObj(raw);
    const price = asObj(it?.price) || asObj(it?.plan);
    const recurring = asObj(price?.recurring);
    const interval = str(recurring?.interval) || str(price?.interval);
    const intervalCount = int(recurring?.interval_count) ?? int(price?.interval_count) ?? 1;
    const unit = int(price?.unit_amount) ?? int(price?.amount);
    currency = currency || normalizeCurrencyCode(price?.currency);
    periodEnd = periodEnd ?? int(it?.current_period_end);
    if (!interval || !INTERVALS.has(interval) || unit === null) continue;
    items.push({
      unitAmountCents: unit,
      quantity: int(it?.quantity) ?? 1,
      interval: interval as RecurringInterval,
      intervalCount,
    });
  }
  const customerObj = asObj(s.customer);
  return {
    id,
    customerId: idOf(s.customer),
    customerName: str(customerObj?.name) || "",
    customerEmail: str(customerObj?.email) || "",
    status,
    currency: currency || "CAD",
    items,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: s.cancel_at_period_end === true,
    canceledAt: int(s.canceled_at),
    livemode: s.livemode === true,
  };
}

export type StripeEventEnvelope = {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  object: Obj;
};

export function eventEnvelope(raw: unknown): StripeEventEnvelope | null {
  const e = asObj(raw);
  const id = str(e?.id);
  const type = str(e?.type);
  const created = int(e?.created);
  const object = asObj(asObj(e?.data)?.object);
  if (!e || !id || !id.startsWith("evt_") || !type || created === null || !object) return null;
  return { id, type, created, livemode: e.livemode === true, object };
}

/** Customer label for reports: never an empty string. */
export function customerLabel(parts: { contactName?: string | null; name?: string | null; email?: string | null }): string {
  return (parts.contactName || "").trim() || (parts.name || "").trim() || (parts.email || "").trim() || "Unknown customer";
}
