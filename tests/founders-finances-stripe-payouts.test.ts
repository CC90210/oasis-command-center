/**
 * tests/founders-finances-stripe-payouts.test.ts — Stripe money booked right
 * for OASIS, and only OASIS's (2026-09-30, T5), against a REAL local libSQL
 * database with the finance migrations and the ledger core applied.
 *
 *   - A charge whose payment intent paid a SUBSCRIPTION invoice books to 4010
 *     Subscription revenue: the invoice is looked up when the charge names
 *     none (API 2025-03-31), through invoice_payments and, when that lists an
 *     invoice it did not expand, the invoice itself. A one-off stays 4000.
 *   - payout.paid moves the money from 1050 Stripe clearing into 1000 Business
 *     chequing exactly ONCE, however often it is replayed: the same event
 *     again, a second event for the same payout, the daily reconcile.
 *   - The contamination guard: an event from another Stripe account (Trytan's
 *     Arthrisil store has its own) never reaches the OASIS book. It names
 *     another account, or the pinned account's key cannot find it, or nothing
 *     is pinned: ignored and dead-lettered with ids only. A Stripe outage
 *     while checking fails the event (retried), it never skips the check.
 *   - payment.received / refund.issued carry the client record the Stripe
 *     customer is linked to as the ledger's customer_id join.
 *
 * api.stripe.com is served from fixtures only while a Stripe key is set
 * (reads only; a write throws). The Bank of Canada is unreachable.
 *
 * Run: node --conditions=react-server --import tsx tests/founders-finances-stripe-payouts.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "t5-stripe-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "STRIPE_SECRET_KEY", "FOUNDERS_TENANT_IDS", "STRIPE_FINANCE_WEBHOOK_SECRET"]) delete process.env[k];

type Json = Record<string, unknown>;
const PINNED = "acct_1RyM4HHj2zGc7I1J";

/** api.stripe.com while a key is set: the pinned account's objects, and which events it holds. */
const stripe = {
  events: new Set<string>(),
  eventsDown: false,
  accountDown: false,
  invoicePayments: new Map<string, Json[]>(),
  invoices: new Map<string, Json>(),
  payouts: new Map<string, Json>(),
  calls: [] as string[],
};
globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
  const url = new URL(String(input));
  if (url.host !== "api.stripe.com" || !process.env.STRIPE_SECRET_KEY) throw new Error(`network disabled in test: ${url.host}${url.pathname}`);
  if ((init?.method || "GET").toUpperCase() !== "GET") throw new Error(`Stripe write attempted in test: ${url.pathname}`);
  stripe.calls.push(url.pathname);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const list = (data: unknown[]) => json({ object: "list", data, has_more: false });
  const p = url.pathname;
  if (p === "/v1/account") return stripe.accountDown ? json({ error: { message: "api_error" } }, 500) : json({ id: PINNED, settings: { dashboard: { display_name: "OASIS AI" } } });
  if (p.startsWith("/v1/events/")) {
    if (stripe.eventsDown) return json({ error: { message: "api_error" } }, 500);
    const id = decodeURIComponent(p.slice("/v1/events/".length));
    return stripe.events.has(id) ? json({ id, object: "event" }) : json({ error: { type: "invalid_request_error", message: `No such event: '${id}'` } }, 404);
  }
  if (p === "/v1/invoice_payments") return list(stripe.invoicePayments.get(url.searchParams.get("payment[payment_intent]") || "") ?? []);
  if (p.startsWith("/v1/invoices/")) {
    const inv = stripe.invoices.get(decodeURIComponent(p.slice("/v1/invoices/".length)));
    return inv ? json(inv) : json({ error: { message: "No such invoice" } }, 404);
  }
  if (p.startsWith("/v1/payouts/")) {
    const po = stripe.payouts.get(decodeURIComponent(p.slice("/v1/payouts/".length)));
    return po ? json(po) : json({ error: { message: "No such payout" } }, 404);
  }
  if (p === "/v1/payouts") return list([...stripe.payouts.values()]);
  if (["/v1/charges", "/v1/refunds", "/v1/subscriptions", "/v1/balance_transactions"].includes(p)) return list([]);
  return json({ error: { message: "No such object" } }, 404);
}) as typeof fetch;

