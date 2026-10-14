/**
 * Focused regressions for the Money provider/settings integrity pass.
 *
 * Uses a real local libSQL database. Network is fixture-only: no provider
 * writes, and the only Stripe reads are the two cache-identity probes.
 *
 * Run: node --conditions=react-server --import tsx tests/finances-provider-settings.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "fin-provider-settings-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
for (const key of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "STRIPE_SECRET_KEY", "FOUNDERS_TENANT_IDS"]) delete process.env[key];

let stripeAccountCalls = 0;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.host !== "api.stripe.com" || url.pathname !== "/v1/account") {
    throw new Error(`network disabled in test: ${url.host}${url.pathname}`);
  }
  stripeAccountCalls += 1;
  const authorization = new Headers(init?.headers).get("authorization") || "";
  const account = authorization.includes("company_a") ? "acct_company_a" : "acct_company_b";
  return new Response(JSON.stringify({ id: account, settings: { dashboard: { display_name: account } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

let failures = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    console.log(`  FAIL  ${name}\n        ${detail.split("\n").slice(0, 8).join("\n        ")}`);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cc = { kind: "founder" as const, ownerKey: "cc" as const, email: "conaugh@oasisai.work", userId: "u-cc" };

async function main(): Promise<void> {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  for (const migration of [
    "180_founders_finances.turso.sql",
    "184_finance_wise_payments.turso.sql",
    "185_finance_invoice_retainer.turso.sql",
    "bravo__190_ledger_core.sql",
    "bravo__193_stripe_payouts.sql",
  ]) {
    await raw.executeMultiple(readFileSync(join(root, "database/turso", migration), "utf8"));
  }

  const { ensureFinanceSeed } = await import("../lib/founders-finances/seed-io");
  const access = await import("../lib/founders-finances/access-io");
  const bills = await import("../lib/founders-finances/bills-io");
  const invoices = await import("../lib/founders-finances/invoices-io");
  const settings = await import("../lib/founders-finances/settings-io");
  const payouts = await import("../lib/founders-finances/stripe-payouts-io");
  const stripeIo = await import("../lib/founders-finances/stripe-io");
  const { buildPosting } = await import("../lib/founders-finances/ledger-io");
  const { writeBatch } = await import("../lib/founders-finances/db");
  const { getTursoClient } = await import("../lib/turso");
  const { accountId, categoryId, BUSINESS_ENTITY_ID: B, SYS } = await import("../lib/founders-finances/chart");
  await ensureFinanceSeed();

  const CHEQUING = accountId(B, SYS.chequing);
  const CLEARING = accountId(B, SYS.stripeClearing);
  const SOFTWARE = categoryId(B, "5100");
  const count = async (sql: string, args: Array<string | number | null> = []) => Number((await raw.execute({ sql, args })).rows[0][0] ?? 0);

  async function withBatchRace<T>(
    match: (batchJson: string) => boolean,
    race: () => Promise<void>,
    fn: () => Promise<T>,
  ): Promise<{ result: T; raced: boolean }> {
    const client = getTursoClient() as unknown as Record<string, unknown>;
    const original = (Object.getPrototypeOf(client) as { batch: (...args: unknown[]) => Promise<unknown> }).batch;
    let raced = false;
    client.batch = async function (this: unknown, statements: unknown, ...rest: unknown[]) {
      if (!raced && match(JSON.stringify(statements))) {
        raced = true;
        await race();
      }
      return original.call(this, statements, ...rest);
    };
    try {
      return { result: await fn(), raced };
    } finally {
      delete client.batch;
    }
  }

  async function addClearing(id: string, amountCents: number, date: string): Promise<void> {
    const posting = await buildPosting({
      entityId: B,
      entryDate: date,
      memo: `Clearing fixture ${id}`,
      source: "test_clearing",
      sourceRef: id,
      createdBy: "test",
      lines: [
        { accountId: CLEARING, currency: "CAD", debitCents: amountCents },
        { accountId: accountId(B, SYS.serviceRevenue), currency: "CAD", creditCents: amountCents },
      ],
    });
    await writeBatch(posting.statements);
  }

  const payoutFacts = (id: string, status: "paid" | "failed" | "canceled", amountCents: number, arrivalDate: string) => ({
    payoutId: id,
    status,
    amountCents,
    currency: "CAD",
    arrivalDate,
    created: 1,
    livemode: true,
    settlementCents: amountCents,
    settlementCurrency: "CAD",
    feeCents: 0,
    balanceTxnId: `txn_${id}`,
    destinationId: "ba_test",
    failureCode: status === "paid" ? null : `test_${status}`,
  });

  await check("registration effective date controls dated invoices and bills, including the boundary day", async () => {
    await raw.execute({
      sql: `UPDATE fin_settings
               SET gst_qst_registered = 1, gst_number = '123456789RT0001', qst_number = '1234567890TQ0001',
                   registration_effective_date = '2026-07-01'
             WHERE entity_id = ?`,
      args: [B],
    });

    const before = await invoices.createDraftInvoice(cc, B, {
      new_contact: { name: "Before registration", email: "before@example.test" },
      issue_date: "2026-06-30",
      currency: "CAD",
      lines: [{ description: "Before", quantity: 1, unit_price: "100.00" }],
    });
    const beforeDraft = (await raw.execute({ sql: `SELECT gst_cents, qst_cents, total_cents, tax_registered_snapshot FROM fin_invoices WHERE id = ?`, args: [before] })).rows[0];
    assert.deepEqual([Number(beforeDraft.gst_cents), Number(beforeDraft.qst_cents), Number(beforeDraft.total_cents), Number(beforeDraft.tax_registered_snapshot)], [0, 0, 10_000, 0]);
    const beforeIssued = await invoices.finalizeInvoice(cc, before);
    assert.deepEqual([beforeIssued.gst_cents, beforeIssued.qst_cents, beforeIssued.total_cents, beforeIssued.tax_registered_snapshot], [0, 0, 10_000, 0]);

    const boundary = await invoices.createDraftInvoice(cc, B, {
      new_contact: { name: "Registration boundary", email: "boundary@example.test" },
      issue_date: "2026-07-01",
      currency: "CAD",
      lines: [{ description: "Boundary", quantity: 1, unit_price: "100.00" }],
    });
    let boundaryDraft = (await raw.execute({ sql: `SELECT contact_id, gst_cents, qst_cents, total_cents, tax_registered_snapshot FROM fin_invoices WHERE id = ?`, args: [boundary] })).rows[0];
    assert.deepEqual([Number(boundaryDraft.gst_cents), Number(boundaryDraft.qst_cents), Number(boundaryDraft.total_cents), Number(boundaryDraft.tax_registered_snapshot)], [500, 998, 11_498, 1]);
    await invoices.updateDraftInvoice(cc, boundary, {
      contact_id: String(boundaryDraft.contact_id),
      issue_date: "2026-06-30",
      currency: "CAD",
      lines: [{ description: "Boundary", quantity: 1, unit_price: "100.00" }],
    });
    boundaryDraft = (await raw.execute({ sql: `SELECT contact_id, gst_cents, qst_cents, total_cents, tax_registered_snapshot FROM fin_invoices WHERE id = ?`, args: [boundary] })).rows[0];
    assert.deepEqual([Number(boundaryDraft.gst_cents), Number(boundaryDraft.qst_cents), Number(boundaryDraft.total_cents), Number(boundaryDraft.tax_registered_snapshot)], [0, 0, 10_000, 0], "editing across the effective date re-totals the draft");
    await invoices.updateDraftInvoice(cc, boundary, {
      contact_id: String(boundaryDraft.contact_id),
      issue_date: "2026-07-01",
      currency: "CAD",
      lines: [{ description: "Boundary", quantity: 1, unit_price: "100.00" }],
    });
    const boundaryIssued = await invoices.finalizeInvoice(cc, boundary);
    assert.deepEqual([boundaryIssued.gst_cents, boundaryIssued.qst_cents, boundaryIssued.total_cents, boundaryIssued.tax_registered_snapshot], [500, 998, 11_498, 1]);

    const beforeBill = await bills.createBill(cc, B, {
      kind: "expense",
      vendor_name: "Before-date expense",
      bill_date: "2026-06-30",
      subtotal: "100.00",
      gst: "5.00",
      qst: "9.98",
      currency: "CAD",
      category_id: SOFTWARE,
      paid_from_account_id: CHEQUING,
    });
    const afterBill = await bills.createBill(cc, B, {
      kind: "expense",
      vendor_name: "Boundary-date expense",
      bill_date: "2026-07-01",
      subtotal: "100.00",
      gst: "5.00",
      qst: "9.98",
      currency: "CAD",
      category_id: SOFTWARE,
      paid_from_account_id: CHEQUING,
    });
    const billLegs = async (id: string) =>
      (await raw.execute({
        sql: `SELECT l.account_id, l.debit_cents FROM fin_journal_lines l
               JOIN fin_bills b ON b.entry_id = l.entry_id WHERE b.id = ? AND l.debit_cents > 0 ORDER BY l.line_no`,
        args: [id],
      })).rows.map((row) => [String(row.account_id), Number(row.debit_cents)]);
    assert.deepEqual(await billLegs(beforeBill), [[accountId(B, "5100"), 11_498]], "before registration, tax is part of cost");
    assert.deepEqual(await billLegs(afterBill), [
      [accountId(B, "5100"), 10_000],
      [accountId(B, SYS.gstReceivable), 500],
      [accountId(B, SYS.qstReceivable), 998],
    ]);
  });

  await check("bill pay and void race has one winner, no orphan reversal, and truthful audit", async () => {
    const id = await bills.createBill(cc, B, {
      kind: "bill",
      vendor_name: "Race vendor",
      bill_date: "2026-10-01",
      due_date: "2026-10-10",
      subtotal: "40.00",
      currency: "CAD",
      category_id: SOFTWARE,
    });
    const before = (await raw.execute({ sql: `SELECT entry_id FROM fin_bills WHERE id = ?`, args: [id] })).rows[0];
    const raced = await withBatchRace(
      (batch) => batch.includes("bill.voided") && batch.includes(id),
      () => bills.payBill(cc, id, { account_id: CHEQUING, date: "2026-10-02" }),
      () => assert.rejects(bills.voidBill(cc, id), (error: unknown) => error instanceof access.FinanceInputError && /changed while it was being voided/.test(error.message)),
    );
    assert.equal(raced.raced, true);
    const after = (await raw.execute({ sql: `SELECT status, payment_entry_id FROM fin_bills WHERE id = ?`, args: [id] })).rows[0];
    assert.equal(after.status, "paid");
    assert.equal((await raw.execute({ sql: `SELECT status FROM fin_journal_entries WHERE id = ?`, args: [String(before.entry_id)] })).rows[0].status, "posted");
    assert.equal((await raw.execute({ sql: `SELECT status FROM fin_journal_entries WHERE id = ?`, args: [String(after.payment_entry_id)] })).rows[0].status, "posted");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'reversal' AND source_ref IN (?, ?)`, [String(before.entry_id), String(after.payment_entry_id)]), 0);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_audit_log WHERE object_id = ? AND action = 'bill.paid'`, [id]), 1);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_audit_log WHERE object_id = ? AND action = 'bill.voided'`, [id]), 0);
  });

  await check("recurring materialization and schedule advance are one atomic idempotent transaction", async () => {
    const item = await bills.createRecurring(cc, B, {
      name: "Atomic recurring",
      amount: "19.00",
      currency: "CAD",
      cadence: "monthly",
      next_run_on: "2026-10-05",
      category_id: SOFTWARE,
    });
    const sourceRef = `${item}:2026-10-05`;
    let winner = "";
    const raced = await withBatchRace(
      (batch) => batch.includes(sourceRef) && batch.includes("fin_recurring_items SET next_run_on"),
      async () => {
        winner = await bills.recordRecurringNow(cc, item);
      },
      () => bills.recordRecurringNow(cc, item),
    );
    assert.equal(raced.raced, true);
    assert.equal(raced.result, winner, "both contenders resolve to the one materialization");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_bills WHERE entity_id = ? AND source = 'recurring' AND source_ref = ?`, [B, sourceRef]), 1);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_bills WHERE entity_id = ? AND vendor_name = 'Atomic recurring'`, [B]), 1, "no untagged orphan bill");
    assert.equal((await raw.execute({ sql: `SELECT next_run_on FROM fin_recurring_items WHERE id = ?`, args: [item] })).rows[0].next_run_on, "2026-11-05");
  });

  await check("settings reject an invoice-number rewind below an already-issued number", async () => {
    const before = await settings.loadSettings(B);
    assert.equal(before.invoice_next_number, 3, "the two issued tax-date fixtures used 0001 and 0002");
    await assert.rejects(
      settings.updateSettings(cc, B, {
        gst_qst_registered: true,
        gst_number: "123456789RT0001",
        qst_number: "1234567890TQ0001",
        registration_effective_date: "2026-07-01",
        invoice_next_number: 2,
      }),
      (error: unknown) => error instanceof access.FinanceInputError && /already issued/.test(error.message),
    );
    assert.equal((await settings.loadSettings(B)).invoice_next_number, 3, "the rejected rewind changed nothing");
  });

  await check("paid-to-failed payout race cannot leave a failed payout booked", async () => {
    const id = "po_status_race";
    const amount = 2_100;
    await addClearing("status-race", amount, "2026-10-06");
    await settings.setStripePayoutAccount(cc, B, CHEQUING);

    const client = getTursoClient() as unknown as Record<string, unknown>;
    const proto = Object.getPrototypeOf(client) as { batch: (...args: unknown[]) => Promise<unknown>; execute: (...args: unknown[]) => Promise<unknown> };
    const bookingReached = deferred();
    const releaseBooking = deferred();
    const failureUpdateReached = deferred();
    const releaseFailureUpdate = deferred();
    let heldBooking = false;
    let heldFailureUpdate = false;
    client.batch = async function (this: unknown, statements: unknown, ...rest: unknown[]) {
      const json = JSON.stringify(statements);
      if (!heldBooking && json.includes(id) && json.includes("UPDATE fin_stripe_payouts SET booking = 'booked'")) {
        heldBooking = true;
        bookingReached.resolve();
        await releaseBooking.promise;
      }
      return proto.batch.call(this, statements, ...rest);
    };
    client.execute = async function (this: unknown, statement: unknown, ...rest: unknown[]) {
      const json = JSON.stringify(statement);
      if (!heldFailureUpdate && json.includes(id) && json.includes("SET booking = 'not_booked'")) {
        heldFailureUpdate = true;
        failureUpdateReached.resolve();
        await releaseFailureUpdate.promise;
      }
      return proto.execute.call(this, statement, ...rest);
    };
    try {
      const paid = payouts.recordStripePayout(payoutFacts(id, "paid", amount, "2026-10-06"));
      await bookingReached.promise;
      const failed = payouts.recordStripePayout(payoutFacts(id, "failed", amount, "2026-10-06"), { reportedOn: "2026-10-07" });
      await failureUpdateReached.promise;
      releaseBooking.resolve();
      await paid;
      releaseFailureUpdate.resolve();
      await failed;
    } finally {
      releaseBooking.resolve();
      releaseFailureUpdate.resolve();
      delete client.batch;
      delete client.execute;
    }
    assert.equal(heldBooking, true);
    assert.equal(heldFailureUpdate, true);
    const row = await payouts.loadPayout(id);
    assert.deepEqual([row?.stripe_status, row?.booking], ["failed", "not_booked"]);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'stripe_payout' AND source_ref = ? AND status = 'posted'`, [id]), 0);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_audit_log WHERE action = 'stripe.payout_booked' AND object_id = ?`, [id]), 0);
  });

  await check("payout booking is pinned to the payout-account setting snapshot", async () => {
    const backup = await settings.createAccount(cc, B, { code: "1015", name: "Payout backup", type: "asset", subtype: "bank" });
    await settings.setStripePayoutAccount(cc, B, CHEQUING);
    const id = "po_account_race";
    const amount = 2_200;
    await addClearing("account-race", amount, "2026-10-08");
    const raced = await withBatchRace(
      (batch) => batch.includes(id) && batch.includes("UPDATE fin_stripe_payouts SET booking = 'booked'"),
      () => raw.execute({ sql: `UPDATE fin_settings SET stripe_payout_account_id = ? WHERE entity_id = ?`, args: [backup, B] }).then(() => undefined),
      () => payouts.recordStripePayout(payoutFacts(id, "paid", amount, "2026-10-08")),
    );
    assert.equal(raced.raced, true);
    const row = await payouts.loadPayout(id);
    assert.deepEqual([row?.booking, row?.bank_account_id], ["booked", backup]);
    assert.equal(
      await count(`SELECT COUNT(*) FROM fin_journal_lines WHERE entry_id = ? AND account_id = ? AND debit_cents = ?`, [row?.entry_id ?? null, backup, amount]),
      1,
      "the payout landed only in the newly selected bank",
    );
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_lines WHERE entry_id = ? AND account_id = ?`, [row?.entry_id ?? null, CHEQUING]), 0);
  });

  await check("Stripe account cache identities use the full key, not a colliding six-character suffix", async () => {
    const calls = stripeAccountCalls;
    const first = await stripeIo.stripeAccountForKey("rk_test_company_a_shared_suffix");
    const second = await stripeIo.stripeAccountForKey("rk_test_company_b_shared_suffix");
    assert.deepEqual([first.id, second.id], ["acct_company_a", "acct_company_b"]);
    assert.equal(stripeAccountCalls - calls, 2, "both distinct full keys were verified with Stripe");
  });

  await check("all journal entries remain balanced", async () => {
    assert.equal(
      await count(`SELECT COUNT(*) FROM (
        SELECT entry_id FROM fin_journal_lines GROUP BY entry_id
        HAVING SUM(cad_debit_cents) <> SUM(cad_credit_cents)
      )`),
      0,
    );
  });

  if (failures) {
    console.error(`finances-provider-settings: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("finances-provider-settings: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
