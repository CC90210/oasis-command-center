/**
 * tests/finances-wise-open-bills.test.ts — a Wise debit that pays a bill still
 * OPEN on the books is held for a founder, never booked a second time
 * (2026-09-30, T5 review).
 *
 * WHY. Since T5 a recurring cost whose paying account no founder confirmed is
 * recorded as a bill DUE (bills-io.ts recordRecurringNow): its cost is on the
 * books (Dr expense / Cr Accounts payable), its payment is not. Every
 * production recurring item is unconfirmed. The Wise feed's once-only
 * protections only knew PAID bills paid from chequing, so the day its writes
 * are switched on (FINANCE_WISE_FEED_WRITES), the Wise debits for rent and
 * software matched nothing: a founder rule ("turso") or a founder categorising
 * the line booked the cost again, while the bill stayed open in A/P.
 *
 * Pinned here, against a REAL local libSQL file with the finance migrations:
 *   - the debit for an open bill (same currency and amount, between its bill
 *     date and due date or within the match window of either) is HELD with a
 *     note naming the bill: no rule books it, "Apply rules" does not either,
 *     each cost is on the books once, the bill stays open, and chequing plus
 *     the waiting lines equals Wise;
 *   - once a founder marks the bill paid from Business chequing, the next
 *     sync LINKS the line to that payment: posted, nothing new, the money in
 *     the bank once;
 *   - a line categorised anyway (the reverse order) is reported as a possible
 *     double count, with what to do (exclude it AND mark the bill paid);
 *   - the pure matcher: an open bill matches anywhere from its bill date to its
 *     due date; one that also fits a paid expense is ambiguous, with advice.
 *
 * Run: node --conditions=react-server --import tsx tests/finances-wise-open-bills.test.ts
 */
process.env.FINANCE_WISE_FEED_WRITES = "on";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "finances-wise-open-bills-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
for (const k of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "STRIPE_SECRET_KEY", "FOUNDERS_TENANT_IDS", "WISE_API_TOKEN", "WISE_PROFILE_ID"]) delete process.env[k];
process.env.WISE_API_TOKEN = "wise-test-token";
process.env.WISE_PROFILE_ID = "82000001";

