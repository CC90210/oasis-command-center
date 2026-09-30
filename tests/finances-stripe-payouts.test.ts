/**
 * tests/finances-stripe-payouts.test.ts — Stripe payouts in the books, against
 * a REAL local libSQL database with the finance migrations, the ledger core
 * (bravo__190) and bravo__193 applied.
 *
 * WHY. On 2026-09-29 Today showed "Cash on hand -CA$1,788.23": every charge
 * landed in 1050 Stripe clearing and no payout ever took it out, so clearing
 * held +CA$1,639.21 while Stripe's own balance was $0. payout.paid now moves
 * the money into the bank account a founder chose, payout.failed reverses it,
 * payout.canceled never books, and a payout the books could not book is a
 * named cash gap.
 *
 * The figures copy the live account's shape (stripe-ingest.ts header): a CA$
 * charge settles into a USD balance (CA$100.00 -> US$72.26, fee US$4.42), so
 * Stripe clearing holds the charge in CAD and the fee in USD, and the USD
 * payout needs the CAD converted. api.stripe.com and the Bank of Canada are
 * unreachable: there is no Stripe key, so events are processed from their
 * payloads, exactly as the webhook does without a verified key.
 *
 * Run: node --conditions=react-server --import tsx tests/finances-stripe-payouts.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "finances-payouts-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "STRIPE_SECRET_KEY", "FOUNDERS_TENANT_IDS", "STRIPE_FINANCE_WEBHOOK_SECRET"]) delete process.env[k];

/** api.stripe.com, served only for the reconcile section at the end (reads only; any write throws). */
const stripe = { serve: false, payouts: [] as Array<Record<string, unknown>> };
globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
  const url = new URL(String(input));
  if (stripe.serve && url.host === "api.stripe.com") {
    if ((init?.method || "GET").toUpperCase() !== "GET") throw new Error(`Stripe write attempted in test: ${url.pathname}`);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const list = (data: unknown[]) => json({ object: "list", data, has_more: false });
    if (url.pathname === "/v1/account") return json({ id: "acct_test_oasis", settings: { dashboard: { display_name: "OASIS AI" } } });
    if (["/v1/charges", "/v1/refunds", "/v1/subscriptions"].includes(url.pathname)) return list([]);
    if (url.pathname === "/v1/payouts") return list(stripe.payouts);
  }
  throw new Error(`network disabled in test: ${url.host}${url.pathname}`);
}) as typeof fetch;

type Json = Record<string, unknown>;
const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);
let seq = 0;
const event = (type: string, object: Json, at = "2026-09-08T12:00:00Z"): Json => ({
  id: `evt_payout_test_${++seq}`,
  object: "event",
  type,
  created: epoch(at),
  livemode: true,
  data: { object },
});

/** A basil-shaped live charge: CAD amount, USD balance transaction (expanded, as the reconcile reads it). */
function liveCharge(p: { id: string; amount: number; at: string; bt: { id: string; amount: number; fee: number } }): Json {
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
    customer: "cus_live",
    description: "Subscription update",
    billing_details: { name: "Client", email: "client@example.test" },
    balance_transaction: { id: p.bt.id, object: "balance_transaction", amount: p.bt.amount, fee: p.bt.fee, net: p.bt.amount - p.bt.fee, currency: "usd", created: epoch(p.at) },
    metadata: {},
    refunds: { object: "list", data: [], has_more: false },
  };
}

