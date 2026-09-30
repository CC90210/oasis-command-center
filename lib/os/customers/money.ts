/**
 * lib/os/customers/money.ts — a client's money, read from OASIS's books.
 *
 * READ-ONLY, and only OASIS's business book (fin_entities 'fin_ent_oasis',
 * lib/founders-finances/chart.ts BUSINESS_ENTITY_ID). The books belong to
 * OASIS, so only OASIS's own client records have a Money tab; the page decides
 * that, and the founders' finance gate decides who reads it.
 *
 * HOW A CLIENT IS FOUND IN THE BOOKS (never guessed from a name):
 *   payments       fin_payments whose Stripe customer is the record's
 *                  stripe_customer_id, whose customer email is the record's
 *                  primary_email, or that pay an invoice of the client's
 *                  fin_contacts. A refund inherits its payment's customer.
 *   subscriptions  fin_subscriptions by stripe_customer_id or customer_email.
 *   invoices       fin_invoices of fin_contacts matched by stripe_customer_id
 *                  or email.
 *
 * MONEY STAYS INTEGER CENTS, PER CURRENCY. Nothing here converts currencies,
 * so every total is the exact sum of fin_payments rows (payments minus
 * refunds, live mode only, the rows the Finances pages count) and reconciles
 * to them to the cent.
 */
import type { Client, ResultSet } from "@libsql/client";
import { BUSINESS_ENTITY_ID } from "@/lib/founders-finances/chart";
import { MRR_STATUSES } from "@/lib/founders-finances/mrr";

type Row = Record<string, unknown>;

function rows(rs: ResultSet): Row[] {
  return rs.rows.map((r) => {
    const o: Row = {};
    rs.columns.forEach((c, i) => {
      const v = (r as unknown as unknown[])[i];
      o[c] = typeof v === "bigint" ? Number(v) : v;
    });
    return o;
  });
}

const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export type MoneyCustomer = {
  stripe_customer_id: string | null;
  primary_email: string | null;
};

export type ClientInvoice = {
  id: string;
  number: string | null;
  status: string;
  issue_date: string;
  due_date: string;
  currency: string;
  total_cents: number;
  amount_paid_cents: number;
  /** Past due and not paid or void, as of `today`. */
  overdue: boolean;
  payment_link: string | null;
};

export type ClientSubscription = {
  status: string;
  currency: string;
  monthly_cents: number;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

export type ClientMoney = {
  /** How the client was matched, for the page to say ("by Stripe customer and email"). */
  matchedBy: Array<"stripe_customer" | "email">;
  /** Payments minus refunds, per currency, live mode, all time. */
  collected: Array<{ currency: string; cents: number }>;
  paymentCount: number;
  refundCount: number;
  lastPaymentAt: string | null;
  /** Monthly recurring revenue from active / trialing / past_due subscriptions, per currency. */
  mrr: Array<{ currency: string; cents: number }>;
  subscriptions: ClientSubscription[];
  /** The earliest renewal of a counted subscription that is not set to cancel. */
  nextRenewal: string | null;
  cancelAtPeriodEnd: boolean;
  /** Subscriptions Stripe could not charge (past_due, unpaid). */
  failedPayments: number;
  invoices: ClientInvoice[];
  overdueInvoices: number;
  /** Still owed on sent and overdue invoices, per currency. */
  outstanding: Array<{ currency: string; cents: number }>;
};

function add(map: Map<string, number>, currency: string, cents: number): void {
  const c = currency.toUpperCase();
  map.set(c, (map.get(c) ?? 0) + cents);
}

function list(map: Map<string, number>): Array<{ currency: string; cents: number }> {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, cents]) => ({ currency, cents }));
}

function unixToIso(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const secs = Number(v);
  return Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : null;
}

/**
 * Everything the Money tab shows for one client. `today` is the YYYY-MM-DD the
 * caller counts "overdue" against (America/Toronto in the app). A client with
 * no Stripe customer and no email has nothing to match: null, which the page
 * says as "not linked to the books", never as zeros.
 */