type Json = Record<string, unknown>;
const statements: Record<string, Json> = {};
/** Wise only (no Stripe key: the sync notes that payouts cannot be recognised and goes on). */
globalThis.fetch = (async (input: unknown) => {
  const url = new URL(String(input));
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
    if (m) return json(statements[m[1] === "11" ? "CAD" : "USD"]);
    return json({ error: "not_found" }, 404);
  }
  throw new Error(`network disabled in test: ${url.host}${url.pathname}`);
}) as typeof fetch;

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 12).join("\n        ")}`);
  }
}

const cc = { kind: "founder" as const, ownerKey: "cc" as const, email: "conaugh@oasisai.work", userId: "u-cc" };

type Tx = { dir: "CREDIT" | "DEBIT"; kind: string; at: string; value: number; cur: "CAD" | "USD"; ref: string; merchant?: string; desc?: string };
function statementOf(cur: "CAD" | "USD", txns: Tx[], start: number): Json {
  let running = Math.round(start * 100);
  const withRunning = [...txns]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((t) => {
      running += Math.round(t.value * 100);
      return { t, running: running / 100 };
    });
  return {
    accountHolder: { type: "BUSINESS", businessName: "OASISAI" },
    bankDetails: [],
    transactions: withRunning.reverse().map(({ t, running: r }) => ({
      type: t.dir,
      date: t.at,
      amount: { value: t.value, currency: t.cur, zero: false },
      totalFees: { value: 0, currency: t.cur, zero: true },
      details: { type: t.kind, description: t.desc ?? "", ...(t.merchant ? { merchant: { name: t.merchant, city: "Montreal" } } : {}) },
      exchangeDetails: null,
      runningBalance: { value: r, currency: t.cur, zero: false },
      referenceNumber: t.ref,
      attachment: null,
    })),
    startOfStatementBalance: { value: start, currency: cur, zero: start === 0 },
    endOfStatementBalance: { value: running / 100, currency: cur },
  };
}

async function main() {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  for (const f of ["180_founders_finances.turso.sql", "184_finance_wise_payments.turso.sql", "bravo__190_ledger_core.sql", "bravo__193_stripe_payouts.sql"]) {
    await raw.executeMultiple(readFileSync(join(root, "database/turso", f), "utf8"));
  }
  const { addDays, torontoToday } = await import("../lib/founders-finances/fx");
  const today = torontoToday();
  for (let day = addDays(today, -40); day <= addDays(today, 5); day = addDays(day, 1)) {
    await raw.execute({ sql: `INSERT INTO fin_fx_rates (pair, rate_date, rate) VALUES ('USDCAD', ?, '1.3700')`, args: [day] });
  }
  const feed = await import("../lib/founders-finances/wise-feed");
  const { ensureFinanceSeed } = await import("../lib/founders-finances/seed-io");
  const { accountId, categoryId, BUSINESS_ENTITY_ID: B, SYS } = await import("../lib/founders-finances/chart");
  const bills = await import("../lib/founders-finances/bills-io");
  const txns = await import("../lib/founders-finances/transactions-io");
  const feedIo = await import("../lib/founders-finances/wise-feed-io");

  // ── pure: the matcher ─────────────────────────────────────────────────
  const row = (fitid: string, date: string, cents: number, cur = "USD"): import("../lib/founders-finances/wise-feed").WiseFeedRow => ({
    fitid,
    postedDate: date,
    occurredAt: `${date}T15:00:00.000Z`,
    amountCents: cents,
    feeCents: 0,
    currency: cur,
    kind: "CARD",
    ref: fitid,
    name: "",
    memo: "",
  });
  const openBill = (id: string, billDate: string, dueOn: string, cents: number, cur = "USD") =>
    ({ id, open: true as const, entryId: null, label: `open bill "${id}" (due ${dueOn})`, currency: cur, totalCents: cents, paidOn: billDate, dueOn, categoryId: null });
  const paid = (id: string, date: string, cents: number, cur = "USD") => ({ id, entryId: `je-${id}`, label: `expense "${id}" (${date})`, currency: cur, totalCents: cents, paidOn: date, categoryId: null });
  const plan = (rows: ReturnType<typeof row>[], candidates: Parameters<typeof feed.planFeed>[0]["bills"]) =>
    feed.planFeed({ rows, payouts: new Map(), recordedDepositRefs: new Set(), lines: new Map(), openings: new Map(), bills: candidates });

  await check("matcher: an open bill is matched anywhere from its bill date to its due date (and within the window of either); it resolves to 'held', never 'linked'", () => {
    const b = openBill("notion", "2026-09-20", "2026-09-30", 1200);
    assert.equal(plan([row("L1", "2026-09-25", -1200)], [b]).get("L1")?.kind, "bill_open", "paid between the bill date and the due date");
    assert.equal(plan([row("L2", "2026-10-07", -1200)], [b]).get("L2")?.kind, "bill_open", "7 days after the due date");
    assert.equal(plan([row("L3", "2026-10-08", -1200)], [b]).get("L3"), undefined, "8 days after: new money, as before");
    assert.equal(plan([row("L4", "2026-09-25", -1201)], [b]).get("L4"), undefined, "a cent off: not that bill");
    const r = plan([row("L5", "2026-09-25", -1200)], [b]).get("L5");
    assert.ok(r && r.kind === "bill_open" && r.bill.entryId === null, "an open bill is never a link target");
    // An open bill and a paid expense of the same amount: a founder decides.
    const both = plan([row("L6", "2026-09-25", -1200)], [b, paid("figma", "2026-09-25", 1200)]).get("L6");
    assert.equal(both?.kind, "bill_ambiguous");
  });

  // ── the live shape: recurring costs recorded as open bills, the Wise feed on ──
  await ensureFinanceSeed();
  await raw.execute({ sql: `UPDATE fin_settings SET stripe_account_id = 'acct_test_oasis' WHERE entity_id = ?`, args: [B] });
  const chequing = accountId(B, SYS.chequing);
  const acct = (code: string) => accountId(B, code);
  const count = async (sql: string, args: Array<string | number> = []) => Number((await raw.execute({ sql, args })).rows[0][0]);
  const native = (account: string, cur: string) =>
    count(`SELECT COALESCE(SUM(debit_cents - credit_cents), 0) FROM fin_journal_lines WHERE account_id = ? AND currency = ?`, [account, cur]);
  const pending = (cur: string) => count(`SELECT COALESCE(SUM(amount_cents), 0) FROM fin_bank_transactions WHERE fitid LIKE 'WISE-%' AND currency = ? AND status = 'unreviewed'`, [cur]);
  const line = async (fitid: string) => (await raw.execute({ sql: `SELECT * FROM fin_bank_transactions WHERE fitid = ?`, args: [fitid] })).rows[0];
  const billRow = async (id: string) => (await raw.execute({ sql: `SELECT status, entry_id, payment_entry_id FROM fin_bills WHERE id = ?`, args: [id] })).rows[0];

  const d0 = addDays(today, -10);
  const at = (date: string) => `${date}T15:00:00.000Z`;
  // The production state after T5: recurring items created with no paid-from, so each due date is a bill due.
  const recurring: Array<[string, string, "CAD" | "USD", string]> = [
    ["Office rent", "2750.00", "CAD", "5650"],
    ["Turso (database)", "27.99", "USD", "5900"],
    ["AI subscriptions", "420.00", "USD", "5100"],
  ];
  const billIds: Record<string, string> = {};
  for (const [name, amount, currency, code] of recurring) {
    const item = await bills.createRecurring(cc, "oasis", { name, amount, currency, cadence: "monthly", next_run_on: d0, category_id: categoryId(B, code) });
    billIds[name] = await bills.recordRecurringNow(cc, item);
  }
  for (const id of Object.values(billIds)) assert.equal((await billRow(id)).status, "open", "setup: each is a bill due, unpaid");
  // A rule a founder would plausibly have: before the fix it booked Turso a second time.
  await txns.createRule(cc, "oasis", { pattern: "turso", category_id: categoryId(B, "5900"), direction: "out" });

  const cadTx: Tx[] = [{ dir: "DEBIT", kind: "TRANSFER", at: at(d0), value: -2750, cur: "CAD", ref: "TRANSFER-RENT", desc: "Sent money to Landlord Property Mgmt" }];
  const usdTx: Tx[] = [
    { dir: "DEBIT", kind: "CARD", at: at(d0), value: -27.99, cur: "USD", ref: "CARD-TURSO", merchant: "Turso" },
    { dir: "DEBIT", kind: "CARD", at: at(addDays(d0, 1)), value: -420, cur: "USD", ref: "CARD-AI", merchant: "Anthropic" },
  ];
  statements.CAD = statementOf("CAD", cadTx, 5000);
  statements.USD = statementOf("USD", usdTx, 1000);
  const since = addDays(d0, -2);
  const wiseMove = { CAD: -275000, USD: -2799 - 42000 };
  const costsOnce = async () => {
    assert.equal(await native(acct("5650"), "CAD"), 275000, "rent once");
    assert.equal(await native(acct("5900"), "USD"), 2799, "Turso once");
    assert.equal(await native(acct("5100"), "USD"), 42000, "AI once");
  };

  const synced = await feedIo.syncWiseFeed(cc, { since }, { dryRun: false });

  await check("the Wise debits that pay OPEN bills are held with the bill named: no rule books them, each cost is on the books once, the bills stay open", async () => {
    const byCur = (c: string) => synced.currencies.find((x) => x.currency === c)!;
    assert.deepEqual([byCur("CAD").needs_review, byCur("USD").needs_review, byCur("USD").matched_expenses], [1, 2, 0]);
    const held: Array<[string, string]> = [
      ["WISE-CAD-DEBIT-TRANSFER-RENT", `open bill "Office rent" (due ${d0}), 2750.00 CAD`],
      ["WISE-USD-DEBIT-CARD-TURSO", `open bill "Turso (database)" (due ${d0}), 27.99 USD`],
      ["WISE-USD-DEBIT-CARD-AI", `open bill "AI subscriptions" (due ${d0}), 420.00 USD`],
    ];
    for (const [fitid, named] of held) {
      const l = await line(fitid);
      assert.deepEqual([l.status, l.entry_id, l.rule_id], ["unreviewed", null, null], `${fitid}: held, not booked (the 'turso' rule did not touch it)`);
      assert.ok(String(l.memo).startsWith(`Wise feed: this looks like the payment of ${named}, which is still open (owed) in Bills & Expenses`), String(l.memo));
      assert.match(String(l.memo), /mark that bill paid from Business chequing on \d{4}-\d{2}-\d{2}; the next sync links this line/);
    }
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'bank_txn'`), 0, "no bank line posted anything");
    await costsOnce();
    for (const id of Object.values(billIds)) assert.equal((await billRow(id)).status, "open");
    // Every Wise movement is on the books exactly once: here, as a line waiting for a founder.
    assert.equal((await native(chequing, "CAD")) + (await pending("CAD")), wiseMove.CAD);
    assert.equal((await native(chequing, "USD")) + (await pending("USD")), wiseMove.USD);
  });

  await check("held stays held: 'Apply rules to unreviewed' never books the Turso line; no opening balance is computed through the held lines", async () => {
    await txns.applyRulesToUnreviewed(cc, "oasis");
    assert.deepEqual([(await line("WISE-USD-DEBIT-CARD-TURSO")).status, (await line("WISE-USD-DEBIT-CARD-TURSO")).entry_id], ["unreviewed", null]);
    await costsOnce();
    const ob = await feedIo.postWiseOpeningBalance(cc, { date: addDays(d0, 2) }, { dryRun: true });
    assert.match(String(ob.blocked), /3 Wise line\(s\) on or before .* waiting for your decision/);
  });

  await check("a founder marks the Turso bill paid from Business chequing: the next sync LINKS the line to that payment; the money leaves the bank once", async () => {
    await bills.payBill(cc, billIds["Turso (database)"], { account_id: chequing, date: d0 });
    const paidBill = await billRow(billIds["Turso (database)"]);
    assert.equal(paidBill.status, "paid");
    await feedIo.syncWiseFeed(cc, { since }, { dryRun: false });
    const l = await line("WISE-USD-DEBIT-CARD-TURSO");
    assert.deepEqual([l.status, l.entry_id], ["posted", paidBill.payment_entry_id], "linked to the bill's payment entry");
    assert.match(String(l.memo), /^Matched to bill "Turso \(database\)" .* already on the books; nothing new was posted\./);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'bank_txn'`), 0, "still nothing posted by a bank line");
    await costsOnce();
    assert.equal(await native(chequing, "USD"), -2799, "the payment took Turso out of chequing once");
    assert.equal((await native(chequing, "USD")) + (await pending("USD")), wiseMove.USD, "chequing + what still waits = Wise");
    assert.match(String((await line("WISE-USD-DEBIT-CARD-AI")).memo), /^Wise feed: this looks like the payment of open bill "AI subscriptions"/, "the other open bill's line is still held");
  });

  await check("the reverse order: a Wise debit a rule booked BEFORE its bill was recorded is reported as a possible double count, saying to exclude it AND mark the bill paid", async () => {
    // The Cloudflare charge arrives and the founder's 'cloudflare' rule books it: no bill of that amount exists yet.
    await txns.createRule(cc, "oasis", { pattern: "cloudflare", category_id: categoryId(B, "5900"), direction: "out" });
    const day = addDays(d0, 2);
    usdTx.push({ dir: "DEBIT", kind: "CARD", at: at(day), value: -5, cur: "USD", ref: "CARD-CF", merchant: "Cloudflare" });
    statements.USD = statementOf("USD", usdTx, 1000);
    await feedIo.syncWiseFeed(cc, { since }, { dryRun: false });
    const cf = await line("WISE-USD-DEBIT-CARD-CF");
    assert.equal(cf.status, "posted", "setup: the rule booked it (Dr hosting / Cr chequing)");
    // Then the recurring Cloudflare cost is recorded, unconfirmed: an open bill for the same US$5.00 (Dr hosting / Cr A/P).
    const item = await bills.createRecurring(cc, "oasis", { name: "Cloudflare", amount: "5.00", currency: "USD", cadence: "monthly", next_run_on: day, category_id: categoryId(B, "5900") });
    await bills.recordRecurringNow(cc, item);
    const r = await feedIo.syncWiseFeed(cc, { since }, { dryRun: true });
    const note = r.notes.find((n) => n.startsWith(`Possible double count: the Wise payment of 5.00 USD on ${day}`));
    assert.ok(note, r.notes.join(" | "));
    assert.ok(note!.includes(`open bill "Cloudflare" (due ${day}) is also on the books.`), note);
    assert.match(note!, /If they are the same payment, exclude the line in Transactions and mark the open bill paid from Business chequing/);
  });

  if (failures) {
    console.error(`finances-wise-open-bills: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("finances-wise-open-bills: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
