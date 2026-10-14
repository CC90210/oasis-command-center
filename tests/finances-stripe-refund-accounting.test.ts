/**
 * Refund accounting invariants against a disposable local libSQL database.
 *
 * A refund of an invoice payment reverses settlement (Dr AR / Cr Stripe
 * clearing); it does not cancel the sale. Both Stripe delivery orders must
 * converge: invoice metadata before the refund, or refund before metadata.
 * No provider call is allowed in this test.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "finances-refund-accounting-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
for (const key of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "STRIPE_SECRET_KEY", "FOUNDERS_TENANT_IDS"]) delete process.env[key];

globalThis.fetch = (async () => {
  throw new Error("network disabled: refund accounting test must not call a provider");
}) as typeof fetch;

const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

async function main() {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  for (const migration of ["180_founders_finances.turso.sql", "bravo__190_ledger_core.sql"]) {
    await raw.executeMultiple(readFileSync(join(root, "database/turso", migration), "utf8"));
  }

  const { ensureFinanceSeed } = await import("../lib/founders-finances/seed-io");
  const { BUSINESS_ENTITY_ID: B, SYS, accountId } = await import("../lib/founders-finances/chart");
  const { buildPosting } = await import("../lib/founders-finances/ledger-io");
  const { writeBatch } = await import("../lib/founders-finances/db");
  const { recordRefundsForCharge, recordStripeCharge, linkPaymentToInvoice } = await import(
    "../lib/founders-finances/stripe-ingest"
  );
  const { voidInvoice } = await import("../lib/founders-finances/invoices-io");
  await ensureFinanceSeed();
  await raw.execute({
    sql: `UPDATE fin_settings SET stripe_account_id = 'acct_refund_accounting_test' WHERE entity_id = ?`,
    args: [B],
  });

  const AR = accountId(B, SYS.ar);
  const CLEARING = accountId(B, SYS.stripeClearing);
  const REVENUE = accountId(B, SYS.serviceRevenue);
  const REFUNDS = accountId(B, SYS.refunds);
  const cc = { kind: "founder" as const, ownerKey: "cc" as const, email: "conaugh@oasisai.work", userId: "u-cc" };

  const createInvoice = async (slug: string, paid: boolean) => {
    const invoiceId = `inv_${slug}`;
    const paymentId = `pay_${slug}`;
    const contactId = `con_${slug}`;
    const chargeId = `ch_${slug}`;
    const customerId = `cus_${slug}`;
    await raw.batch([
      {
        sql: `INSERT INTO fin_contacts (id, entity_id, kind, name, email, stripe_customer_id)
              VALUES (?, ?, 'customer', ?, '', ?)`,
        args: [contactId, B, `Customer ${slug}`, customerId],
      },
      {
        sql: `INSERT INTO fin_invoices
                (id, entity_id, contact_id, number, status, issue_date, due_date, currency,
                 subtotal_cents, total_cents, amount_paid_cents, sent_at, paid_at, created_by)
              VALUES (?, ?, ?, ?, ?, '2026-09-01', '2099-01-01', 'CAD',
                      10000, 10000, ?, '2026-09-01T12:00:00.000Z', ?, 'test')`,
        args: [
          invoiceId,
          B,
          contactId,
          `OASIS-${slug.toUpperCase()}`,
          paid ? "paid" : "sent",
          paid ? 10000 : 0,
          paid ? "2026-09-02T12:00:00.000Z" : null,
        ],
      },
      ...(paid
        ? [
            {
              sql: `INSERT INTO fin_payments
                      (id, entity_id, kind, source, occurred_at, occurred_on, amount_cents, currency,
                       settlement_cad_cents, fee_status, invoice_id, contact_id, customer_name,
                       stripe_customer_id, stripe_charge_id, deposit_account_id, income_account_id,
                       description, livemode, created_by)
                    VALUES (?, ?, 'payment', 'stripe', '2026-09-02T12:00:00.000Z', '2026-09-02', 10000, 'CAD',
                            10000, 'none', ?, ?, ?, ?, ?, ?, ?, 'Invoice payment', 1, 'stripe')`,
              args: [paymentId, B, invoiceId, contactId, `Customer ${slug}`, customerId, chargeId, CLEARING, REVENUE],
            },
          ]
        : []),
    ]);

    const recognition = await buildPosting({
      entityId: B,
      entryDate: "2026-09-01",
      memo: `Invoice ${slug} issued`,
      source: "invoice",
      sourceRef: invoiceId,
      createdBy: "test",
      lines: [
        { accountId: AR, currency: "CAD", debitCents: 10000, contactId },
        { accountId: REVENUE, currency: "CAD", creditCents: 10000, contactId },
      ],
    });
    const statements = [
      ...recognition.statements,
      {
        sql: `UPDATE fin_invoices SET recognition_entry_id = ? WHERE id = ?`,
        args: [recognition.entryId, invoiceId],
      },
    ];
    if (paid) {
      const settlement = await buildPosting({
        entityId: B,
        entryDate: "2026-09-02",
        memo: `Invoice ${slug} paid`,
        source: "stripe_charge",
        sourceRef: chargeId,
        createdBy: "test",
        lines: [
          { accountId: CLEARING, currency: "CAD", debitCents: 10000, contactId },
          { accountId: AR, currency: "CAD", creditCents: 10000, contactId },
        ],
      });
      statements.push(
        ...settlement.statements,
        {
          sql: `UPDATE fin_payments SET entry_id = ? WHERE id = ?`,
          args: [settlement.entryId, paymentId],
        },
      );
    }
    await writeBatch(statements);
    return { invoiceId, paymentId, contactId, chargeId, customerId };
  };

  const refund = (id: string, amountCents: number, chargeId: string, at = "2026-09-03T12:00:00.000Z") => ({
    refundId: id,
    chargeId,
    amountCents,
    currency: "CAD",
    created: epoch(at),
    balanceTxnId: null,
    balanceTxn: null,
    status: "succeeded",
  });
  const charge = (args: {
    chargeId: string;
    amountCents: number;
    refundedCents?: number;
    refunds?: ReturnType<typeof refund>[];
    customerId: string;
    invoiceId?: string | null;
    at?: string;
  }) => ({
    chargeId: args.chargeId,
    paymentIntentId: `pi_${args.chargeId}`,
    stripeInvoiceId: null,
    subscriptionInvoice: false,
    customerId: args.customerId,
    customerName: "Refund customer",
    customerEmail: "",
    amountCents: args.amountCents,
    amountRefundedCents: args.refundedCents ?? 0,
    currency: "CAD",
    created: epoch(args.at ?? "2026-09-02T12:00:00.000Z"),
    balanceTxnId: null,
    balanceTxn: null,
    livemode: true,
    succeeded: true,
    description: "",
    metadata: { finInvoiceId: args.invoiceId ?? null, finEntityId: args.invoiceId ? B : null, finInvoicePriceId: null },
    refunds: args.refunds ?? [],
  });
  const invoice = async (id: string) => {
    const result = await raw.execute({
      sql: `SELECT status, amount_paid_cents, paid_at FROM fin_invoices WHERE id = ?`,
      args: [id],
    });
    return result.rows[0];
  };
  const accountNet = async (contactId: string, account: string, natural: "debit" | "credit") => {
    const result = await raw.execute({
      sql: `SELECT COALESCE(SUM(debit_cents), 0) AS debit, COALESCE(SUM(credit_cents), 0) AS credit
              FROM fin_journal_lines WHERE contact_id = ? AND account_id = ?`,
      args: [contactId, account],
    });
    const debit = Number(result.rows[0].debit);
    const credit = Number(result.rows[0].credit);
    return natural === "debit" ? debit - credit : credit - debit;
  };
  const assertBooks = async (
    row: { contactId: string },
    expected: { ar: number; clearing: number; revenue: number; refunds?: number },
  ) => {
    assert.equal(await accountNet(row.contactId, AR, "debit"), expected.ar, "AR agrees with the invoice balance");
    assert.equal(await accountNet(row.contactId, CLEARING, "debit"), expected.clearing, "Stripe clearing agrees with net cash");
    assert.equal(await accountNet(row.contactId, REVENUE, "credit"), expected.revenue, "issued revenue is unchanged by a settlement refund");
    assert.equal(await accountNet(row.contactId, REFUNDS, "debit"), expected.refunds ?? 0, "invoice refunds do not remain contra-revenue");
  };

  // Invoice link first, refund second.
  const linked = await createInvoice("linked_first", true);
  const linkedRefund = refund("re_linked_first", 2500, linked.chargeId);
  assert.equal(
    await recordRefundsForCharge(
      linked.paymentId,
      charge({ chargeId: linked.chargeId, amountCents: 10000, refundedCents: 2500, refunds: [linkedRefund], customerId: linked.customerId, invoiceId: linked.invoiceId }),
      [linkedRefund],
      { fetchFees: false },
    ),
    1,
  );
  assert.deepEqual({ ...(await invoice(linked.invoiceId)) }, { status: "sent", amount_paid_cents: 7500, paid_at: null });
  await assertBooks(linked, { ar: 2500, clearing: 7500, revenue: 10000 });

  const recollected = await recordStripeCharge(
    charge({ chargeId: "ch_linked_recollect", amountCents: 2500, customerId: linked.customerId, invoiceId: linked.invoiceId, at: "2026-09-04T12:00:00.000Z" }),
    { fetchFees: false },
  );
  assert.equal(recollected.created, true);
  assert.deepEqual(
    { ...(await invoice(linked.invoiceId)) },
    { status: "paid", amount_paid_cents: 10000, paid_at: "2026-09-04T12:00:00.000Z" },
  );
  await assertBooks(linked, { ar: 0, clearing: 10000, revenue: 10000 });

  // Refund first, invoice metadata link second. The link transaction must add
  // both the gross payment reclass and the refund reclass.
  const later = await createInvoice("linked_later", false);
  const unlinkedPayment = await recordStripeCharge(
    charge({ chargeId: later.chargeId, amountCents: 10000, customerId: later.customerId }),
    { fetchFees: false },
  );
  assert.ok(unlinkedPayment.paymentId);
  const earlierRefund = refund("re_linked_later", 2500, later.chargeId);
  assert.equal(
    await recordRefundsForCharge(
      unlinkedPayment.paymentId as string,
      charge({ chargeId: later.chargeId, amountCents: 10000, refundedCents: 2500, refunds: [earlierRefund], customerId: later.customerId }),
      [earlierRefund],
      { fetchFees: false },
    ),
    1,
  );
  assert.equal(await linkPaymentToInvoice(unlinkedPayment.paymentId as string, later.invoiceId), true);
  assert.deepEqual({ ...(await invoice(later.invoiceId)) }, { status: "sent", amount_paid_cents: 7500, paid_at: null });
  await assertBooks(later, { ar: 2500, clearing: 7500, revenue: 10000 });
  assert.equal(
    Number(
      (
        await raw.execute({
          sql: `SELECT COUNT(*) AS n FROM fin_journal_entries WHERE source = 'stripe_refund_invoice_link' AND source_ref = ?`,
          args: [earlierRefund.refundId],
        })
      ).rows[0].n,
    ),
    1,
    "the pre-link refund is reclassified exactly once",
  );

  await recordStripeCharge(
    charge({ chargeId: "ch_later_recollect", amountCents: 2500, customerId: later.customerId, invoiceId: later.invoiceId, at: "2026-09-04T12:00:00.000Z" }),
    { fetchFees: false },
  );
  await assertBooks(later, { ar: 0, clearing: 10000, revenue: 10000 });

  // A row/event committed by older code before its journal failed must heal
  // on the next delivery instead of staying off-books forever.
  const repair = await createInvoice("repair", true);
  await raw.execute({
    sql: `INSERT INTO fin_payments
            (id, entity_id, kind, source, occurred_at, occurred_on, amount_cents, currency,
             settlement_cad_cents, fee_status, parent_payment_id, invoice_id, contact_id,
             customer_name, stripe_customer_id, stripe_refund_id, deposit_account_id,
             income_account_id, description, livemode, created_by)
          VALUES ('ref_repair', ?, 'refund', 'stripe', '2026-09-03T12:00:00.000Z', '2026-09-03',
                  2500, 'CAD', 2500, 'none', ?, ?, ?, 'Repair customer', ?, 're_repair', ?, ?,
                  'Stripe refund', 1, 'stripe')`,
    args: [B, repair.paymentId, repair.invoiceId, repair.contactId, repair.customerId, CLEARING, REFUNDS],
  });
  const repairRefund = refund("re_repair", 2500, repair.chargeId);
  assert.equal(
    await recordRefundsForCharge(
      repair.paymentId,
      charge({ chargeId: repair.chargeId, amountCents: 10000, refundedCents: 2500, refunds: [repairRefund], customerId: repair.customerId, invoiceId: repair.invoiceId }),
      [repairRefund],
      { fetchFees: false },
    ),
    0,
  );
  await assertBooks(repair, { ar: 2500, clearing: 7500, revenue: 10000 });
  assert.equal(
    Number((await raw.execute(`SELECT COUNT(*) AS n FROM fin_payments WHERE id = 'ref_repair' AND entry_id IS NOT NULL`)).rows[0].n),
    1,
    "the replay adopts the repaired refund journal",
  );

  // A full settlement reversal followed by a void clears AR and recognised
  // revenue; it never leaves a negative receivable.
  const voided = await createInvoice("full_refund_void", true);
  const fullRefund = refund("re_full_refund_void", 10000, voided.chargeId);
  await recordRefundsForCharge(
    voided.paymentId,
    charge({ chargeId: voided.chargeId, amountCents: 10000, refundedCents: 10000, refunds: [fullRefund], customerId: voided.customerId, invoiceId: voided.invoiceId }),
    [fullRefund],
    { fetchFees: false },
  );
  await assertBooks(voided, { ar: 10000, clearing: 0, revenue: 10000 });
  await voidInvoice(cc, voided.invoiceId);
  assert.equal((await invoice(voided.invoiceId)).status, "void");
  await assertBooks(voided, { ar: 0, clearing: 0, revenue: 0 });

  const unbalanced = Number(
    (
      await raw.execute(
        `SELECT COUNT(*) AS n FROM (
           SELECT entry_id, currency FROM fin_journal_lines
           GROUP BY entry_id, currency HAVING SUM(debit_cents) <> SUM(credit_cents)
         )`,
      )
    ).rows[0].n,
  );
  assert.equal(unbalanced, 0, "every journal remains balanced by currency");
  console.log("finances-stripe-refund-accounting: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
