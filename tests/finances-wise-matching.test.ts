/**
 * tests/finances-wise-matching.test.ts — the Wise bank feed can be switched on
 * without counting money twice (review defects A–F, 2026-09-24).
 *
 * The fixture mirrors the LIVE business book on 2026-09-24: 13 Stripe charges
 * and 2 refunds in CAD Stripe clearing, the 6 recurring expenses recorded on
 * 2026-09-01 from Business chequing (rent CA$2,750, Turso US$27.99, Google
 * Workspace US$30, Cloudflare US$5, Zernio US$45, AI subscriptions US$420),
 * one CA$100/mo Stripe subscription, Stripe payouts arriving in Wise as
 * "OASIS AI" (USD and CAD), an invoice deposit already recorded by "Check for
 * Wise payments", and a CAD->USD Wise conversion. Dates are the live ones when
 * run on 2026-09-24 and shift with the clock otherwise (Wise statements only
 * reach back 460 days).
 *
 *   A  a debit that IS an expense already on the books is linked, not posted
 *   B  a deposit already recorded against an invoice is held back from rules
 *   C  the opening balance counts fed lines not yet categorised
 *   D  exactly one opening balance per currency; re-posting replaces it
 *   E  conversions go through 1060 with the fee and FX difference
 *   F  a USD payout of CAD-settled charges leaves CAD Stripe clearing
 * Each phase asserts no double count and that per-currency chequing equals
 * Wise's running balance.
 *
 * Real local libSQL + the real modules; the network is a fixture router.
 * Run: node --conditions=react-server --import tsx tests/finances-wise-matching.test.ts
 */
process.env.FINANCE_WISE_FEED_WRITES = "on";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "finances-wise-matching-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
for (const k of ["STRIPE_SECRET_KEY", "FOUNDERS_TENANT_IDS", "WISE_API_TOKEN", "WISE_PROFILE_ID", "INVOICE_FROM_EMAIL", "INVOICE_FROM_APP_PASSWORD", "OASIS_MAIL_FROM", "OASIS_MAIL_APP_PASSWORD"]) {
  delete process.env[k];
}
process.env.WISE_API_TOKEN = "wise-test-token";
process.env.WISE_PROFILE_ID = "82000001";
process.env.STRIPE_SECRET_KEY = "rk_test_wise_matching";