async function withKey<T>(fn: () => Promise<T>): Promise<T> {
  process.env.STRIPE_SECRET_KEY = "rk_live_t5_test_only";
  try {
    return await fn();
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
}

const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);
let seq = 0;
/** An event from OASIS's account: the pinned account's key finds it. `account` = a Connect-style event naming one. */
const event = (type: string, object: Json, opts: { at?: string; id?: string; account?: string; oasis?: boolean } = {}): Json => {
  const id = opts.id ?? `evt_t5_${++seq}`;
  if (opts.oasis !== false) stripe.events.add(id);
  return { id, object: "event", type, created: epoch(opts.at ?? "2026-09-20T12:00:00Z"), livemode: true, ...(opts.account ? { account: opts.account } : {}), data: { object } };
};

/** A basil-shaped live charge (no `invoice` key) with a CAD balance transaction. */
function charge(p: { id: string; amount: number; at: string; customer?: string; fee?: number }): Json {
  return {
    id: p.id,
    object: "charge",
    amount: p.amount,
    amount_captured: p.amount,
    amount_refunded: 0,
    currency: "cad",
    created: epoch(p.at),
    status: "succeeded",
    paid: true,
    livemode: true,
    payment_intent: `pi_${p.id}`,
    customer: p.customer ?? "cus_t5",
    description: "Subscription update",
    billing_details: { name: "A Client", email: "client@example.test" },
    balance_transaction: { id: `txn_${p.id}`, object: "balance_transaction", amount: p.amount, fee: p.fee ?? 320, net: p.amount - (p.fee ?? 320), currency: "cad", created: epoch(p.at) },
    metadata: {},
    refunds: { object: "list", data: [], has_more: false },
  };
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 8).join("\n        ")}`);
  }
}

const cc = { kind: "founder" as const, ownerKey: "cc" as const, email: "conaugh@oasisai.work", userId: "u-cc" };

async function main() {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  for (const f of ["180_founders_finances.turso.sql", "184_finance_wise_payments.turso.sql", "185_finance_invoice_retainer.turso.sql", "bravo__190_ledger_core.sql", "bravo__193_stripe_payouts.sql"]) {
    await raw.executeMultiple(readFileSync(join(root, "database/turso", f), "utf8"));
  }
  // bravo__188 (client records) alters migration 183's delivery tables, so those come first (as os-honest-numbers does).
  const delivery = readFileSync(join(root, "database/turso/183_delivery_and_support.turso.sql"), "utf8").match(
    /CREATE TABLE IF NOT EXISTS (?:delivery_projects|delivery_tasks|delivery_updates|support_tickets|ticket_comments) \([\s\S]*?\n\);/g,
  );
  assert.equal(delivery?.length, 5);
  await raw.executeMultiple(delivery!.join("\n"));
  await raw.executeMultiple(readFileSync(join(root, "database/turso/bravo__188_os_customers.sql"), "utf8"));
  // With a finance tenant set, the key is read from the tenant's stored credentials: an empty store = no key.
  await raw.execute(`CREATE TABLE tenant_integration_credentials (tenant_id TEXT, service TEXT, field_key TEXT, encrypted_value TEXT)`);
  for (let d = 1; d <= 30; d++) {
    await raw.execute({ sql: `INSERT INTO fin_fx_rates (pair, rate_date, rate) VALUES ('USDCAD', ?, '1.3800')`, args: [`2026-09-${String(d).padStart(2, "0")}`] });
  }

  const { ensureFinanceSeed } = await import("../lib/founders-finances/seed-io");
  const ingest = await import("../lib/founders-finances/stripe-ingest");
  const settingsIo = await import("../lib/founders-finances/settings-io");
  const { accountId, SYS, BUSINESS_ENTITY_ID: B } = await import("../lib/founders-finances/chart");
  await ensureFinanceSeed();
  await raw.execute({ sql: `UPDATE fin_settings SET stripe_account_id = ? WHERE entity_id = ?`, args: [PINNED, B] });

  const CHEQUING = accountId(B, SYS.chequing);
  const CLEARING = accountId(B, SYS.stripeClearing);
  const num = async (sql: string, args: Array<string | number> = []) => Number((await raw.execute({ sql, args })).rows[0][0] ?? 0);
  const payment = async (chargeId: string) =>
    (await raw.execute({ sql: `SELECT id, income_account_id, stripe_invoice_id, entry_id FROM fin_payments WHERE kind = 'payment' AND stripe_charge_id = ?`, args: [chargeId] })).rows[0] as unknown as
      | { id: string; income_account_id: string; stripe_invoice_id: string | null; entry_id: string | null }
      | undefined;
  const creditedTo = async (entryId: string) =>
    (await raw.execute({ sql: `SELECT account_id FROM fin_journal_lines WHERE entry_id = ? AND credit_cents > 0`, args: [entryId] })).rows.map((r) => String(r.account_id));

  // ── subscription revenue ───────────────────────────────────────────────
  await check("a charge whose payment intent paid a subscription invoice books to 4010 Subscription revenue (the charge names no invoice)", async () => {
    stripe.invoicePayments.set("pi_ch_t5_sub", [
      { object: "invoice_payment", status: "paid", invoice: { id: "in_t5_sub", object: "invoice", billing_reason: "subscription_cycle", parent: { subscription_details: { subscription: "sub_t5" } } } },
    ]);
    await withKey(() => ingest.handleStripeEvent(event("charge.succeeded", charge({ id: "ch_t5_sub", amount: 10000, at: "2026-09-05T19:27:56Z" }))));
    const pay = await payment("ch_t5_sub");
    assert.ok(pay, "recorded");
    assert.equal(pay!.income_account_id, accountId(B, SYS.subscriptionRevenue));
    assert.equal(pay!.stripe_invoice_id, "in_t5_sub", "the invoice id the lookup found is kept");
    assert.deepEqual(await creditedTo(String(pay!.entry_id)), [accountId(B, SYS.subscriptionRevenue)], "Cr 4010");
  });

  await check("invoice_payments lists an invoice it did not expand: the invoice is read, and a subscription one still books to 4010", async () => {
    stripe.invoicePayments.set("pi_ch_t5_bare", [{ object: "invoice_payment", status: "paid", invoice: "in_t5_bare" }]);
    stripe.invoices.set("in_t5_bare", { id: "in_t5_bare", object: "invoice", subscription: "sub_t5", billing_reason: "subscription_create" });
    await withKey(() => ingest.handleStripeEvent(event("charge.succeeded", charge({ id: "ch_t5_bare", amount: 10000, at: "2026-09-06T10:00:00Z" }))));
    const pay = await payment("ch_t5_bare");
    assert.equal(pay?.income_account_id, accountId(B, SYS.subscriptionRevenue));
    assert.ok(stripe.calls.includes("/v1/invoices/in_t5_bare"), "the invoice itself was read");
  });

  await check("control: a one-off charge (Stripe lists no invoice for it) books to 4000 Service revenue", async () => {
    await withKey(() => ingest.handleStripeEvent(event("charge.succeeded", charge({ id: "ch_t5_oneoff", amount: 5000, at: "2026-09-07T10:00:00Z" }))));
    assert.equal((await payment("ch_t5_oneoff"))?.income_account_id, accountId(B, SYS.serviceRevenue));
  });

  // ── payouts: clearing to chequing, exactly once ─────────────────────────
  const clearingNet = () => num(`SELECT COALESCE(SUM(cad_debit_cents - cad_credit_cents), 0) FROM fin_journal_lines WHERE account_id = ?`, [CLEARING]);
  const chequingIn = () => num(`SELECT COALESCE(SUM(cad_debit_cents), 0) FROM fin_journal_lines WHERE account_id = ?`, [CHEQUING]);
  const payoutEntries = (id: string) => num(`SELECT COUNT(*) FROM fin_journal_entries WHERE source_ref = ? AND source LIKE 'stripe_payout%' AND status = 'posted'`, [id]);

  await check("payout.paid moves the money from Stripe clearing into Business chequing exactly once, however often it is replayed", async () => {
    await settingsIo.setStripePayoutAccount(cc, "oasis", CHEQUING);
    const inClearing = await clearingNet();
    assert.ok(inClearing > 0, "the charges above are in clearing");
    const po: Json = {
      id: "po_t5_1",
      object: "payout",
      amount: inClearing,
      currency: "cad",
      arrival_date: epoch("2026-09-10T00:00:00Z"),
      created: epoch("2026-09-08T00:00:00Z"),
      status: "paid",
      livemode: true,
      destination: "ba_t5",
      balance_transaction: { id: "txn_po_t5_1", object: "balance_transaction", amount: -inClearing, fee: 0, currency: "cad" },
    };
    stripe.payouts.set("po_t5_1", po);
    const bare = { ...po, balance_transaction: "txn_po_t5_1" };
    const chequingBefore = await chequingIn();
    const first = event("payout.paid", bare, { at: "2026-09-10T08:00:00Z" });
    assert.equal((await withKey(() => ingest.handleStripeEvent(first))).status, "processed");
    assert.equal(await payoutEntries("po_t5_1"), 1, "booked");
    assert.equal(await chequingIn(), chequingBefore + inClearing, "chequing received the payout");
    assert.equal(await clearingNet(), 0, "clearing emptied into the bank");
    // The same event again, a second event for the same payout, and the reconcile listing it.
    assert.equal((await withKey(() => ingest.handleStripeEvent(first))).status, "duplicate");
    await withKey(() => ingest.handleStripeEvent(event("payout.paid", bare, { at: "2026-09-10T09:00:00Z" })));
    await withKey(() => ingest.reconcileStripe({ days: 30 }));
    assert.equal(await payoutEntries("po_t5_1"), 1, "still one booking");
    assert.equal(await chequingIn(), chequingBefore + inClearing, "the deposit is in chequing once");
    assert.equal(await clearingNet(), 0);
  });

  // ── contamination guard ─────────────────────────────────────────────────
  const deadLetters = async () =>
    (await raw.execute(`SELECT idempotency_key, error, payload_json FROM ledger_dead_letters WHERE error LIKE 'foreign_stripe_account:%' ORDER BY first_seen`)).rows.map((r) => ({
      key: String(r.idempotency_key),
      error: String(r.error),
      payload: String(r.payload_json),
    }));
  const bookCounts = async () => [
    await num(`SELECT COUNT(*) FROM fin_payments`),
    await num(`SELECT COUNT(*) FROM fin_journal_entries`),
    await num(`SELECT COUNT(*) FROM outcome_events`),
    await num(`SELECT COUNT(*) FROM fin_subscriptions`),
  ];

  await check("a Trytan-account payload (an event naming another Stripe account) never reaches the OASIS book: ignored, dead-lettered, ids only", async () => {
    const before = await bookCounts();
    const e = event("charge.succeeded", charge({ id: "ch_trytan_1", amount: 14900, at: "2026-09-21T15:00:00Z", customer: "cus_arthrisil" }), { account: "acct_1TrytanArthrisil" });
    const out = await withKey(() => ingest.handleStripeEvent(e));
    assert.equal(out.status, "ignored");
    assert.match(out.detail, /stripe_account_mismatch/);
    assert.deepEqual(await bookCounts(), before, "no payment, no entry, no ledger fact, no subscription");
    assert.equal(await payment("ch_trytan_1"), undefined);
    assert.equal((await raw.execute({ sql: `SELECT status FROM fin_stripe_events WHERE event_id = ?`, args: [String(e.id)] })).rows[0].status, "ignored");
    const dl = (await deadLetters()).find((d) => d.key === `stripe:${e.id}`);
    assert.equal(dl?.error, "foreign_stripe_account:stripe_account_mismatch");
    assert.deepEqual(JSON.parse(dl!.payload), { reason: "stripe_account_mismatch", stripe_account: "acct_1TrytanArthrisil", stripe_event_id: e.id, stripe_event_type: "charge.succeeded" });
    assert.doesNotMatch(dl!.payload, /14900|A Client|client@example/, "no amount, name or email parked");
    // A redelivery is a duplicate: it never gets a second look, and never books.
    assert.equal((await withKey(() => ingest.handleStripeEvent(e))).status, "duplicate");
    assert.deepEqual(await bookCounts(), before);
  });

  await check("a direct-account payload the pinned account's key cannot find (another account's endpoint secret in the wrong variable): refused the same way", async () => {
    const before = await bookCounts();
    const e = event("customer.subscription.created", { id: "sub_trytan", object: "subscription", status: "active", currency: "cad", livemode: true, customer: "cus_arthrisil", items: { data: [] } }, { oasis: false });
    const out = await withKey(() => ingest.handleStripeEvent(e));
    assert.equal(out.status, "ignored");
    assert.deepEqual(await bookCounts(), before);
    assert.equal((await deadLetters()).find((d) => d.key === `stripe:${e.id}`)?.error, "foreign_stripe_account:event_not_in_pinned_account");
  });

  await check("a Stripe outage while checking whose event it is fails the event (Stripe retries); it is never skipped, and the retry books it", async () => {
    const e = event("charge.succeeded", charge({ id: "ch_t5_retry", amount: 7000, at: "2026-09-22T10:00:00Z" }));
    stripe.eventsDown = true;
    try {
      await assert.rejects(withKey(() => ingest.handleStripeEvent(e)));
    } finally {
      stripe.eventsDown = false;
    }
    assert.equal(await payment("ch_t5_retry"), undefined, "nothing booked on a failed check");
    assert.equal((await raw.execute({ sql: `SELECT status FROM fin_stripe_events WHERE event_id = ?`, args: [String(e.id)] })).rows[0].status, "failed");
    assert.equal((await withKey(() => ingest.handleStripeEvent(e))).status, "processed");
    assert.ok(await payment("ch_t5_retry"), "Stripe's retry lands it");
  });

  await check("Stripe cannot say whose the key is (GET /v1/account fails): the event fails and is retried, never booked unchecked", async () => {
    const e = event("charge.succeeded", charge({ id: "ch_t5_acct_down", amount: 4000, at: "2026-09-22T11:00:00Z" }));
    stripe.accountDown = true;
    process.env.STRIPE_SECRET_KEY = "rk_live_t5_uncached_key";
    try {
      await assert.rejects(ingest.handleStripeEvent(e));
    } finally {
      stripe.accountDown = false;
      delete process.env.STRIPE_SECRET_KEY;
    }
    assert.equal(await payment("ch_t5_acct_down"), undefined, "nothing booked");
    assert.equal((await raw.execute({ sql: `SELECT status FROM fin_stripe_events WHERE event_id = ?`, args: [String(e.id)] })).rows[0].status, "failed");
  });

  await check("nothing pinned: no event reaches the books, even with no key to ask Stripe", async () => {
    await raw.execute({ sql: `UPDATE fin_settings SET stripe_account_id = NULL WHERE entity_id = ?`, args: [B] });
    try {
      const before = await bookCounts();
      const out = await ingest.handleStripeEvent(event("charge.succeeded", charge({ id: "ch_t5_unpinned", amount: 3000, at: "2026-09-23T10:00:00Z" })));
      assert.equal(out.status, "ignored");
      assert.deepEqual(await bookCounts(), before);
    } finally {
      await raw.execute({ sql: `UPDATE fin_settings SET stripe_account_id = ? WHERE entity_id = ?`, args: [PINNED, B] });
    }
  });

  await check("control: with no key, an OASIS event on the pinned book is proved by the endpoint's secret and recorded", async () => {
    await ingest.handleStripeEvent(event("charge.succeeded", charge({ id: "ch_t5_nokey", amount: 2000, at: "2026-09-24T10:00:00Z" })));
    assert.ok(await payment("ch_t5_nokey"));
  });

  // ── the ledger's customer join ──────────────────────────────────────────
  await check("payment.received and refund.issued carry the client record the Stripe customer is linked to (customer_id); none linked: null", async () => {
    const TENANT = "oasis-books-t5";
    process.env.FOUNDERS_TENANT_IDS = TENANT;
    try {
      await raw.execute({
        sql: `INSERT INTO customers (id, tenant_id, display_name, lifecycle, stripe_customer_id, created_at, updated_at) VALUES ('cust_t5_linked', ?, 'Linked Client', 'active', 'cus_linked', ?, ?)`,
        args: [TENANT, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z"],
      });
      const refundOf = (id: string, amount: number): Json => ({ id, object: "refund", amount, currency: "cad", created: epoch("2026-09-26T10:00:00Z"), status: "succeeded", charge: "ch_t5_linked", balance_transaction: null });
      await ingest.handleStripeEvent(event("charge.succeeded", charge({ id: "ch_t5_linked", amount: 10000, at: "2026-09-25T10:00:00Z", customer: "cus_linked" })));
      await ingest.handleStripeEvent(event("charge.succeeded", charge({ id: "ch_t5_unlinked", amount: 10000, at: "2026-09-25T11:00:00Z", customer: "cus_nobody" })));
      await ingest.handleStripeEvent(
        event("charge.refunded", { ...charge({ id: "ch_t5_linked", amount: 10000, at: "2026-09-25T10:00:00Z", customer: "cus_linked" }), amount_refunded: 2500, refunds: { object: "list", data: [refundOf("re_t5_linked", 2500)], has_more: false } }, { at: "2026-09-26T10:00:00Z" }),
      );
      const facts = async (key: string) =>
        (await raw.execute({ sql: `SELECT idempotency_key, customer_id, tenant_id FROM outcome_events WHERE event_key = ? ORDER BY idempotency_key`, args: [key] })).rows.map((r) => [String(r.idempotency_key), r.customer_id, r.tenant_id]);
      assert.deepEqual(await facts("payment.received"), [
        ["stripe:ch_t5_linked", "cust_t5_linked", TENANT],
        ["stripe:ch_t5_unlinked", null, TENANT],
      ]);
      assert.deepEqual(await facts("refund.issued"), [["stripe:re_t5_linked", "cust_t5_linked", TENANT]]);
    } finally {
      delete process.env.FOUNDERS_TENANT_IDS;
    }
  });

  await check("the books still balance after everything", async () => {
    assert.equal(await num(`SELECT COUNT(*) FROM (SELECT entry_id, SUM(cad_debit_cents) d, SUM(cad_credit_cents) c FROM fin_journal_lines GROUP BY entry_id HAVING d <> c)`), 0);
  });

  if (failures) {
    console.error(`founders-finances-stripe-payouts: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("founders-finances-stripe-payouts: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
