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
 * What else is pinned (the review of PR #491):
 *   - a USD payout converts EXACTLY the charges it pays out (Stripe's list of
 *     them, matched to the rows that booked them): nothing of a paid-out
 *     charge stays in CAD clearing, and Stripe's rate against the Bank of
 *     Canada's is a realised loss or gain, both ways; Stripe clearing is read
 *     as of the arrival day;
 *   - one payout is on the books once, whichever came first: a deposit
 *     categorised to Stripe clearing (an uploaded statement, the seeded rule)
 *     is adopted by the payout, and a deposit categorised after the payout
 *     was booked is linked to it; each side's write is gated on the other, so
 *     one landing between a check and its write changes nothing;
 *   - "Last synced" counts only live events that reached the books.
 *
 * The figures copy the live account's shape (stripe-ingest.ts header): a CA$
 * charge settles into a USD balance (CA$100.00 -> US$72.26, fee US$4.42), so
 * Stripe clearing holds the charge in CAD and the fee in USD, and the USD
 * payout needs the CAD converted. api.stripe.com is served from fixtures
 * only inside withStripe (reads only); elsewhere there is no Stripe key and
 * events are processed from their payloads, exactly as the webhook does
 * without a verified key. The Bank of Canada is unreachable.
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

type Json = Record<string, unknown>;

/** api.stripe.com while `serve` is on (reads only; any write throws): payouts, and what each payout pays out. */
const stripe = { serve: false, payouts: [] as Json[], contents: {} as Record<string, Json[]> };
globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
  const url = new URL(String(input));
  if (stripe.serve && url.host === "api.stripe.com") {
    if ((init?.method || "GET").toUpperCase() !== "GET") throw new Error(`Stripe write attempted in test: ${url.pathname}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const list = (data: unknown[]) => json({ object: "list", data, has_more: false });
    if (url.pathname === "/v1/account") return json({ id: "acct_test_oasis", settings: { dashboard: { display_name: "OASIS AI" } } });
    if (url.pathname === "/v1/balance_transactions") return list(stripe.contents[url.searchParams.get("payout") ?? ""] ?? []);
    if (url.pathname === "/v1/payouts") return list(stripe.payouts);
    if (["/v1/charges", "/v1/refunds", "/v1/subscriptions", "/v1/invoice_payments"].includes(url.pathname)) return list([]);
    return json({ error: { message: "No such object" } }, 404);
  }
  throw new Error(`network disabled in test: ${url.host}${url.pathname}`);
}) as typeof fetch;

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
function payout(p: { id: string; amount: number; arrival: string; status?: string; currency?: "usd" | "cad"; bt?: { amount: number; fee?: number } | null }): Json {
  const currency = p.currency ?? "usd";
  return {
    id: p.id,
    object: "payout",
    amount: p.amount,
    currency,
    arrival_date: epoch(`${p.arrival}T00:00:00Z`),
    created: epoch(`${p.arrival}T00:00:00Z`) - 2 * 86_400,
    status: p.status ?? "paid",
    livemode: true,
    automatic: true,
    destination: "ba_test_wise",
    balance_transaction:
      p.bt === null ? `txn_${p.id}` : { id: `txn_${p.id}`, object: "balance_transaction", amount: -(p.bt?.amount ?? p.amount), fee: p.bt?.fee ?? 0, currency },
  };
}

/** One entry of Stripe's list of what a payout pays out (GET /v1/balance_transactions?payout=). */
const bt = (id: string, type: string, source: string, amount: number, fee = 0): Json => ({ id, object: "balance_transaction", type, source, amount, fee, net: amount - fee, currency: "usd" });

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

/** With a Stripe key for the pinned account, and api.stripe.com served from the fixtures. */
async function withStripe<T>(fn: () => Promise<T>): Promise<T> {
  process.env.STRIPE_SECRET_KEY = "sk_test_payouts_only";
  stripe.serve = true;
  try {
    return await fn();
  } finally {
    stripe.serve = false;
    delete process.env.STRIPE_SECRET_KEY;
  }
}

/**
 * Run `fn`; the first time a write batch that `match` picks is about to run,
 * run `race` first: the moment between a check and its write, where a
 * concurrent webhook, reconcile or founder lands. Test-only: the cached
 * libSQL client's batch is shadowed for the duration.
 */
async function withRace<T>(match: (batchJson: string) => boolean, race: () => Promise<void>, fn: () => Promise<T>): Promise<{ result: T; raced: boolean }> {
  const { getTursoClient } = await import("../lib/turso");
  const client = getTursoClient() as unknown as Record<string, unknown>;
  const original = (Object.getPrototypeOf(client) as { batch: (...a: unknown[]) => Promise<unknown> }).batch;
  let raced = false;
  client.batch = async function (this: unknown, stmts: unknown, ...rest: unknown[]) {
    if (!raced && match(JSON.stringify(stmts))) {
      raced = true;
      await race();
    }
    return original.call(this, stmts, ...rest);
  };
  try {
    const result = await fn();
    return { result, raced };
  } finally {
    delete client.batch;
  }
}

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
  const txns = await import("../lib/founders-finances/transactions-io");
  const { buildPosting } = await import("../lib/founders-finances/ledger-io");
  const { writeBatch } = await import("../lib/founders-finances/db");
  const { payoutFacts } = await import("../lib/founders-finances/stripe-map");
  const { usdToCadCents, parseRateMicro } = await import("../lib/founders-finances/fx");
  const { accountId, SYS, BUSINESS_ENTITY_ID: B } = await import("../lib/founders-finances/chart");
  await ensureFinanceSeed();
  // The account the key belongs to is pinned; without a key (most of this file) that changes nothing.
  await raw.execute({ sql: `UPDATE fin_settings SET stripe_account_id = 'acct_test_oasis' WHERE entity_id = ?`, args: [B] });

  const CHEQUING = accountId(B, SYS.chequing);
  const CLEARING = accountId(B, SYS.stripeClearing);
  const FX_CLEARING = accountId(B, SYS.fxClearing);
  const FX_GAIN_LOSS = accountId(B, SYS.fxGainLoss);
  const STRIPE_FEES = accountId(B, SYS.stripeFees);
  const cad138 = (usd: number) => usdToCadCents(usd, parseRateMicro("1.3800"));
  const num = async (sql: string, args: Array<string | number> = []) => Number((await raw.execute({ sql, args })).rows[0][0] ?? 0);
  const held = (account: string, currency: string) =>
    num(`SELECT COALESCE(SUM(debit_cents - credit_cents), 0) FROM fin_journal_lines WHERE account_id = ? AND currency = ?`, [account, currency]);
  const cadBalance = (account: string) => num(`SELECT COALESCE(SUM(cad_debit_cents - cad_credit_cents), 0) FROM fin_journal_lines WHERE account_id = ?`, [account]);
  const row = async (id: string) => (await raw.execute({ sql: `SELECT * FROM fin_stripe_payouts WHERE id = ?`, args: [id] })).rows[0] as unknown as Record<string, string | number | null> | undefined;
  const entries = (source: string, ref: string) => num(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = ? AND source_ref = ?`, [source, ref]);
  const line = async (description: string) =>
    (await raw.execute({ sql: `SELECT * FROM fin_bank_transactions WHERE description = ?`, args: [description] })).rows[0] as unknown as Record<string, string | number | null>;
  const coverage = async () => (await reportsIo.overview(cc, B, { sweep: "deferred" })).coverage;
  const booksBalance = async () => {
    assert.equal(await num(`SELECT COUNT(*) FROM (SELECT entry_id, currency FROM fin_journal_lines GROUP BY entry_id, currency HAVING SUM(debit_cents) <> SUM(credit_cents))`), 0, "every entry balances in each currency");
    assert.equal(await num(`SELECT COUNT(*) FROM (SELECT entry_id FROM fin_journal_lines GROUP BY entry_id HAVING SUM(cad_debit_cents) <> SUM(cad_credit_cents))`), 0, "every entry balances in CAD");
  };
  /** A charge already in Stripe clearing in `currency` (a US client paying in USD, say): what a payout can take without a conversion. */
  const chargeInClearing = async (ref: string, day: string, cents: number, currency = "USD") => {
    const posting = await buildPosting({
      entityId: B,
      entryDate: day,
      memo: "Stripe charge",
      source: "stripe_charge",
      sourceRef: ref,
      createdBy: "test",
      lines: [
        { accountId: CLEARING, currency, debitCents: cents },
        { accountId: accountId(B, SYS.serviceRevenue), currency, creditCents: cents },
      ],
    });
    await writeBatch(posting.statements);
  };
  /** An uploaded statement (CSV) for Business chequing, in USD; the seeded "Stripe payouts are transfers" rule categorises a Stripe deposit. */
  const importCsv = (rows: string) => txns.commitImport(cc, B, { accountId: CHEQUING, filename: `bank-${++seq}.csv`, text: `Date,Description,Amount\n${rows}\n`, currency: "USD" });

  // ── pure: planStripePayout ────────────────────────────────────────────────
  const acct = { stripeClearing: CLEARING, fxClearing: FX_CLEARING, fxGainLoss: FX_GAIN_LOSS, stripeFees: STRIPE_FEES, bankFees: accountId(B, "5010") };
  const facts = (over: Partial<ReturnType<typeof payoutFacts> & object> = {}) => ({ ...payoutFacts(payout({ id: "po_pure", amount: 6784, arrival: "2026-09-08" }))!, ...over });
  const cadOf = (cents: number, currency: string) => (currency === "CAD" ? cents : cad138(cents));
  /** What po_pure pays out: one CA$100.00 charge Stripe settled at US$72.26 (fee US$4.42). */
  const contents = (over: Partial<{ settledCents: number; cadBookedCents: number; stripeFeeCents: number }> = {}) => ({
    ok: true as const,
    settledCents: 7226,
    cadBookedCents: 10_000,
    stripeFeeCents: 0,
    ...over,
  });
  const plan = (clearing: Record<string, number>, c: ReturnType<typeof contents> | { ok: false; reason: string } | null, over = {}) =>
    payouts.planStripePayout({ payout: facts(over), bankAccountId: CHEQUING, accounts: acct, clearing, contents: c, cadOf });
  const lines = (ls: Array<{ accountId: string; currency: string; debitCents?: number; creditCents?: number }>) =>
    ls.map((l) => [l.accountId, l.currency, l.debitCents ?? 0, l.creditCents ?? 0]);

  await check("plan: no payout account chosen -> unmapped, never a guessed account", () => {
    const p = payouts.planStripePayout({ payout: facts(), bankAccountId: null, accounts: acct, clearing: { USD: 100_000 }, contents: null, cadOf });
    assert.equal(p.kind, "unmapped");
    assert.match((p as { reason: string }).reason, /no bank account is chosen for Stripe payouts/);
  });

  await check("plan: USD clearing covers it -> Dr bank / Cr Stripe clearing in USD, no conversion, no contents needed", () => {
    assert.equal(payouts.payoutNeedsContents(facts(), { USD: 6784 }), false);
    const p = plan({ USD: 6784 }, null);
    assert.equal(p.kind, "book");
    if (p.kind !== "book") return;
    assert.equal(p.conversion, null);
    assert.deepEqual(lines(p.lines), [
      [CHEQUING, "USD", 6784, 0],
      [CLEARING, "USD", 0, 6784],
    ]);
  });

  await check("plan: USD short -> converts exactly the charges it pays out; Stripe's rate below the Bank of Canada's is a realised LOSS", () => {
    assert.equal(payouts.payoutNeedsContents(facts(), { CAD: 10_000, USD: -442 }), true);
    assert.equal(payouts.payoutNeedsContents(facts({ settlementCurrency: "CAD" }), { CAD: 0 }), false, "a CAD payout never converts");
    const p = plan({ CAD: 10_000, USD: -442 }, contents());
    if (p.kind !== "book" || !p.conversion) return assert.fail(`expected a conversion: ${JSON.stringify(p)}`);
    const need = cad138(7226);
    assert.equal(p.conversion.cents, 7226, "what Stripe settled the charge at, not a shortfall");
    assert.equal(p.conversion.cadCents, need);
    assert.equal(p.conversion.cadTakenCents, 10_000, "the whole CAD the charge was booked at leaves clearing");
    assert.equal(p.conversion.fxCents, need - 10_000);
    assert.deepEqual(lines(p.conversion.lines), [
      [CLEARING, "USD", 7226, 0],
      [FX_CLEARING, "USD", 0, 7226],
      [FX_CLEARING, "CAD", need, 0],
      [CLEARING, "CAD", 0, 10_000],
      [FX_GAIN_LOSS, "CAD", 10_000 - need, 0],
    ]);
  });

  await check("plan: ...and a realised GAIN when the charges were booked at less CAD than their USD is worth", () => {
    const need = cad138(7226);
    const p = plan({ CAD: 20_000, USD: -442 }, contents({ cadBookedCents: need - 100 }));
    if (p.kind !== "book" || !p.conversion) return assert.fail("expected a conversion");
    assert.equal(p.conversion.cadTakenCents, need - 100, "only what those charges were booked at, not what clearing happens to hold");
    assert.equal(p.conversion.lines.find((l) => l.accountId === FX_GAIN_LOSS)?.creditCents, 100);
  });

  await check("plan: held, with the reason, whenever the contents cannot be trusted", () => {
    const reason = (p: ReturnType<typeof plan>) => (p.kind === "book" ? assert.fail("expected held") : (p as { reason: string }).reason);
    assert.equal(reason(plan({ CAD: 10_000, USD: -442 }, { ok: false, reason: "the Stripe charge ch_x that payout po_pure pays out is not booked yet" })), "the Stripe charge ch_x that payout po_pure pays out is not booked yet");
    assert.match(reason(plan({ CAD: 10_000, USD: -442 }, null)), /Stripe was not asked which charges payout po_pure pays out/);
    assert.match(reason(plan({ CAD: 2_000, USD: -442 }, contents())), /were booked at 100\.00 CAD, but Stripe clearing holds 20\.00 CAD on the books on 2026-09-08/);
    assert.match(reason(plan({ CAD: 20_000, USD: -442 }, contents({ cadBookedCents: 15_000 }))), /a gap that size is not exchange rates/, "a loss beyond the tolerance");
    assert.match(reason(plan({ CAD: 20_000, USD: -442 }, contents({ cadBookedCents: 8_000 }))), /a gap that size is not exchange rates/, "a gain beyond the tolerance: never invented income");
    assert.match(reason(plan({ CAD: 20_000, USD: -442 }, contents({ settledCents: 0, cadBookedCents: 0 }))), /pays out no charge the books hold in CAD/);
  });

  await check("plan: Stripe's own fees in the payout (billing fees) are booked with it", () => {
    const p = plan({ CAD: 10_000, USD: -442 }, contents({ stripeFeeCents: 100 }), { amountCents: 6684, settlementCents: 6684 });
    if (p.kind !== "book") return assert.fail(`expected a booking: ${JSON.stringify(p)}`);
    assert.deepEqual(lines(p.lines), [
      [CHEQUING, "USD", 6684, 0],
      [CLEARING, "USD", 0, 6684],
      [STRIPE_FEES, "USD", 100, 0],
      [CLEARING, "USD", 0, 100],
    ]);
  });

  await check("plan: no settlement, no rate, a negative payout -> held with the reason, nothing booked", () => {
    const noBt = plan({ USD: 99_999 }, null, { settlementCents: null, settlementCurrency: null });
    assert.match((noBt as { reason: string }).reason, /did not say what payout po_pure took/);
    const noRate = payouts.planStripePayout({ payout: facts(), bankAccountId: CHEQUING, accounts: acct, clearing: { CAD: 99_999 }, contents: contents(), cadOf: (c, cur) => (cur === "CAD" ? c : null) });
    assert.match((noRate as { reason: string }).reason, /no Bank of Canada USD rate is stored for 2026-09-08/);
    const back = plan({ USD: 99_999 }, null, { amountCents: -500, settlementCents: -500 });
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
  stripe.payouts = [P1];
  stripe.contents.po_live_1 = [bt("txn_ch_payout_1", "charge", "ch_payout_1", 7226, 442), bt("txn_po_live_1", "payout", "po_live_1", -6784)];
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

  await check("choosing the payout account with no Stripe key: the payout waits, held, saying Stripe must list what it pays out", async () => {
    await assert.rejects(settingsIo.setStripePayoutAccount(cc, B, CLEARING), /bank accounts/, "only a bank account");
    const r = await settingsIo.setStripePayoutAccount(cc, B, CHEQUING);
    assert.equal(r.booked, 0);
    const p = await row("po_live_1");
    assert.equal(p?.booking, "held");
    assert.match(String(p?.reason), /Stripe is not connected \(stripe_key_missing\), so which charges payout po_live_1 pays out cannot be read/);
    assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_live_1"), 0);
  });

  await check("with Stripe connected the waiting payout books: its charge's CAD leaves clearing whole, the conversion's loss is FX, clearing back to Stripe's $0", async () => {
    assert.equal(await withStripe(() => payoutsIo.retryUnbookedPayouts()), 1);
    const p = await row("po_live_1");
    assert.equal(p?.booking, "booked");
    assert.equal(p?.bank_account_id, CHEQUING);
    assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_live_1"), 1);
    assert.equal(await entries(payouts.PAYOUT_FX_SOURCE, "po_live_1"), 1);
    assert.equal(await held(CHEQUING, "USD"), 6784, "chequing holds what reached the bank");
    assert.equal(await held(CLEARING, "USD"), 0, "USD clearing: fee -4.42, conversion +72.26, payout -67.84");
    assert.equal(await held(CLEARING, "CAD"), 0, "CAD clearing: nothing of the paid-out charge stays behind to read as cash");
    assert.equal(await cadBalance(FX_GAIN_LOSS), 10_000 - cad138(7226), "Stripe's rate against the Bank of Canada's: a realised loss");
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
    // A prefix of another payout's id never matches (po_from_ban is not po_from_bank), and a
    // bank line another payout owns is never adopted by its shape either.
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
    stripe.payouts = [payout({ id: "po_only_in_stripe", amount: 500, arrival: "2026-09-20" })];
    await withStripe(async () => {
      const before = await ingest.lastStripeSync();
      const summary = await ingest.reconcileStripe({ days: 7 });
      assert.equal(summary.payouts_seen, 1);
      assert.equal(summary.payouts_booked, 1);
      assert.equal(summary.payouts_unbooked, 2, "po_no_bt and po_too_big are still held, and counted");
      assert.equal((await row("po_only_in_stripe"))?.booking, "booked");
      assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_only_in_stripe"), 1);
      assert.match(String((await row("po_too_big"))?.reason), /what Stripe lists in payout po_too_big comes to 0\.00 USD, not the 9000\.00 USD it took/);
      const again = await ingest.reconcileStripe({ days: 7 });
      assert.equal(again.payouts_booked, 0, "a re-run books nothing new");
      assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_only_in_stripe"), 1);
      assert.equal(await num(`SELECT COUNT(*) FROM fin_audit_log WHERE action = ?`, [ingest.STRIPE_RECONCILED_ACTION]), 2, "each run leaves the row 'Last synced' reads");
      const after = await ingest.lastStripeSync();
      assert.ok(after && (!before || after > before), `last sync moved forward: ${before} -> ${after}`);
      await booksBalance();
    });
  });

  await check("'Last synced' moves only when a live event reaches the books: a test-mode, unhandled or failing delivery does not count", async () => {
    const before = await ingest.lastStripeSync();
    assert.ok(before, "the books have heard from Stripe by now");
    // The condition Settings reads too (page-context.ts selects it; tests/os-stripe-sync.test.ts pins the page to it).
    const eventSync = async () => (await raw.execute(ingest.LAST_SYNCED_EVENT_SQL)).rows[0][0];
    const eventBefore = await eventSync();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await ingest.handleStripeEvent({ ...event("payout.paid", payout({ id: "po_sync_test_mode", amount: 100, arrival: "2026-09-16" })), livemode: false })).status, "ignored");
    assert.equal((await ingest.handleStripeEvent(event("customer.created", { id: "cus_sync", object: "customer" }))).status, "ignored");
    const broken = event("charge.succeeded", { id: "not_a_charge", object: "charge" });
    await assert.rejects(ingest.handleStripeEvent(broken), /without a readable charge/);
    await assert.rejects(ingest.handleStripeEvent(broken), /without a readable charge/, "Stripe's retry fails again, and is claimed again");
    assert.equal(await ingest.lastStripeSync(), before, "nothing reached the books");
    assert.equal(await eventSync(), eventBefore, "Settings' webhook half of Last synced did not move either");
    const received = String((await raw.execute(`SELECT MAX(received_at) FROM fin_stripe_events`)).rows[0][0]);
    assert.ok(received > before, "the deliveries themselves were received (and are shown as such)");
  });

  // ── one payout, one booking, whichever reached the books first ───────────
  await check("a deposit already categorised to Stripe clearing (an uploaded statement, the seeded rule) IS the payout: payout.paid adopts its entry and posts nothing", async () => {
    const chequingBefore = await held(CHEQUING, "USD");
    const clearingBefore = await held(CLEARING, "USD");
    const imported = await importCsv(`2026-09-22,STRIPE TRANSFER,40.00`);
    assert.equal(imported.posted, 1, "the rule categorised it: Dr chequing / Cr Stripe clearing");
    const bankLine = await line("STRIPE TRANSFER");
    assert.ok(bankLine.entry_id);
    const out = await ingest.handleStripeEvent(event("payout.paid", payout({ id: "po_csv_first", amount: 4_000, arrival: "2026-09-21" })));
    assert.equal(out.detail, "payout po_csv_first booked");
    const p = await row("po_csv_first");
    assert.equal(p?.entry_id, bankLine.entry_id, "the bank line's entry");
    assert.equal(p?.bank_account_id, CHEQUING);
    assert.match(String(p?.reason), /booked from the bank line of 2026-09-22 already on the books/);
    assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_csv_first"), 0, "no second entry");
    assert.equal(await held(CHEQUING, "USD"), chequingBefore + 4_000, "the US$40 reached the bank once");
    assert.equal(await held(CLEARING, "USD"), clearingBefore - 4_000, "and left Stripe clearing once");
    // The daily reconcile seeing the same payout changes nothing.
    stripe.payouts = [payout({ id: "po_csv_first", amount: 4_000, arrival: "2026-09-21" })];
    await withStripe(() => ingest.reconcileStripe({ days: 7 }));
    assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_csv_first"), 0);
    assert.equal(await held(CHEQUING, "USD"), chequingBefore + 4_000);
  });

  await check("the other order: a deposit categorised to Stripe clearing AFTER its payout was booked from Stripe is linked to that booking, never posted", async () => {
    await chargeInClearing("ch_usd_link", "2026-09-22", 2_500);
    await ingest.handleStripeEvent(event("payout.paid", payout({ id: "po_stripe_first", amount: 2_500, arrival: "2026-09-23" })));
    const p = await row("po_stripe_first");
    assert.equal(p?.booking, "booked");
    assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_stripe_first"), 1);
    const chequingBefore = await held(CHEQUING, "USD");
    const imported = await importCsv(`2026-09-24,STRIPE TRANSFER PO2,25.00`);
    assert.equal(imported.posted, 1);
    const bankLine = await line("STRIPE TRANSFER PO2");
    assert.equal(bankLine.status, "posted");
    assert.equal(bankLine.entry_id, p?.entry_id, "linked to the payout's entry");
    assert.equal(await entries("bank_txn", String(bankLine.id)), 0, "the line has no entry of its own");
    assert.equal(await held(CHEQUING, "USD"), chequingBefore, "nothing new reached chequing");
    // Categorising it again by hand is a no-op; a second deposit of the same amount is its own money.
    await txns.categorizeTransaction(cc, String(bankLine.id), String(bankLine.category_id));
    assert.equal(await held(CHEQUING, "USD"), chequingBefore);
  });

  await check("a payout booked from Stripe BETWEEN a categorisation's check and its write: the line's posting is refused, and the line is linked", async () => {
    await chargeInClearing("ch_usd_race_cat", "2026-09-24", 1_500);
    const chequingBefore = await held(CHEQUING, "USD");
    const { raced } = await withRace(
      (b) => b.includes("txn.categorized") && b.includes("STRIPE TRANSFER PO3"),
      async () => {
        const out = await ingest.handleStripeEvent(event("payout.paid", payout({ id: "po_race_cat", amount: 1_500, arrival: "2026-09-25" })));
        assert.equal(out.detail, "payout po_race_cat booked");
      },
      () => importCsv(`2026-09-25,STRIPE TRANSFER PO3,15.00`),
    );
    assert.ok(raced, "the payout was booked between the check and the write");
    const bankLine = await line("STRIPE TRANSFER PO3");
    const p = await row("po_race_cat");
    assert.equal(bankLine.entry_id, p?.entry_id, "linked to the payout booked meanwhile");
    assert.equal(await entries("bank_txn", String(bankLine.id)), 0, "its own entry was refused by the gate");
    assert.equal(await held(CHEQUING, "USD"), chequingBefore + 1_500, "the US$15 is in chequing once");
    await booksBalance();
  });

  await check("a bank line booked BETWEEN the payout's check and its write: the payout's posting is refused by its gate, and the line adopted (by its Wise tag, or by its shape)", async () => {
    for (const [id, description, day] of [
      ["po_race_tag", "Stripe payout po_race_tag — Received money from OASIS AI", "2026-09-26"],
      ["po_race_shape", "STRIPE TRANSFER PO5", "2026-09-27"],
    ] as const) {
      await chargeInClearing(`ch_${id}`, day, 1_200);
      const chequingBefore = await held(CHEQUING, "USD");
      let lineEntry = "";
      const { raced } = await withRace(
        (b) => b.includes("UPDATE fin_stripe_payouts SET booking = 'booked'") && b.includes(`"${id}"`),
        async () => {
          const posting = await buildPosting({
            entityId: B,
            entryDate: day,
            memo: description,
            source: "bank_txn",
            sourceRef: `txn_${id}`,
            createdBy: "test",
            lines: [
              { accountId: CHEQUING, currency: "USD", debitCents: 1_200 },
              { accountId: CLEARING, currency: "USD", creditCents: 1_200 },
            ],
          });
          lineEntry = posting.entryId;
          await writeBatch([
            ...posting.statements,
            {
              sql: `INSERT INTO fin_bank_transactions (id, entity_id, account_id, posted_date, description, amount_cents, currency, status, entry_id, dedupe_hash, source, created_by)
                    VALUES (?, ?, ?, ?, ?, 1200, 'USD', 'posted', ?, ?, 'import', 'test')`,
              args: [`txn_${id}`, B, CHEQUING, day, description, posting.entryId, `h_${id}`],
            },
          ]);
        },
        () => ingest.handleStripeEvent(event("payout.paid", payout({ id, amount: 1_200, arrival: day }))),
      );
      assert.ok(raced, `${id}: the bank line landed between the check and the write`);
      const p = await row(id);
      assert.equal(p?.booking, "booked", id);
      assert.equal(p?.entry_id, lineEntry, `${id}: the bank line's entry, adopted after the gate refused`);
      assert.equal(await entries(payouts.PAYOUT_SOURCE, id), 0, `${id}: never posted a second time`);
      assert.equal(await held(CHEQUING, "USD"), chequingBefore + 1_200, `${id}: US$12 in chequing once`);
    }
    await booksBalance();
  });

  await check("a reversal with the payout's shape (money Stripe pulled back, then undone) lands no money and is never adopted as the payout", async () => {
    const { buildReversal } = await import("../lib/founders-finances/ledger-io");
    const pulled = await buildPosting({
      entityId: B,
      entryDate: "2026-09-28",
      memo: "Stripe pulled money back",
      source: "bank_txn",
      sourceRef: "txn_pull_back",
      createdBy: "test",
      lines: [
        { accountId: CLEARING, currency: "USD", debitCents: 700 },
        { accountId: CHEQUING, currency: "USD", creditCents: 700 },
      ],
    });
    await writeBatch(pulled.statements);
    // Its reversal debits chequing and credits Stripe clearing: a payout's shape.
    const rev = await buildReversal({ entityId: B, entryId: pulled.entryId, date: "2026-09-28", memo: "Excluded", createdBy: "test" });
    await writeBatch(rev.statements);
    await chargeInClearing("ch_usd_after_reversal", "2026-09-28", 700);
    await ingest.handleStripeEvent(event("payout.paid", payout({ id: "po_not_the_reversal", amount: 700, arrival: "2026-09-28" })));
    const p = await row("po_not_the_reversal");
    assert.equal(p?.booking, "booked");
    assert.notEqual(p?.entry_id, rev.entryId, "not the reversal");
    assert.equal(await entries(payouts.PAYOUT_SOURCE, "po_not_the_reversal"), 1, "booked on its own");
    await booksBalance();
  });

  await check("a manual entry of a payout already booked from Stripe (a deposit into Stripe clearing, same amount and days) is refused, never posted", async () => {
    const { categoryId } = await import("../lib/founders-finances/chart");
    const chequingBefore = await held(CHEQUING, "USD");
    await assert.rejects(
      txns.createManualTransaction(cc, B, { date: "2026-09-29", description: "Stripe payout", amount: "7.00", currency: "USD", account_id: CHEQUING, category_id: categoryId(B, SYS.stripeClearing) }),
      /Stripe payout po_not_the_reversal \(7\.00 USD, arrived 2026-09-28\) is already booked from Stripe; recording it here too would count it twice/,
    );
    assert.equal(await held(CHEQUING, "USD"), chequingBefore);
    // Money into Stripe clearing that is no booked payout (another amount) is recorded as usual.
    await txns.createManualTransaction(cc, B, { date: "2026-09-29", description: "Stripe payout, older", amount: "8.00", currency: "USD", account_id: CHEQUING, category_id: categoryId(B, SYS.stripeClearing) });
    assert.equal(await held(CHEQUING, "USD"), chequingBefore + 800);
  });

  // ── what converts, and as of when ─────────────────────────────────────────
  await check("Stripe clearing is read as of the arrival day: a charge booked after a payout never funds it", async () => {
    await chargeInClearing("ch_cad_late", "2026-09-25", 5_000, "CAD");
    assert.equal(await held(CLEARING, "CAD"), 5_000, "CAD clearing holds the late charge (the paid-out one left whole)");
    const early = payout({ id: "po_cad_early", amount: 5_000, arrival: "2026-09-12", currency: "cad" });
    await ingest.handleStripeEvent(event("payout.paid", early));
    const p = await row("po_cad_early");
    assert.equal(p?.booking, "held");
    assert.match(String(p?.reason), /took 50\.00 CAD from the Stripe balance, but Stripe clearing holds 0\.00 CAD on the books on 2026-09-12/);
    await ingest.handleStripeEvent(event("payout.paid", payout({ id: "po_cad_late", amount: 5_000, arrival: "2026-09-26", currency: "cad" })));
    assert.equal((await row("po_cad_late"))?.booking, "booked", "the payout after it is paid from it");
    assert.equal(await held(CLEARING, "CAD"), 0);
  });

  await check("what a payout pays out is read from Stripe and matched to the books; anything the books do not hold, or a list that does not add up, holds it", async () => {
    await withStripe(async () => {
      const ask = (id: string, settled: number) => payoutsIo.payoutContents({ payoutId: id, settlementCents: settled, settlementCurrency: "USD", feeCents: 0 });
      stripe.contents.po_c_ok = [bt("txn_ch_payout_1", "charge", "ch_payout_1", 7226, 442), bt("txn_bill", "stripe_fee", "", -100), bt("txn_po_c_ok", "payout", "po_c_ok", -6684)];
      assert.deepEqual(await ask("po_c_ok", 6684), { ok: true, settledCents: 7226, cadBookedCents: 10_000, stripeFeeCents: 100 });
      stripe.contents.po_c_by_charge = [{ ...bt("txn_unrecorded_id", "charge", "ch_payout_1", 7226, 442) }];
      assert.deepEqual(await ask("po_c_by_charge", 6784), { ok: true, settledCents: 7226, cadBookedCents: 10_000, stripeFeeCents: 0 }, "matched by the charge id when the balance transaction id is not recorded");
      stripe.contents.po_c_missing = [bt("txn_x", "charge", "ch_not_in_books", 5000, 100)];
      assert.deepEqual(await ask("po_c_missing", 4900), { ok: false, reason: "the Stripe charge ch_not_in_books that payout po_c_missing pays out is not booked yet" });
      stripe.contents.po_c_dispute = [bt("txn_ch_payout_1", "charge", "ch_payout_1", 7226, 442), bt("txn_dp", "adjustment", "du_1", -1000)];
      assert.match(String(((await ask("po_c_dispute", 5784)) as { reason?: string }).reason), /also pays out a Stripe adjustment \(txn_dp, -10\.00 USD\) that the books do not record/);
      stripe.contents.po_c_short = [bt("txn_ch_payout_1", "charge", "ch_payout_1", 7226, 442)];
      assert.match(String(((await ask("po_c_short", 9999)) as { reason?: string }).reason), /comes to 67\.84 USD, not the 99\.99 USD it took/);
    });
    // Without a key the question is never guessed at.
    assert.match(String(((await payoutsIo.payoutContents({ payoutId: "po_c_ok", settlementCents: 6684, settlementCurrency: "USD", feeCents: 0 })) as { reason?: string }).reason), /Stripe is not connected/);
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