type Json = Record<string, unknown>;
const fixtures: { statements: Record<string, Json>; payouts: Json[] } = { statements: {}, payouts: [] };
const calls: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  const url = new URL(String(input));
  calls.push(`${url.host}${url.pathname}`);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.host === "api.transferwise.com") {
    if (url.pathname === "/v2/profiles") return json([{ id: 82000001, type: "BUSINESS", businessName: "OASISAI" }]);
    if (url.pathname === "/v4/profiles/82000001/balances") {
      return json([
        { id: 11, currency: "CAD", amount: { value: 0, currency: "CAD" } },
        { id: 12, currency: "USD", amount: { value: 0, currency: "USD" } },
      ]);
    }
    const m = /^\/v1\/profiles\/\d+\/balance-statements\/(\d+)\/statement\.json$/.exec(url.pathname);
    if (m) return json(fixtures.statements[m[1] === "11" ? "CAD" : "USD"]);
    return json({ error: "not_found" }, 404);
  }
  if (url.host === "api.stripe.com") {
    if (url.pathname === "/v1/account") return json({ id: "acct_test_oasis", settings: { dashboard: { display_name: "OASIS AI" } } });
    if (url.pathname === "/v1/payouts") return json({ object: "list", data: fixtures.payouts, has_more: false });
  }
  throw new Error(`network disabled in test: ${url.host}${url.pathname}`);
}) as typeof fetch;

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 24).join("\n        ")}`);
  }
}

const cc = { kind: "founder" as const, ownerKey: "cc" as const, email: "conaugh@oasisai.work", userId: "u-cc" };

type Tx = { dir: "CREDIT" | "DEBIT"; kind: string; at: string; value: number; cur: "CAD" | "USD"; ref: string; running: number; fee?: number; sender?: string; payref?: string; desc?: string; merchant?: string };
const tx = (t: Tx) => ({
  type: t.dir,
  date: t.at,
  amount: { value: t.value, currency: t.cur, zero: false },
  totalFees: { value: t.fee ?? 0, currency: t.cur, zero: !t.fee },
  details: {
    type: t.kind,
    description: t.desc ?? "",
    ...(t.sender ? { senderName: t.sender } : {}),
    ...(t.payref !== undefined ? { paymentReference: t.payref } : {}),
    ...(t.merchant ? { merchant: { name: t.merchant, city: "Montreal" } } : {}),
  },
  exchangeDetails: null,
  runningBalance: { value: t.running, currency: t.cur, zero: false },
  referenceNumber: t.ref,
  attachment: null,
});
const statementOf = (cur: "CAD" | "USD", txns: Tx[], start: number) => ({
  accountHolder: { type: "BUSINESS", businessName: "OASISAI" },
  bankDetails: [],
  transactions: [...txns].sort((a, b) => b.at.localeCompare(a.at)).map(tx),
  startOfStatementBalance: { value: start, currency: cur, zero: start === 0 },
  endOfStatementBalance: { value: txns.length ? [...txns].sort((a, b) => a.at.localeCompare(b.at))[txns.length - 1].running : start, currency: cur },
});

async function main() {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(readFileSync(join(root, "database/turso/180_founders_finances.turso.sql"), "utf8"));
  await raw.executeMultiple(readFileSync(join(root, "database/turso/184_finance_wise_payments.turso.sql"), "utf8"));

  const { addDays, torontoToday, usdToCadCents, parseRateMicro } = await import("../lib/founders-finances/fx");
  // Live dates when run on 2026-09-24; shifted with the clock otherwise.
  const SHIFT = Math.round((Date.parse(`${torontoToday()}T00:00:00Z`) - Date.parse("2026-09-24T00:00:00Z")) / 86_400_000);
  const d = (iso: string) => addDays(iso, SHIFT);
  const at = (iso: string, hhmm = "15:00") => `${d(iso)}T${hhmm}:00.000Z`;
  for (let day = d("2026-08-01"); day <= d("2026-10-01"); day = addDays(day, 1)) {
    await raw.execute({ sql: `INSERT INTO fin_fx_rates (pair, rate_date, rate) VALUES ('USDCAD', ?, ?)`, args: [day, day <= d("2026-09-05") ? "1.3600" : "1.3700"] });
  }
  const r137 = parseRateMicro("1.3700");

  const feed = await import("../lib/founders-finances/wise-feed");
  const { ensureFinanceSeed } = await import("../lib/founders-finances/seed-io");
  const { accountId, categoryId, SYS, BUSINESS_ENTITY_ID: B } = await import("../lib/founders-finances/chart");
  const { postJournalEntry } = await import("../lib/founders-finances/ledger-io");
  const bills = await import("../lib/founders-finances/bills-io");
  const txns = await import("../lib/founders-finances/transactions-io");
  const invoices = await import("../lib/founders-finances/invoices-io");
  const store = await import("../lib/founders-finances/invoice-store");
  const reconcile = await import("../lib/founders-finances/wise-reconcile");
  const feedIo = await import("../lib/founders-finances/wise-feed-io");
  const reportsIo = await import("../lib/founders-finances/reports-io");

  const count = async (sql: string, args: Array<string | number> = []) => Number((await raw.execute({ sql, args })).rows[0][0]);
  const chequing = accountId(B, SYS.chequing);
  const acct = (code: string) => accountId(B, code);
  const native = (account: string, cur: string, onOrBefore = "9999-12-31") =>
    count(
      `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) FROM fin_journal_lines l JOIN fin_journal_entries e ON e.id = l.entry_id
        WHERE l.account_id = ? AND l.currency = ? AND e.entry_date <= ?`,
      [account, cur, onOrBefore],
    );
  const cadEq = (account: string) => count(`SELECT COALESCE(SUM(cad_debit_cents - cad_credit_cents), 0) FROM fin_journal_lines WHERE account_id = ?`, [account]);
  const pending = (cur: string) => count(`SELECT COALESCE(SUM(amount_cents), 0) FROM fin_bank_transactions WHERE fitid LIKE 'WISE-%' AND currency = ? AND status = 'unreviewed'`, [cur]);
  const line = async (fitid: string) => (await raw.execute({ sql: `SELECT * FROM fin_bank_transactions WHERE fitid = ?`, args: [fitid] })).rows[0];
  const entryLines = async (entryId: string) =>
    (await raw.execute({ sql: `SELECT account_id, currency, debit_cents, credit_cents, cad_debit_cents, cad_credit_cents FROM fin_journal_lines WHERE entry_id = ? ORDER BY line_no`, args: [entryId] })).rows.map(
      (l) => [String(l.account_id).split(":").pop(), l.currency, Number(l.debit_cents), Number(l.credit_cents), Number(l.cad_debit_cents), Number(l.cad_credit_cents)],
    );
  const entries = () => count(`SELECT COUNT(*) FROM fin_journal_entries`);
  const audits = () => count(`SELECT COUNT(*) FROM fin_audit_log`);
  const activeOpenings = (cur: string) =>
    count(
      `SELECT COUNT(*) FROM fin_journal_entries e WHERE e.source = 'opening_balance' AND e.status = 'posted'
         AND EXISTS (SELECT 1 FROM fin_journal_lines l WHERE l.entry_id = e.id AND l.account_id = ? AND l.currency = ?)`,
      [chequing, cur],
    );

  // ── pure: the matcher's rules ─────────────────────────────────────────
  const row = (fitid: string, date: string, cents: number, cur = "USD", kind = "CARD", ref = fitid): import("../lib/founders-finances/wise-feed").WiseFeedRow => ({
    fitid,
    postedDate: date,
    occurredAt: `${date}T15:00:00.000Z`,
    amountCents: cents,
    feeCents: 0,
    currency: cur,
    kind,
    ref,
    name: "",
    memo: "",
  });
  const bill = (id: string, date: string, cents: number, cur = "USD") => ({ id, entryId: `je-${id}`, label: id, currency: cur, totalCents: cents, paidOn: date, categoryId: null });

  await check("matcher: the closest date wins, a bill is used once, a tie is left for a founder", async () => {
    const m = feed.matchDebitsToBills([row("L1", "2026-09-02", -3000), row("L2", "2026-09-05", -3000)], [bill("google", "2026-09-01", 3000)]);
    assert.deepEqual([...m.linked].map(([k, v]) => [k, v.id]), [["L1", "google"]]);
    assert.equal(m.ambiguous.size, 0, "the farther debit has no bill left: it is simply new money");
    const tie = feed.matchDebitsToBills([row("F1", "2026-09-04", -1500), row("F2", "2026-09-06", -1500)], [bill("figma", "2026-09-05", 1500)]);
    assert.equal(tie.linked.size, 0);
    assert.deepEqual([...tie.ambiguous.keys()].sort(), ["F1", "F2"]);
    const two = feed.matchDebitsToBills([row("X", "2026-09-01", -500)], [bill("a", "2026-09-01", 500), bill("b", "2026-09-01", 500)]);
    assert.equal(two.linked.size, 0, "two identical expenses on the day: never guessed");
    assert.equal(feed.matchDebitsToBills([row("Y", "2026-09-01", -500, "CAD")], [bill("usd", "2026-09-01", 500)]).linked.size, 0, "currency must match");
    assert.equal(feed.matchDebitsToBills([row("Z", "2026-09-09", -500)], [bill("far", "2026-09-01", 500)]).linked.size, 0, "8 days is outside the window");
  });

  await check("payout parsing: Stripe's settlement comes from the balance transaction; without it nothing is guessed", async () => {
    const p = feed.stripePayoutFromApi({ id: "po_1", status: "paid", amount: 6784, currency: "usd", arrival_date: 1_757_808_000, balance_transaction: { amount: -9300, currency: "cad", fee: 0 } })!;
    assert.deepEqual([p.settlementCents, p.settlementCurrency, p.currency], [9300, "CAD", "USD"]);
    const bare = feed.stripePayoutFromApi({ id: "po_2", status: "paid", amount: 6784, currency: "usd", arrival_date: 1_757_808_000, balance_transaction: "txn_123" })!;
    const r = feed.stripePayoutLines(row("P", "2026-09-14", 6784, "USD", "DEPOSIT"), bare, { chequing: "c", stripeClearing: "s", fxClearing: "x", fxGainLoss: "g", stripeFees: "f", bankFees: "b" }, (c) => c);
    assert.equal(r.ok, false, "settlement unknown: recognised, not booked");
    assert.equal(feed.stripePayoutFromApi({ id: "po_3", status: "failed", amount: 1, currency: "usd", arrival_date: 1 }), null);
    const a = { chequing: "1000", stripeClearing: "1050", fxClearing: "1060", fxGainLoss: "6000", stripeFees: "5000", bankFees: "5010" };
    const net = (lines: Array<{ accountId: string; currency: string; debitCents?: number; creditCents?: number }>) =>
      lines.map((l) => [l.accountId, l.currency, (l.debitCents || 0) - (l.creditCents || 0)]);
    // Stripe pulls money back (a negative payout, a DIRECT_DEBIT on Wise): the mirror image, still no revenue.
    const back = feed.stripePayoutFromApi({ id: "po_neg", status: "paid", amount: -6784, currency: "usd", arrival_date: 1_757_808_000, balance_transaction: { amount: 9300, currency: "cad", fee: 0 } })!;
    const rb = feed.stripePayoutLines(row("N", "2026-09-14", -6784, "USD", "DIRECT_DEBIT"), back, a, (c, cur) => (cur === "CAD" ? c : usdToCadCents(c, r137)));
    assert.ok(rb.ok);
    if (rb.ok) assert.deepEqual(net(rb.lines), [["1000", "USD", -6784], ["1060", "USD", 6784], ["1060", "CAD", -9294], ["1050", "CAD", 9300], ["6000", "CAD", -6]]);
    // An instant payout's fee comes out of Stripe clearing too, as a Stripe fee.
    const fast = feed.stripePayoutFromApi({ id: "po_fee", status: "paid", amount: 10000, currency: "cad", arrival_date: 1_757_808_000, balance_transaction: { amount: -10000, currency: "cad", fee: 150 } })!;
    const rf = feed.stripePayoutLines(row("I", "2026-09-14", 10000, "CAD", "DEPOSIT"), fast, a, (c) => c);
    assert.ok(rf.ok);
    if (rf.ok) assert.deepEqual(net(rf.lines), [["1000", "CAD", 10000], ["1050", "CAD", -10150], ["5000", "CAD", 150]]);
  });

  await check("parts: 2 to 4 debits adding up EXACTLY to one expense are held; one debit, a cent off, 5 parts or another currency are not", async () => {
    const lump = bill("ai", "2026-09-01", 42000);
    const m = feed.debitsAddingUpToBills([row("A1", "2026-09-01", -20000), row("A2", "2026-09-02", -20000), row("A3", "2026-09-03", -2000), row("X", "2026-09-02", -999)], [lump]);
    assert.deepEqual([...m.keys()].sort(), ["A1", "A2", "A3"]);
    assert.equal(feed.debitsAddingUpToBills([row("B1", "2026-09-01", -20000), row("B2", "2026-09-01", -21999)], [lump]).size, 0, "a cent off");
    assert.equal(feed.debitsAddingUpToBills([row("C1", "2026-09-01", -42000)], [lump]).size, 0, "one equal debit is the one-to-one matcher's");
    assert.equal(feed.debitsAddingUpToBills([1, 2, 3, 4, 5].map((i) => row(`F${i}`, "2026-09-01", -8400)), [lump]).size, 0, "5 parts: not guessed");
    assert.equal(feed.debitsAddingUpToBills([row("D1", "2026-09-01", -20000, "CAD"), row("D2", "2026-09-01", -22000, "CAD")], [lump]).size, 0, "currency");
    const plan = feed.planFeed({ rows: [row("P1", "2026-09-01", -20000), row("P2", "2026-09-02", -22000)], payouts: new Map(), recordedDepositRefs: new Set(), lines: new Map(), openings: new Map(), bills: [lump] });
    assert.deepEqual([...plan.values()].map((r) => r.kind), ["bill_parts", "bill_parts"]);
  });

  await check("payout: not booked when Stripe clearing does not hold it in the settlement currency (the live Stripe balance is USD, the live charges CAD)", async () => {
    const a = { chequing: "1000", stripeClearing: "1050", fxClearing: "1060", fxGainLoss: "6000", stripeFees: "5000", bankFees: "5010" };
    const live = feed.stripePayoutFromApi({ id: "po_live", status: "paid", amount: 7200, currency: "usd", arrival_date: 1_757_808_000, balance_transaction: { amount: -7200, currency: "usd", fee: 0 } })!;
    const deposit = row("L", "2026-09-19", 7200, "USD", "DEPOSIT");
    const held = feed.stripePayoutLines(deposit, live, a, (c) => c, 0);
    assert.equal(held.ok, false);
    if (!held.ok) assert.match(held.reason, /Stripe clearing holds 0\.00 USD/);
    assert.equal(feed.stripePayoutLines(deposit, live, a, (c) => c, 7200).ok, true, "covered: booked");
    const back = feed.stripePayoutFromApi({ id: "po_back", status: "paid", amount: -7200, currency: "usd", arrival_date: 1_757_808_000, balance_transaction: { amount: 7200, currency: "usd", fee: 0 } })!;
    assert.equal(feed.stripePayoutBlocker(row("N", "2026-09-19", -7200, "USD", "DIRECT_DEBIT"), back, 0), null, "money Stripe pulls back refills clearing: never blocked");
  });

  await check("a conversion leg with no partner in CAD/USD is held, never half-booked", async () => {
    const plan = feed.planFeed({
      rows: [row("WISE-USD-DEBIT-BALANCE-9", "2026-09-12", -1000, "USD", "CONVERSION", "BALANCE-9")],
      payouts: new Map(),
      recordedDepositRefs: new Set(),
      lines: new Map(),
      openings: new Map(),
      bills: [],
    });
    assert.equal(plan.get("WISE-USD-DEBIT-BALANCE-9")?.kind, "conversion_unpaired");
  });

  // ── the live book ─────────────────────────────────────────────────────
  await ensureFinanceSeed();
  await raw.execute({ sql: `UPDATE fin_settings SET stripe_account_id = 'acct_test_oasis' WHERE entity_id = ?`, args: [B] });
  // 13 Stripe charges (CA$2,050) and 2 refunds (CA$300), all CAD, all in Stripe clearing — as live.
  const charges: Array<[string, number]> = [
    ["2026-01-20", 60000], ["2026-02-20", 15000], ["2026-03-05", 10000], ["2026-03-20", 15000], ["2026-04-05", 10000], ["2026-04-20", 15000], ["2026-05-05", 10000],
    ["2026-05-20", 15000], ["2026-06-05", 10000], ["2026-06-20", 15000], ["2026-07-05", 10000], ["2026-08-05", 10000], ["2026-09-05", 10000],
  ];
  for (const [i, [day, cents]] of charges.entries()) {
    await postJournalEntry({ entityId: B, entryDate: day, memo: "Stripe charge", source: "stripe_charge", sourceRef: `ch_${i}`, createdBy: "stripe", lines: [
      { accountId: acct(SYS.stripeClearing), currency: "CAD", debitCents: cents },
      { accountId: acct(SYS.serviceRevenue), currency: "CAD", creditCents: cents },
    ] });
  }
  for (const i of [1, 2]) {
    await postJournalEntry({ entityId: B, entryDate: "2026-06-24", memo: "Stripe refund", source: "stripe_refund", sourceRef: `re_${i}`, createdBy: "stripe", lines: [
      { accountId: acct(SYS.refunds), currency: "CAD", debitCents: 15000 },
      { accountId: acct(SYS.stripeClearing), currency: "CAD", creditCents: 15000 },
    ] });
  }
  await raw.execute({ sql: `INSERT INTO fin_subscriptions (id, entity_id, status, currency, monthly_cents) VALUES ('sub_live', ?, 'active', 'CAD', 10000)`, args: [B] });
  // The 6 recurring expenses, recorded from Bills on 2026-09-01, paid from Business chequing.
  const recurring: Array<[string, string, string, string]> = [
    ["Office rent", "2750.00", "CAD", "5650"],
    ["Turso (database)", "27.99", "USD", "5900"],
    ["Google Workspace", "30.00", "USD", "5100"],
    ["Cloudflare", "5.00", "USD", "5900"],
    ["Zernio (social scheduling)", "45.00", "USD", "5100"],
    ["AI subscriptions", "420.00", "USD", "5100"],
  ];
  const billIds: Record<string, string> = {};
  for (const [name, amount, currency, code] of recurring) {
    const item = await bills.createRecurring(cc, "oasis", { name, amount, currency, cadence: "monthly", next_run_on: d("2026-09-01"), category_id: categoryId(B, code), paid_from_account_id: chequing });
    billIds[name] = await bills.recordRecurringNow(cc, item);
  }
  // One more expense whose Wise charge cannot be told apart from another one (a tie).
  billIds.Figma = await bills.createBill(cc, "oasis", { kind: "expense", vendor_name: "Figma", bill_date: d("2026-09-05"), currency: "USD", subtotal: "15.00", category_id: categoryId(B, "5100"), paid_from_account_id: chequing });
  // Rules a founder would plausibly have. Before the fix each of them booked money a second time.
  await txns.createRule(cc, "oasis", { pattern: "turso", category_id: categoryId(B, "5900"), direction: "out" });
  await txns.createRule(cc, "oasis", { pattern: "acme", category_id: categoryId(B, "4000"), direction: "in" });
  await txns.createRule(cc, "oasis", { pattern: "figma", category_id: categoryId(B, "5100"), direction: "out" });

  const invA = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Acme Corp", email: "ap@acme.test" }, issue_date: d("2026-09-05"), currency: "CAD", lines: [{ description: "Build", quantity: 1, unit_price: "1500.00" }] });
  const numA = (await invoices.finalizeInvoice(cc, invA)).number as string;

  // Wise, as the statements report it. CAD opened at 5,050.00 on the 25th; USD at 1,000.00.
  const cadTx: Tx[] = [
    { dir: "DEBIT", kind: "CARD", at: at("2026-08-28"), value: -50, cur: "CAD", ref: "CARD-C0", running: 5000, merchant: "Staples" },
    { dir: "DEBIT", kind: "TRANSFER", at: at("2026-09-01", "14:00"), value: -2750, cur: "CAD", ref: "TRANSFER-R1", running: 2250, desc: "Sent money to Landlord Property Mgmt" },
    { dir: "CREDIT", kind: "DEPOSIT", at: at("2026-09-10"), value: 1500, cur: "CAD", ref: "TRANSFER-A1", running: 3750, sender: "Acme Corp", payref: numA, desc: `Received money from Acme Corp with reference ${numA}` },
    { dir: "DEBIT", kind: "CONVERSION", at: at("2026-09-12"), value: -370, fee: 1.69, cur: "CAD", ref: "BALANCE-7001", running: 3380, desc: "Converted 370.00 CAD to 262.79 USD" },
    { dir: "CREDIT", kind: "DEPOSIT", at: at("2026-09-15"), value: 100, cur: "CAD", ref: "TRANSFER-P2", running: 3480, sender: "OASIS AI", payref: "5552098", desc: "Received money from OASIS AI with reference 5552098" },
    { dir: "DEBIT", kind: "CARD", at: at("2026-09-16"), value: -12.34, cur: "CAD", ref: "CARD-C1", running: 3467.66, merchant: "Cafe Olimpico" },
  ];
  const usdTx: Tx[] = [
    { dir: "DEBIT", kind: "CARD", at: at("2026-09-01", "16:00"), value: -27.99, cur: "USD", ref: "CARD-U1", running: 972.01, merchant: "Turso" },
    { dir: "DEBIT", kind: "CARD", at: at("2026-09-01", "17:00"), value: -5, cur: "USD", ref: "CARD-U2", running: 967.01, merchant: "Cloudflare" },
    { dir: "DEBIT", kind: "CARD", at: at("2026-09-01", "18:00"), value: -420, cur: "USD", ref: "CARD-U3", running: 547.01, merchant: "Anthropic" },
    { dir: "DEBIT", kind: "CARD", at: at("2026-09-02", "16:00"), value: -30, cur: "USD", ref: "CARD-U4", running: 517.01, merchant: "Google Workspace" },
    { dir: "DEBIT", kind: "CARD", at: at("2026-09-03", "16:00"), value: -45, cur: "USD", ref: "CARD-U5", running: 472.01, merchant: "Zernio" },
    { dir: "DEBIT", kind: "CARD", at: at("2026-09-04", "16:00"), value: -15, cur: "USD", ref: "CARD-U6", running: 457.01, merchant: "Figma" },
    { dir: "DEBIT", kind: "CARD", at: at("2026-09-06", "16:00"), value: -15, cur: "USD", ref: "CARD-U7", running: 442.01, merchant: "Figma" },
    { dir: "CREDIT", kind: "CONVERSION", at: at("2026-09-12"), value: 262.79, cur: "USD", ref: "BALANCE-7001", running: 704.8, desc: "Converted 370.00 CAD to 262.79 USD" },
    { dir: "CREDIT", kind: "DEPOSIT", at: at("2026-09-14"), value: 67.84, cur: "USD", ref: "TRANSFER-P1", running: 772.64, sender: "OASIS AI", payref: "5552097", desc: "Received money from OASIS AI with reference 5552097" },
  ];
  const publish = () => {
    fixtures.statements.CAD = statementOf("CAD", cadTx, 5050);
    fixtures.statements.USD = statementOf("USD", usdTx, 1000);
  };
  publish();
  const arrival = (iso: string) => Math.floor(Date.parse(`${d(iso)}T00:00:00Z`) / 1000);
  fixtures.payouts = [
    // A USD payout of CAD-settled charges: CA$93.00 left the Stripe balance, US$67.84 arrived.
    { id: "po_usd", object: "payout", status: "paid", amount: 6784, currency: "usd", arrival_date: arrival("2026-09-14"), balance_transaction: { id: "txn_1", amount: -9300, currency: "cad", fee: 0, net: -9300 } },
    { id: "po_cad", object: "payout", status: "paid", amount: 10000, currency: "cad", arrival_date: arrival("2026-09-15"), balance_transaction: { id: "txn_2", amount: -10000, currency: "cad", fee: 0, net: -10000 } },
  ];

  // "Check for Wise payments" records the Acme deposit against its invoice BEFORE the feed ever runs.
  const pre = await reconcile.reconcileWise(cc, { days: 60, dryRun: false });
  assert.equal(pre.recorded, 1, "setup: the invoice deposit is recorded first");
  assert.equal((await store.loadInvoice(invA))!.status, "paid");

  // ── phase 1: the first sync ───────────────────────────────────────────
  const since = d("2026-09-01");
  const wiseMove = (cur: "CAD" | "USD") => {
    const list = (cur === "CAD" ? cadTx : usdTx).filter((t) => t.at.slice(0, 10) >= since).sort((a, b) => a.at.localeCompare(b.at));
    const startRunning = (cur === "CAD" ? cadTx : usdTx).filter((t) => t.at.slice(0, 10) < since).sort((a, b) => a.at.localeCompare(b.at)).pop()?.running ?? (cur === "CAD" ? 5050 : 1000);
    return Math.round((list[list.length - 1].running - startRunning) * 100);
  };
  const beforeEntries = await entries();
  const dry = await feedIo.syncWiseFeed(cc, { since }, { dryRun: true });
  await check("dry run: says what the sync will do, writes nothing", async () => {
    const usd = dry.currencies.find((c) => c.currency === "USD")!;
    const cad = dry.currencies.find((c) => c.currency === "CAD")!;
    assert.deepEqual([usd.matched_expenses, usd.needs_review, usd.stripe_payouts, usd.conversions], [5, 2, 1, 1]);
    assert.deepEqual([cad.matched_expenses, cad.invoice_payments, cad.stripe_payouts, cad.conversions], [1, 1, 1, 1]);
    assert.equal(await entries(), beforeEntries);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_bank_transactions`), 0);
  });

  const synced = await feedIo.syncWiseFeed(cc, { since }, { dryRun: false });
  const usdRes = synced.currencies.find((c) => c.currency === "USD")!;
  const cadRes = synced.currencies.find((c) => c.currency === "CAD")!;

  await check("A: the Wise debits for the 6 recurring expenses are LINKED to them — no second expense, chequing moved once", async () => {
    assert.equal(usdRes.matched_expenses, 5);
    assert.equal(cadRes.matched_expenses, 1);
    const linked: Array<[string, string]> = [
      ["WISE-CAD-DEBIT-TRANSFER-R1", "Office rent"],
      ["WISE-USD-DEBIT-CARD-U1", "Turso (database)"],
      ["WISE-USD-DEBIT-CARD-U2", "Cloudflare"],
      ["WISE-USD-DEBIT-CARD-U3", "AI subscriptions"],
      ["WISE-USD-DEBIT-CARD-U4", "Google Workspace"],
      ["WISE-USD-DEBIT-CARD-U5", "Zernio (social scheduling)"],
    ];
    for (const [fitid, name] of linked) {
      const l = await line(fitid);
      const b = (await raw.execute({ sql: `SELECT entry_id FROM fin_bills WHERE id = ?`, args: [billIds[name]] })).rows[0];
      assert.equal(l.status, "posted", fitid);
      assert.equal(l.entry_id, b.entry_id, `${fitid} points at the ${name} expense's own entry`);
      assert.equal(l.rule_id, null, `${fitid}: no rule touched it (the "turso" rule would have)`);
      assert.match(String(l.memo), /already on the books/);
    }
    assert.equal(await count(`SELECT COUNT(*) FROM fin_bank_transactions WHERE entry_id IN (SELECT entry_id FROM fin_bills)`), 6, "each bill matched once");
    assert.equal(
      await count(`SELECT COUNT(*) FROM fin_journal_lines l JOIN fin_journal_entries e ON e.id = l.entry_id WHERE e.source = 'bank_txn' AND l.account_id IN (?, ?, ?)`, [acct("5100"), acct("5900"), acct("5650")]),
      0,
      "no bank line posted an expense of its own",
    );
    assert.equal(await native(acct("5900"), "USD"), 2799 + 500, "hosting: Turso + Cloudflare, once");
    assert.equal(await native(acct("5650"), "CAD"), 275000, "rent once");
  });

  await check("A: two identical charges for one expense are a tie — both left for a founder, named, and no rule posts them", async () => {
    for (const f of ["WISE-USD-DEBIT-CARD-U6", "WISE-USD-DEBIT-CARD-U7"]) {
      const l = await line(f);
      assert.equal(l.status, "unreviewed");
      assert.equal(l.entry_id, null);
      assert.equal(l.rule_id, null, "the 'figma' rule did not post it");
      assert.match(String(l.memo), /could be expense "Figma"/);
    }
    assert.equal(usdRes.needs_review, 2);
  });

  await check("held lines stay held AFTER the import too: 'Apply rules to unreviewed transactions' never books the Figma tie", async () => {
    const [cheq, design] = [await native(chequing, "USD"), await native(acct("5100"), "USD")];
    await txns.applyRulesToUnreviewed(cc, "oasis");
    for (const f of ["WISE-USD-DEBIT-CARD-U6", "WISE-USD-DEBIT-CARD-U7"]) {
      const l = await line(f);
      assert.deepEqual([l.status, l.entry_id], ["unreviewed", null], `${f}: the 'figma' rule left it for a founder`);
    }
    assert.equal(await native(chequing, "USD"), cheq, "chequing USD did not move");
    assert.equal(await native(acct("5100"), "USD"), design, "Figma is on the books once (the expense), not three times");
  });

  await check("B: the invoice deposit already recorded is set aside BEFORE the matching 'acme' rule could post it — revenue once", async () => {
    const l = await line("WISE-CAD-CREDIT-TRANSFER-A1");
    assert.equal(l.status, "excluded");
    assert.equal(l.entry_id, null);
    assert.equal(l.rule_id, null);
    assert.equal(cadRes.invoice_payments, 1);
    assert.equal(await native(acct(SYS.serviceRevenue), "CAD"), -(205000 + 150000), "13 charges + the invoice, not + the deposit again");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'wise_payment' AND source_ref = 'TRANSFER-A1'`), 1);
  });

  await check("B: a founder cannot categorise the set-aside deposit either — it is already an invoice payment", async () => {
    const l = await line("WISE-CAD-CREDIT-TRANSFER-A1");
    await assert.rejects(txns.categorizeTransaction(cc, String(l.id), categoryId(B, "4000")), /already recorded as an invoice payment/);
    assert.equal((await line("WISE-CAD-CREDIT-TRANSFER-A1")).status, "excluded");
    assert.equal(await native(acct(SYS.serviceRevenue), "CAD"), -(205000 + 150000), "revenue once");
  });

  await check("E: the CAD->USD conversion goes through 1060: CAD out, USD in, Wise's fee to Bank fees, the rest to FX", async () => {
    const cadLeg = await line("WISE-CAD-DEBIT-BALANCE-7001");
    const usdLeg = await line("WISE-USD-CREDIT-BALANCE-7001");
    assert.equal(cadLeg.status, "posted");
    assert.equal(usdLeg.status, "posted");
    assert.equal(cadLeg.category_id, categoryId(B, SYS.fxClearing), "the category it has now");
    const usdCad = usdToCadCents(26279, r137);
    assert.deepEqual(await entryLines(String(cadLeg.entry_id)), [
      ["1060", "CAD", 37000, 0, 37000, 0],
      ["1000", "CAD", 0, 37000, 0, 37000],
    ]);
    assert.deepEqual(await entryLines(String(usdLeg.entry_id)), [
      ["1000", "USD", 26279, 0, usdCad, 0],
      ["1060", "USD", 0, 26279, 0, usdCad],
      ["1060", "CAD", 0, 37000 - usdCad, 0, 37000 - usdCad],
      ["5010", "CAD", 169, 0, 169, 0],
      ["6000", "CAD", 37000 - usdCad - 169, 0, 37000 - usdCad - 169, 0],
    ]);
    assert.equal(usdRes.conversions + cadRes.conversions, 2);
  });

  await check("F: the USD payout takes CA$93.00 out of CAD Stripe clearing, US$67.84 into chequing, FX for the gap; the CAD payout is a plain transfer; never revenue", async () => {
    const usdPayout = await line("WISE-USD-CREDIT-TRANSFER-P1");
    const cadPayout = await line("WISE-CAD-CREDIT-TRANSFER-P2");
    assert.equal(usdPayout.rule_id, null, "booked by the feed, not the seeded 'stripe' rule");
    const v = usdToCadCents(6784, r137);
    assert.deepEqual(await entryLines(String(usdPayout.entry_id)), [
      ["1000", "USD", 6784, 0, v, 0],
      ["1060", "USD", 0, 6784, 0, v],
      ["1060", "CAD", v, 0, v, 0],
      ["1050", "CAD", 0, 9300, 0, 9300],
      ["6000", "CAD", 9300 - v, 0, 9300 - v, 0],
    ]);
    assert.deepEqual(await entryLines(String(cadPayout.entry_id)), [
      ["1000", "CAD", 10000, 0, 10000, 0],
      ["1050", "CAD", 0, 10000, 0, 10000],
    ]);
    assert.equal(await native(acct(SYS.stripeClearing), "CAD"), 205000 - 30000 - 9300 - 10000, "Stripe clearing: charges - refunds - what each payout took");
    assert.equal(await native(acct(SYS.stripeClearing), "USD"), 0, "no USD ever lands in CAD Stripe clearing");
    assert.equal(await cadEq(acct(SYS.fxClearing)), 0, "1060 nets to zero in CAD");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_lines WHERE account_id IN (?, ?) AND entry_id IN (?, ?)`, [acct("4000"), acct("4010"), String(usdPayout.entry_id), String(cadPayout.entry_id)]), 0);
  });

  await check("after the sync, every Wise movement is on the books exactly once, per currency (the waiting lines included)", async () => {
    // While the Figma tie is open, no opening balance can be computed through it: either answer could be wrong.
    const blocked = await feedIo.postWiseOpeningBalance(cc, { date: d("2026-09-16") }, { dryRun: true });
    assert.match(String(blocked.blocked), /2 Wise line\(s\) on or before .* waiting for your decision/);
    await assert.rejects(feedIo.postWiseOpeningBalance(cc, { date: d("2026-09-16") }, { dryRun: false }), /waiting for your decision/);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'opening_balance'`), 0);
    // The Figma tie: one of the two charges IS the Figma expense, the other is new.
    await txns.excludeTransaction(cc, String((await line("WISE-USD-DEBIT-CARD-U7")).id));
    await txns.categorizeTransaction(cc, String((await line("WISE-USD-DEBIT-CARD-U6")).id), categoryId(B, "5100"));
    assert.equal((await native(chequing, "CAD")) + (await pending("CAD")), wiseMove("CAD"));
    assert.equal((await native(chequing, "USD")) + (await pending("USD")), wiseMove("USD"));
    assert.equal(await pending("USD"), 0);
    assert.equal(await pending("CAD"), -1234, "only the café is waiting");
  });

  // ── phase 2: opening balance counts what is still waiting (C) ─────────
  await check("C: the opening balance counts the line not yet categorised, so categorising it keeps chequing = Wise", async () => {
    const day = d("2026-09-16");
    const p = await feedIo.postWiseOpeningBalance(cc, { date: day }, { dryRun: true });
    const ledgerCad = await native(chequing, "CAD", day);
    await feedIo.postWiseOpeningBalance(cc, { date: day }, { dryRun: false });
    await txns.categorizeTransaction(cc, String((await line("WISE-CAD-DEBIT-CARD-C1")).id), categoryId(B, "5400"));
    assert.equal(await native(chequing, "CAD"), 346766, "chequing CAD = Wise CAD after categorising (not Wise - 12.34)");
    assert.equal(await native(chequing, "USD"), 77264, "chequing USD = Wise USD");
    const cad = p.lines.find((l) => l.currency === "CAD")!;
    const usd = p.lines.find((l) => l.currency === "USD")!;
    assert.equal(p.blocked, null);
    assert.deepEqual([cad.wise_cents, cad.pending_cents, cad.pending_lines], [346766, -1234, 1]);
    assert.equal(cad.books_cents, ledgerCad - 1234);
    assert.deepEqual([cad.difference_cents, usd.difference_cents], [500000, 100000], "exactly what Wise held before the feed began");
    const usdOb = (await raw.execute({ sql: `SELECT l.cad_debit_cents FROM fin_journal_lines l JOIN fin_journal_entries e ON e.id = l.entry_id WHERE e.source = 'opening_balance' AND l.account_id = ? AND l.currency = 'USD'`, args: [chequing] })).rows[0];
    assert.equal(Number(usdOb.cad_debit_cents), usdToCadCents(100000, r137), "a USD opening balance at the stored own-day rate");
  });

  await check("C: a linked debit dated after its expense counts on the bank's day (the Google and Zernio charges straddle 1 Sep)", async () => {
    const p = await feedIo.postWiseOpeningBalance(cc, { date: d("2026-09-01") }, { dryRun: true });
    const usd = p.lines.find((l) => l.currency === "USD")!;
    assert.equal(usd.wise_cents, 54701);
    assert.equal(usd.difference_cents, 100000, "Wise USD before any activity; counting the expenses' dates instead would say 1,075.00");
  });

  // ── phase 3: exactly one opening balance per currency (D) ─────────────
  await check("D: posting on another day REPLACES the opening balance (old one reversed, audit row), never adds a second", async () => {
    const day = d("2026-08-31");
    const p = await feedIo.postWiseOpeningBalance(cc, { date: day }, { dryRun: true });
    const old = (await raw.execute({ sql: `SELECT id FROM fin_journal_entries WHERE source = 'opening_balance' AND status = 'posted'`, args: [] })).rows.map((r) => String(r.id));
    const posted = await feedIo.postWiseOpeningBalance(cc, { date: day }, { dryRun: false });
    assert.equal(await activeOpenings("CAD"), 1, "exactly one CAD opening balance in force");
    assert.equal(await activeOpenings("USD"), 1);
    assert.equal(await native(chequing, "CAD"), 346766, "still Wise, not Wise + a second opening balance");
    assert.equal(await native(chequing, "USD"), 77264);
    assert.equal(await native(chequing, "CAD", day), 500000, "and now right on the 31st too");
    for (const id of old) assert.equal((await raw.execute({ sql: `SELECT status FROM fin_journal_entries WHERE id = ?`, args: [id] })).rows[0].status, "reversed");
    assert.equal(posted.lines.filter((l) => l.entry_id).length, 2);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_audit_log WHERE action = 'wise.opening_balance_replaced'`), 2);
    assert.deepEqual(
      p.lines.map((l) => [l.currency, l.action, l.existing?.date, l.difference_cents]),
      [["CAD", "replace", d("2026-09-16"), 500000], ["USD", "replace", d("2026-09-16"), 100000]],
      "the preview named the balance in force and said it would be replaced",
    );
    const [e, a] = [await entries(), await audits()];
    const again = await feedIo.postWiseOpeningBalance(cc, { date: day }, { dryRun: false });
    assert.deepEqual(again.lines.map((l) => l.action), ["keep", "keep"]);
    assert.deepEqual([await entries(), await audits()], [e, a], "posting the same balance again changes nothing");
  });

  // ── phase 4: idempotent ───────────────────────────────────────────────
  await check("a re-sync is a no-op: no lines, no entries, no audit rows, same balances", async () => {
    const [e, a, t] = [await entries(), await audits(), await count(`SELECT COUNT(*) FROM fin_bank_transactions`)];
    const r = await feedIo.syncWiseFeed(cc, { since }, { dryRun: false });
    assert.deepEqual(r.currencies.map((c) => [c.currency, c.inserted, c.posted]), [["CAD", 0, 0], ["USD", 0, 0]]);
    assert.deepEqual([await entries(), await audits(), await count(`SELECT COUNT(*) FROM fin_bank_transactions`)], [e, a, t]);
    assert.equal(await native(chequing, "CAD"), 346766);
  });

  // ── phase 5: late arrivals, and the reverse order of B ────────────────
  const invB = await invoices.createDraftInvoice(cc, "oasis", { contact_id: (await store.loadInvoice(invA))!.contact_id, issue_date: d("2026-09-17"), currency: "CAD", lines: [{ description: "Retainer", quantity: 1, unit_price: "800.00" }] });
  const numB = (await invoices.finalizeInvoice(cc, invB)).number as string;
  cadTx.push({ dir: "CREDIT", kind: "DEPOSIT", at: at("2026-09-18"), value: 800, cur: "CAD", ref: "TRANSFER-A2", running: 4267.66, sender: "Acme Corp", payref: numB, desc: `Received money from Acme Corp with reference ${numB}` });
  publish();

  await check("a line dated before the opening balance that arrives after it is held (the balance already contains it); re-posting then books it once", async () => {
    const late = await feedIo.syncWiseFeed(cc, { since: d("2026-08-25") }, { dryRun: false });
    const c0 = await line("WISE-CAD-DEBIT-CARD-C0");
    assert.equal(c0.status, "unreviewed");
    assert.equal(c0.entry_id, null);
    assert.match(String(c0.memo), /^Wise feed \(opening balance\): dated on or before the opening balance/);
    assert.equal(await native(chequing, "CAD", d("2026-08-31")), 500000, "not booked a second time on top of the balance");
    assert.ok(late.notes.some((n) => /The CAD opening balance for .* no longer makes Business chequing equal Wise: .* moved by -50\.00 CAD/.test(n)), late.notes.join(" | "));
    // Neither a rule applied later nor a founder may book it while the balance that contains it is in force.
    await txns.createRule(cc, "oasis", { pattern: "staples", category_id: categoryId(B, "5600"), direction: "out" });
    await txns.applyRulesToUnreviewed(cc, "oasis");
    assert.deepEqual([(await line("WISE-CAD-DEBIT-CARD-C0")).status, (await line("WISE-CAD-DEBIT-CARD-C0")).entry_id], ["unreviewed", null], "the 'staples' rule left it alone");
    await assert.rejects(txns.categorizeTransaction(cc, String(c0.id), categoryId(B, "5600")), /opening balance of .* already contains it/);
    assert.equal(await native(chequing, "CAD", d("2026-08-31")), 500000, "still counted once");
    const p = await feedIo.postWiseOpeningBalance(cc, { date: d("2026-08-31") }, { dryRun: true });
    const cad = p.lines.find((l) => l.currency === "CAD")!;
    assert.equal(p.blocked, null, "a line inside the balance counts as pending; it does not block");
    assert.deepEqual([cad.action, cad.pending_cents, cad.difference_cents], ["replace", -5000, 505000]);
    await feedIo.postWiseOpeningBalance(cc, { date: d("2026-08-31") }, { dryRun: false });
    const resynced = await feedIo.syncWiseFeed(cc, { since: d("2026-08-25") }, { dryRun: false });
    assert.ok(!resynced.notes.some((n) => /no longer makes/.test(n)), "re-posted: the balance matches the books again");
    assert.equal((await line("WISE-CAD-DEBIT-CARD-C0")).memo, "", "no longer held: the note is cleared");
    await txns.categorizeTransaction(cc, String(c0.id), categoryId(B, "5600"));
    assert.equal(await native(chequing, "CAD", d("2026-08-31")), 500000, "the 31st still equals Wise");
    assert.equal(await activeOpenings("CAD"), 1);
  });

  await check("B, reverse order: a deposit a rule already booked is refused by 'Check for Wise payments' instead of recorded again", async () => {
    const a2 = await line("WISE-CAD-CREDIT-TRANSFER-A2");
    assert.equal(a2.status, "posted", "not yet recorded when synced, so the 'acme' rule booked it");
    const r = await reconcile.reconcileWise(cc, { days: 60, dryRun: false });
    assert.equal(r.recorded, 0);
    assert.ok(r.errors.some((e) => e.invoice_number === numB && /already categorised/.test(e.message)));
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'wise_payment' AND source_ref = 'TRANSFER-A2'`), 0);
    assert.equal(await native(chequing, "CAD"), 426766, "chequing CAD = Wise CAD: the 800 is in once");
  });

  await check("a linked line is protected: re-categorising is refused, excluding only unlinks, the expense stays; a voided expense sends its line back for review", async () => {
    const turso = await line("WISE-USD-DEBIT-CARD-U1");
    await assert.rejects(txns.categorizeTransaction(cc, String(turso.id), categoryId(B, "5100")), /matched to/);
    const tursoEntry = String(turso.entry_id);
    await txns.excludeTransaction(cc, String(turso.id));
    assert.equal((await raw.execute({ sql: `SELECT status FROM fin_journal_entries WHERE id = ?`, args: [tursoEntry] })).rows[0].status, "posted", "the Turso expense is not reversed");
    assert.equal(await native(chequing, "USD"), 77264);
    // Cloudflare's expense is voided: its money leaves the books, so its bank line comes back to be booked.
    await bills.voidBill(cc, billIds.Cloudflare);
    await feedIo.syncWiseFeed(cc, { since }, { dryRun: false });
    const cf = await line("WISE-USD-DEBIT-CARD-U2");
    assert.deepEqual([cf.status, cf.entry_id], ["unreviewed", null]);
    assert.match(String(cf.memo), /voided/);
    assert.equal((await native(chequing, "USD")) + (await pending("USD")), 77264, "chequing + the waiting line = Wise");
  });

  // ── phase 6: the live Stripe settlement, lumped and late expenses, rules run later ──
  // Wise rows dated after everything above, so no earlier balance moves.
  const rerun = (list: Tx[], start: number) => {
    let bal = Math.round(start * 100);
    for (const t of [...list].sort((a, b) => a.at.localeCompare(b.at))) {
      bal += Math.round(t.value * 100);
      t.running = bal / 100;
    }
  };
  const wiseNow = (cur: "CAD" | "USD") => Math.round([...(cur === "CAD" ? cadTx : usdTx)].sort((a, b) => a.at.localeCompare(b.at)).pop()!.running * 100);
  const linearId = await bills.createBill(cc, "oasis", { kind: "expense", vendor_name: "Linear", bill_date: d("2026-09-20"), currency: "USD", subtotal: "8.00", category_id: categoryId(B, "5100"), paid_from_account_id: chequing });
  await bills.createBill(cc, "oasis", { kind: "expense", vendor_name: "Design tools", bill_date: d("2026-09-20"), currency: "USD", subtotal: "60.00", category_id: categoryId(B, "5100"), paid_from_account_id: chequing });
  for (const pattern of ["canva", "notion", "converted"]) await txns.createRule(cc, "oasis", { pattern, category_id: categoryId(B, "5100"), direction: "out" });
  usdTx.push(
    // Straddles the next opening balance: the bank moved on the 18th, the expense is dated the 20th.
    { dir: "DEBIT", kind: "CARD", at: at("2026-09-18"), value: -8, cur: "USD", ref: "CARD-U8", running: 0, merchant: "Linear" },
    // A Stripe payout as the LIVE account makes it: settled in USD (the Stripe balance is USD-only), while the charges sit in CAD Stripe clearing.
    { dir: "CREDIT", kind: "DEPOSIT", at: at("2026-09-19"), value: 72, cur: "USD", ref: "TRANSFER-P3", running: 0, sender: "OASIS AI", payref: "5552099", desc: "Received money from OASIS AI with reference 5552099" },
    // "Design tools" was recorded as one US$60 expense; the bank shows two charges that add up to it.
    { dir: "DEBIT", kind: "CARD", at: at("2026-09-20"), value: -25, cur: "USD", ref: "CARD-U9", running: 0, merchant: "Canva" },
    { dir: "DEBIT", kind: "CARD", at: at("2026-09-21"), value: -35, cur: "USD", ref: "CARD-U10", running: 0, merchant: "Framer" },
    // Booked by the 'notion' rule; the same expense is recorded on Bills only afterwards (reverse order).
    { dir: "DEBIT", kind: "CARD", at: at("2026-09-22"), value: -12, cur: "USD", ref: "CARD-U11", running: 0, merchant: "Notion" },
    // A conversion to a currency the books do not hold: one leg, nothing to pair it with.
    { dir: "DEBIT", kind: "CONVERSION", at: at("2026-09-23"), value: -10, cur: "USD", ref: "BALANCE-8001", running: 0, desc: "Converted 10.00 USD to 9.10 EUR" },
  );
  rerun(usdTx, 1000);
  publish();
  fixtures.payouts.push({ id: "po_live_usd", object: "payout", status: "paid", amount: 7200, currency: "usd", arrival_date: arrival("2026-09-19"), balance_transaction: { id: "txn_3", amount: -7200, currency: "usd", fee: 0, net: -7200 } });

  await check("F live shape: a USD-settled payout while Stripe clearing holds only CAD is held (preview and sync), never booked by the feed or the 'stripe' rule", async () => {
    const preview = await feedIo.syncWiseFeed(cc, { since: d("2026-09-19") }, { dryRun: true });
    const pu = preview.currencies.find((c) => c.currency === "USD")!;
    assert.deepEqual([pu.new_rows, pu.stripe_payouts, pu.needs_review, pu.matched_expenses], [5, 0, 4, 0], "payout, the two parts and the conversion leg are previewed as held");
    const r = await feedIo.syncWiseFeed(cc, { since: d("2026-09-19") }, { dryRun: false });
    const u = r.currencies.find((c) => c.currency === "USD")!;
    assert.deepEqual([u.inserted, u.stripe_payouts, u.needs_review], [5, 0, 4]);
    const p3 = await line("WISE-USD-CREDIT-TRANSFER-P3");
    assert.deepEqual([p3.status, p3.entry_id, p3.rule_id], ["unreviewed", null, null]);
    assert.match(String(p3.memo), /^Wise feed: Stripe payout po_live_usd recognised but not booked: .*Stripe clearing holds 0\.00 USD/);
    assert.equal(await native(acct(SYS.stripeClearing), "USD"), 0, "USD Stripe clearing never driven negative");
    assert.match(String((await line("WISE-USD-DEBIT-BALANCE-8001")).memo), /^Wise feed: Wise conversion to or from a currency the books do not hold/);
    for (const f of ["WISE-USD-DEBIT-CARD-U9", "WISE-USD-DEBIT-CARD-U10"]) {
      const l = await line(f);
      assert.deepEqual([l.status, l.rule_id], ["unreviewed", null], `${f}: not booked by the 'canva' rule at import`);
      assert.match(String(l.memo), /add up exactly to expense "Design tools".*60\.00 USD/);
    }
    assert.equal((await line("WISE-USD-DEBIT-CARD-U11")).status, "posted", "an ordinary line still goes through the rules");
  });

  await check("rules run LATER ('Apply rules', 'create rule from transaction') leave every held line alone: payout, parts, conversion leg", async () => {
    const before = [await native(chequing, "USD"), await native(acct("5100"), "USD"), await native(acct(SYS.stripeClearing), "USD")];
    await txns.applyRulesToUnreviewed(cc, "oasis");
    await txns.createRuleFromTransaction(cc, String((await line("WISE-USD-DEBIT-CARD-U11")).id), { pattern: "framer", category_id: categoryId(B, "5100") });
    for (const f of ["WISE-USD-CREDIT-TRANSFER-P3", "WISE-USD-DEBIT-CARD-U9", "WISE-USD-DEBIT-CARD-U10", "WISE-USD-DEBIT-BALANCE-8001"]) {
      const l = await line(f);
      assert.deepEqual([l.status, l.entry_id], ["unreviewed", null], `${f} is still held`);
    }
    assert.deepEqual([await native(chequing, "USD"), await native(acct("5100"), "USD"), await native(acct(SYS.stripeClearing), "USD")], before);
    // A founder decides the two charges ARE the Design tools expense.
    for (const f of ["WISE-USD-DEBIT-CARD-U9", "WISE-USD-DEBIT-CARD-U10"]) await txns.excludeTransaction(cc, String((await line(f)).id));
    assert.equal((await native(chequing, "USD")) + (await pending("USD")), wiseNow("USD"), "US$60 once: the expense, not the expense plus its parts");
  });

  await check("C/D: a matched line straddling the opening balance's day makes the sync say to re-post it; re-posting puts chequing back on Wise", async () => {
    const day = d("2026-09-18");
    const pre = await feedIo.postWiseOpeningBalance(cc, { date: day }, { dryRun: true });
    assert.equal(pre.blocked, null);
    await feedIo.postWiseOpeningBalance(cc, { date: day }, { dryRun: false });
    assert.deepEqual([await activeOpenings("CAD"), await activeOpenings("USD")], [1, 1]);
    // The Notion expense is recorded now, AFTER its bank line was booked by a rule.
    await bills.createBill(cc, "oasis", { kind: "expense", vendor_name: "Notion", bill_date: d("2026-09-22"), currency: "USD", subtotal: "12.00", category_id: categoryId(B, "5100"), paid_from_account_id: chequing });
    const r = await feedIo.syncWiseFeed(cc, { since: d("2026-08-25") }, { dryRun: false });
    const u8 = await line("WISE-USD-DEBIT-CARD-U8");
    const linear = (await raw.execute({ sql: `SELECT entry_id FROM fin_bills WHERE id = ?`, args: [linearId] })).rows[0];
    assert.deepEqual([u8.status, u8.entry_id], ["posted", linear.entry_id], "linked to the Linear expense, nothing new posted");
    assert.ok(r.notes.some((n) => new RegExp(`The USD opening balance for ${day} no longer makes Business chequing equal Wise: .* moved by -8\\.00 USD`).test(n)), r.notes.join(" | "));
    assert.ok(r.notes.some((n) => /Possible double count: the Wise payment of 12\.00 USD .* expense "Notion"/.test(n)), "the reverse order is named, since it cannot be undone automatically");
    assert.equal((await native(chequing, "USD")) + (await pending("USD")), wiseNow("USD") - 800 - 1200, "before the fixes: 8.00 inside the stale balance and 12.00 booked twice");
    // Do what the notes say.
    await txns.excludeTransaction(cc, String((await line("WISE-USD-DEBIT-CARD-U11")).id));
    const again = await feedIo.postWiseOpeningBalance(cc, { date: day }, { dryRun: true });
    assert.deepEqual(again.lines.map((l) => [l.currency, l.action]), [["CAD", "keep"], ["USD", "replace"]]);
    await feedIo.postWiseOpeningBalance(cc, { date: day }, { dryRun: false });
    const clean = await feedIo.syncWiseFeed(cc, { since: d("2026-08-25") }, { dryRun: false });
    assert.ok(!clean.notes.some((n) => /no longer makes|Possible double count/.test(n)), clean.notes.join(" | "));
    assert.equal((await native(chequing, "USD")) + (await pending("USD")), wiseNow("USD"), "chequing USD + the held lines = Wise USD");
    assert.equal((await native(chequing, "CAD")) + (await pending("CAD")), wiseNow("CAD"), "chequing CAD = Wise CAD");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_lines l JOIN fin_journal_entries e ON e.id = l.entry_id WHERE e.source = 'bank_txn' AND e.status = 'posted' AND l.account_id = ? AND l.currency = 'USD' AND l.debit_cents IN (800, 1200)`, [acct("5100")]), 0, "Linear and Notion are each on the books once, as their expenses");
    assert.equal(await native(acct(SYS.stripeClearing), "USD"), 0);
    assert.deepEqual([await activeOpenings("CAD"), await activeOpenings("USD")], [1, 1]);
  });

  await check("D, on screen: the Wise card says when an opening balance is in force and what posting again does", async () => {
    const src = readFileSync(join(root, "components/founders/finances/WiseCard.tsx"), "utf8");
    assert.match(src, /l\.existing &&/, "renders the balance in force");
    assert.match(src, /case "replace":[\s\S]*reversed/, "a replacement is described as reversing the old entry");
    assert.match(src, /opening\.blocked/, "shows why posting is not possible yet");
    assert.match(src, /disabled=\{[^}]*!!opening\.blocked/, "and does not offer the button then");
  });

  await check("the books still balance: trial balance, every entry in CAD, FX clearing at zero, and nothing ever asked Wise to move money", async () => {
    const tb = (await reportsIo.runReport(cc, "oasis", "trial", { to: "2099-12-31" })).data as { balanced: boolean };
    assert.equal(tb.balanced, true);
    const bs = (await reportsIo.runReport(cc, "oasis", "balance", { to: "2099-12-31" })).data as { balanced: boolean };
    assert.equal(bs.balanced, true);
    assert.equal(await count(`SELECT COUNT(*) FROM (SELECT entry_id, SUM(cad_debit_cents) d, SUM(cad_credit_cents) c FROM fin_journal_lines GROUP BY entry_id HAVING d <> c)`), 0);
    assert.equal(
      await count(`SELECT COUNT(*) FROM (SELECT entry_id, currency, SUM(debit_cents) d, SUM(credit_cents) c FROM fin_journal_lines GROUP BY entry_id, currency HAVING d <> c)`),
      0,
      "every entry balances per currency",
    );
    assert.equal(await cadEq(acct(SYS.fxClearing)), 0);
    assert.ok(calls.every((c) => !c.includes("/transfers") && !c.includes("/quotes")));
  });

  if (failures > 0) {
    console.log(`finances-wise-matching: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("finances-wise-matching: all passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
