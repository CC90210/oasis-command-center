/**
 * tests/finances-stripe-ledger.test.ts — Stripe -> books: fees and the
 * subscription/one-off revenue split, against a REAL local libSQL database
 * with migration 180 applied.
 *
 * The fixtures copy the shapes read live from OASIS's Stripe on 2026-09-24
 * (account default API 2025-07-30.basil): CA$ charges whose balance
 * transactions are in USD (the account settles in USD), card charges (ch_)
 * and Link payments (py_), no `invoice` key on a charge, and the subscription
 * named on invoice.parent.subscription_details. api.stripe.com answers GETs
 * from those fixtures; any other host, and any Stripe write, throws.
 *
 * Run: node --conditions=react-server --import tsx tests/finances-stripe-ledger.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "finances-stripe-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
for (const k of ["STRIPE_SECRET_KEY", "FOUNDERS_TENANT_IDS", "STRIPE_FINANCE_WEBHOOK_SECRET"]) delete process.env[k];

type Json = Record<string, unknown>;
const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const stripe = {
  charges: new Map<string, Json>(),
  list: [] as string[],
  invoicePayments: new Map<string, Json[]>(),
  invoices: new Map<string, Json>(),
  paymentIntents: new Map<string, Json>(),
  failInvoicePayments: new Set<string>(),
};
/** Bank of Canada Valet: offline unless a test serves these observations. */
const valet = { serve: false, observations: [] as Array<{ d: string; FXUSDCAD: { v: string } }> };
const calls: Array<{ method: string; path: string }> = [];
globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
  const url = new URL(String(input));
  const method = (init?.method || "GET").toUpperCase();
  calls.push({ method, path: `${url.host}${url.pathname}` });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const list = (data: unknown[]) => json({ object: "list", data, has_more: false });
  if (url.host === "www.bankofcanada.ca" && valet.serve) {
    const from = url.searchParams.get("start_date") || "";
    const to = url.searchParams.get("end_date") || "";
    return json({ observations: valet.observations.filter((o) => o.d >= from && o.d <= to) });
  }
  if (url.host !== "api.stripe.com") throw new Error(`network disabled in test: ${url.host}${url.pathname}`);
  if (method !== "GET") throw new Error(`Stripe write attempted in test: ${method} ${url.pathname}`);
  const p = url.pathname;
  if (p === "/v1/account") return json({ id: "acct_test_oasis", settings: { dashboard: { display_name: "OASIS AI" } } });
  if (p === "/v1/charges") return list(stripe.list.map((id) => stripe.charges.get(id)));
  if (p.startsWith("/v1/charges/")) {
    const c = stripe.charges.get(decodeURIComponent(p.slice("/v1/charges/".length)));
    return c ? json(c) : json({ error: { message: "No such charge" } }, 404);
  }
  if (p.startsWith("/v1/payment_intents/")) {
    const pi = stripe.paymentIntents.get(decodeURIComponent(p.slice("/v1/payment_intents/".length)));
    return pi ? json(pi) : json({ error: { message: "No such payment_intent" } }, 404);
  }
  if (p === "/v1/invoice_payments") {
    assert.equal(url.searchParams.get("payment[type]"), "payment_intent");
    const pi = url.searchParams.get("payment[payment_intent]") || "";
    if (stripe.failInvoicePayments.has(pi)) return json({ error: { message: "api_error" } }, 500);
    return list(stripe.invoicePayments.get(pi) || []);
  }
  if (p.startsWith("/v1/invoices/")) {
    const inv = stripe.invoices.get(decodeURIComponent(p.slice("/v1/invoices/".length)));
    return inv ? json(inv) : json({ error: { message: "No such invoice" } }, 404);
  }
  if (p === "/v1/refunds") return list([]);
  if (p === "/v1/subscriptions") {
    return list([{ id: "sub_live", object: "subscription", status: "active", currency: "cad", livemode: true, customer: { id: "cus_live", name: "Client", email: "client@example.test" }, items: { data: [{ quantity: 1, price: { unit_amount: 10000, currency: "cad", recurring: { interval: "month", interval_count: 1 } } }] } }]);
  }
  throw new Error(`unrouted Stripe GET in test: ${p}`);
}) as typeof fetch;

