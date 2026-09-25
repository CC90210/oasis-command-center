/**
 * tests/finances-wise.test.ts — Wise in FOUNDERS > Finances: invoice payment
 * options, the deposit reconcile, the bank feed and the opening balance.
 *
 * Runs the real modules and route handlers against a REAL local libSQL file
 * with migration 180 applied, then applies migration 184 (NOT applied to any
 * live database) mid-run to prove both sides of it. The network is a router:
 * api.transferwise.com and api.stripe.com answer from fixtures shaped like the
 * live responses probed 2026-09-24 (scripts/integrations/wise_tool.py);
 * anything else throws.
 *
 * Run: node --conditions=react-server --import tsx tests/finances-wise.test.ts
 */
// The feed writes are switched off in production (lib/founders-finances/wise-feed.ts);
// this suite exercises the logic behind the switch.
process.env.FINANCE_WISE_FEED_WRITES = "on";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "finances-wise-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.FINANCE_AGENT_TOKEN = "atlas-test-token-0123456789abcdef";
for (const k of ["STRIPE_SECRET_KEY", "FOUNDERS_TENANT_IDS", "WISE_API_TOKEN", "WISE_PROFILE_ID", "INVOICE_FROM_EMAIL", "INVOICE_FROM_APP_PASSWORD", "OASIS_MAIL_FROM", "OASIS_MAIL_APP_PASSWORD"]) {
  delete process.env[k];
}