export async function loadClientMoney(db: Client, customer: MoneyCustomer, today: string): Promise<ClientMoney | null> {
  const stripe = s(customer.stripe_customer_id);
  const email = s(customer.primary_email)?.toLowerCase() ?? null;
  if (!stripe && !email) return null;
  const E = BUSINESS_ENTITY_ID;
  const matchedBy: ClientMoney["matchedBy"] = [];
  if (stripe) matchedBy.push("stripe_customer");
  if (email) matchedBy.push("email");

  // The client's contacts in the books.
  const contactWhere: string[] = [];
  const contactArgs: string[] = [];
  if (stripe) {
    contactWhere.push("stripe_customer_id = ?");
    contactArgs.push(stripe);
  }
  if (email) {
    contactWhere.push("lower(email) = ?");
    contactArgs.push(email);
  }
  const contactIds = rows(
    await db.execute({
      sql: `SELECT id FROM fin_contacts WHERE entity_id = ? AND kind IN ('customer', 'both') AND (${contactWhere.join(" OR ")})`,
      args: [E, ...contactArgs],
    }),
  ).map((r) => String(r.id));

  // Payments and refunds. One row per fin_payments row; a refund reads its
  // customer through its parent payment, as the Finances metrics do.
  const payWhere: string[] = [];
  const payArgs: string[] = [];
  if (stripe) {
    payWhere.push("COALESCE(p.stripe_customer_id, pp.stripe_customer_id) = ?");
    payArgs.push(stripe);
  }
  if (email) {
    payWhere.push("lower(COALESCE(NULLIF(p.customer_email, ''), pp.customer_email)) = ?");
    payArgs.push(email);
  }
  if (contactIds.length) {
    const marks = contactIds.map(() => "?").join(", ");
    payWhere.push(`COALESCE(i.contact_id, p.contact_id, pp.contact_id) IN (${marks})`);
    payArgs.push(...contactIds);
  }
  const payments = rows(
    await db.execute({
      sql: `SELECT p.id, p.kind, p.amount_cents, p.currency, p.occurred_at
            FROM fin_payments p
            LEFT JOIN fin_payments pp ON pp.id = p.parent_payment_id
            LEFT JOIN fin_invoices i ON i.id = COALESCE(p.invoice_id, pp.invoice_id)
            WHERE p.entity_id = ? AND p.livemode = 1 AND (${payWhere.join(" OR ")})`,
      args: [E, ...payArgs],
    }),
  );
  const collected = new Map<string, number>();
  let paymentCount = 0;
  let refundCount = 0;
  let lastPaymentAt: string | null = null;
  for (const p of payments) {
    const cents = n(p.amount_cents);
    if (p.kind === "refund") {
      add(collected, String(p.currency), -cents);
      refundCount += 1;
    } else {
      add(collected, String(p.currency), cents);
      paymentCount += 1;
      const at = s(p.occurred_at);
      if (at && (!lastPaymentAt || at > lastPaymentAt)) lastPaymentAt = at;
    }
  }

  // Subscriptions.
  const subWhere: string[] = [];
  const subArgs: string[] = [];
  if (stripe) {
    subWhere.push("stripe_customer_id = ?");
    subArgs.push(stripe);
  }
  if (email) {
    subWhere.push("lower(customer_email) = ?");
    subArgs.push(email);
  }
  const subs = rows(
    await db.execute({
      sql: `SELECT status, currency, monthly_cents, current_period_end, cancel_at_period_end
            FROM fin_subscriptions WHERE entity_id = ? AND livemode = 1 AND (${subWhere.join(" OR ")})
            ORDER BY current_period_end DESC`,
      args: [E, ...subArgs],
    }),
  );
  const mrr = new Map<string, number>();
  const subscriptions: ClientSubscription[] = [];
  let nextRenewal: string | null = null;
  let cancelAtPeriodEnd = false;
  let failedPayments = 0;
  for (const r of subs) {
    const status = String(r.status ?? "");
    const sub: ClientSubscription = {
      status,
      currency: String(r.currency ?? "").toUpperCase(),
      monthly_cents: n(r.monthly_cents),
      current_period_end: unixToIso(r.current_period_end),
      cancel_at_period_end: n(r.cancel_at_period_end) === 1,
    };
    subscriptions.push(sub);
    if (status === "past_due" || status === "unpaid") failedPayments += 1;
    if (!MRR_STATUSES.has(status)) continue;
    add(mrr, sub.currency, sub.monthly_cents);
    if (sub.cancel_at_period_end) cancelAtPeriodEnd = true;
    else if (sub.current_period_end && (!nextRenewal || sub.current_period_end < nextRenewal)) nextRenewal = sub.current_period_end;
  }

  // Invoices.
  const invoices: ClientInvoice[] = [];
  const outstanding = new Map<string, number>();
  let overdueInvoices = 0;
  if (contactIds.length) {
    const marks = contactIds.map(() => "?").join(", ");
    const inv = rows(
      await db.execute({
        sql: `SELECT id, number, status, issue_date, due_date, currency, total_cents, amount_paid_cents, stripe_payment_link_url
              FROM fin_invoices WHERE entity_id = ? AND contact_id IN (${marks})
              ORDER BY issue_date DESC, id DESC LIMIT 100`,
        args: [E, ...contactIds],
      }),
    );
    for (const r of inv) {
      const status = String(r.status ?? "");
      const due = String(r.due_date ?? "");
      const open = status === "sent" || status === "overdue";
      const overdue = status === "overdue" || (status === "sent" && due !== "" && due < today);
      if (overdue) overdueInvoices += 1;
      const total = n(r.total_cents);
      const paid = n(r.amount_paid_cents);
      if (open && total > paid) add(outstanding, String(r.currency), total - paid);
      invoices.push({
        id: String(r.id),
        number: s(r.number),
        status,
        issue_date: String(r.issue_date ?? ""),
        due_date: due,
        currency: String(r.currency ?? "").toUpperCase(),
        total_cents: total,
        amount_paid_cents: paid,
        overdue,
        payment_link: s(r.stripe_payment_link_url),
      });
    }
  }

  return {
    matchedBy,
    collected: list(collected),
    paymentCount,
    refundCount,
    lastPaymentAt,
    mrr: list(mrr),
    subscriptions,
    nextRenewal,
    cancelAtPeriodEnd,
    failedPayments,
    invoices,
    overdueInvoices,
    outstanding: list(outstanding),
  };
}