/** A basil-shaped live charge: CAD amount, USD balance transaction, no `invoice` key. */
function liveCharge(p: { id: string; amount: number; at: string; pi: string; bt: { id: string; amount: number; fee: number } | null; status?: string }): Json {
  const status = p.status ?? "succeeded";
  return {
    id: p.id,
    object: "charge",
    amount: p.amount,
    amount_captured: p.amount,
    amount_refunded: 0,
    currency: "cad",
    created: epoch(p.at),
    status,
    paid: status === "succeeded",
    livemode: true,
    payment_intent: p.pi,
    customer: "cus_live",
    description: "Subscription update",
    billing_details: { name: "Client", email: "client@example.test" },
    payment_method_details: { type: p.id.startsWith("py_") ? "link" : "card" },
    balance_transaction: p.bt
      ? { id: p.bt.id, object: "balance_transaction", type: p.id.startsWith("py_") ? "payment" : "charge", amount: p.bt.amount, fee: p.bt.fee, net: p.bt.amount - p.bt.fee, currency: "usd", created: epoch(p.at), status: "available", reporting_category: "charge" }
      : null,
    metadata: {},
    refunds: { object: "list", data: [], has_more: false },
  };
}
const subscriptionInvoice = (id: string, reason = "subscription_cycle"): Json => ({
  id,
  object: "invoice",
  billing_reason: reason,
  parent: { type: "subscription_details", quote_details: null, subscription_details: { metadata: {}, subscription: "sub_live" } },
});
const oneOffInvoice = (id: string): Json => ({ id, object: "invoice", billing_reason: "manual", parent: null });
const paidBy = (invoice: Json): Json[] => [{ id: `inpay_${invoice.id}`, object: "invoice_payment", status: "paid", is_default: true, invoice }];

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 5).join("\n        ")}`);
  }
}

const cc = { kind: "founder" as const, ownerKey: "cc" as const, email: "conaugh@oasisai.work", userId: "u-cc" };

async function main() {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(readFileSync(join(root, "database/turso/180_founders_finances.turso.sql"), "utf8"));
  const rates: Array<[string, string]> = [];
  for (let d = 12; d <= 22; d++) rates.push([`2026-06-${d}`, "1.3700"]);
  for (let d = 1; d <= 24; d++) rates.push([`2026-09-${String(d).padStart(2, "0")}`, "1.3800"]);
  for (const [d, r] of rates) await raw.execute({ sql: `INSERT INTO fin_fx_rates (pair, rate_date, rate) VALUES ('USDCAD', ?, ?)`, args: [d, r] });

  const { ensureFinanceSeed } = await import("../lib/founders-finances/seed-io");
  const ingest = await import("../lib/founders-finances/stripe-ingest");
  const { chargeFacts } = await import("../lib/founders-finances/stripe-map");
  const reportsIo = await import("../lib/founders-finances/reports-io");
  const { usdToCadCents, parseRateMicro } = await import("../lib/founders-finances/fx");
  const { accountId, SYS, BUSINESS_ENTITY_ID: B } = await import("../lib/founders-finances/chart");
  await ensureFinanceSeed();

  const count = async (sql: string, args: Array<string | number> = []) => Number((await raw.execute({ sql, args })).rows[0][0]);
  const FEES = accountId(B, SYS.stripeFees);
  const CLEARING = accountId(B, SYS.stripeClearing);
  const SERVICE = accountId(B, SYS.serviceRevenue);
  const SUBSCRIPTION = accountId(B, SYS.subscriptionRevenue);
  const cad = (usdCents: number, rate: string) => usdToCadCents(usdCents, parseRateMicro(rate));

  const payment = async (chargeId: string) =>
    (await raw.execute({ sql: `SELECT * FROM fin_payments WHERE kind = 'payment' AND stripe_charge_id = ?`, args: [chargeId] })).rows[0] as unknown as
      | { id: string; fee_status: string; fee_cad_cents: number | null; income_account_id: string; stripe_invoice_id: string | null; entry_id: string | null }
      | undefined;
  const feeEntry = async (chargeId: string) =>
    (
      await raw.execute({
        sql: `SELECT e.entry_date, l.account_id, l.currency, l.debit_cents, l.credit_cents, l.cad_debit_cents, l.cad_credit_cents
                FROM fin_journal_entries e JOIN fin_journal_lines l ON l.entry_id = e.id
               WHERE e.entity_id = ? AND e.source = 'stripe_fee' AND e.source_ref = ? ORDER BY l.line_no`,
        args: [B, chargeId],
      })
    ).rows.map((r) => ({ ...r }));
  const feeEntries = (chargeId: string) => count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'stripe_fee' AND source_ref = ?`, [chargeId]);
  const incomeCredit = async (chargeId: string) =>
    (
      await raw.execute({
        sql: `SELECT l.account_id, l.currency, l.credit_cents FROM fin_journal_entries e JOIN fin_journal_lines l ON l.entry_id = e.id
               WHERE e.source = 'stripe_charge' AND e.source_ref = ? AND l.credit_cents > 0`,
        args: [chargeId],
      })
    ).rows.map((r) => ({ ...r }));
  const booksBalance = async () => {
    assert.equal(await count(`SELECT COUNT(*) FROM (SELECT entry_id, currency FROM fin_journal_lines GROUP BY entry_id, currency HAVING SUM(debit_cents) <> SUM(credit_cents))`), 0, "every entry balances in each currency");
    assert.equal(await count(`SELECT COUNT(*) FROM (SELECT entry_id FROM fin_journal_lines GROUP BY entry_id HAVING SUM(cad_debit_cents) <> SUM(cad_credit_cents))`), 0, "every entry balances in CAD");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries e WHERE NOT EXISTS (SELECT 1 FROM fin_journal_lines l WHERE l.entry_id = e.id)`), 0, "no entry without lines");
    const tb = (await reportsIo.runReport(cc, "oasis", "trial", { to: "2099-12-31" })).data as { balanced: boolean };
    assert.equal(tb.balanced, true, "trial balance");
    const bs = (await reportsIo.runReport(cc, "oasis", "balance", { to: "2099-12-31" })).data as { balanced: boolean };
    assert.equal(bs.balanced, true, "balance sheet");
  };

  // ── the live state: payments recorded while the fee could not be read ───
  const L1 = { id: "py_3TkVaCHj2zGc7I1J1J0LT4jn", pi: "pi_L1", at: "2026-06-20T19:13:44Z", amount: 15000, bt: { id: "txn_L1", amount: 10596, fee: 540 } };
  const L2 = { id: "ch_3UCRkdHj2zGc7I1J1XgmsGfB", pi: "pi_L2", at: "2026-09-05T19:27:56Z", amount: 10000, bt: { id: "txn_L2", amount: 7226, fee: 442 } };
  const L3 = { id: "py_3SrkfdHj2zGc7I1J0N1yR7oY", pi: "pi_L3", at: "2026-01-20T17:00:00Z", amount: 60000, bt: { id: "txn_L3", amount: 43377, fee: 2148 } };
  const L4 = { id: "ch_L4_pending_bt", pi: "pi_L4", at: "2026-09-06T15:00:00Z", amount: 10000, bt: null as null | { id: string; amount: number; fee: number } };
  for (const l of [L1, L2, L3, L4]) {
    stripe.charges.set(l.id, liveCharge(l));
    stripe.invoicePayments.set(l.pi, paidBy(subscriptionInvoice(`in_${l.pi}`)));
  }

  await check("setup: without a verified key the payment is booked, its fee left pending (the 13 live rows' state)", async () => {
    for (const l of [L1, L2, L3, L4]) {
      const unexpanded = { ...liveCharge(l), balance_transaction: l.bt ? l.bt.id : null };
      const r = await ingest.recordStripeCharge(chargeFacts(unexpanded)!, { fetchFees: true });
      assert.equal(r.created, true);
    }
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE kind = 'payment' AND fee_status = 'pending'`), 4);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'stripe_fee'`), 0);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE income_account_id = ?`, [SERVICE]), 4, "unknown without a key -> service revenue, as the live rows were booked");
    assert.equal(calls.length, 0, "no key -> no Stripe call");
    await booksBalance();
  });

  process.env.STRIPE_SECRET_KEY = "rk_live_restricted_test";
  await raw.execute({ sql: `UPDATE fin_settings SET stripe_account_id = 'acct_test_oasis' WHERE entity_id = ?`, args: [B] });

  await check("[G] the sync completes USD-settled fees for card (ch_) AND Link (py_) charges, on the day the balance moved", async () => {
    const done = await ingest.syncPendingStripe();
    assert.equal(done, 2, "L1 (py_) and L2 (ch_) complete; L3 has no rate yet, L4 no balance transaction yet");
    assert.deepEqual(await feeEntry(L1.id), [
      { entry_date: "2026-06-20", account_id: FEES, currency: "USD", debit_cents: 540, credit_cents: 0, cad_debit_cents: cad(540, "1.3700"), cad_credit_cents: 0 },
      { entry_date: "2026-06-20", account_id: CLEARING, currency: "USD", debit_cents: 0, credit_cents: 540, cad_debit_cents: 0, cad_credit_cents: cad(540, "1.3700") },
    ]);
    const l2 = await feeEntry(L2.id);
    assert.equal(l2.length, 2);
    assert.equal(l2[0].entry_date, "2026-09-05");
    assert.equal(l2[0].currency, "USD");
    assert.equal(l2[0].debit_cents, 442);
    for (const [l, rate] of [[L1, "1.3700"], [L2, "1.3800"]] as const) {
      const p = (await payment(l.id))!;
      assert.equal(p.fee_status, "posted", l.id);
      assert.equal(p.fee_cad_cents, cad(l.bt.fee, rate), "fee_cad_cents is the CAD the ledger booked");
    }
    await booksBalance();
  });

  await check("[G] no rate for the fee's day, or no balance transaction yet: stays pending, nothing guessed, no error", async () => {
    for (const l of [L3, L4]) {
      assert.equal((await payment(l.id))!.fee_status, "pending", l.id);
      assert.equal(await feeEntries(l.id), 0, l.id);
    }
    assert.ok(calls.some((c) => c.path === `api.stripe.com/v1/charges/${L3.id}`), "the py_ charge was fetched, not skipped");
  });

  await check("[G] idempotent: re-running the sync posts no second fee", async () => {
    const before = await count(`SELECT COUNT(*) FROM fin_journal_entries`);
    assert.equal(await ingest.syncPendingStripe(), 0);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries`), before);
    assert.equal(await feeEntries(L1.id), 1);
    assert.equal(await feeEntries(L2.id), 1);
  });

  await check("[G] the pending ones complete once the rate and the balance transaction exist (one Bank of Canada request for all)", async () => {
    valet.serve = true;
    for (let d = 13; d <= 20; d++) valet.observations.push({ d: `2026-01-${d}`, FXUSDCAD: { v: "1.4300" } });
    L4.bt = { id: "txn_L4", amount: 7100, fee: 440 };
    stripe.charges.set(L4.id, liveCharge(L4));
    const boc = () => calls.filter((c) => c.path.startsWith("www.bankofcanada.ca")).length;
    const bocBefore = boc();
    assert.equal(await ingest.syncPendingStripe(), 2);
    assert.equal(boc() - bocBefore, 1, "missing days are fetched once, up front");
    valet.serve = false;
    const l3 = await feeEntry(L3.id);
    assert.equal(l3[0].entry_date, "2026-01-20");
    assert.equal(l3[0].debit_cents, 2148);
    assert.equal(l3[0].cad_debit_cents, cad(2148, "1.4300"));
    assert.equal((await payment(L4.id))!.fee_status, "posted");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE kind = 'payment' AND fee_status = 'pending'`), 0);
    await booksBalance();
  });

  // ── reconcile: new charges are classified; existing ones are left alone ──
  const N1 = { id: "ch_N1_sub", pi: "pi_N1", at: "2026-09-20T15:00:00Z", amount: 10000, bt: { id: "txn_N1", amount: 7100, fee: 440 } };
  const N2 = { id: "py_N2_oneoff", pi: "pi_N2", at: "2026-09-21T15:00:00Z", amount: 50000, bt: { id: "txn_N2", amount: 36000, fee: 1800 } };
  const N3 = { id: "ch_N3_manual_invoice", pi: "pi_N3", at: "2026-09-22T15:00:00Z", amount: 20000, bt: { id: "txn_N3", amount: 14400, fee: 720 } };
  const N4 = { id: "ch_N4_create", pi: "pi_N4", at: "2026-09-22T16:00:00Z", amount: 60000, bt: { id: "txn_N4", amount: 43200, fee: 1500 } };
  const failed = { id: "py_failed", pi: "pi_failed", at: "2026-09-22T17:00:00Z", amount: 15000, bt: null, status: "failed" };
  for (const n of [N1, N2, N3, N4, failed]) stripe.charges.set(n.id, liveCharge(n));
  stripe.invoicePayments.set(N1.pi, paidBy(subscriptionInvoice("in_N1")));
  stripe.invoicePayments.set(N2.pi, []);
  stripe.invoicePayments.set(N3.pi, paidBy(oneOffInvoice("in_N3")));
  // An invoice_payments row that names the invoice without expanding it: the invoice is fetched.
  stripe.invoicePayments.set(N4.pi, [{ id: "inpay_N4", object: "invoice_payment", status: "paid", invoice: "in_N4" }]);
  stripe.invoices.set("in_N4", subscriptionInvoice("in_N4", "subscription_create"));
  stripe.list = [N1.id, N2.id, N3.id, N4.id, failed.id, L1.id, L2.id];

  await check("[H] reconcile: subscription-invoice payments credit 4010, one-off charges and one-off invoices 4000; fees post in USD", async () => {
    const s = await ingest.reconcileStripe({ days: 30 });
    assert.equal(s.payments_recorded, 4);
    assert.equal(s.subscriptions_upserted, 1);
    const expect: Array<[typeof N1, string, string | null]> = [
      [N1, SUBSCRIPTION, "in_N1"],
      [N2, SERVICE, null],
      [N3, SERVICE, "in_N3"],
      [N4, SUBSCRIPTION, "in_N4"],
    ];
    for (const [n, income, stripeInvoice] of expect) {
      const p = (await payment(n.id))!;
      assert.equal(p.income_account_id, income, n.id);
      assert.equal(p.stripe_invoice_id, stripeInvoice, `${n.id}: the Stripe invoice it paid is on the row`);
      assert.deepEqual(await incomeCredit(n.id), [{ account_id: income, currency: "CAD", credit_cents: n.amount }], n.id);
      assert.equal(p.fee_status, "posted", n.id);
      const fee = await feeEntry(n.id);
      assert.equal(fee[0].currency, "USD");
      assert.equal(fee[0].debit_cents, n.bt.fee);
      assert.equal(fee[0].entry_date, n.at.slice(0, 10));
    }
    assert.equal(await payment(failed.id), undefined, "a failed charge never enters the books");
    await booksBalance();
  });

  await check("[H] rows already in the books are NOT rewritten, even when Stripe now says subscription", async () => {
    for (const l of [L1, L2, L3, L4]) {
      assert.equal((await payment(l.id))!.income_account_id, SERVICE, l.id);
      assert.deepEqual(await incomeCredit(l.id), [{ account_id: SERVICE, currency: "CAD", credit_cents: l.amount }], l.id);
    }
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source NOT IN ('stripe_charge', 'stripe_fee')`), 0, "no reclass or adjustment entry was posted");
    assert.equal(
      calls.filter((c) => c.path === "api.stripe.com/v1/invoice_payments").length,
      4,
      "only the four NEW payments were looked up",
    );
  });

  await check("[G][H] idempotent: a second reconcile adds no payment, no entry, no fee", async () => {
    const payments = await count(`SELECT COUNT(*) FROM fin_payments`);
    const entries = await count(`SELECT COUNT(*) FROM fin_journal_entries`);
    const lines = await count(`SELECT COUNT(*) FROM fin_journal_lines`);
    const s = await ingest.reconcileStripe({ days: 30 });
    assert.equal(s.payments_recorded, 0);
    assert.equal(s.pending_completed, 0);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments`), payments);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries`), entries);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_lines`), lines);
    await booksBalance();
  });

  // ── webhook events ──────────────────────────────────────────────────────
  let seq = 0;
  const event = (type: string, object: Json, id = `evt_stripe_ledger_${++seq}`) => ({ id, object: "event", type, created: epoch("2026-09-23T15:00:00Z"), livemode: true, data: { object } });
  const basilInvoicePaid = (inv: Json, pi: string, amount: number): Json => ({
    ...inv,
    currency: "cad",
    amount_paid: amount,
    livemode: true,
    customer: "cus_live",
    status_transitions: { paid_at: epoch("2026-09-23T15:00:00Z") },
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: pi } }] },
  });
  const W1 = { id: "ch_W1_sub", pi: "pi_W1", at: "2026-09-23T15:00:00Z", amount: 10000, bt: { id: "txn_W1", amount: 7250, fee: 450 } };
  const W2 = { id: "ch_W2_oneoff", pi: "pi_W2", at: "2026-09-23T15:30:00Z", amount: 25000, bt: { id: "txn_W2", amount: 18100, fee: 900 } };
  for (const w of [W1, W2]) {
    stripe.charges.set(w.id, liveCharge(w));
    stripe.paymentIntents.set(w.pi, { id: w.pi, object: "payment_intent", currency: "cad", created: epoch(w.at), amount_received: w.amount, livemode: true, latest_charge: w.id, metadata: {} });
  }

  await check("[H] invoice.paid: a subscription invoice books 4010, a one-off Stripe invoice 4000 (not 4010)", async () => {
    const r1 = await ingest.handleStripeEvent(event("invoice.paid", basilInvoicePaid(subscriptionInvoice("in_W1"), W1.pi, W1.amount)));
    assert.equal(r1.status, "processed");
    const r2 = await ingest.handleStripeEvent(event("invoice.paid", basilInvoicePaid(oneOffInvoice("in_W2"), W2.pi, W2.amount)));
    assert.equal(r2.status, "processed");
    assert.equal((await payment(W1.id))!.income_account_id, SUBSCRIPTION);
    assert.equal((await payment(W2.id))!.income_account_id, SERVICE);
    assert.equal(await feeEntries(W1.id), 1);
    assert.equal(await feeEntries(W2.id), 1);
    // The same invoice's charge.succeeded arriving afterwards changes nothing.
    const again = await ingest.handleStripeEvent(event("charge.succeeded", liveCharge(W1)));
    assert.equal(again.status, "processed");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE kind = 'payment' AND stripe_payment_intent_id = ?`, [W1.pi]), 1);
    assert.equal(await feeEntries(W1.id), 1);
    await booksBalance();
  });

  await check("[H] a Stripe outage while classifying fails the event (retried later) instead of guessing the account", async () => {
    const W3 = { id: "py_W3_sub", pi: "pi_W3", at: "2026-09-23T16:00:00Z", amount: 15000, bt: { id: "txn_W3", amount: 10900, fee: 560 } };
    stripe.charges.set(W3.id, liveCharge(W3));
    stripe.invoicePayments.set(W3.pi, paidBy(subscriptionInvoice("in_W3")));
    stripe.failInvoicePayments.add(W3.pi);
    const ev = event("charge.succeeded", liveCharge(W3), "evt_stripe_ledger_outage");
    await assert.rejects(ingest.handleStripeEvent(ev));
    assert.equal(await payment(W3.id), undefined, "nothing booked on a guess");
    stripe.failInvoicePayments.delete(W3.pi);
    const retry = await ingest.handleStripeEvent(ev);
    assert.equal(retry.status, "processed", "Stripe's redelivery of the failed event succeeds");
    assert.equal((await payment(W3.id))!.income_account_id, SUBSCRIPTION);
    assert.equal(await feeEntries(W3.id), 1);
  });

  await check("books still balance after everything; Stripe was only ever read", async () => {
    await booksBalance();
    const feesUsd = await count(`SELECT COALESCE(SUM(debit_cents - credit_cents), 0) FROM fin_journal_lines WHERE account_id = ? AND currency = 'USD'`, [FEES]);
    assert.equal(feesUsd, 540 + 442 + 2148 + 440 + 440 + 1800 + 720 + 1500 + 450 + 900 + 560, "5000 Stripe fees holds every fee, once");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_lines WHERE account_id = ? AND currency <> 'USD'`, [FEES]), 0, "fees sit in the settlement currency");
    assert.equal(await count(`SELECT COALESCE(SUM(fee_cad_cents), 0) FROM fin_payments`), await count(`SELECT COALESCE(SUM(cad_debit_cents - cad_credit_cents), 0) FROM fin_journal_lines WHERE account_id = ?`, [FEES]), "fee_cad_cents ties to the ledger");
    assert.ok(calls.every((c) => c.method === "GET"), "no Stripe write");
  });

  if (failures > 0) {
    console.log(`finances-stripe-ledger: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("finances-stripe-ledger: all passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
