/**
 * tests/finances-io.test.ts — FOUNDERS > Finances I/O against a REAL local
 * libSQL database with migration 180 applied.
 *
 * Drives the real modules and the real route handlers (webhook, internal API)
 * — no mocks of our own code. Network is disabled (global fetch throws), and
 * no Stripe key is configured, so every path that would call Stripe or the
 * Bank of Canada takes its offline branch, which is itself under test:
 * fees recorded as pending, rates read from the seeded table.
 *
 * Run: node --conditions=react-server --import tsx tests/finances-io.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbFile = join(mkdtempSync(join(tmpdir(), "finances-io-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.STRIPE_FINANCE_WEBHOOK_SECRET = "whsec_finance_test_secret_value";
process.env.FINANCE_AGENT_TOKEN = "atlas-test-token-0123456789abcdef";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.FOUNDERS_TENANT_IDS;
delete process.env.INVOICE_FROM_EMAIL;
delete process.env.INVOICE_FROM_APP_PASSWORD;
delete process.env.OASIS_MAIL_FROM;
delete process.env.OASIS_MAIL_APP_PASSWORD;

let networkCalls = 0;
globalThis.fetch = (async (input: unknown) => {
  networkCalls += 1;
  throw new Error(`network disabled in test: ${String(input).slice(0, 80)}`);
}) as typeof fetch;

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 4).join("\n        ")}`);
  }
}

const cc = { kind: "founder" as const, ownerKey: "cc" as const, email: "conaugh@oasisai.work", userId: "u-cc" };
const adon = { kind: "founder" as const, ownerKey: "adon" as const, email: "adon@oasisai.work", userId: "u-adon" };
const atlas = { kind: "agent" as const, name: "atlas" as const };

const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

async function main() {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(readFileSync(join(__dirname, "../database/turso/180_founders_finances.turso.sql"), "utf8"));
  for (const [d, r] of [
    ["2026-09-10", "1.3600"],
    ["2026-09-11", "1.3600"],
    ["2026-09-18", "1.3800"],
    ["2026-09-21", "1.3900"],
    ["2026-09-22", "1.3850"],
    ["2026-09-23", "1.3700"],
  ]) {
    await raw.execute({ sql: `INSERT INTO fin_fx_rates (pair, rate_date, rate) VALUES ('USDCAD', ?, ?)`, args: [d, r] });
  }

  const { ensureFinanceSeed } = await import("../lib/founders-finances/seed-io");
  const access = await import("../lib/founders-finances/access-io");
  const ledgerIo = await import("../lib/founders-finances/ledger-io");
  const { LedgerError } = await import("../lib/founders-finances/ledger");
  const txns = await import("../lib/founders-finances/transactions-io");
  const invoices = await import("../lib/founders-finances/invoices-io");
  const metrics = await import("../lib/founders-finances/metrics");
  const reportsIo = await import("../lib/founders-finances/reports-io");
  const { computeStripeSignature } = await import("../lib/founders-finances/stripe-signature");
  const { InvoiceMailerNotConfigured } = await import("../lib/founders-finances/invoice-email");
  const { accountId, categoryId, SYS, BUSINESS_ENTITY_ID } = await import("../lib/founders-finances/chart");
  const webhook = await import("../app/api/webhooks/stripe-finance/route");
  const summaryRoute = await import("../app/api/internal/finance/summary/route");
  const draftsRoute = await import("../app/api/internal/finance/transactions/route");
  const remindRoute = await import("../app/api/internal/finance/invoices/remind-overdue/route");
  const B = BUSINESS_ENTITY_ID;

  const count = async (sql: string, args: Array<string | number> = []) => Number((await raw.execute({ sql, args })).rows[0][0]);

  let evtSeq = 0;
  async function deliver(type: string, object: Record<string, unknown>, opts: { created?: number; livemode?: boolean; id?: string; sign?: "good" | "bad" | "stale" } = {}) {
    const event = { id: opts.id || `evt_test_${++evtSeq}`, object: "event", type, created: opts.created ?? epoch("2026-09-21T15:00:00Z"), livemode: opts.livemode ?? true, data: { object } };
    const payload = JSON.stringify(event);
    const now = Math.floor(Date.now() / 1000);
    const ts = opts.sign === "stale" ? now - 600 : now;
    const secret = opts.sign === "bad" ? "whsec_wrong" : (process.env.STRIPE_FINANCE_WEBHOOK_SECRET as string);
    const sig = computeStripeSignature(payload, secret, ts);
    const res = await webhook.POST(new Request("http://localhost/api/webhooks/stripe-finance", { method: "POST", headers: { "stripe-signature": `t=${ts},v1=${sig}` }, body: payload }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, event };
  }
  const charge = (p: { id: string; amount: number; currency?: string; created?: number; pi?: string; metadata?: Record<string, string>; bt?: Record<string, unknown> | string; refunded?: number; refunds?: unknown[]; name?: string; email?: string; customer?: string }) => ({
    id: p.id,
    object: "charge",
    amount: p.amount,
    amount_refunded: p.refunded ?? 0,
    currency: p.currency ?? "cad",
    created: p.created ?? epoch("2026-09-21T15:00:00Z"),
    status: "succeeded",
    paid: true,
    livemode: true,
    payment_intent: p.pi ?? null,
    customer: p.customer ?? null,
    balance_transaction: p.bt ?? null,
    billing_details: { name: p.name ?? "Acme Inc", email: p.email ?? "ap@acme.test" },
    metadata: p.metadata ?? {},
    ...(p.refunds ? { refunds: { object: "list", data: p.refunds } } : {}),
  });

  await check("seed is idempotent", async () => {
    await ensureFinanceSeed();
    const { resetFinanceSeedMemo } = await import("../lib/founders-finances/seed-io");
    resetFinanceSeedMemo();
    await ensureFinanceSeed();
    assert.equal(await count(`SELECT COUNT(*) FROM fin_entities`), 3);
    const accounts = await count(`SELECT COUNT(*) FROM fin_accounts`);
    resetFinanceSeedMemo();
    await ensureFinanceSeed();
    assert.equal(await count(`SELECT COUNT(*) FROM fin_accounts`), accounts, "re-seeding adds nothing");
    assert.equal(await count(`SELECT gst_qst_registered FROM fin_settings WHERE entity_id = ?`, [B]), 0, "OASIS starts unregistered");
  });

  await check("privacy: a founder can never reach the other's personal book", async () => {
    const ccSees = (await access.visibleEntities(cc)).map((e) => e.slug).sort();
    assert.deepEqual(ccSees, ["cc-personal", "oasis"]);
    const adonSees = (await access.visibleEntities(adon)).map((e) => e.slug).sort();
    assert.deepEqual(adonSees, ["adon-personal", "oasis"]);
    assert.deepEqual((await access.visibleEntities(atlas)).map((e) => e.slug), ["oasis"], "Atlas sees the business only");
    await assert.rejects(access.requireEntity(adon, "cc-personal"), access.FinanceNotFound);
    await assert.rejects(access.requireEntity(cc, "fin_ent_adon"), access.FinanceNotFound, "by id as well as slug");
    await assert.rejects(access.requireEntity(atlas, "cc-personal"), access.FinanceNotFound);
    await assert.rejects(txns.listTransactions(adon, "cc-personal"), access.FinanceNotFound);
    const ccTxn = await txns.createManualTransaction(cc, "cc-personal", { date: "2026-09-10", description: "Groceries", amount: "-82.40", category_id: categoryId("fin_ent_cc", "5100"), account_id: accountId("fin_ent_cc", "1000") });
    await assert.rejects(txns.categorizeTransaction(adon, ccTxn, categoryId("fin_ent_cc", "5200")), access.FinanceNotFound, "writes by row id are gated too");
    await assert.rejects(txns.excludeTransaction(adon, ccTxn), access.FinanceNotFound);
    await assert.rejects(txns.createManualTransaction(adon, "cc-personal", { date: "2026-09-10", description: "x x", amount: "1" }), access.FinanceNotFound);
    await assert.rejects(reportsIo.runReport(adon, "cc-personal", "pnl", {}), access.FinanceNotFound);
    const own = await reportsIo.runReport(cc, "cc-personal", "pnl", { from: "2026-09-01", to: "2026-10-01" });
    assert.equal((own.data as { totalExpenseCents: number }).totalExpenseCents, 8240);
    // A category from another book cannot be used even by its owner through the wrong entity.
    await assert.rejects(
      txns.createManualTransaction(cc, "oasis", { date: "2026-09-10", description: "wrong book", amount: "-1", category_id: categoryId("fin_ent_cc", "5100") }),
      access.FinanceInputError,
    );
  });

  await check("ledger: balanced entries post atomically, unbalanced and foreign accounts are refused", async () => {
    const before = await count(`SELECT COUNT(*) FROM fin_journal_entries`);
    const ok = await ledgerIo.postJournalEntry({
      entityId: B,
      entryDate: "2026-09-01",
      memo: "Opening contribution",
      source: "test",
      sourceRef: "opening-1",
      createdBy: "test",
      lines: [
        { accountId: accountId(B, SYS.chequing), currency: "CAD", debitCents: 500000 },
        { accountId: accountId(B, SYS.equityCc), currency: "CAD", creditCents: 250000 },
        { accountId: accountId(B, SYS.equityAdon), currency: "CAD", creditCents: 250000 },
      ],
    });
    assert.equal(ok.created, true);
    const again = await ledgerIo.postJournalEntry({
      entityId: B, entryDate: "2026-09-01", memo: "dup", source: "test", sourceRef: "opening-1", createdBy: "test",
      lines: [
        { accountId: accountId(B, SYS.chequing), currency: "CAD", debitCents: 1 },
        { accountId: accountId(B, SYS.equityCc), currency: "CAD", creditCents: 1 },
      ],
    });
    assert.equal(again.created, false, "same source ref is idempotent");
    assert.equal(again.entryId, ok.entryId);
    await assert.rejects(
      ledgerIo.postJournalEntry({
        entityId: B, entryDate: "2026-09-01", memo: "bad", source: "test", sourceRef: "bad-1", createdBy: "test",
        lines: [
          { accountId: accountId(B, SYS.chequing), currency: "CAD", debitCents: 100 },
          { accountId: accountId(B, SYS.equityCc), currency: "CAD", creditCents: 99 },
        ],
      }),
      (e: unknown) => e instanceof LedgerError && e.code === "unbalanced",
    );
    await assert.rejects(
      ledgerIo.postJournalEntry({
        entityId: B, entryDate: "2026-09-01", memo: "foreign", source: "test", sourceRef: "bad-2", createdBy: "test",
        lines: [
          { accountId: accountId("fin_ent_cc", "1000"), currency: "CAD", debitCents: 100 },
          { accountId: accountId(B, SYS.equityCc), currency: "CAD", creditCents: 100 },
        ],
      }),
      (e: unknown) => e instanceof LedgerError && e.code === "foreign_account",
      "a line on another book's account is refused",
    );
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries`), before + 1, "refused entries wrote nothing");
    const unbalancedInDb = await count(
      `SELECT COUNT(*) FROM (SELECT entry_id, currency, SUM(debit_cents) d, SUM(credit_cents) c FROM fin_journal_lines GROUP BY entry_id, currency HAVING d <> c)`,
    );
    assert.equal(unbalancedInDb, 0, "every stored entry balances per currency");
  });

  const CSV = `Date,Description,Amount
2026-09-10,"FIGMA MONTHLY",-20.00
2026-09-10,Coffee,-4.50
2026-09-10,Coffee,-4.50
2026-09-11,"STRIPE TRANSFER ST-A1B2",950.00
`;
  await check("statement import: preview flags duplicates, re-import adds 0 rows (CSV and OFX)", async () => {
    const acct = accountId(B, SYS.chequing);
    const first = await txns.commitImport(cc, "oasis", { accountId: acct, filename: "rbc.csv", text: CSV });
    assert.equal(first.inserted, 4);
    assert.equal(first.posted, 1, "the seeded Stripe-payout rule categorised the transfer");
    const preview = await txns.previewImport(cc, "oasis", { accountId: acct, filename: "rbc.csv", text: CSV });
    assert.equal(preview.duplicates, 4, "preview marks every row as already imported");
    const second = await txns.commitImport(cc, "oasis", { accountId: acct, filename: "rbc.csv", text: CSV });
    assert.equal(second.inserted, 0, "re-importing the same file adds nothing");
    assert.equal(second.duplicates, 4);
    const ofx = `<OFX><STMTTRN><DTPOSTED>20260911<TRNAMT>-39.00<FITID>F1<NAME>SHOPIFY\n<STMTTRN><DTPOSTED>20260911<TRNAMT>-12.00<FITID>F2<NAME>HOSTING\n</OFX>`;
    const card = accountId(B, SYS.creditCard);
    assert.equal((await txns.commitImport(cc, "oasis", { accountId: card, filename: "card.qfx", text: ofx })).inserted, 2);
    assert.equal((await txns.commitImport(cc, "oasis", { accountId: card, filename: "card.qfx", text: ofx })).inserted, 0);
    const transfer = await raw.execute(`SELECT status, category_id FROM fin_bank_transactions WHERE description LIKE 'STRIPE TRANSFER%'`);
    assert.equal(transfer.rows[0].status, "posted");
    const figma = (await raw.execute(`SELECT id FROM fin_bank_transactions WHERE description = 'FIGMA MONTHLY'`)).rows[0].id as string;
    const made = await txns.createRuleFromTransaction(cc, figma, { category_id: categoryId(B, "5100") });
    assert.ok(made.ruleId);
    assert.equal((await raw.execute({ sql: `SELECT status FROM fin_bank_transactions WHERE id = ?`, args: [figma] })).rows[0].status, "posted");
    // Re-categorising reverses and re-posts; the ledger still balances and the expense moved.
    await txns.categorizeTransaction(cc, figma, categoryId(B, "5900"));
    const pnl = (await reportsIo.runReport(cc, "oasis", "pnl", { from: "2026-09-01", to: "2026-10-01" })).data as { expenses: Array<{ code: string; amountCents: number }> };
    assert.equal(pnl.expenses.find((e) => e.code === "5100"), undefined, "old category fully reversed");
    assert.equal(pnl.expenses.find((e) => e.code === "5900")?.amountCents, 2000);
  });

  await check("webhook: signature required (good / bad / stale / unconfigured)", async () => {
    const bad = await deliver("charge.succeeded", charge({ id: "ch_sig", amount: 100 }), { sign: "bad" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.reason, "no_matching_signature");
    const stale = await deliver("charge.succeeded", charge({ id: "ch_sig", amount: 100 }), { sign: "stale" });
    assert.equal(stale.status, 400);
    assert.equal(stale.body.reason, "timestamp_outside_tolerance");
    const saved = process.env.STRIPE_FINANCE_WEBHOOK_SECRET;
    delete process.env.STRIPE_FINANCE_WEBHOOK_SECRET;
    const unconfigured = await webhook.POST(new Request("http://localhost/x", { method: "POST", body: "{}" }));
    process.env.STRIPE_FINANCE_WEBHOOK_SECRET = saved;
    assert.equal(unconfigured.status, 503, "no secret is a hard refusal, never 'accept unsigned'");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE stripe_charge_id = 'ch_sig'`), 0);
  });

  await check("webhook: idempotent on event id, one payment across charge + intent events", async () => {
    const bt = { id: "txn_1", object: "balance_transaction", amount: 50000, fee: 1480, net: 48520, currency: "cad" };
    const c1 = charge({ id: "ch_1", amount: 50000, pi: "pi_1", bt, name: "Northwind", email: "ap@northwind.test", customer: "cus_nw" });
    const first = await deliver("charge.succeeded", c1, { id: "evt_same" });
    assert.equal(first.status, 200);
    assert.equal(first.body.status, "processed");
    const again = await deliver("charge.succeeded", c1, { id: "evt_same" });
    assert.equal(again.body.status, "duplicate", "a redelivered event changes nothing");
    const pi = await deliver("payment_intent.succeeded", { id: "pi_1", object: "payment_intent", amount_received: 50000, currency: "cad", created: c1.created, livemode: true, latest_charge: "ch_1", metadata: {} });
    assert.equal(pi.status, 200);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE kind = 'payment' AND (stripe_charge_id = 'ch_1' OR stripe_payment_intent_id = 'pi_1')`), 1);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'stripe_charge' AND source_ref = 'ch_1'`), 1);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'stripe_fee' AND source_ref = 'ch_1'`), 1, "fee posted from the balance transaction");
    const test = await deliver("charge.succeeded", { ...c1, id: "ch_test", livemode: false }, { livemode: false });
    assert.equal(test.body.status, "ignored");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE stripe_charge_id = 'ch_test'`), 0, "test-mode events never enter the books");
    assert.equal(networkCalls, 0, "no key configured -> no Stripe call attempted");
  });

  let invoiceStripe = "";
  let invoiceStripeTotal = 0;
  await check("invoice: draft -> issued (numbered, AR recognised); email failure is loud and leaves sent_at empty", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Contoso", email: "billing@contoso.test" },
      issue_date: "2026-09-15",
      currency: "CAD",
      lines: [
        { description: "Automation build", quantity: "1", unit_price: "2500.00" },
        { description: "Support", quantity: "1.5", unit_price: "120" },
      ],
    });
    const fin = await invoices.finalizeInvoice(cc, id);
    assert.equal(fin.number, "OASIS-2026-0001");
    assert.equal(fin.status, "sent");
    assert.equal(fin.total_cents, 268000);
    assert.equal(fin.gst_cents + fin.qst_cents, 0, "unregistered: no tax");
    const again = await invoices.finalizeInvoice(cc, id);
    assert.equal(again.number, "OASIS-2026-0001", "finalising twice does not renumber");
    await assert.rejects(invoices.sendInvoice(cc, id, { paymentLink: false }), InvoiceMailerNotConfigured, "no mailbox -> a loud error, never a silent skip");
    assert.equal((await raw.execute({ sql: `SELECT sent_at FROM fin_invoices WHERE id = ?`, args: [id] })).rows[0].sent_at, null);
    const second = await invoices.createDraftInvoice(cc, "oasis", { contact_id: fin.contact_id, issue_date: "2026-09-16", currency: "CAD", lines: [{ description: "x", quantity: 1, unit_price: "10" }] });
    assert.equal((await invoices.finalizeInvoice(cc, second)).number, "OASIS-2026-0002");
    await invoices.voidInvoice(cc, second);
    invoiceStripe = id;
    invoiceStripeTotal = fin.total_cents;
    await assert.rejects(invoices.createDraftInvoice(cc, "cc-personal", { new_contact: { name: "x" }, lines: [{ description: "x", quantity: 1, unit_price: "1" }] }), access.FinanceInputError, "personal books do not invoice");
  });

  await check("invoice paid through Stripe: counted once, AR cleared, revenue not doubled (charge first, intent second)", async () => {
    const created = epoch("2026-09-22T16:00:00Z");
    const c = charge({ id: "ch_inv", amount: invoiceStripeTotal, pi: "pi_inv", created, name: "Contoso", bt: { id: "txn_inv", amount: invoiceStripeTotal, fee: 7800, net: invoiceStripeTotal - 7800, currency: "cad" } });
    // charge.succeeded arrives FIRST and carries no invoice metadata: booked as plain revenue.
    await deliver("charge.succeeded", c, { created });
    // then payment_intent.succeeded carries fin_invoice_id: linked + reclassed, not re-counted.
    await deliver("payment_intent.succeeded", { id: "pi_inv", object: "payment_intent", amount_received: invoiceStripeTotal, currency: "cad", created, livemode: true, latest_charge: "ch_inv", metadata: { fin_invoice_id: invoiceStripe } }, { created });
    const inv = (await raw.execute({ sql: `SELECT status, amount_paid_cents FROM fin_invoices WHERE id = ?`, args: [invoiceStripe] })).rows[0];
    assert.equal(inv.status, "paid");
    assert.equal(Number(inv.amount_paid_cents), invoiceStripeTotal);
    const day = await metrics.revenueCollected({ from: "2026-09-22", to: "2026-09-23" });
    assert.equal(day.payments, 1, "one payment, not two");
    assert.equal(day.cad_cents, invoiceStripeTotal);
    const bs = (await reportsIo.runReport(cc, "oasis", "balance", { to: "2026-10-01" })).data as { assets: Array<{ code: string; amountCents: number }>; balanced: boolean };
    assert.equal(bs.assets.find((a) => a.code === SYS.ar)?.amountCents ?? 0, 0, "AR is cleared");
    assert.equal(bs.balanced, true);
    const pnl = (await reportsIo.runReport(cc, "oasis", "pnl", { from: "2026-09-01", to: "2026-10-01" })).data as { revenue: Array<{ code: string; amountCents: number }> };
    const service = pnl.revenue.find((r) => r.code === SYS.serviceRevenue)?.amountCents ?? 0;
    assert.equal(service, 50000 + invoiceStripeTotal, "invoice revenue recognised once (plus the earlier unrelated charge)");
    // invoice.paid for an unrelated Stripe invoice with the same PI must not add a row either.
    await deliver("invoice.paid", { id: "in_x", object: "invoice", currency: "cad", amount_paid: invoiceStripeTotal, livemode: true, payment_intent: "pi_inv", status_transitions: { paid_at: created } });
    assert.equal((await metrics.revenueCollected({ from: "2026-09-22", to: "2026-09-23" })).payments, 1);
  });

  await check("manual mark-paid: one payment row, invoice paid, collected once", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Fabrikam", email: "pay@fabrikam.test" }, issue_date: "2026-09-18", currency: "USD", lines: [{ description: "Retainer", quantity: 1, unit_price: "1000.00" }] });
    await invoices.finalizeInvoice(cc, id);
    await assert.rejects(invoices.markInvoicePaidManually(cc, id, { amount: "2000", date: "2026-09-23" }), access.FinanceInputError, "more than the balance is refused");
    await invoices.markInvoicePaidManually(cc, id, { date: "2026-09-23", received_cad: "1372.00", reference: "Wire 5541" });
    const inv = (await raw.execute({ sql: `SELECT status, amount_paid_cents FROM fin_invoices WHERE id = ?`, args: [id] })).rows[0];
    assert.equal(inv.status, "paid");
    const d = await metrics.revenueCollected({ from: "2026-09-23", to: "2026-09-24" });
    assert.equal(d.payments, 1);
    assert.equal(d.usd_cents, 100000, "USD side is the invoice's own amount");
    assert.equal(d.cad_cents, 137200, "CAD side is what landed");
    const tb = (await reportsIo.runReport(cc, "oasis", "trial", { to: "2026-10-01" })).data as { balanced: boolean };
    assert.equal(tb.balanced, true);
    // Issued at 1.38 (Sep 18): carrying CA$1,380.00; received CA$1,372.00 -> CA$8.00 realised FX loss.
    const fx = (await reportsIo.runReport(cc, "oasis", "pnl", { from: "2026-09-01", to: "2026-10-01" })).data as { expenses: Array<{ code: string; amountCents: number }> };
    assert.equal(fx.expenses.find((e) => e.code === SYS.fxGainLoss)?.amountCents, 800);
  });

  await check("refunds net by their own date and can never exceed what Stripe refunded", async () => {
    const refundCreated = epoch("2026-09-23T14:00:00Z");
    const refunded = charge({ id: "ch_1", amount: 50000, pi: "pi_1", refunded: 10000, refunds: [{ id: "re_1", object: "refund", amount: 10000, currency: "cad", created: refundCreated, status: "succeeded", charge: "ch_1" }] });
    await deliver("charge.refunded", refunded, { created: refundCreated });
    await deliver("charge.refunded", refunded, { created: refundCreated }); // a second event for the same refund
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE kind = 'refund' AND stripe_refund_id = 're_1'`), 1);
    // A later event with no refund list and a SMALLER cumulative must not add a delta.
    await deliver("charge.refunded", charge({ id: "ch_1", amount: 50000, pi: "pi_1", refunded: 10000 }), { created: refundCreated });
    assert.equal(await count(`SELECT COALESCE(SUM(amount_cents), 0) FROM fin_payments WHERE kind = 'refund'`), 10000);
    const sept21 = await metrics.revenueCollected({ from: "2026-09-21", to: "2026-09-22" });
    assert.equal(sept21.cad_cents, 50000, "the original payment day is unchanged");
    const sept23 = await metrics.revenueCollected({ from: "2026-09-23", to: "2026-09-24" });
    assert.equal(sept23.cad_cents, 137200 - 10000, "the refund subtracts on its own day");
  });

  await check("byDay and byCustomer agree with revenueCollected (Toronto days, zero-filled, sorted)", async () => {
    const range = { from: "2026-09-19", to: "2026-09-25" };
    const total = await metrics.revenueCollected(range);
    const byDay = await metrics.revenueCollectedByDay(range);
    assert.deepEqual(byDay.map((d) => d.date), ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"]);
    assert.equal(byDay[0].cad_cents, 0);
    assert.equal(byDay[1].usd_cents, 0);
    assert.equal(byDay.reduce((s, d) => s + d.cad_cents, 0), total.cad_cents, "sum(byDay) cad == revenueCollected");
    assert.equal(byDay.reduce((s, d) => s + d.usd_cents, 0), total.usd_cents, "sum(byDay) usd == revenueCollected");
    const byCustomer = await metrics.revenueByCustomer(range);
    assert.equal(byCustomer.reduce((s, c) => s + c.usd_cents, 0), total.usd_cents);
    for (let i = 1; i < byCustomer.length; i++) assert.ok(byCustomer[i - 1].usd_cents >= byCustomer[i].usd_cents, "sorted desc by usd");
    assert.ok(byCustomer.every((c) => c.customer.trim().length > 0), "never an empty customer label");
    assert.ok(byCustomer.some((c) => c.customer === "Contoso"), "an invoice payment is attributed to the invoice contact");
    // A payment at 23:30 Toronto on Sep 24 (03:30Z Sep 25) is a Sep 24 payment.
    await deliver("charge.succeeded", charge({ id: "ch_late", amount: 1000, created: epoch("2026-09-25T03:30:00Z"), name: "Late Night" }));
    const late = await metrics.revenueCollectedByDay({ from: "2026-09-24", to: "2026-09-26" });
    assert.equal(late[0].cad_cents, 1000, "counted on the Toronto calendar day");
    assert.equal(late[1].cad_cents, 0);
  });

  await check("MRR from subscription events: intervals normalised, stale events ignored", async () => {
    const sub = (id: string, status: string, unit: number, interval: string, qty = 1) => ({
      id, object: "subscription", status, currency: "usd", livemode: true, customer: "cus_nw",
      items: { object: "list", data: [{ quantity: qty, price: { unit_amount: unit, currency: "usd", recurring: { interval, interval_count: 1 } } }] },
    });
    await deliver("customer.subscription.created", sub("sub_1", "active", 120000, "year"), { created: epoch("2026-09-01T00:00:00Z") });
    await deliver("customer.subscription.created", sub("sub_2", "trialing", 25000, "month", 2), { created: epoch("2026-09-02T00:00:00Z") });
    await deliver("customer.subscription.updated", sub("sub_3", "active", 50000, "month"), { created: epoch("2026-09-05T00:00:00Z") });
    await deliver("customer.subscription.deleted", sub("sub_3", "active", 50000, "month"), { created: epoch("2026-09-10T00:00:00Z") });
    // An OLDER update arriving late must not resurrect sub_3.
    await deliver("customer.subscription.updated", sub("sub_3", "active", 50000, "month"), { created: epoch("2026-09-06T00:00:00Z") });
    const m = await metrics.stripeMrr();
    assert.equal(m.currency, "USD");
    assert.equal(m.mrr_cents, 10000 + 50000, "yearly/12 + monthly x qty 2; the canceled one excluded");
    assert.equal(m.active_subscriptions, 2);
    assert.ok(m.as_of);
  });

  await check("usdPerCad: own day, weekend falls back to Friday", async () => {
    assert.equal(await metrics.usdPerCad("2026-09-21"), Number((1 / 1.39).toFixed(6)));
    assert.equal(await metrics.usdPerCad("2026-09-20"), Number((1 / 1.38).toFixed(6)));
  });

  await check("internal API: fail closed without token, drafts are idempotent, reminders are dry-run unless send === true", async () => {
    const url = "http://localhost/api/internal/finance/summary?from=2026-09-01&to=2026-10-01";
    assert.equal((await summaryRoute.GET(new Request(url))).status, 401);
    const saved = process.env.FINANCE_AGENT_TOKEN;
    delete process.env.FINANCE_AGENT_TOKEN;
    assert.equal((await summaryRoute.GET(new Request(url, { headers: { authorization: `Bearer ${saved}` } }))).status, 503, "unset token -> 503, never open");
    process.env.FINANCE_AGENT_TOKEN = saved;
    assert.equal((await summaryRoute.GET(new Request(url, { headers: { authorization: "Bearer wrong-token-wrong-token-wrong" } }))).status, 401);
    const res = await summaryRoute.GET(new Request(url, { headers: { authorization: `Bearer ${saved}` } }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { revenue_collected: { payments: number }; threshold: { level: string }; mrr: { mrr_cents: number } };
    assert.ok(body.revenue_collected.payments >= 3);
    assert.equal(body.threshold.level, "ok");
    assert.equal(body.mrr.mrr_cents, 60000);
    const post = (payload: unknown) =>
      draftsRoute.POST(new Request("http://localhost/api/internal/finance/transactions", { method: "POST", headers: { authorization: `Bearer ${saved}` }, body: JSON.stringify(payload) }));
    const drafts = { transactions: [
      { date: "2026-09-12", description: "Figma receipt", amount: "-15.00", currency: "USD", account_code: "2100", external_ref: "gmail:abc" },
      { date: "2026-09-12", description: "bad", amount: "0" },
    ] };
    const r1 = (await (await post(drafts)).json()) as { inserted: number; rejected: number };
    assert.equal(r1.inserted, 1);
    assert.equal(r1.rejected, 1);
    const r2 = (await (await post(drafts)).json()) as { inserted: number; duplicates: number };
    assert.equal(r2.inserted, 0, "resending the same receipt is a no-op");
    assert.equal(r2.duplicates, 1);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'bank_txn' AND memo = 'Figma receipt'`), 0, "drafts are not posted");
    // Make one invoice overdue, then ask for reminders without send:true.
    const id = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Late Payer", email: "late@payer.test" }, issue_date: "2026-08-01", due_date: "2026-08-15", currency: "CAD", lines: [{ description: "Work", quantity: 1, unit_price: "300" }] });
    await invoices.finalizeInvoice(cc, id);
    const remind = (payload: unknown) =>
      remindRoute.POST(new Request("http://localhost/api/internal/finance/invoices/remind-overdue", { method: "POST", headers: { authorization: `Bearer ${saved}` }, body: JSON.stringify(payload) }));
    const dry = (await (await remind({ send: "true" })).json()) as { mode: string; reminders: Array<{ action: string; number: string }> };
    assert.equal(dry.mode, "dry_run", "only a literal true sends");
    assert.equal(dry.reminders.length, 1);
    assert.equal(dry.reminders[0].action, "would_send");
    const real = (await (await remind({ send: true })).json()) as { mode: string; reminders: Array<{ action: string; reason: string }> };
    assert.equal(real.mode, "sent");
    assert.equal(real.reminders[0].action, "failed", "no mailbox configured -> reported as failed, not as sent");
    assert.match(real.reminders[0].reason, /No OASIS mailbox is configured/);
  });

  await check("books still balance after everything", async () => {
    const tb = (await reportsIo.runReport(cc, "oasis", "trial", { to: "2026-12-31" })).data as { balanced: boolean; totalDebitCents: number };
    assert.equal(tb.balanced, true);
    assert.ok(tb.totalDebitCents > 0);
    const bs = (await reportsIo.runReport(cc, "oasis", "balance", { to: "2026-12-31" })).data as { balanced: boolean };
    assert.equal(bs.balanced, true);
    const cad = await count(`SELECT COUNT(*) FROM (SELECT entry_id, SUM(cad_debit_cents) d, SUM(cad_credit_cents) c FROM fin_journal_lines GROUP BY entry_id HAVING d <> c)`);
    assert.equal(cad, 0, "every entry balances in CAD too");
  });

  if (failures > 0) {
    console.log(`finances-io: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("finances-io: all passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
