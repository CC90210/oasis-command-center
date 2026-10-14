/**
 * Stripe refunds must reverse the amount applied to their parent invoice.
 *
 * This is deliberately an integration test against real local libSQL. It
 * proves the refund row, invoice lifecycle, Business Ledger event and journal
 * stay idempotent together without making a provider call.
 *
 * Run: node --conditions=react-server --import tsx tests/finances-stripe-refund-lifecycle.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "finances-refund-lifecycle-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.FOUNDERS_TENANT_IDS = "oasis-books-test";
for (const key of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "STRIPE_SECRET_KEY"]) delete process.env[key];

globalThis.fetch = (async () => {
  throw new Error("network disabled: refund lifecycle test must not call a provider");
}) as typeof fetch;

const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

async function main() {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  for (const migration of ["180_founders_finances.turso.sql", "bravo__190_ledger_core.sql"]) {
    await raw.executeMultiple(readFileSync(join(root, "database/turso", migration), "utf8"));
  }

  const { ensureFinanceSeed } = await import("../lib/founders-finances/seed-io");
  const { BUSINESS_ENTITY_ID, SYS, accountId } = await import("../lib/founders-finances/chart");
  const { recordRefundsForCharge } = await import("../lib/founders-finances/stripe-ingest");
  await ensureFinanceSeed();
  await raw.execute({
    sql: `UPDATE fin_settings SET stripe_account_id = 'acct_refund_lifecycle_test' WHERE entity_id = ?`,
    args: [BUSINESS_ENTITY_ID],
  });
  await raw.execute({
    sql: `INSERT INTO fin_contacts (id, entity_id, kind, name, email) VALUES ('con_refund_test', ?, 'customer', 'Refund Test', '')`,
    args: [BUSINESS_ENTITY_ID],
  });

  const createPaidInvoice = async (id: string, number: string, dueDate: string, paymentId: string, chargeId: string) => {
    await raw.batch([
      {
        sql: `INSERT INTO fin_invoices
                (id, entity_id, contact_id, number, status, issue_date, due_date, currency,
                 subtotal_cents, total_cents, amount_paid_cents, sent_at, paid_at, created_by)
              VALUES (?, ?, 'con_refund_test', ?, 'paid', '2026-09-01', ?, 'CAD',
                      10000, 10000, 10000, '2026-09-01T12:00:00.000Z', '2026-09-02T12:00:00.000Z', 'test')`,
        args: [id, BUSINESS_ENTITY_ID, number, dueDate],
      },
      {
        sql: `INSERT INTO fin_payments
                (id, entity_id, kind, source, occurred_at, occurred_on, amount_cents, currency,
                 settlement_cad_cents, fee_status, invoice_id, contact_id, stripe_charge_id,
                 deposit_account_id, income_account_id, description, livemode, created_by)
              VALUES (?, ?, 'payment', 'stripe', '2026-09-02T12:00:00.000Z', '2026-09-02', 10000, 'CAD',
                      10000, 'none', ?, 'con_refund_test', ?, ?, ?, 'Invoice payment', 1, 'stripe')`,
        args: [
          paymentId,
          BUSINESS_ENTITY_ID,
          id,
          chargeId,
          accountId(BUSINESS_ENTITY_ID, SYS.stripeClearing),
          accountId(BUSINESS_ENTITY_ID, SYS.serviceRevenue),
        ],
      },
    ]);
  };

  await createPaidInvoice("inv_refund_future", "OASIS-REF-FUTURE", "2099-01-01", "pay_refund_future", "ch_refund_future");
  await createPaidInvoice("inv_refund_past", "OASIS-REF-PAST", "2000-01-01", "pay_refund_past", "ch_refund_past");
  await createPaidInvoice("inv_refund_other", "OASIS-REF-OTHER", "2099-01-01", "pay_refund_other", "ch_refund_other");

  const refund = (refundId: string, amountCents: number, created: string, chargeId: string) => ({
    refundId,
    chargeId,
    amountCents,
    currency: "CAD",
    created: epoch(created),
    balanceTxnId: null,
    balanceTxn: null,
    status: "succeeded",
  });
  const charge = (chargeId: string, amountRefundedCents: number, refunds: ReturnType<typeof refund>[]) => ({
    chargeId,
    paymentIntentId: `pi_${chargeId}`,
    stripeInvoiceId: null,
    subscriptionInvoice: false,
    customerId: null,
    customerName: "",
    customerEmail: "",
    amountCents: 10000,
    amountRefundedCents,
    currency: "CAD",
    created: epoch("2026-09-02T12:00:00.000Z"),
    balanceTxnId: null,
    balanceTxn: null,
    livemode: true,
    succeeded: true,
    description: "",
    metadata: { finInvoiceId: null, finEntityId: null, finInvoicePriceId: null },
    refunds,
  });
  const invoice = async (id: string) => {
    const result = await raw.execute({
      sql: `SELECT status, total_cents, amount_paid_cents, paid_at FROM fin_invoices WHERE id = ?`,
      args: [id],
    });
    assert.equal(result.rows.length, 1);
    return result.rows[0];
  };
  const count = async (sql: string, args: Array<string | number> = []) =>
    Number((await raw.execute({ sql, args })).rows[0][0]);

  const partial = refund("re_refund_partial", 2500, "2026-09-03T12:00:00.000Z", "ch_refund_future");
  assert.equal(
    await recordRefundsForCharge("pay_refund_future", charge("ch_refund_future", 2500, [partial]), [partial], { fetchFees: false }),
    1,
  );
  assert.deepEqual(
    { ...(await invoice("inv_refund_future")) },
    { status: "sent", total_cents: 10000, amount_paid_cents: 7500, paid_at: null },
    "a partial refund reopens the invoice with the founder-facing partial-payment facts",
  );

  assert.equal(
    await recordRefundsForCharge("pay_refund_future", charge("ch_refund_future", 2500, [partial]), [partial], { fetchFees: false }),
    0,
    "a replay does not insert the Stripe refund twice",
  );
  assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE stripe_refund_id = 're_refund_partial'`), 1);
  assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'stripe_refund' AND source_ref = 're_refund_partial'`), 1);
  assert.equal(await count(`SELECT COUNT(*) FROM outcome_events WHERE event_key = 'refund.issued' AND idempotency_key = 'stripe:re_refund_partial'`), 1);

  // The parent payment is the source of truth. A stale or malformed copied
  // invoice_id on the refund must neither stop the reduction nor touch that
  // other invoice when Stripe replays the event.
  await raw.execute(`UPDATE fin_payments SET invoice_id = 'inv_refund_other' WHERE stripe_refund_id = 're_refund_partial'`);
  assert.equal(
    await recordRefundsForCharge("pay_refund_future", charge("ch_refund_future", 2500, [partial]), [partial], { fetchFees: false }),
    0,
  );
  assert.equal(Number((await invoice("inv_refund_future")).amount_paid_cents), 7500);
  assert.equal(Number((await invoice("inv_refund_other")).amount_paid_cents), 10000, "a copied foreign invoice id has no cross-invoice effect");

  const remainder = refund("re_refund_remainder", 7500, "2026-09-04T12:00:00.000Z", "ch_refund_future");
  assert.equal(
    await recordRefundsForCharge("pay_refund_future", charge("ch_refund_future", 10000, [remainder]), [remainder], { fetchFees: false }),
    1,
  );
  assert.deepEqual(
    { ...(await invoice("inv_refund_future")) },
    { status: "sent", total_cents: 10000, amount_paid_cents: 0, paid_at: null },
    "a full refund restores the full balance without making the applied amount negative",
  );
  assert.equal(
    await recordRefundsForCharge(
      "pay_refund_future",
      charge("ch_refund_future", 10000, [refund("re_refund_over_cap", 1, "2026-09-05T12:00:00.000Z", "ch_refund_future")]),
      [refund("re_refund_over_cap", 1, "2026-09-05T12:00:00.000Z", "ch_refund_future")],
      { fetchFees: false },
    ),
    0,
    "Stripe's cumulative cap prevents over-refunding the parent payment",
  );
  assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE parent_payment_id = 'pay_refund_future' AND kind = 'refund'`), 2);
  assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'stripe_refund'`), 2);

  const pastPartial = refund("re_refund_past_partial", 3000, "2026-09-03T12:00:00.000Z", "ch_refund_past");
  assert.equal(
    await recordRefundsForCharge("pay_refund_past", charge("ch_refund_past", 3000, [pastPartial]), [pastPartial], { fetchFees: false }),
    1,
  );
  assert.deepEqual(
    { ...(await invoice("inv_refund_past")) },
    { status: "overdue", total_cents: 10000, amount_paid_cents: 7000, paid_at: null },
    "an unpaid balance past its due date reopens overdue",
  );
  assert.deepEqual(
    { ...(await invoice("inv_refund_other")) },
    { status: "paid", total_cents: 10000, amount_paid_cents: 10000, paid_at: "2026-09-02T12:00:00.000Z" },
    "a refund changes only its parent invoice",
  );

  assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE kind = 'payment'`), 3, "original payment history is retained");
  assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE kind = 'refund'`), 3, "refund history is retained");
  console.log("finances-stripe-refund-lifecycle: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
