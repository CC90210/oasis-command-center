/**
 * tests/finances-stripe-ledger-events.test.ts — every Stripe fact the books
 * record is also a Business Ledger event (lib/ledger, plan §F2), written in
 * the SAME batch as the book write, against a REAL local libSQL database with
 * the finance migrations and the ledger core (bravo__190) applied.
 *
 * What is pinned:
 *   - each handled event type emits its catalog key (payment.received,
 *     payment.failed, refund.issued, invoice.paid, subscription.started /
 *     renewed / changed / cancelled), from lib/founders-finances/stripe-ingest.ts,
 *     for the workspace OASIS's pinned Stripe account belongs to;
 *   - a redelivery writes no second row;
 *   - a failed ledger insert rolls the book write back (the payment row, the
 *     subscription row, an invoice's payment: its row, key or link, the
 *     processed mark) and Stripe's retry then lands both;
 *   - no workspace to say (no finance tenant): the book write still happens,
 *     the fact goes to ledger_dead_letters, never to a default tenant; no
 *     Stripe account pinned: the event itself is refused and dead-lettered
 *     (the contamination guard, 2026-09-30), and every event here is proved
 *     the pinned account's by its key first;
 *   - payloads hold ids and codes: no customer name or email reaches the ledger.
 *
 * Run: node --conditions=react-server --import tsx tests/finances-stripe-ledger-events.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "finances-ledger-events-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "STRIPE_SECRET_KEY", "FOUNDERS_TENANT_IDS", "STRIPE_FINANCE_WEBHOOK_SECRET"]) delete process.env[k];

// A webhook event is booked only when a key of the pinned account proves it is
// that account's (stripe-ingest.ts stripeEventOrigin; no key = refused). The
// key is OASIS's pinned account's: Stripe knows each event and no other object
// (every other read is a 404, handled as "Stripe could not say").
const STRIPE_KEY = "rk_live_ledger_events_test_only";
process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "ledger-events-test-only-field-key-000";
globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
  const url = new URL(String(input));
  if (url.host !== "api.stripe.com") throw new Error(`network disabled in test: ${String(input).slice(0, 80)}`);
  if ((init?.method || "GET").toUpperCase() !== "GET") throw new Error(`Stripe write attempted in test: ${url.pathname}`);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/v1/account") return json({ id: "acct_test_oasis", settings: { dashboard: { display_name: "OASIS AI" } } });
  if (url.pathname.startsWith("/v1/events/")) return json({ id: decodeURIComponent(url.pathname.slice("/v1/events/".length)), object: "event" });
  return json({ error: { type: "invalid_request_error", message: "No such object" } }, 404);
}) as typeof fetch;

const TENANT = "oasis-books-test";
const PRODUCER = "lib/founders-finances/stripe-ingest.ts";

type Json = Record<string, unknown>;
const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);
let seq = 0;
const event = (type: string, object: Json, at = "2026-09-20T12:00:00Z", id = `evt_ledger_${++seq}`, previous?: Json): Json => ({
  id,
  object: "event",
  type,
  created: epoch(at),
  livemode: true,
  data: previous ? { object, previous_attributes: previous } : { object },
});

function charge(p: { id: string; amount: number; at: string; status?: string; refunded?: number; refunds?: Json[]; failureCode?: string }): Json {
  const status = p.status ?? "succeeded";
  return {
    id: p.id,
    object: "charge",
    amount: p.amount,
    amount_captured: p.amount,
    amount_refunded: p.refunded ?? 0,
    currency: "cad",
    created: epoch(p.at),
    status,
    paid: status === "succeeded",
    livemode: true,
    payment_intent: `pi_${p.id}`,
    customer: "cus_live",
    description: "Subscription update",
    billing_details: { name: "Jean Tremblay", email: "jean@example.test" },
    balance_transaction: { id: `txn_${p.id}`, object: "balance_transaction", amount: Math.round(p.amount * 0.7226), fee: 442, net: 0, currency: "usd", created: epoch(p.at) },
    failure_code: p.failureCode ?? null,
    metadata: {},
    refunds: { object: "list", data: p.refunds ?? [], has_more: false },
  };
}

const STARTER = { id: "price_1StarterCAD", lookup_key: "starter", unit_amount: 10000 };
const GROWTH = { id: "price_1GrowthCAD", lookup_key: "growth", unit_amount: 25000 };

/** A subscription's items list (from API 2025-03-31 each item carries its own billing period). */
const items = (price: { id: string; lookup_key: string; unit_amount: number }, periodEnd = "2026-10-01T00:00:00Z"): Json => ({
  data: [{ quantity: 1, current_period_end: epoch(periodEnd), price: { ...price, currency: "cad", recurring: { interval: "month", interval_count: 1 } } }],
});