const PROFILE = "82000001";
type Json = Record<string, unknown>;
const fixtures: { statements: Record<string, Json>; payouts: Json[] } = { statements: {}, payouts: [] };
const calls: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  const url = new URL(String(input));
  calls.push(`${url.host}${url.pathname}`);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.host === "api.transferwise.com") {
    if (url.pathname === "/v2/profiles") return json([{ id: Number(PROFILE), type: "BUSINESS", businessName: "OASISAI" }]);
    if (url.pathname === `/v4/profiles/${PROFILE}/balances`) {
      return json([
        { id: 11, currency: "CAD", amount: { value: 983.25, currency: "CAD" } },
        { id: 12, currency: "USD", amount: { value: 9.88, currency: "USD" } },
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
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 5).join("\n        ")}`);
  }
}

const cc = { kind: "founder" as const, ownerKey: "cc" as const, email: "conaugh@oasisai.work", userId: "u-cc" };

// ── Wise statement fixtures (the live shape, invented values) ─────────────
const cadDetails = {
  deprecated: false,
  address: { firstLine: "Wise Payments Canada Inc.", secondLine: "99 Bank Street, Suite 1420", city: "Ottawa", stateCode: "ON", postCode: "K1P 1H4", country: "Canada" },
  accountNumbers: [{ accountType: "Account number", accountNumber: "200110000111" }],
  bankCodes: [
    { scheme: "Institution number", value: "621" },
    { scheme: "Transit number", value: "16001" },
    { scheme: "Swift/BIC", value: "TRWICAW1XXX" },
  ],
};
const usdDetails = {
  deprecated: false,
  address: { firstLine: "Community Federal Savings Bank", secondLine: "89-16 Jamaica Ave", city: "Woodhaven", stateCode: "NY", postCode: "11421", country: "United States" },
  accountNumbers: [{ accountType: "Account number", accountNumber: "822000999888" }],
  bankCodes: [
    { scheme: "Routing number (ACH or ABA)", value: "026073150" },
    { scheme: "Swift/BIC", value: "CMFGUS33" },
  ],
};
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
    ...(t.merchant ? { merchant: { name: t.merchant, city: "SF" } } : {}),
  },
  exchangeDetails: null,
  runningBalance: { value: t.running, currency: t.cur, zero: false },
  referenceNumber: t.ref,
  attachment: null,
});
const statementOf = (cur: "CAD" | "USD", txns: Tx[], start: number, details: Json[]) => ({
  accountHolder: { type: "BUSINESS", businessName: "OASISAI" },
  bankDetails: [{ ...details[0], deprecated: true, accountNumbers: [{ accountType: "Account number", accountNumber: "000000000001" }] }, ...details],
  // Wise lists newest first.
  transactions: [...txns].sort((a, b) => b.at.localeCompare(a.at)).map(tx),
  startOfStatementBalance: { value: start, currency: cur, zero: start === 0 },
  endOfStatementBalance: { value: txns.length ? [...txns].sort((a, b) => a.at.localeCompare(b.at))[txns.length - 1].running : start, currency: cur },
});

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    standardFontDataUrl: join(root, "node_modules", "pdfjs-dist", "standard_fonts") + "/",
  }).promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    out += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
  }
  return out;
}

async function main() {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(readFileSync(join(root, "database/turso/180_founders_finances.turso.sql"), "utf8"));

  const { addDays, torontoToday, usdToCadCents, parseRateMicro } = await import("../lib/founders-finances/fx");
  const today = torontoToday();
  // 1.36 up to 8 days ago (when the USD invoices are issued), 1.37 after (when they are paid): a realised FX gain on receipt.
  for (let i = -30; i <= 1; i++) {
    await raw.execute({ sql: `INSERT INTO fin_fx_rates (pair, rate_date, rate) VALUES ('USDCAD', ?, ?)`, args: [addDays(today, i), i <= -8 ? "1.3600" : "1.3700"] });
  }
  const at = (daysAgo: number) => `${addDays(today, -daysAgo)}T15:00:00.000Z`;

  const wise = await import("../lib/founders-finances/wise");
  const feed = await import("../lib/founders-finances/wise-feed");
  const { parseStatement, dedupeHashes } = await import("../lib/founders-finances/import-parse");
  const { renderInvoicePdf } = await import("../lib/founders-finances/invoice-pdf");
  const { composeInvoiceEmail } = await import("../lib/founders-finances/invoice-email");
  const { ensureFinanceSeed } = await import("../lib/founders-finances/seed-io");
  const access = await import("../lib/founders-finances/access-io");
  const invoices = await import("../lib/founders-finances/invoices-io");
  const store = await import("../lib/founders-finances/invoice-store");
  const wiseIo = await import("../lib/founders-finances/wise-io");
  const reconcile = await import("../lib/founders-finances/wise-reconcile");
  const feedIo = await import("../lib/founders-finances/wise-feed-io");
  const reportsIo = await import("../lib/founders-finances/reports-io");
  const { accountId, SYS, BUSINESS_ENTITY_ID: B } = await import("../lib/founders-finances/chart");
  const syncRoute = await import("../app/api/internal/finance/wise-sync/route");
  const reconcileRoute = await import("../app/api/internal/finance/wise-reconcile/route");

  const count = async (sql: string, args: Array<string | number> = []) => Number((await raw.execute({ sql, args })).rows[0][0]);
  const internal = (route: { POST: (r: Request) => Promise<Response> }, body: Json, auth = true) =>
    route.POST(
      new Request("http://localhost/api/internal/finance/x", {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${process.env.FINANCE_AGENT_TOKEN}` } : {}) },
        body: JSON.stringify(body),
      }),
    );
  const chequing = accountId(B, SYS.chequing);
  const nativeBalance = async (cur: string, onOrBefore = "9999-12-31") =>
    count(
      `SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) FROM fin_journal_lines l JOIN fin_journal_entries e ON e.id = l.entry_id
        WHERE l.account_id = ? AND l.currency = ? AND e.entry_date <= ?`,
      [chequing, cur, onOrBefore],
    );

  // ── pure ──────────────────────────────────────────────────────────────
  await check("receiving details: the live block, labelled as Wise labels it, Swift last", async () => {
    const d = wise.receivingDetailsFromStatement(statementOf("CAD", [], 0, [cadDetails]), "CAD");
    assert.ok(d);
    assert.equal(d!.accountHolder, "OASISAI");
    assert.deepEqual(d!.fields.map((f) => f.label), ["Institution number", "Transit number", "Account number", "Swift/BIC"]);
    assert.equal(d!.fields[2].value, "200110000111", "the deprecated block is skipped");
    const lines = wise.bankTransferLines(d!, "OASIS-2026-0009");
    assert.deepEqual(lines[lines.length - 1], { label: "Payment reference", value: "OASIS-2026-0009" });
    assert.equal(wise.maskAccountNumber("200110000111"), "****0111");
  });

  await check("matching: exact needs reference AND amount; everything else is only suggested", async () => {
    assert.equal(wise.referenceNames("OASIS-2026-0007", "pmt oasis 2026 0007 thanks"), true);
    assert.equal(wise.referenceNames("OASIS-2026-1000", "OASIS-2026-10000"), false, "a longer number is not this one");
    const dep = (ref: string, cents: number, reference: string, cur = "USD") => ({ ref, occurredAt: at(2), currency: cur, netCents: cents, feeCents: 0, grossCents: cents, kind: "DEPOSIT", sender: "Acme", reference, description: "" });
    const inv = [
      { id: "i1", number: "OASIS-2026-0001", currency: "USD", balanceCents: 100000, contactName: "Acme" },
      { id: "i2", number: "OASIS-2026-0002", currency: "USD", balanceCents: 25000, contactName: "Globex" },
    ];
    const p = wise.proposeWiseMatches(
      [dep("T1", 100000, "OASIS-2026-0001"), dep("T2", 25000, ""), dep("T3", 90000, "OASIS-2026-0001"), dep("T4", 100000, "OASIS-2026-0001", "CAD")],
      inv,
      { recordedRefs: new Set(), dismissed: new Set(["T2|i2"]) },
    );
    assert.deepEqual(p.exact.map((m) => m.deposit.ref), ["T1"]);
    assert.deepEqual(p.fuzzy.map((m) => m.deposit.ref).sort(), ["T3", "T4"], "wrong amount / wrong currency are suggestions; the dismissed one is gone");
    assert.deepEqual(wise.settlementFor({ ...dep("T5", 98500, ""), feeCents: 1500, grossCents: 100000 }, 100000), { amountCents: 100000, feeCents: 1500, full: true });
    assert.equal(wise.settlementFor(dep("T6", 120000, ""), 100000), null, "an overpayment is never guessed");
  });

  await check("feed rows: signed, Toronto-dated, one id per currency+direction; OFX round-trips through the statement parser", async () => {
    const cadStmt = statementOf("CAD", [
      { dir: "DEBIT", kind: "CONVERSION", at: at(5), value: -370, fee: 1.69, cur: "CAD", ref: "BALANCE-7001", running: 630, desc: "Converted 370.00 CAD to 262.79 USD" },
      { dir: "DEBIT", kind: "CARD", at: "2026-09-02T02:30:00.000Z", value: -28.25, cur: "CAD", ref: "CARD-5001", running: 601.75, merchant: "Openai *Chatgpt Subscr", desc: "Card transaction of 28.25 CAD issued by Openai *Chatgpt Subscr" },
    ], 1000, [cadDetails]);
    const rows = feed.feedRowsFromStatement(cadStmt, "CAD");
    assert.deepEqual(rows.map((r) => r.fitid), ["WISE-CAD-DEBIT-CARD-5001", "WISE-CAD-DEBIT-BALANCE-7001"], "oldest first");
    const card = rows.find((r) => r.kind === "CARD")!;
    assert.equal(card.postedDate, "2026-09-01", "02:30 UTC is still the evening before in Toronto");
    assert.equal(card.amountCents, -2825);
    assert.equal(card.name, "Openai *Chatgpt Subscr");
    assert.equal(rows.find((r) => r.kind === "CONVERSION")!.amountCents, -37000, "the fee is inside the balance movement, not added again");
    assert.notEqual(feed.wiseFitid("CAD", "DEBIT", "BALANCE-7001"), feed.wiseFitid("USD", "CREDIT", "BALANCE-7001"), "a conversion's two legs stay two rows");
    const parsed = parseStatement("wise-CAD.ofx", feed.feedRowsToOfx(rows, "CAD"));
    assert.equal(parsed.format, "ofx");
    assert.equal(parsed.currency, "CAD");
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.rows.map((r) => [r.postedDate, r.amountCents, r.fitid]), rows.map((r) => [r.postedDate, r.amountCents, r.fitid]));
    assert.equal(new Set(dedupeHashes(parsed.rows)).size, rows.length);
  });

  await check("stripe payouts are recognised by the payout itself, not by a name", async () => {
    const rows = feed.feedRowsFromStatement(
      statementOf("USD", [
        { dir: "CREDIT", kind: "DEPOSIT", at: at(3), value: 67.84, cur: "USD", ref: "TRANSFER-1", running: 67.84, sender: "OASIS AI", payref: "5552097", desc: "Received money from OASIS AI with reference 5552097" },
        { dir: "CREDIT", kind: "DEPOSIT", at: at(9), value: 67.84, cur: "USD", ref: "TRANSFER-2", running: 135.68, sender: "OASIS AI", desc: "Received money from OASIS AI" },
        { dir: "DEBIT", kind: "DIRECT_DEBIT", at: at(4), value: -105.37, cur: "USD", ref: "DIRECT_DEBIT-1", running: 30.31, desc: "Paid to STRIPE" },
      ], 0, [usdDetails]),
      "USD",
    );
    const { rows: tagged, tagged: n } = feed.tagStripePayouts(rows, [
      { id: "po_1", amountCents: 6784, currency: "usd", arrivalDate: addDays(today, -2) },
      { id: "po_neg", amountCents: -10537, currency: "usd", arrivalDate: addDays(today, -4) },
      { id: "po_far", amountCents: 6784, currency: "usd", arrivalDate: addDays(today, -30) },
    ]);
    assert.equal(n, 2);
    assert.equal(tagged.find((r) => r.ref === "TRANSFER-1")!.name, "Stripe payout po_1", "the closest deposit within 3 days");
    assert.equal(tagged.find((r) => r.ref === "TRANSFER-2")!.name, "OASIS AI", "same amount, 21 days away: not a payout");
    assert.equal(tagged.find((r) => r.ref === "DIRECT_DEBIT-1")!.name, "Stripe payout po_neg");
  });

  await check("balance at the end of a day: running balance of its last row, else the statement's opening", async () => {
    const s = statementOf("CAD", [
      { dir: "CREDIT", kind: "DEPOSIT", at: "2026-09-10T15:00:00.000Z", value: 100, cur: "CAD", ref: "A", running: 600 },
      { dir: "DEBIT", kind: "CARD", at: "2026-09-11T03:00:00.000Z", value: -50, cur: "CAD", ref: "B", running: 550 },
      { dir: "DEBIT", kind: "CARD", at: "2026-09-12T15:00:00.000Z", value: -25, cur: "CAD", ref: "C", running: 525 },
    ], 500, [cadDetails]);
    assert.equal(feed.balanceAtEndOf(s, "2026-09-09"), 50000);
    assert.equal(feed.balanceAtEndOf(s, "2026-09-10"), 55000, "03:00 UTC on the 11th is the 10th in Toronto");
    assert.equal(feed.balanceAtEndOf(s, "2026-09-12"), 52500);
  });

  await check("PDF and email: Wise details for the invoice currency with the reference; a Stripe-only invoice is unchanged", async () => {
    const usd = wise.receivingDetailsFromStatement(statementOf("USD", [], 0, [usdDetails]), "USD")!;
    const bank = wise.bankTransferLines(usd, "OASIS-2026-0011");
    const input = {
      seller: { legalName: "OASIS AI Solutions", addressLines: ["Montreal, QC"], email: "conaugh@oasisai.work", gstNumber: "", qstNumber: "" },
      invoice: {
        number: "OASIS-2026-0011", status: "sent" as const, issueDate: "2026-09-24", dueDate: "2026-10-08", currency: "USD", subtotalCents: 100000, gstCents: 0, qstCents: 0,
        totalCents: 100000, amountPaidCents: 0, taxRegistered: false, notes: "", paymentLinkUrl: "https://buy.stripe.com/test_link", paymentInstructions: "Questions: billing@oasisai.work",
      },
      customer: { name: "Acme", company: "", email: "ap@acme.test", address: "" },
      lines: [{ description: "Build", quantityMilli: 1000, unitPriceCents: 100000, amountCents: 100000 }],
    };
    const withBank = await pdfText(await renderInvoicePdf({ ...input, invoice: { ...input.invoice, bankTransfer: bank } }));
    assert.match(withBank, /PAY BY BANK TRANSFER \(WISE\)/);
    assert.match(withBank, /Routing number \(ACH or ABA\)\s+026073150/);
    assert.match(withBank, /822000999888/, "the client's PDF prints the full account number");
    assert.match(withBank, /Payment reference\s+OASIS-2026-0011/);
    assert.match(withBank, /buy\.stripe\.com/, "and the card link when the method offers both");
    const stripeOnly = await pdfText(await renderInvoicePdf(input));
    assert.doesNotMatch(stripeOnly, /BANK TRANSFER|Routing number/);
    assert.match(stripeOnly, /buy\.stripe\.com/);

    const args = { kind: "invoice" as const, sellerName: "OASIS AI Solutions", customerName: "Acme", number: "OASIS-2026-0011", totalCents: 100000, balanceCents: 100000, currency: "USD", dueDate: "2026-10-08", paymentLinkUrl: "https://buy.stripe.com/x", paymentInstructions: "" };
    const mail = composeInvoiceEmail({ ...args, bankTransfer: bank });
    assert.match(mail.text, /Pay by bank transfer \(Wise\):/);
    assert.match(mail.text, /Payment reference: OASIS-2026-0011/);
    assert.match(mail.html, /<strong>OASIS-2026-0011<\/strong>/);
    assert.ok(mail.text.indexOf("bank transfer") < mail.text.indexOf("buy.stripe.com"), "bank transfer first: it is the default way to pay a one-off");
    assert.deepEqual(composeInvoiceEmail({ ...args, bankTransfer: null }), composeInvoiceEmail(args), "no Wise lines: byte-for-byte the card email");
  });

  // ── migration 184, both sides ─────────────────────────────────────────
  await ensureFinanceSeed();
  let preInvoice = "";
  await check("before migration 184: every invoice is a card invoice, and choosing Wise is refused in plain English", async () => {
    store.resetPaymentMethodColumnMemo();
    assert.equal(await store.paymentMethodColumnReady(), false);
    preInvoice = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Old Client", email: "ap@old.test" }, currency: "CAD", lines: [{ description: "x", quantity: 1, unit_price: "100" }] });
    assert.equal((await invoices.getInvoiceDetail(cc, preInvoice)).paymentMethod, "stripe");
    await assert.rejects(
      invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "N", email: "n@n.test" }, currency: "CAD", payment_method: "wise", lines: [{ description: "x", quantity: 1, unit_price: "1" }] }),
      /isn't available on invoices yet/,
    );
  });

  await check("migration 184 applies additively: old rows read 'stripe', new drafts default to 'wise', the CHECK holds", async () => {
    await raw.executeMultiple(readFileSync(join(root, "database/turso/184_finance_wise_payments.turso.sql"), "utf8"));
    store.resetPaymentMethodColumnMemo();
    assert.equal(await store.paymentMethodColumnReady(), true);
    assert.equal((await invoices.getInvoiceDetail(cc, preInvoice)).paymentMethod, "stripe", "an invoice from before keeps its card flow");
    const fresh = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "New Client", email: "ap@new.test" }, currency: "USD", lines: [{ description: "x", quantity: 1, unit_price: "10" }] });
    assert.equal((await invoices.getInvoiceDetail(cc, fresh)).paymentMethod, "wise", "a new one-off invoice asks for a bank transfer");
    await invoices.updateDraftInvoice(cc, fresh, { contact_id: (await store.loadInvoice(fresh))!.contact_id, currency: "USD", lines: [{ description: "y", quantity: 1, unit_price: "12" }] });
    assert.equal((await invoices.getInvoiceDetail(cc, fresh)).paymentMethod, "wise", "an edit that does not mention the method keeps it");
    await invoices.updateDraftInvoice(cc, fresh, { contact_id: (await store.loadInvoice(fresh))!.contact_id, currency: "USD", payment_method: "wise_stripe", lines: [{ description: "y", quantity: 1, unit_price: "12" }] });
    assert.equal((await invoices.getInvoiceDetail(cc, fresh)).paymentMethod, "wise_stripe");
    await assert.rejects(invoices.updateDraftInvoice(cc, fresh, { contact_id: (await store.loadInvoice(fresh))!.contact_id, payment_method: "paypal", lines: [{ description: "y", quantity: 1, unit_price: "12" }] }), access.FinanceInputError);
    await assert.rejects(raw.execute({ sql: `UPDATE fin_invoices SET payment_method = 'paypal' WHERE id = ?`, args: [fresh] }), /CHECK constraint/);
  });

  // ── Wise not configured ───────────────────────────────────────────────
  await check("not configured: every Wise path fails closed with a sentence a founder can act on", async () => {
    wiseIo.resetWiseCache();
    const st = await wiseIo.wiseStatus();
    assert.equal(st.configured, false);
    assert.match(String(st.error), /Wise isn't connected yet/);
    assert.doesNotMatch(String(st.error), /WISE_|env|server/, "founder copy never names settings or infrastructure");
    const r = await wiseIo.receivingDetailsOrReason("CAD");
    assert.equal(r.ok, false);
    await assert.rejects(feedIo.syncWiseFeed(cc, {}, { dryRun: true }), (e: unknown) => e instanceof wiseIo.WiseNotReady && e.code === "wise_not_configured");
    const sync = await internal(syncRoute, {});
    assert.equal(sync.status, 503);
    assert.match(String(((await sync.json()) as Json).message), /isn't connected/);
    assert.equal((await internal(reconcileRoute, {})).status, 503);
    assert.equal((await internal(syncRoute, {}, false)).status, 401, "the bearer is checked before anything else");
    assert.equal(calls.filter((c) => c.startsWith("api.transferwise.com")).length, 0, "nothing was sent to Wise");
  });

  await check("not configured: a Wise invoice still goes out with the instructions — and is refused when there is no way to pay at all", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Hooli", email: "ap@hooli.test" }, currency: "CAD", lines: [{ description: "Build", quantity: 1, unit_price: "500" }] });
    await assert.rejects(invoices.sendInvoice(cc, id), (e: unknown) => e instanceof access.FinanceInputError && /Wise isn't connected/.test(e.message) && /NOT emailed/.test(e.message));
    await raw.execute({ sql: `UPDATE fin_settings SET payment_instructions = 'Interac e-Transfer to billing@oasisai.work' WHERE entity_id = ?`, args: [B] });
    await assert.rejects(invoices.sendInvoice(cc, id), /mailbox/i, "with instructions it gets as far as the mailer (none configured in tests)");
    await raw.execute({ sql: `UPDATE fin_settings SET payment_instructions = '' WHERE entity_id = ?`, args: [B] });
    const pdf = await pdfText((await invoices.invoicePdfBytes(cc, id)).bytes);
    assert.doesNotMatch(pdf, /BANK TRANSFER/, "no invented bank details");
  });

  // ── Wise configured ───────────────────────────────────────────────────
  process.env.WISE_API_TOKEN = "wise-test-token";
  process.env.WISE_PROFILE_ID = PROFILE;
  wiseIo.resetWiseCache();

  const invA = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Acme", email: "ap@acme.test" }, issue_date: addDays(today, -8), currency: "USD", lines: [{ description: "Build", quantity: 1, unit_price: "1000.00" }] });
  const numA = (await invoices.finalizeInvoice(cc, invA)).number as string;
  const invB = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Globex", email: "ap@globex.test" }, issue_date: addDays(today, -8), currency: "USD", lines: [{ description: "Audit", quantity: 1, unit_price: "250.00" }] });
  const numB = (await invoices.finalizeInvoice(cc, invB)).number as string;

  const usdTx: Tx[] = [
    { dir: "CREDIT", kind: "DEPOSIT", at: at(6), value: 1000, cur: "USD", ref: "TRANSFER-9001", running: 1000, sender: "Acme Inc", payref: numA, desc: `Received money from Acme Inc with reference ${numA}` },
    { dir: "CREDIT", kind: "DEPOSIT", at: at(5), value: 250, cur: "USD", ref: "TRANSFER-9002", running: 1250, sender: "Globex", payref: "", desc: "Received money from Globex with reference " },
    { dir: "CREDIT", kind: "DEPOSIT", at: at(4), value: 67.84, cur: "USD", ref: "TRANSFER-9003", running: 1317.84, sender: "OASIS AI", payref: "5552097", desc: "Received money from OASIS AI with reference 5552097" },
    { dir: "DEBIT", kind: "CARD", at: at(3), value: -28.25, cur: "USD", ref: "CARD-5001", running: 1289.59, merchant: "OpenAI", desc: "Card transaction of 28.25 USD issued by OpenAI" },
    { dir: "CREDIT", kind: "CONVERSION", at: at(2), value: 262.79, cur: "USD", ref: "BALANCE-7001", running: 1552.38, desc: "Converted 370.00 CAD to 262.79 USD" },
  ];
  const cadTx: Tx[] = [
    { dir: "CREDIT", kind: "DEPOSIT", at: at(7), value: 1159.47, cur: "CAD", ref: "TRANSFER-8001", running: 1659.47, sender: "CONAUGH MCKENNA", payref: "", desc: "Received money from CONAUGH MCKENNA with reference " },
    { dir: "DEBIT", kind: "CONVERSION", at: at(2), value: -370, fee: 1.69, cur: "CAD", ref: "BALANCE-7001", running: 1289.47, desc: "Converted 370.00 CAD to 262.79 USD" },
  ];
  fixtures.statements.CAD = statementOf("CAD", cadTx, 500, [cadDetails]);
  fixtures.statements.USD = statementOf("USD", usdTx, 0, [usdDetails]);

  await check("configured: status, and the PDF of a USD Wise invoice prints the USD details (not the CAD ones) with its number", async () => {
    const st = await wiseIo.wiseStatus();
    assert.equal(st.ready, true);
    assert.equal(st.profileName, "OASISAI");
    assert.deepEqual(st.details.CAD!.fields.map((f) => f.label), ["Institution number", "Transit number", "Account number", "Swift/BIC"]);
    const draft = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Initech", email: "ap@initech.test" }, currency: "USD", lines: [{ description: "x", quantity: 1, unit_price: "40" }] });
    const text = await pdfText((await invoices.invoicePdfBytes(cc, draft)).bytes);
    assert.match(text, /Routing number \(ACH or ABA\)\s+026073150/);
    assert.doesNotMatch(text, /Transit number/);
    assert.match(text, /Payment reference\s+the invoice number \(assigned when issued\)/, "a draft has no number yet and says so");
  });

  await check("reconcile: exact matches recorded once, fuzzy ones only listed; dry run writes nothing", async () => {
    const payments = () => count(`SELECT COUNT(*) FROM fin_payments WHERE entity_id = ?`, [B]);
    const before = await payments();
    const dry = await reconcile.reconcileWise(cc, { days: 30, dryRun: true });
    assert.equal(dry.dry_run, true);
    assert.deepEqual(dry.exact.map((m) => [m.invoice_number, m.payment_id]), [[numA, null]]);
    assert.equal(await payments(), before, "a dry run records nothing");
    const run = await reconcile.reconcileWise(cc, { days: 30, dryRun: false });
    assert.equal(run.recorded, 1);
    assert.ok(run.needs_confirmation.some((m) => m.deposit.wise_ref === "TRANSFER-9002" && m.invoice_number === numB), "the unreferenced 250 is a suggestion for B");
    assert.equal((await store.loadInvoice(invA))!.status, "paid");
    assert.equal((await store.loadInvoice(invB))!.status, "sent", "the fuzzy match was NOT recorded");
    assert.equal(await payments(), before + 1);
    const again = await reconcile.reconcileWise(cc, { days: 30, dryRun: false });
    assert.equal(again.recorded, 0);
    assert.ok(again.already_recorded >= 1);
    assert.equal(await payments(), before + 1, "idempotent on Wise's transaction reference");
    const viaRoute = (await (await internal(reconcileRoute, {})).json()) as { result: { dry_run: boolean } };
    assert.equal(viaRoute.result.dry_run, true, "Atlas's route is a dry run unless it says otherwise");
  });

  await check("confirming a fuzzy match re-reads the deposit from Wise and records it", async () => {
    const r = await reconcile.confirmWiseMatch(cc, { wise_ref: "TRANSFER-9002", invoice_id: invB });
    assert.equal(r.full, true);
    assert.equal((await store.loadInvoice(invB))!.status, "paid");
    await assert.rejects(reconcile.confirmWiseMatch(cc, { wise_ref: "TRANSFER-9002", invoice_id: invB }), access.FinanceInputError, "twice is refused");
  });

  process.env.STRIPE_SECRET_KEY = "rk_test_wise_feed";
  await raw.execute({ sql: `UPDATE fin_settings SET stripe_account_id = 'acct_test_oasis' WHERE entity_id = ?`, args: [B] });
  fixtures.payouts = [{ id: "po_test_1", object: "payout", amount: 6784, currency: "usd", status: "paid", arrival_date: Math.floor(Date.parse(`${addDays(today, -4)}T00:00:00Z`) / 1000) }];
  const since = addDays(today, -20);
  const txnRows = () => count(`SELECT COUNT(*) FROM fin_bank_transactions WHERE entity_id = ? AND account_id = ?`, [B, chequing]);
  const imports = () => count(`SELECT COUNT(*) FROM fin_imports WHERE entity_id = ?`, [B]);

  await check("feed dry run: counts everything, writes nothing", async () => {
    const r = await feedIo.syncWiseFeed(cc, { since }, { dryRun: true });
    assert.equal(r.dry_run, true);
    const usd = r.currencies.find((c) => c.currency === "USD")!;
    assert.equal(usd.rows, 5);
    assert.equal(usd.new_rows, 5);
    assert.equal(usd.stripe_payouts, 1);
    assert.equal(usd.invoice_payments, 2, "the two deposits reconcile already recorded");
    assert.equal(await txnRows(), 0);
    assert.equal(await imports(), 0);
  });

  await check("feed: Wise activity lands on Business chequing through the import; a Stripe payout becomes a transfer from clearing at the stored own-day rate", async () => {
    const r = await feedIo.syncWiseFeed(cc, { since }, { dryRun: false });
    const usd = r.currencies.find((c) => c.currency === "USD")!;
    const cad = r.currencies.find((c) => c.currency === "CAD")!;
    assert.equal(usd.inserted, 5);
    assert.equal(cad.inserted, 2);
    assert.equal(usd.posted, 1, "only the payout matched a rule");
    assert.equal(usd.invoice_payments, 2);
    assert.equal(await txnRows(), 7);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_bank_transactions WHERE fitid LIKE '%-BALANCE-7001'`), 2, "both legs of the conversion");
    const payout = (await raw.execute({ sql: `SELECT * FROM fin_bank_transactions WHERE fitid = 'WISE-USD-CREDIT-TRANSFER-9003'`, args: [] })).rows[0];
    assert.equal(payout.status, "posted");
    assert.match(String(payout.description), /Stripe payout po_test_1/);
    assert.equal(payout.source, "import");
    const lines = (await raw.execute({ sql: `SELECT account_id, currency, debit_cents, credit_cents, cad_debit_cents, cad_credit_cents FROM fin_journal_lines WHERE entry_id = ? ORDER BY line_no`, args: [String(payout.entry_id)] })).rows;
    const cadValue = usdToCadCents(6784, parseRateMicro("1.3700"));
    assert.deepEqual(
      lines.map((l) => [l.account_id, l.currency, Number(l.debit_cents), Number(l.credit_cents), Number(l.cad_debit_cents), Number(l.cad_credit_cents)]),
      [
        [chequing, "USD", 6784, 0, cadValue, 0],
        [accountId(B, SYS.stripeClearing), "USD", 0, 6784, 0, cadValue],
      ],
    );
    for (const ref of ["TRANSFER-9001", "TRANSFER-9002"]) {
      const row = (await raw.execute({ sql: `SELECT status, memo, entry_id FROM fin_bank_transactions WHERE fitid = ?`, args: [`WISE-USD-CREDIT-${ref}`] })).rows[0];
      assert.equal(row.status, "excluded", `${ref} was recorded against its invoice already`);
      assert.match(String(row.memo), /invoice payment/);
      assert.equal(row.entry_id, null);
    }
    assert.equal((await raw.execute({ sql: `SELECT status FROM fin_bank_transactions WHERE fitid = 'WISE-USD-DEBIT-CARD-5001'`, args: [] })).rows[0].status, "unreviewed");
  });

  await check("feed: re-syncing the same activity is a no-op — no rows, no import record", async () => {
    const [rows, imps] = [await txnRows(), await imports()];
    const r = await feedIo.syncWiseFeed(cc, { since }, { dryRun: false });
    assert.deepEqual(r.currencies.map((c) => [c.currency, c.new_rows, c.inserted]), [["CAD", 0, 0], ["USD", 0, 0]]);
    assert.equal(await txnRows(), rows);
    assert.equal(await imports(), imps);
    const viaRoute = (await (await internal(syncRoute, { since })).json()) as { ok: boolean; result: { dry_run: boolean } };
    assert.equal(viaRoute.ok, true);
    assert.equal(viaRoute.result.dry_run, true, "Atlas's route is a dry run unless it says otherwise");
  });

  await check("one deposit, two writers: a fed line is set aside when reconcile records the same deposit", async () => {
    const invC = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Umbrella", email: "ap@umbrella.test" }, issue_date: addDays(today, -3), currency: "USD", lines: [{ description: "Retainer", quantity: 1, unit_price: "400.00" }] });
    const numC = (await invoices.finalizeInvoice(cc, invC)).number as string;
    usdTx.push({ dir: "CREDIT", kind: "DEPOSIT", at: at(1), value: 400, cur: "USD", ref: "TRANSFER-9004", running: 1952.38, sender: "Umbrella", payref: numC, desc: `Received money from Umbrella with reference ${numC}` });
    fixtures.statements.USD = statementOf("USD", usdTx, 0, [usdDetails]);
    await feedIo.syncWiseFeed(cc, { since }, { dryRun: false });
    const fitid = "WISE-USD-CREDIT-TRANSFER-9004";
    assert.equal((await raw.execute({ sql: `SELECT status FROM fin_bank_transactions WHERE fitid = ?`, args: [fitid] })).rows[0].status, "unreviewed");
    const beforeUsd = await nativeBalance("USD");
    const run = await reconcile.reconcileWise(cc, { days: 30, dryRun: false });
    assert.equal(run.recorded, 1);
    assert.equal((await raw.execute({ sql: `SELECT status FROM fin_bank_transactions WHERE fitid = ?`, args: [fitid] })).rows[0].status, "excluded");
    assert.equal(await nativeBalance("USD"), beforeUsd + 40000, "the money is in the books once");
  });

  await check("opening balance: preview only, then an explicit post makes chequing equal Wise on that day, per currency", async () => {
    const day = addDays(today, -1);
    await assert.rejects(feedIo.postWiseOpeningBalance(cc, { date: addDays(today, 2) }, { dryRun: true }), /future/);
    const entries = () => count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'opening_balance'`);
    const preview = await feedIo.postWiseOpeningBalance(cc, { date: day }, { dryRun: true });
    assert.equal(await entries(), 0, "a preview posts nothing");
    const usd = preview.lines.find((l) => l.currency === "USD")!;
    const cad = preview.lines.find((l) => l.currency === "CAD")!;
    assert.equal(usd.wise_cents, 195238, "running balance after the day's last row");
    assert.equal(cad.wise_cents, 128947);
    assert.equal(usd.books_cents, await nativeBalance("USD", day));
    assert.equal(usd.difference_cents, usd.wise_cents - usd.books_cents);
    const posted = await feedIo.postWiseOpeningBalance(cc, { date: day }, { dryRun: false });
    assert.equal(posted.lines.filter((l) => l.entry_id).length, preview.lines.filter((l) => l.difference_cents !== 0).length);
    assert.equal(await nativeBalance("USD", day), 195238);
    assert.equal(await nativeBalance("CAD", day), 128947);
    const usdEntry = posted.lines.find((l) => l.currency === "USD")!.entry_id!;
    const usdLine = (await raw.execute({ sql: `SELECT debit_cents, credit_cents, cad_debit_cents, cad_credit_cents FROM fin_journal_lines WHERE entry_id = ? AND account_id = ?`, args: [usdEntry, chequing] })).rows[0];
    const moved = Number(usdLine.debit_cents) - Number(usdLine.credit_cents);
    assert.equal(Number(usdLine.cad_debit_cents) - Number(usdLine.cad_credit_cents), Math.sign(moved) * usdToCadCents(Math.abs(moved), parseRateMicro("1.3700")), "USD at the stored rate for the day");
    const again = await feedIo.postWiseOpeningBalance(cc, { date: day }, { dryRun: false });
    assert.deepEqual(again.lines.map((l) => [l.difference_cents, l.entry_id]), [[0, null], [0, null]], "already matching: nothing more to post");
    assert.equal(await entries(), posted.lines.filter((l) => l.entry_id).length);
  });

  await check("books still balance after everything", async () => {
    const tb = (await reportsIo.runReport(cc, "oasis", "trial", { to: "2099-12-31" })).data as { balanced: boolean };
    assert.equal(tb.balanced, true);
    const bs = (await reportsIo.runReport(cc, "oasis", "balance", { to: "2099-12-31" })).data as { balanced: boolean };
    assert.equal(bs.balanced, true);
    assert.equal(await count(`SELECT COUNT(*) FROM (SELECT entry_id, SUM(cad_debit_cents) d, SUM(cad_credit_cents) c FROM fin_journal_lines GROUP BY entry_id HAVING d <> c)`), 0);
    const fx = accountId(B, SYS.fxClearing);
    assert.equal(await count(`SELECT COALESCE(SUM(cad_debit_cents - cad_credit_cents), 0) FROM fin_journal_lines WHERE account_id = ?`, [fx]), 0, "USD receipts held at Wise leave nothing in FX clearing");
    assert.equal(await count(`SELECT COALESCE(SUM(debit_cents - credit_cents), 0) FROM fin_journal_lines WHERE account_id = ? AND currency = 'USD'`, [fx]), 0);
    assert.ok(await count(`SELECT COUNT(*) FROM fin_journal_lines WHERE account_id = ? AND memo = 'Realised FX gain'`, [accountId(B, SYS.fxGainLoss)]) > 0, "paid at 1.37 on a 1.36 invoice: the gain is realised");
    assert.ok(calls.every((c) => !c.includes("/transfers") && !c.includes("/quotes")), "nothing ever asked Wise to move money");
  });

  if (failures > 0) {
    console.log(`finances-wise: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("finances-wise: all passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