/** A payout; `bt` null = the balance transaction arrives as a bare id (what a real event carries). */
function payout(p: { id: string; amount: number; arrival: string; status?: string; bt?: { amount: number; fee?: number } | null }): Json {
  return {
    id: p.id,
    object: "payout",
    amount: p.amount,
    currency: "usd",
    arrival_date: epoch(`${p.arrival}T00:00:00Z`),
    created: epoch(`${p.arrival}T00:00:00Z`) - 2 * 86_400,
    status: p.status ?? "paid",
    livemode: true,
    automatic: true,
    destination: "ba_test_wise",
    balance_transaction:
      p.bt === null ? `txn_${p.id}` : { id: `txn_${p.id}`, object: "balance_transaction", amount: -(p.bt?.amount ?? p.amount), fee: p.bt?.fee ?? 0, currency: "usd" },
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

const cc = { kind: "founder" as const, ownerKey: "cc" as const, email: "conaugh@oasisai.work", userId: "u-cc" };

async function main() {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  for (const f of ["180_founders_finances.turso.sql", "184_finance_wise_payments.turso.sql", "185_finance_invoice_retainer.turso.sql", "bravo__190_ledger_core.sql", "bravo__193_stripe_payouts.sql"]) {
    await raw.executeMultiple(readFileSync(join(root, "database/turso", f), "utf8"));
  }
  for (let d = 1; d <= 30; d++) {
    await raw.execute({ sql: `INSERT INTO fin_fx_rates (pair, rate_date, rate) VALUES ('USDCAD', ?, '1.3800')`, args: [`2026-09-${String(d).padStart(2, "0")}`] });
  }

  const { ensureFinanceSeed } = await import("../lib/founders-finances/seed-io");
  const ingest = await import("../lib/founders-finances/stripe-ingest");
  const payouts = await import("../lib/founders-finances/stripe-payouts");
  const payoutsIo = await import("../lib/founders-finances/stripe-payouts-io");
  const settingsIo = await import("../lib/founders-finances/settings-io");
  const reportsIo = await import("../lib/founders-finances/reports-io");
  const { buildPosting } = await import("../lib/founders-finances/ledger-io");
  const { writeBatch } = await import("../lib/founders-finances/db");
  const { payoutFacts } = await import("../lib/founders-finances/stripe-map");
  const { usdToCadCents, parseRateMicro } = await import("../lib/founders-finances/fx");
  const { accountId, SYS, BUSINESS_ENTITY_ID: B } = await import("../lib/founders-finances/chart");
  await ensureFinanceSeed();

  const CHEQUING = accountId(B, SYS.chequing);
  const CLEARING = accountId(B, SYS.stripeClearing);
  const FX_CLEARING = accountId(B, SYS.fxClearing);
  const FX_GAIN_LOSS = accountId(B, SYS.fxGainLoss);
  const cad138 = (usd: number) => usdToCadCents(usd, parseRateMicro("1.3800"));
  const num = async (sql: string, args: Array<string | number> = []) => Number((await raw.execute({ sql, args })).rows[0][0] ?? 0);
  const held = (account: string, currency: string) =>
    num(`SELECT COALESCE(SUM(debit_cents - credit_cents), 0) FROM fin_journal_lines WHERE account_id = ? AND currency = ?`, [account, currency]);
  const cadBalance = (account: string) => num(`SELECT COALESCE(SUM(cad_debit_cents - cad_credit_cents), 0) FROM fin_journal_lines WHERE account_id = ?`, [account]);
  const row = async (id: string) => (await raw.execute({ sql: `SELECT * FROM fin_stripe_payouts WHERE id = ?`, args: [id] })).rows[0] as unknown as Record<string, string | number | null> | undefined;
  const entries = (source: string, ref: string) => num(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = ? AND source_ref = ?`, [source, ref]);
  const coverage = async () => (await reportsIo.overview(cc, B, { sweep: "deferred" })).coverage;
  const booksBalance = async () => {
    assert.equal(await num(`SELECT COUNT(*) FROM (SELECT entry_id, currency FROM fin_journal_lines GROUP BY entry_id, currency HAVING SUM(debit_cents) <> SUM(credit_cents))`), 0, "every entry balances in each currency");
    assert.equal(await num(`SELECT COUNT(*) FROM (SELECT entry_id FROM fin_journal_lines GROUP BY entry_id HAVING SUM(cad_debit_cents) <> SUM(cad_credit_cents))`), 0, "every entry balances in CAD");
  };

  // ── pure: planStripePayout ────────────────────────────────────────────────
  const acct = { stripeClearing: CLEARING, fxClearing: FX_CLEARING, fxGainLoss: FX_GAIN_LOSS, stripeFees: accountId(B, SYS.stripeFees), bankFees: accountId(B, "5010") };
  const facts = (over: Partial<ReturnType<typeof payoutFacts> & object> = {}) => ({ ...payoutFacts(payout({ id: "po_pure", amount: 6784, arrival: "2026-09-08" }))!, ...over });
  const cadOf = (cents: number, currency: string) => (currency === "CAD" ? cents : cad138(cents));

  await check("plan: no payout account chosen -> unmapped, never a guessed account", () => {
    const p = payouts.planStripePayout({ payout: facts(), bankAccountId: null, accounts: acct, clearing: { USD: 100_000 }, cadOf });
    assert.equal(p.kind, "unmapped");
    assert.match((p as { reason: string }).reason, /no bank account is chosen for Stripe payouts/);
  });

  await check("plan: USD clearing covers it -> Dr bank / Cr Stripe clearing in USD, no conversion", () => {
    const p = payouts.planStripePayout({ payout: facts(), bankAccountId: CHEQUING, accounts: acct, clearing: { USD: 6784 }, cadOf });
    assert.equal(p.kind, "book");
    if (p.kind !== "book") return;
    assert.equal(p.conversion, null);
    assert.deepEqual(
      p.lines.map((l) => [l.accountId, l.currency, l.debitCents ?? 0, l.creditCents ?? 0]),
      [
        [CHEQUING, "USD", 6784, 0],
        [CLEARING, "USD", 0, 6784],
      ],
    );
  });

  await check("plan: USD short, CAD holds the charges -> the shortfall is converted out of CAD clearing at the arrival day's rate", () => {
    const p = payouts.planStripePayout({ payout: facts(), bankAccountId: CHEQUING, accounts: acct, clearing: { CAD: 10_000, USD: -442 }, cadOf });
    assert.equal(p.kind, "book");
    if (p.kind !== "book" || !p.conversion) return assert.fail("expected a conversion");
    assert.equal(p.conversion.cents, 7226, "brings USD clearing from -4.42 to exactly the payout");
    assert.equal(p.conversion.cadCents, cad138(7226));
    assert.equal(p.conversion.cadTakenCents, cad138(7226), "CAD clearing holds more than enough");
  });

  await check("plan: CAD clearing a little short (Stripe's rate) -> takes what it holds, the rest is a realised FX gain", () => {
    const need = cad138(7226);
    const p = payouts.planStripePayout({ payout: facts(), bankAccountId: CHEQUING, accounts: acct, clearing: { CAD: need - 100, USD: -442 }, cadOf });
    if (p.kind !== "book" || !p.conversion) return assert.fail("expected a conversion");
    assert.equal(p.conversion.cadTakenCents, need - 100);
    const gain = p.conversion.lines.find((l) => l.accountId === FX_GAIN_LOSS);
    assert.equal(gain?.creditCents, 100);
  });

  await check("plan: CAD clearing far short -> held: the charges it pays out are not in the books", () => {
    const p = payouts.planStripePayout({ payout: facts(), bankAccountId: CHEQUING, accounts: acct, clearing: { CAD: 2_000, USD: 0 }, cadOf });
    assert.equal(p.kind, "held");
    assert.match((p as { reason: string }).reason, /not recorded yet/);
  });

  await check("plan: no settlement, no rate, a negative payout -> held with the reason, nothing booked", () => {
    const noBt = payouts.planStripePayout({ payout: facts({ settlementCents: null, settlementCurrency: null }), bankAccountId: CHEQUING, accounts: acct, clearing: { USD: 99_999 }, cadOf });
    assert.match((noBt as { reason: string }).reason, /did not say what payout po_pure took/);
    const noRate = payouts.planStripePayout({ payout: facts(), bankAccountId: CHEQUING, accounts: acct, clearing: { CAD: 99_999 }, cadOf: (c, cur) => (cur === "CAD" ? c : null) });
    assert.match((noRate as { reason: string }).reason, /no Bank of Canada USD rate is stored for 2026-09-08/);
    const back = payouts.planStripePayout({ payout: facts({ amountCents: -500, settlementCents: -500 }), bankAccountId: CHEQUING, accounts: acct, clearing: { USD: 99_999 }, cadOf });
    assert.equal(back.kind, "held");
  });

  // ── the webhook: a charge, then its payout ───────────────────────────────
  const charge = liveCharge({ id: "ch_payout_1", amount: 10_000, at: "2026-09-05T19:27:56Z", bt: { id: "txn_ch_payout_1", amount: 7226, fee: 442 } });
  await check("setup: a CA$100 charge settles into USD: CAD 100.00 in clearing, the USD 4.42 fee out of it", async () => {
    const out = await ingest.handleStripeEvent(event("charge.succeeded", charge, "2026-09-05T19:28:00Z"));
    assert.equal(out.status, "processed");
    assert.equal(await held(CLEARING, "CAD"), 10_000);
    assert.equal(await held(CLEARING, "USD"), -442);
    const gaps = (await coverage()).gaps.join(" | ");
    assert.match(gaps, /Stripe payouts to the bank are not recorded/, "before any payout: the old shape check still speaks");
  });

  const P1 = payout({ id: "po_live_1", amount: 6784, arrival: "2026-09-08" });
  await check("payout.paid with no payout account chosen: recorded 'unmapped', nothing posted, and the cash tile names it", async () => {
    const out = await ingest.handleStripeEvent(event("payout.paid", P1));
    assert.equal(out.status, "processed");
    assert.equal((await row("po_live_1"))?.booking, "unmapped");
    assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_live_1"), 0);
    const cov = await coverage();
    assert.ok(
      cov.gaps.includes("1 Stripe payout to the bank is not booked: no bank account is chosen for Stripe payouts (Finances › Settings › Stripe)"),
      cov.gaps.join(" | "),
    );
    assert.ok(!cov.gaps.some((g) => g === "Stripe payouts to the bank are not recorded"), "one precise gap, not two");
  });

  await check("choosing the payout account books the waiting payout: Stripe clearing back to Stripe's $0, the USD in chequing", async () => {
    await assert.rejects(settingsIo.setStripePayoutAccount(cc, B, CLEARING), /bank accounts/, "only a bank account");
    const r = await settingsIo.setStripePayoutAccount(cc, B, CHEQUING);
    assert.equal(r.booked, 1);
    const p = await row("po_live_1");
    assert.equal(p?.booking, "booked");
    assert.equal(p?.bank_account_id, CHEQUING);
    assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_live_1"), 1);
    assert.equal(await entries(payouts.PAYOUT_FX_SOURCE, "po_live_1"), 1);
    assert.equal(await held(CHEQUING, "USD"), 6784, "chequing holds what reached the bank");
    assert.equal(await held(CLEARING, "USD"), 0, "USD clearing: fee -4.42, conversion +72.26, payout -67.84");
    assert.equal(await held(CLEARING, "CAD"), 10_000 - cad138(7226), "CAD clearing: only the gap between Stripe's rate and the Bank of Canada's");
    assert.equal(await cadBalance(FX_CLEARING), 0, "currency exchange clearing nets to zero");
    await booksBalance();
    const cov = await coverage();
    assert.ok(!cov.gaps.some((g) => /Stripe payout/.test(g)), `a booked payout satisfies the payout check: ${cov.gaps.join(" | ")}`);
    const clearingLine = cov.accounts.find((a) => a.code === SYS.stripeClearing);
    assert.match(clearingLine?.covers ?? "", /payouts to the bank are recorded/);
  });

  await check("a redelivered payout.paid (another event, same payout) books nothing twice", async () => {
    const out = await ingest.handleStripeEvent(event("payout.paid", P1));
    assert.equal(out.status, "processed");
    assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_live_1"), 1);
    assert.equal(await entries(payouts.PAYOUT_FX_SOURCE, "po_live_1"), 1);
    assert.equal(await held(CHEQUING, "USD"), 6784);
    const same = event("payout.paid", P1);
    await ingest.handleStripeEvent(same);
    assert.equal((await ingest.handleStripeEvent(same)).status, "duplicate", "the same event id is a no-op");
  });

  await check("payout.failed after it was booked: the payout entry is reversed on the day Stripe said so", async () => {
    const out = await ingest.handleStripeEvent(event("payout.failed", { ...P1, status: "failed", failure_code: "account_closed" }, "2026-09-10T15:00:00Z"));
    assert.equal(out.status, "processed");
    const p = await row("po_live_1");
    assert.equal(p?.booking, "reversed");
    assert.ok(p?.reversal_entry_id);
    const original = (await raw.execute({ sql: `SELECT status FROM fin_journal_entries WHERE id = ?`, args: [String(p?.entry_id)] })).rows[0];
    assert.equal(original.status, "reversed");
    const reversal = (await raw.execute({ sql: `SELECT entry_date FROM fin_journal_entries WHERE id = ?`, args: [String(p?.reversal_entry_id)] })).rows[0];
    assert.equal(reversal.entry_date, "2026-09-10");
    assert.equal(await held(CHEQUING, "USD"), 0, "the money never stayed in the bank");
    assert.equal(await held(CLEARING, "USD"), 6784, "it is back in the Stripe balance");
    await booksBalance();
    // A failed payout never comes back to paid, whatever order the events arrive in.
    await ingest.handleStripeEvent(event("payout.paid", P1));
    assert.equal((await row("po_live_1"))?.booking, "reversed");
    assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_live_1"), 1);
  });

  await check("payout.canceled before it landed: recorded 'not_booked', nothing posted", async () => {
    const P2 = payout({ id: "po_canceled", amount: 1_000, arrival: "2026-09-12", status: "canceled" });
    await ingest.handleStripeEvent(event("payout.canceled", P2));
    assert.equal((await row("po_canceled"))?.booking, "not_booked");
    assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_canceled"), 0);
    assert.equal(await entries(payouts.PAYOUT_FX_SOURCE, "po_canceled"), 0);
  });

  await check("a payout the event names without its balance transaction (and no key to read it) is held, and says why", async () => {
    await ingest.handleStripeEvent(event("payout.paid", payout({ id: "po_no_bt", amount: 500, arrival: "2026-09-14", bt: null })));
    const p = await row("po_no_bt");
    assert.equal(p?.booking, "held");
    assert.match(String(p?.reason), /Stripe did not say what payout po_no_bt took from the Stripe balance/);
    assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_no_bt"), 0);
  });

  await check("a payout bigger than anything in clearing is held, and the cash tile lists every unbooked payout", async () => {
    await ingest.handleStripeEvent(event("payout.paid", payout({ id: "po_too_big", amount: 900_000, arrival: "2026-09-15" })));
    assert.equal((await row("po_too_big"))?.booking, "held");
    const unbooked = await payoutsIo.unbookedPayouts();
    assert.deepEqual(unbooked.map((u) => u.id), ["po_no_bt", "po_too_big"], "oldest first");
    const cov = await coverage();
    assert.ok(
      cov.gaps.some((g) => g.startsWith("2 Stripe payouts to the bank are not booked (the oldest, Sep 14: Stripe did not say")),
      cov.gaps.join(" | "),
    );
  });

  await check("a payout the Wise feed already booked from its bank line is adopted, never posted a second time", async () => {
    const posting = await buildPosting({
      entityId: B,
      entryDate: "2026-09-16",
      memo: "Stripe payout po_from_bank: a transfer out of Stripe clearing, not revenue.",
      source: "bank_txn",
      sourceRef: "txn_bank_line_1",
      createdBy: "test",
      lines: [
        { accountId: CHEQUING, currency: "USD", debitCents: 1_000 },
        { accountId: CLEARING, currency: "USD", creditCents: 1_000 },
      ],
    });
    await writeBatch([
      ...posting.statements,
      {
        sql: `INSERT INTO fin_bank_transactions (id, entity_id, account_id, posted_date, description, amount_cents, currency, status, entry_id, dedupe_hash, fitid, source, created_by)
              VALUES ('txn_bank_line_1', ?, ?, '2026-09-16', 'Stripe payout po_from_bank — Received money from OASIS AI', 1000, 'USD', 'posted', ?, 'h1', 'WISE-USD-CREDIT-1', 'import', 'test')`,
        args: [B, CHEQUING, posting.entryId],
      },
    ]);
    await ingest.handleStripeEvent(event("payout.paid", payout({ id: "po_from_bank", amount: 1_000, arrival: "2026-09-16" })));
    const p = await row("po_from_bank");
    assert.equal(p?.booking, "booked");
    assert.equal(p?.entry_id, posting.entryId, "the bank line's own entry");
    assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_from_bank"), 0);
    assert.equal(await entries(payouts.PAYOUT_FX_SOURCE, "po_from_bank"), 0);
    // A prefix of another payout's id never matches (po_from_ban is not po_from_bank).
    await ingest.handleStripeEvent(event("payout.paid", payout({ id: "po_from_ban", amount: 1_000, arrival: "2026-09-16" })));
    assert.notEqual((await row("po_from_ban"))?.entry_id, posting.entryId);
    // And the feed finds the Stripe booking to link its own line to.
    assert.equal(await payoutsIo.bookedPayoutEntry("po_from_bank"), null, "an adopted bank-line entry is the feed's own, not one to link to");
  });

  await check("a test-mode payout never enters the books", async () => {
    const out = await ingest.handleStripeEvent({ ...event("payout.paid", payout({ id: "po_test_mode", amount: 100, arrival: "2026-09-16" })), livemode: false });
    assert.equal(out.status, "ignored");
    assert.equal(await row("po_test_mode"), undefined);
  });

  await check("the daily reconcile books a payout the webhook never delivered, retries the held ones, and records that it ran", async () => {
    await raw.execute({ sql: `UPDATE fin_settings SET stripe_account_id = 'acct_test_oasis' WHERE entity_id = ?`, args: [B] });
    process.env.STRIPE_SECRET_KEY = "sk_test_reconcile_only";
    stripe.serve = true;
    stripe.payouts = [payout({ id: "po_only_in_stripe", amount: 500, arrival: "2026-09-20" })];
    try {
      const before = await ingest.lastStripeSync();
      const summary = await ingest.reconcileStripe({ days: 7 });
      assert.equal(summary.payouts_seen, 1);
      assert.equal(summary.payouts_booked, 1);
      assert.equal(summary.payouts_unbooked, 2, "po_no_bt and po_too_big are still held, and counted");
      assert.equal((await row("po_only_in_stripe"))?.booking, "booked");
      assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_only_in_stripe"), 1);
      const again = await ingest.reconcileStripe({ days: 7 });
      assert.equal(again.payouts_booked, 0, "a re-run books nothing new");
      assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_only_in_stripe"), 1);
      assert.equal(await num(`SELECT COUNT(*) FROM fin_audit_log WHERE action = ?`, [ingest.STRIPE_RECONCILED_ACTION]), 2, "each run leaves the row 'Last synced' reads");
      const after = await ingest.lastStripeSync();
      assert.ok(after && (!before || after > before), `last sync moved forward: ${before} -> ${after}`);
      await booksBalance();
    } finally {
      stripe.serve = false;
      delete process.env.STRIPE_SECRET_KEY;
    }
  });

  await check("the webhook's handled types include the payout events (the endpoint must be subscribed to each)", () => {
    for (const t of ["payout.paid", "payout.failed", "payout.canceled", "charge.failed"]) {
      assert.ok((ingest.HANDLED_EVENT_TYPES as readonly string[]).includes(t), t);
    }
  });

  if (failures) {
    console.error(`finances-stripe-payouts: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("finances-stripe-payouts: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