function subscription(id: string, status = "active", price = STARTER, periodEnd?: string): Json {
  return {
    id,
    object: "subscription",
    status,
    currency: "cad",
    livemode: true,
    customer: { id: "cus_live", name: "Jean Tremblay", email: "jean@example.test" },
    items: items(price, periodEnd),
    cancellation_details: status === "canceled" ? { reason: "cancellation_requested" } : null,
  };
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

async function main() {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  for (const f of ["180_founders_finances.turso.sql", "184_finance_wise_payments.turso.sql", "185_finance_invoice_retainer.turso.sql", "bravo__190_ledger_core.sql", "bravo__193_stripe_payouts.sql"]) {
    await raw.executeMultiple(readFileSync(join(root, "database/turso", f), "utf8"));
  }
  // bravo__188: the client records a Stripe customer links to (payment.received / refund.issued carry the record
  // as customer_id). It alters migration 183's delivery tables, so those come first (as os-honest-numbers does).
  const deliveryTables = readFileSync(join(root, "database/turso/183_delivery_and_support.turso.sql"), "utf8").match(
    /CREATE TABLE IF NOT EXISTS (?:delivery_projects|delivery_tasks|delivery_updates|support_tickets|ticket_comments) \([\s\S]*?\n\);/g,
  );
  assert.equal(deliveryTables?.length, 5, "the five delivery tables are in migration 183");
  await raw.executeMultiple(deliveryTables!.join("\n"));
  await raw.executeMultiple(readFileSync(join(root, "database/turso/bravo__188_os_customers.sql"), "utf8"));
  for (let d = 1; d <= 30; d++) {
    await raw.execute({ sql: `INSERT INTO fin_fx_rates (pair, rate_date, rate) VALUES ('USDCAD', ?, '1.3800')`, args: [`2026-09-${String(d).padStart(2, "0")}`] });
  }
  // With a finance tenant set, the Stripe key is read from the tenant's stored
  // credentials (a tenant other than OASIS's own never falls back to the env key).
  await raw.execute(`CREATE TABLE tenant_integration_credentials (tenant_id TEXT, service TEXT, field_key TEXT, encrypted_value TEXT)`);
  const { encryptField } = await import("../lib/field-encryption");
  await raw.execute({
    sql: `INSERT INTO tenant_integration_credentials (tenant_id, service, field_key, encrypted_value) VALUES (?, 'stripe', 'secret_key', ?)`,
    args: [TENANT, encryptField(STRIPE_KEY)],
  });
  const { ensureFinanceSeed } = await import("../lib/founders-finances/seed-io");
  const ingest = await import("../lib/founders-finances/stripe-ingest");
  const { BUSINESS_ENTITY_ID: B } = await import("../lib/founders-finances/chart");
  await ensureFinanceSeed();

  const pin = (account: string | null) => raw.execute({ sql: `UPDATE fin_settings SET stripe_account_id = ? WHERE entity_id = ?`, args: [account, B] });
  await pin("acct_test_oasis");
  process.env.FOUNDERS_TENANT_IDS = TENANT;

  const num = async (sql: string, args: Array<string | number> = []) => Number((await raw.execute({ sql, args })).rows[0][0] ?? 0);
  const ledger = async (key: string) =>
    (await raw.execute({ sql: `SELECT * FROM outcome_events WHERE event_key = ? ORDER BY recorded_at`, args: [key] })).rows.map((r) => ({ ...r })) as Array<Record<string, unknown>>;
  const payment = async (chargeId: string) =>
    (await raw.execute({ sql: `SELECT id FROM fin_payments WHERE kind = 'payment' AND stripe_charge_id = ?`, args: [chargeId] })).rows[0] as unknown as { id: string } | undefined;
  const eventStatus = async (id: string) => (await raw.execute({ sql: `SELECT status FROM fin_stripe_events WHERE event_id = ?`, args: [id] })).rows[0]?.status;
  const breakLedger = () => raw.execute(`CREATE TRIGGER ledger_down BEFORE INSERT ON outcome_events BEGIN SELECT RAISE(ABORT, 'ledger down'); END`);
  const mendLedger = () => raw.execute(`DROP TRIGGER ledger_down`);

  await check("the ledger's owner for every Stripe key is stripe-ingest.ts (one writer per key)", async () => {
    const { catalogEntry } = await import("../lib/ledger/catalog");
    for (const k of ["payment.received", "payment.failed", "refund.issued", "invoice.paid", "subscription.started", "subscription.renewed", "subscription.changed", "subscription.cancelled"]) {
      assert.equal(catalogEntry(k)?.owningModule, PRODUCER, k);
    }
  });

  await check("charge.succeeded: payment.received with the payment row, for the pinned account's workspace, ids only", async () => {
    await ingest.handleStripeEvent(event("charge.succeeded", charge({ id: "ch_led_1", amount: 10000, at: "2026-09-05T19:27:56Z" })));
    const pay = await payment("ch_led_1");
    assert.ok(pay, "the payment is in the books");
    const rows = await ledger("payment.received");
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.tenant_id, TENANT);
    assert.equal(r.subject_type, "payment");
    assert.equal(r.subject_id, pay!.id);
    assert.equal(r.idempotency_key, "stripe:ch_led_1");
    assert.equal(Number(r.value_cents), 10000);
    assert.equal(r.currency, "CAD");
    assert.equal(r.occurred_at, "2026-09-05T19:27:56.000Z");
    assert.equal(r.producer, PRODUCER);
    assert.equal(r.source, "stripe");
    assert.equal(r.confidence, "verified");
    assert.equal(r.department_key, "finance");
    assert.deepEqual(JSON.parse(String(r.payload_json)), { provider_payment_id: "ch_led_1" });
    const all = JSON.stringify((await raw.execute("SELECT * FROM outcome_events")).rows);
    assert.doesNotMatch(all, /Tremblay|jean@example/, "no name or email in the ledger");
  });

  await check("a redelivery (payment_intent.succeeded for the same charge) writes no second payment.received", async () => {
    await ingest.handleStripeEvent(event("payment_intent.succeeded", { id: "pi_ch_led_1", object: "payment_intent", amount: 10000, amount_received: 10000, currency: "cad", created: epoch("2026-09-05T19:27:56Z"), livemode: true, latest_charge: charge({ id: "ch_led_1", amount: 10000, at: "2026-09-05T19:27:56Z" }), metadata: {} }));
    assert.equal((await ledger("payment.received")).length, 1);
    assert.equal(await num(`SELECT COUNT(*) FROM fin_payments WHERE kind = 'payment'`), 1);
  });

  await check("charge.refunded: refund.issued with the refund row, keyed by Stripe's refund id", async () => {
    const refund = { id: "re_led_1", object: "refund", amount: 2500, currency: "cad", created: epoch("2026-09-07T10:00:00Z"), status: "succeeded", charge: "ch_led_1", balance_transaction: null };
    await ingest.handleStripeEvent(event("charge.refunded", charge({ id: "ch_led_1", amount: 10000, at: "2026-09-05T19:27:56Z", refunded: 2500, refunds: [refund] })));
    const rows = await ledger("refund.issued");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].idempotency_key, "stripe:re_led_1");
    assert.equal(Number(rows[0].value_cents), 2500);
    assert.deepEqual(JSON.parse(String(rows[0].payload_json)), { provider_payment_id: "ch_led_1", provider_refund_id: "re_led_1" });
    await ingest.handleStripeEvent(event("charge.refunded", charge({ id: "ch_led_1", amount: 10000, at: "2026-09-05T19:27:56Z", refunded: 2500, refunds: [refund] })));
    assert.equal((await ledger("refund.issued")).length, 1, "a second delivery: no second refund, no second row");
  });

  await check("invoice.paid for a subscription cycle: invoice.paid and subscription.renewed, committed with the payment", async () => {
    const inv: Json = {
      id: "in_led_1",
      object: "invoice",
      currency: "cad",
      amount_paid: 10000,
      livemode: true,
      billing_reason: "subscription_cycle",
      customer: "cus_live",
      customer_name: "Jean Tremblay",
      customer_email: "jean@example.test",
      status_transitions: { paid_at: epoch("2026-09-06T08:00:00Z") },
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_led_1", metadata: {} } },
      payments: { data: [{ payment: { type: "charge", charge: "ch_led_2", payment_intent: "pi_ch_led_2" } }] },
      metadata: {},
    };
    const e = event("invoice.paid", inv);
    const out = await ingest.handleStripeEvent(e);
    assert.equal(out.status, "processed", out.detail);
    const paid = await ledger("invoice.paid");
    assert.equal(paid.length, 1);
    assert.equal(paid[0].idempotency_key, "inv:in_led_1:paid");
    assert.deepEqual(JSON.parse(String(paid[0].payload_json)), { invoice_id: "in_led_1", source_system: "stripe" });
    const renewed = await ledger("subscription.renewed");
    assert.equal(renewed.length, 1);
    assert.equal(renewed[0].subject_id, "sub_led_1");
    assert.equal(renewed[0].idempotency_key, `stripe:${e.id}`);
    assert.equal((await ledger("payment.received")).length, 2, "the charge behind it is a payment too");
  });

  await check("customer.subscription.created / updated / deleted: started, changed (a plan change only), cancelled, with the subscription row", async () => {
    await ingest.handleStripeEvent(event("customer.subscription.created", subscription("sub_led_2"), "2026-09-01T00:00:00Z"));
    // Stripe sends customer.subscription.updated for much that changes nothing billed.
    const rolled = await ingest.handleStripeEvent(
      event("customer.subscription.updated", subscription("sub_led_2", "active", STARTER, "2026-11-01T00:00:00Z"), "2026-09-09T00:00:00Z", undefined, { items: items(STARTER, "2026-10-01T00:00:00Z") }),
    );
    assert.equal(rolled.status, "processed", rolled.detail);
    await ingest.handleStripeEvent(event("customer.subscription.updated", subscription("sub_led_2", "past_due"), "2026-09-10T00:00:00Z", undefined, { status: "active" }));
    await ingest.handleStripeEvent(event("customer.subscription.updated", subscription("sub_led_2", "active"), "2026-09-11T00:00:00Z", undefined, { cancel_at_period_end: true, default_payment_method: "pm_old" }));
    await ingest.handleStripeEvent(event("customer.subscription.updated", subscription("sub_led_2", "active"), "2026-09-12T00:00:00Z"));
    assert.equal((await ledger("subscription.changed")).length, 0, "a billing-cycle roll, a status, payment-method or cancel-at-period-end change, or no previous_attributes: no subscription.changed");
    assert.equal(await num(`SELECT COUNT(*) FROM fin_subscriptions WHERE id = 'sub_led_2' AND status = 'active'`), 1, "the subscription row still follows every update");
    // An upgrade: the item's price changed.
    await ingest.handleStripeEvent(event("customer.subscription.updated", subscription("sub_led_2", "active", GROWTH), "2026-09-15T00:00:00Z", undefined, { items: items(STARTER) }));
    const changed = await ledger("subscription.changed");
    assert.equal(changed.length, 1);
    assert.equal(Number(changed[0].value_cents), 25000, "the new monthly value");
    assert.deepEqual(JSON.parse(String(changed[0].payload_json)), { from_plan_code: "starter", plan_code: "growth", provider_subscription_id: "sub_led_2" });
    // A quantity change on the same price is a change too.
    const seats = subscription("sub_led_2", "active", GROWTH);
    ((seats.items as Json).data as Json[])[0].quantity = 2;
    await ingest.handleStripeEvent(event("customer.subscription.updated", seats, "2026-09-16T00:00:00Z", undefined, { items: items(GROWTH) }));
    assert.equal((await ledger("subscription.changed")).length, 2);
    await ingest.handleStripeEvent(event("customer.subscription.deleted", subscription("sub_led_2", "canceled"), "2026-09-20T00:00:00Z"));
    const started = await ledger("subscription.started");
    assert.equal(started.length, 1);
    assert.equal(Number(started[0].value_cents), 10000, "the monthly value");
    assert.deepEqual(JSON.parse(String(started[0].payload_json)), { interval: "month", provider_subscription_id: "sub_led_2" });
    const cancelled = await ledger("subscription.cancelled");
    assert.equal(cancelled.length, 1);
    assert.deepEqual(JSON.parse(String(cancelled[0].payload_json)), { cancel_reason: "cancellation_requested", provider_subscription_id: "sub_led_2" });
    assert.equal(cancelled[0].value_cents, null);
  });

  await check("charge.failed: payment.failed with Stripe's failure code; nothing enters the books", async () => {
    await ingest.handleStripeEvent(event("charge.failed", charge({ id: "ch_led_fail", amount: 5000, at: "2026-09-11T10:00:00Z", status: "failed", failureCode: "card_declined" })));
    const rows = await ledger("payment.failed");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].idempotency_key, "stripe:ch_led_fail:failed");
    assert.deepEqual(JSON.parse(String(rows[0].payload_json)), { failure_code: "card_declined", provider_payment_id: "ch_led_fail" });
    assert.equal(await payment("ch_led_fail"), undefined);
  });

  await check("a failed ledger insert rolls the payment back; Stripe's retry then writes both", async () => {
    await breakLedger();
    const e = event("charge.succeeded", charge({ id: "ch_led_rollback", amount: 7000, at: "2026-09-12T10:00:00Z" }));
    try {
      await assert.rejects(ingest.handleStripeEvent(e), /ledger down/);
      assert.equal(await payment("ch_led_rollback"), undefined, "no payment without its ledger row");
      assert.equal(await eventStatus(String(e.id)), "failed", "the event stays unprocessed, so Stripe retries");
    } finally {
      await mendLedger();
    }
    assert.equal((await ingest.handleStripeEvent(e)).status, "processed");
    assert.ok(await payment("ch_led_rollback"));
    assert.equal((await ledger("payment.received")).filter((r) => r.idempotency_key === "stripe:ch_led_rollback").length, 1);
  });

  await check("a failed ledger insert rolls the subscription row and the refund row back too", async () => {
    await breakLedger();
    try {
      await assert.rejects(ingest.handleStripeEvent(event("customer.subscription.created", subscription("sub_led_rollback"))), /ledger down/);
      assert.equal(await num(`SELECT COUNT(*) FROM fin_subscriptions WHERE id = 'sub_led_rollback'`), 0);
      const refund = { id: "re_led_rollback", object: "refund", amount: 1000, currency: "cad", created: epoch("2026-09-13T10:00:00Z"), status: "succeeded", charge: "ch_led_rollback", balance_transaction: null };
      await assert.rejects(ingest.handleStripeEvent(event("charge.refunded", charge({ id: "ch_led_rollback", amount: 7000, at: "2026-09-12T10:00:00Z", refunded: 1000, refunds: [refund] }))), /ledger down/);
      assert.equal(await num(`SELECT COUNT(*) FROM fin_payments WHERE stripe_refund_id = 're_led_rollback'`), 0);
      const inv: Json = { id: "in_led_rollback", object: "invoice", currency: "cad", amount_paid: 7000, livemode: true, billing_reason: "manual", status_transitions: { paid_at: epoch("2026-09-12T10:00:00Z") }, payments: { data: [{ payment: { charge: "ch_led_rollback", payment_intent: "pi_ch_led_rollback" } }] }, metadata: {} };
      const e = event("invoice.paid", inv);
      await assert.rejects(ingest.handleStripeEvent(e), /ledger down/);
      assert.equal(await eventStatus(String(e.id)), "failed", "invoice.paid is not marked processed without its ledger row");
    } finally {
      await mendLedger();
    }
  });

  await check("invoice.paid rides in the batch that records the invoice's payment: when only it fails, nothing of the payment is written; the retry lands both", async () => {
    // Only invoice.paid refuses: payment.received (in the same batch) would go through on its own.
    await raw.execute(`CREATE TRIGGER invoice_paid_down BEFORE INSERT ON outcome_events WHEN NEW.event_key = 'invoice.paid' BEGIN SELECT RAISE(ABORT, 'invoice.paid down'); END`);
    const mend = () => raw.execute(`DROP TRIGGER invoice_paid_down`);
    const invoicePaid = (id: string, chargeId: string, amount: number, metadata: Json = {}): Json => ({
      id,
      object: "invoice",
      currency: "cad",
      amount_paid: amount,
      livemode: true,
      billing_reason: "manual",
      customer: "cus_live",
      status_transitions: { paid_at: epoch("2026-09-15T10:00:00Z") },
      payments: { data: [{ payment: { type: "charge", charge: chargeId, payment_intent: `pi_${chargeId}` } }] },
      metadata,
    });
    const paidFacts = async (invoiceId: string) => (await ledger("invoice.paid")).filter((r) => r.idempotency_key === `inv:${invoiceId}:paid`).length;
    // B: a payment already recorded, which this invoice.paid names: the key fill is the write.
    await ingest.handleStripeEvent(event("charge.succeeded", charge({ id: "ch_led_key", amount: 4000, at: "2026-09-15T09:00:00Z" })));
    // C: a payment already recorded as revenue, whose invoice.paid links it to a fin invoice.
    await raw.execute({ sql: `INSERT INTO fin_contacts (id, entity_id, kind, name) VALUES ('con_led_link', ?, 'customer', 'Client')`, args: [B] });
    await raw.execute({
      sql: `INSERT INTO fin_invoices (id, entity_id, contact_id, number, status, issue_date, due_date, currency, subtotal_cents, total_cents, created_by)
            VALUES ('inv_led_link', ?, 'con_led_link', 'OASIS-2026-0901', 'sent', '2026-09-01', '2026-09-30', 'CAD', 5000, 5000, 'test')`,
      args: [B],
    });
    await ingest.handleStripeEvent(event("charge.succeeded", charge({ id: "ch_led_link", amount: 5000, at: "2026-09-15T09:30:00Z" })));
    const newPay = event("invoice.paid", invoicePaid("in_led_new", "ch_led_new", 6000));
    const keyFill = event("invoice.paid", invoicePaid("in_led_key", "ch_led_key", 4000));
    const link = event("invoice.paid", invoicePaid("in_led_link", "ch_led_link", 5000, { fin_invoice_id: "inv_led_link" }));
    const keyOf = async (chargeId: string) => (await raw.execute({ sql: `SELECT stripe_invoice_id, invoice_id FROM fin_payments WHERE stripe_charge_id = ?`, args: [chargeId] })).rows[0];
    const invoiceStatus = async () => (await raw.execute(`SELECT status FROM fin_invoices WHERE id = 'inv_led_link'`)).rows[0].status;
    try {
      for (const e of [newPay, keyFill, link]) {
        await assert.rejects(ingest.handleStripeEvent(e), /invoice\.paid down/);
        assert.equal(await eventStatus(String(e.id)), "failed", "Stripe retries it");
      }
      assert.equal(await payment("ch_led_new"), undefined, "a new payment: its row is not written without its invoice.paid");
      assert.equal((await keyOf("ch_led_key")).stripe_invoice_id, null, "a recorded payment: the invoice's id is not filled in without its invoice.paid");
      assert.equal((await keyOf("ch_led_link")).invoice_id, null, "a recorded payment: not linked to the fin invoice without its invoice.paid");
      assert.equal(await invoiceStatus(), "sent", "the fin invoice is not paid in the books without its invoice.paid");
    } finally {
      await mend();
    }
    for (const e of [newPay, keyFill, link]) assert.equal((await ingest.handleStripeEvent(e)).status, "processed");
    assert.ok(await payment("ch_led_new"));
    assert.equal((await keyOf("ch_led_key")).stripe_invoice_id, "in_led_key");
    assert.equal((await keyOf("ch_led_link")).invoice_id, "inv_led_link");
    assert.equal(await invoiceStatus(), "paid");
    for (const id of ["in_led_new", "in_led_key", "in_led_link"]) assert.equal(await paidFacts(id), 1, id);
    assert.equal((await ledger("payment.received")).filter((r) => r.idempotency_key === "stripe:ch_led_new").length, 1);
  });

  await check("no workspace to say (finance tenant unset): the payment is booked, the fact is dead-lettered, never filed under a default", async () => {
    delete process.env.FOUNDERS_TENANT_IDS;
    try {
      const before = await num(`SELECT COUNT(*) FROM outcome_events`);
      const e = event("charge.succeeded", charge({ id: "ch_led_orphan", amount: 3000, at: "2026-09-14T10:00:00Z" }));
      assert.equal((await ingest.handleStripeEvent(e)).status, "processed");
      assert.ok(await payment("ch_led_orphan"), "the books still record the money");
      assert.equal(await num(`SELECT COUNT(*) FROM outcome_events`), before, "no ledger row under any tenant");
      const dl = (await raw.execute(`SELECT * FROM ledger_dead_letters WHERE idempotency_key = 'stripe:ch_led_orphan'`)).rows;
      assert.equal(dl.length, 1);
      assert.equal(dl[0].event_key, "payment.received");
      assert.equal(dl[0].producer, PRODUCER);
      assert.equal(dl[0].error, "tenant_unmapped:finance_tenant_unset");
      assert.equal(dl[0].tenant_hint, null);
      assert.doesNotMatch(String(dl[0].payload_json), /Tremblay|jean@example/);
      // The same charge seen again inserts no payment, so it parks nothing again.
      await ingest.handleStripeEvent(event("charge.succeeded", charge({ id: "ch_led_orphan", amount: 3000, at: "2026-09-14T10:00:00Z" })));
      assert.equal(Number((await raw.execute(`SELECT attempts FROM ledger_dead_letters WHERE idempotency_key = 'stripe:ch_led_orphan'`)).rows[0].attempts), 1);
    } finally {
      process.env.FOUNDERS_TENANT_IDS = TENANT;
    }
  });

  // 2026-09-30 (contamination guard, stripe-ingest.ts stripeEventOrigin): with
  // no Stripe account pinned, nothing says the event is OASIS's, so it never
  // reaches the books at all (it used to be kept, with only its ledger fact
  // dead-lettered). It is dead-lettered whole, ids only.
  await check("Stripe account not pinned: the event never reaches the books or the ledger; dead-lettered with that reason, ids only", async () => {
    await pin(null);
    try {
      const out = await ingest.handleStripeEvent(event("customer.subscription.created", subscription("sub_led_unpinned")));
      assert.equal(out.status, "ignored");
      assert.equal(await num(`SELECT COUNT(*) FROM fin_subscriptions WHERE id = 'sub_led_unpinned'`), 0, "nothing kept for an account nobody pinned");
      assert.equal((await ledger("subscription.started")).filter((r) => r.subject_id === "sub_led_unpinned").length, 0);
      const dl = (await raw.execute(`SELECT error, payload_json FROM ledger_dead_letters WHERE error LIKE 'foreign_stripe_account:%'`)).rows;
      assert.deepEqual(dl.map((r) => r.error), ["foreign_stripe_account:stripe_account_unpinned"]);
      assert.doesNotMatch(String(dl[0].payload_json), /Tremblay|jean@example/, "ids only");
    } finally {
      await pin("acct_test_oasis");
    }
  });

  if (failures) {
    console.error(`finances-stripe-ledger-events: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("finances-stripe-ledger-events: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
