/**
 * tests/finances-core.test.ts — the pure rules of FOUNDERS > Finances.
 *
 * Every rule that decides money lives in a pure module under
 * lib/founders-finances/ so it can be executed here with no database, no
 * session and no network. The I/O layer is exercised separately against a
 * real local libSQL database in tests/finances-io.test.ts.
 *
 * Run: node --conditions=react-server --import tsx tests/finances-core.test.ts
 */

import assert from "node:assert/strict";

import { parseMoneyToCents, formatCents, divRoundHalfAwayFromZero } from "../lib/founders-finances/money";
import {
  assertBalanced,
  prepareJournalLines,
  LedgerError,
  allocateProportionally,
  crossCurrencySettlementLines,
  reversalLines,
} from "../lib/founders-finances/ledger";
import {
  computeSalesTax,
  taxAtPpm,
  smallSupplierStatus,
  trailingFourQuarters,
  quarterOf,
  validateRegistration,
  gstQstPeriodReport,
} from "../lib/founders-finances/tax";
import {
  parseValetObservations,
  rateForDate,
  parseRateMicro,
  usdToCadCents,
  cadToUsdCents,
  torontoDateOf,
  isoDateRange,
} from "../lib/founders-finances/fx";
import { verifyStripeSignature, computeStripeSignature } from "../lib/founders-finances/stripe-signature";
import { parseStatement, dedupeHashes, parseCsv, mapCsvRows, parseBankDate } from "../lib/founders-finances/import-parse";
import {
  computeInvoiceTotals,
  formatInvoiceNumber,
  allocateInvoiceNumber,
  effectiveInvoiceStatus,
  canTransition,
  lineAmountCents,
} from "../lib/founders-finances/invoice";
import { canAccessEntity, ownerKeyForUser, ownerKeyForEmail, isFinanceOwnerEmail } from "../lib/founders-finances/access";
import { monthlyCentsForItem, summarizeMrr } from "../lib/founders-finances/mrr";
import { summarizeCollected, collectedByDay, collectedByCustomer, type CollectedRow } from "../lib/founders-finances/metrics-core";
import { firstMatchingRule, suggestRulePattern, type RuleLike } from "../lib/founders-finances/rules";
import { trialBalance, balanceSheet, profitAndLoss, cashFlow, arAging, toCsv, type ReportAccount, type ReportLine } from "../lib/founders-finances/reports";
import { ownerParity } from "../lib/founders-finances/parity";
import { seedStatements, BUSINESS_CHART, PERSONAL_CHART, SYS, ENTITY_SEEDS } from "../lib/founders-finances/chart";
import { validateTransactionInput, validateBulkTransactions, validateBillInput } from "../lib/founders-finances/validation";
import {
  chargeFacts,
  paymentIntentFacts,
  subscriptionFacts,
  invoicePaidFacts,
  customerLabel,
  balanceTxnFacts,
  stripeInvoiceFacts,
  isSubscriptionInvoice,
  invoiceFromInvoicePayments,
} from "../lib/founders-finances/stripe-map";

let passed = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

// ── money ────────────────────────────────────────────────────────────────
t("money parsing is exact and refuses guesses", () => {
  assert.equal(parseMoneyToCents("1,234.56"), 123456);
  assert.equal(parseMoneyToCents("$19.9"), 1990);
  assert.equal(parseMoneyToCents("(12.30)"), -1230);
  assert.equal(parseMoneyToCents("12.30-"), -1230);
  assert.equal(parseMoneyToCents("-0.01"), -1);
  assert.equal(parseMoneyToCents("CA$ 5"), 500);
  assert.equal(parseMoneyToCents("0.1"), 10);
  assert.equal(parseMoneyToCents("1.234"), null, "three decimals is refused, not rounded");
  assert.equal(parseMoneyToCents("abc"), null);
  assert.equal(parseMoneyToCents(""), null);
  assert.equal(parseMoneyToCents(0.1 + 0.2), 30, "binary float noise on a cent-exact JSON number is tolerated");
  assert.equal(parseMoneyToCents(19.99), 1999);
  assert.equal(parseMoneyToCents(0.001), null, "a number finer than a cent is refused");
  assert.equal(formatCents(123456, "CAD"), "CA$1,234.56");
  assert.equal(formatCents(-5, "USD"), "-US$0.05");
  assert.equal(divRoundHalfAwayFromZero(BigInt(5), BigInt(2)), BigInt(3));
  assert.equal(divRoundHalfAwayFromZero(BigInt(-5), BigInt(2)), BigInt(-3));
});

// ── ledger: the balanced-entry invariant ─────────────────────────────────
t("balanced entries pass; unbalanced, one-sided and zero lines are refused", () => {
  assertBalanced([
    { accountId: "a", currency: "CAD", debitCents: 1000 },
    { accountId: "b", currency: "CAD", creditCents: 600 },
    { accountId: "c", currency: "CAD", creditCents: 400 },
  ]);
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof LedgerError, "throws LedgerError");
      return (e as LedgerError).code;
    }
    assert.fail("expected a LedgerError");
  };
  assert.equal(
    code(() => assertBalanced([
      { accountId: "a", currency: "CAD", debitCents: 1000 },
      { accountId: "b", currency: "CAD", creditCents: 999 },
    ])),
    "unbalanced",
  );
  assert.equal(code(() => assertBalanced([{ accountId: "a", currency: "CAD", debitCents: 1 }])), "too_few_lines");
  assert.equal(
    code(() => assertBalanced([
      { accountId: "a", currency: "CAD", debitCents: 5, creditCents: 5 },
      { accountId: "b", currency: "CAD", creditCents: 0, debitCents: 0 },
    ])),
    "one_sided",
  );
  assert.equal(
    code(() => assertBalanced([
      { accountId: "a", currency: "CAD", debitCents: 1.5 },
      { accountId: "b", currency: "CAD", creditCents: 1.5 },
    ])),
    "invalid_amount",
  );
  // Balanced in total but NOT per currency: 10 CAD against 10 USD is refused.
  assert.equal(
    code(() => assertBalanced([
      { accountId: "a", currency: "CAD", debitCents: 1000 },
      { accountId: "b", currency: "USD", creditCents: 1000 },
    ])),
    "unbalanced",
  );
});

t("USD lines get CAD equivalents that balance to the cent", () => {
  const micro = parseRateMicro("1.3517");
  const lines = prepareJournalLines(
    [
      { accountId: "ar", currency: "USD", debitCents: 1001 },
      { accountId: "rev1", currency: "USD", creditCents: 333 },
      { accountId: "rev2", currency: "USD", creditCents: 334 },
      { accountId: "rev3", currency: "USD", creditCents: 334 },
    ],
    (c) => (c === "USD" ? { rate: "1.3517", micro } : null),
  );
  const d = lines.reduce((a, l) => a + l.cadDebitCents, 0);
  const c = lines.reduce((a, l) => a + l.cadCreditCents, 0);
  assert.equal(d, c, "CAD equivalents balance");
  assert.equal(d, usdToCadCents(1001, micro));
  assert.ok(lines.every((l) => l.fxRate === "1.3517"));
  assert.throws(
    () => prepareJournalLines([
      { accountId: "a", currency: "USD", debitCents: 1 },
      { accountId: "b", currency: "USD", creditCents: 1 },
    ]),
    (e: unknown) => e instanceof LedgerError && e.code === "fx_rate_missing",
    "no rate, no posting",
  );
  assert.deepEqual(allocateProportionally(100, [1, 1, 1]), [34, 33, 33]);
});

t("cross-currency settlement legs balance per currency and in CAD", () => {
  const legs = crossCurrencySettlementLines({
    foreignCurrency: "USD",
    foreignCents: 10000,
    arAccountId: "ar",
    fxClearingAccountId: "fx",
    depositAccountId: "stripe",
    fxGainLossAccountId: "gl",
    receivedCadCents: 13600,
    arCadCarryingCents: 13500,
    memo: "m",
  });
  const all = [...legs.foreignLeg, ...legs.cadLeg];
  const carrying = parseRateMicro("1.35");
  const prepared = prepareJournalLines(all, (c) => (c === "USD" ? { rate: "1.35", micro: carrying } : null));
  assert.ok(prepared.length === 5);
  const gain = legs.cadLeg.find((l) => l.accountId === "gl");
  assert.equal(gain?.creditCents, 100, "CA$1.00 realised gain");
  const rev = reversalLines(all);
  assertBalanced(rev);
});

// ── GST/QST ─────────────────────────────────────────────────────────────
t("unregistered means no tax at all", () => {
  assert.deepEqual(computeSalesTax(100000, false), { gstCents: 0, qstCents: 0, taxCents: 0 });
});
t("GST 5% and QST 9.975% both on the pre-tax amount, rounded half away from zero", () => {
  assert.deepEqual(computeSalesTax(10000, true), { gstCents: 500, qstCents: 998, taxCents: 1498 });
  // 9.975% of 1.00 = 9.975 cents -> 10; 5% of 1.01 = 5.05 -> 5
  assert.equal(taxAtPpm(100, 99_750), 10);
  assert.equal(taxAtPpm(101, 50_000), 5);
  // 9.975% of 2.00 = 19.95 -> 20 (half up); of 0.20 = 1.995 -> 2
  assert.equal(taxAtPpm(200, 99_750), 20);
  assert.equal(taxAtPpm(20, 99_750), 2);
  // non-compounding: QST is NOT charged on GST
  const t2 = computeSalesTax(123456, true);
  assert.equal(t2.gstCents, 6173);
  assert.equal(t2.qstCents, 12315);
  assert.equal(validateRegistration({ registered: true, gstNumber: "123456789 RT 0001", qstNumber: "1234567890TQ0001" }).ok, true);
  assert.equal(validateRegistration({ registered: true, gstNumber: "", qstNumber: "1234567890TQ0001" }).ok, false);
  assert.equal(validateRegistration({ registered: false, gstNumber: "", qstNumber: "" }).ok, true);
  const rep = gstQstPeriodReport({ registered: true, gstCollectedCents: 500, qstCollectedCents: 998, gstItcCents: 100, qstItrCents: 200 });
  assert.equal(rep.gstNetCents, 400);
  assert.equal(rep.qstNetCents, 798);
});

t("small-supplier tracker warns at 75% / 90% and flags a single quarter over", () => {
  const qs = (a: number, b: number, c: number, d: number) =>
    [a, b, c, d].map((v, i) => ({ label: `Q${i}`, revenueCents: v }));
  assert.equal(smallSupplierStatus(qs(0, 0, 0, 1_000_000)).level, "ok");
  assert.equal(smallSupplierStatus(qs(500_000, 500_000, 600_000, 650_000)).level, "watch"); // 75%
  assert.equal(smallSupplierStatus(qs(700_000, 700_000, 700_000, 600_000)).level, "warning"); // 90%
  assert.equal(smallSupplierStatus(qs(800_000, 800_000, 800_000, 700_001)).level, "exceeded");
  const single = smallSupplierStatus(qs(0, 0, 0, 3_000_001));
  assert.equal(single.level, "exceeded");
  assert.equal(single.singleQuarterExceeded, "Q3");
  assert.deepEqual(trailingFourQuarters("2026-09-24").map((q) => q.label), ["2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3"]);
  assert.deepEqual(quarterOf("2026-12-31"), { label: "2026-Q4", from: "2026-10-01", to: "2027-01-01" });
});

// ── FX ──────────────────────────────────────────────────────────────────
t("FX: own-day rate, weekend falls back to Friday, stale table reports missing", () => {
  const obs = parseValetObservations({
    observations: [
      { d: "2026-09-18", FXUSDCAD: { v: "1.3800" } }, // Friday
      { d: "2026-09-21", FXUSDCAD: { v: "1.3900" } }, // Monday
      { d: "2026-09-22", FXUSDCAD: { v: "" } }, // unusable -> skipped, not 0
    ],
  });
  assert.equal(obs.length, 2);
  const rates = new Map(obs.map((o) => [o.date, o.rate]));
  assert.deepEqual(rateForDate(rates, "2026-09-21"), { rate: "1.3900", rateDate: "2026-09-21", fallback: false });
  assert.deepEqual(rateForDate(rates, "2026-09-20"), { rate: "1.3800", rateDate: "2026-09-18", fallback: true }, "Sunday uses Friday");
  assert.deepEqual(rateForDate(rates, "2026-09-19"), { rate: "1.3800", rateDate: "2026-09-18", fallback: true }, "Saturday uses Friday");
  assert.equal(rateForDate(rates, "2026-10-15"), null, "beyond the lookback is missing, not borrowed");
  const micro = parseRateMicro("1.3800");
  assert.equal(usdToCadCents(10000, micro), 13800);
  assert.equal(cadToUsdCents(13800, micro), 10000);
  assert.equal(cadToUsdCents(1, micro), 1, "0.72 cent rounds to 1");
  assert.throws(() => parseRateMicro("0"));
  assert.throws(() => parseRateMicro("abc"));
});

t("Toronto day boundaries, not UTC", () => {
  // 2026-02-01T03:30Z is 22:30 on Jan 31 in Toronto (EST, UTC-5).
  assert.equal(torontoDateOf("2026-02-01T03:30:00Z"), "2026-01-31");
  assert.equal(torontoDateOf("2026-02-01T05:30:00Z"), "2026-02-01");
  // Summer: EDT, UTC-4.
  assert.equal(torontoDateOf("2026-07-01T03:59:00Z"), "2026-06-30");
  assert.equal(torontoDateOf("2026-07-01T04:00:00Z"), "2026-07-01");
  assert.deepEqual(isoDateRange("2026-01-30", "2026-02-02"), ["2026-01-30", "2026-01-31", "2026-02-01"]);
});

// ── Stripe signature ────────────────────────────────────────────────────
t("webhook signature: good passes, bad and stale fail", () => {
  const secret = "whsec_test_secret";
  const payload = JSON.stringify({ id: "evt_1", type: "charge.succeeded" });
  const ts = 1_800_000_000;
  const sig = computeStripeSignature(payload, secret, ts);
  assert.deepEqual(verifyStripeSignature({ payload, header: `t=${ts},v1=${sig}`, secret, nowSeconds: ts + 10 }), { ok: true, timestamp: ts });
  // rotation: second v1 matches
  assert.equal(verifyStripeSignature({ payload, header: `t=${ts},v1=${"0".repeat(64)},v1=${sig}`, secret, nowSeconds: ts }).ok, true);
  const bad = verifyStripeSignature({ payload, header: `t=${ts},v1=${"a".repeat(64)}`, secret, nowSeconds: ts });
  assert.deepEqual(bad, { ok: false, reason: "no_matching_signature" });
  const tampered = verifyStripeSignature({ payload: payload + " ", header: `t=${ts},v1=${sig}`, secret, nowSeconds: ts });
  assert.equal(tampered.ok, false, "a changed body fails");
  const stale = verifyStripeSignature({ payload, header: `t=${ts},v1=${sig}`, secret, nowSeconds: ts + 301 });
  assert.deepEqual(stale, { ok: false, reason: "timestamp_outside_tolerance" });
  const future = verifyStripeSignature({ payload, header: `t=${ts},v1=${sig}`, secret, nowSeconds: ts - 301 });
  assert.equal(future.ok, false);
  assert.deepEqual(verifyStripeSignature({ payload, header: `t=${ts},v1=${sig}`, secret: "", nowSeconds: ts }), { ok: false, reason: "missing_secret" });
  assert.deepEqual(verifyStripeSignature({ payload, header: null, secret, nowSeconds: ts }), { ok: false, reason: "missing_header" });
  assert.deepEqual(verifyStripeSignature({ payload, header: "garbage", secret, nowSeconds: ts }), { ok: false, reason: "malformed_header" });
});

// ── import parsing + dedupe ─────────────────────────────────────────────
const CSV = `Date,Description,Amount
2026-09-01,"SHOPIFY* 4417283 MONTREAL QC",-39.00
2026-09-02,Coffee,-4.50
2026-09-02,Coffee,-4.50
2026-09-03,"Client payment, thanks",1500.00
`;
t("CSV parses, keeps genuine duplicates, and re-hashes identically", () => {
  const p = parseStatement("rbc.csv", CSV);
  assert.equal(p.errors.length, 0, p.errors.join("; "));
  assert.equal(p.rows.length, 4, "two identical coffees are two rows");
  assert.equal(p.rows[3].description, "Client payment, thanks");
  assert.equal(p.rows[0].amountCents, -3900);
  const h1 = dedupeHashes(p.rows);
  const h2 = dedupeHashes(parseStatement("rbc.csv", CSV).rows);
  assert.deepEqual(h1, h2, "same file, same hashes");
  assert.equal(new Set(h1).size, 4, "the two coffees hash differently");
  // a wider export that overlaps maps the overlap back onto the same hashes
  const wider = CSV + "2026-09-04,Rent,-2000.00\n";
  const h3 = dedupeHashes(parseStatement("rbc.csv", wider).rows);
  assert.deepEqual(h3.slice(0, 4), h1);
});
t("headerless TD-style CSV and date-order inference", () => {
  const td = "09/01/2026,PAYROLL,,2500.00,9000.00\n09/02/2026,HYDRO QUEBEC,120.55,,8879.45\n";
  const p = mapCsvRows(parseCsv(td));
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].amountCents, 250000);
  assert.equal(p.rows[1].amountCents, -12055);
  assert.equal(p.rows[1].postedDate, "2026-09-02");
  const dmy = mapCsvRows(parseCsv("Date,Description,Amount\n25/09/2026,X,-1.00\n"));
  assert.equal(dmy.rows[0].postedDate, "2026-09-25");
  assert.equal(parseBankDate("2026/09/03", "mdy"), "2026-09-03");
});
const OFX = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260901120000<TRNAMT>-39.00<FITID>A1<NAME>SHOPIFY<MEMO>subscription
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260903<TRNAMT>1500.00<FITID>A2<NAME>CLIENT
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
t("OFX/QFX (SGML, no closing tags) parses with FITID dedupe", () => {
  const p = parseStatement("bank.qfx", OFX);
  assert.equal(p.format, "qfx");
  assert.equal(p.rows.length, 2);
  assert.equal(p.currency, "CAD");
  assert.equal(p.rows[0].fitid, "A1");
  assert.equal(p.rows[0].postedDate, "2026-09-01");
  assert.equal(p.rows[1].amountCents, 150000);
  assert.deepEqual(dedupeHashes(p.rows), dedupeHashes(parseStatement("bank.ofx", OFX).rows));
});

// ── invoices ────────────────────────────────────────────────────────────
t("invoice totals, quantities and numbering", () => {
  const unreg = computeInvoiceTotals(
    [
      { description: "Automation build", quantity: "1", unitPrice: "2500.00" },
      { description: "Support hours", quantity: "1.5", unitPrice: "120.00" },
    ],
    { registered: false },
  );
  assert.equal(unreg.subtotalCents, 268000);
  assert.equal(unreg.gstCents + unreg.qstCents, 0, "no tax while unregistered");
  assert.equal(unreg.totalCents, 268000);
  const reg = computeInvoiceTotals([{ description: "Build", quantity: "1", unitPrice: "1000.00" }], { registered: true });
  assert.equal(reg.gstCents, 5000);
  assert.equal(reg.qstCents, 9975);
  assert.equal(reg.totalCents, 114975);
  assert.equal(lineAmountCents(333, 100), 33, "0.333 x 1.00 = 0.333 -> 0.33");
  assert.throws(() => computeInvoiceTotals([], { registered: false }));
  assert.throws(() => computeInvoiceTotals([{ description: "x", quantity: "0", unitPrice: "1" }], { registered: false }));
  assert.equal(formatInvoiceNumber("oasis", 2026, 1), "OASIS-2026-0001");
  assert.equal(formatInvoiceNumber("OASIS", 2026, 12345), "OASIS-2026-12345");
  assert.deepEqual(allocateInvoiceNumber({ prefix: "OASIS", nextNumber: 7, numberYear: 2026 }, 2026), {
    number: "OASIS-2026-0007",
    nextNumber: 8,
    numberYear: 2026,
  });
  assert.equal(allocateInvoiceNumber({ prefix: "OASIS", nextNumber: 42, numberYear: 2026 }, 2027).number, "OASIS-2027-0001", "resets on a new year");
  assert.equal(effectiveInvoiceStatus({ status: "sent", dueDate: "2026-09-01", totalCents: 100, amountPaidCents: 0 }, "2026-09-24"), "overdue");
  assert.equal(effectiveInvoiceStatus({ status: "sent", dueDate: "2026-09-30", totalCents: 100, amountPaidCents: 0 }, "2026-09-24"), "sent");
  assert.equal(effectiveInvoiceStatus({ status: "overdue", dueDate: "2026-09-01", totalCents: 100, amountPaidCents: 100 }, "2026-09-24"), "paid");
  assert.equal(effectiveInvoiceStatus({ status: "draft", dueDate: "2026-09-01", totalCents: 100, amountPaidCents: 0 }, "2026-09-24"), "draft");
  assert.equal(canTransition("draft", "sent"), true);
  assert.equal(canTransition("paid", "void"), false, "a paid invoice is refunded, not voided");
  assert.equal(canTransition("void", "sent"), false);
});

// ── privacy ─────────────────────────────────────────────────────────────
t("personal books: owner only; machines never", () => {
  const cc = { kind: "founder" as const, ownerKey: "cc" as const, email: "conaugh@oasisai.work", userId: "u-cc" };
  const adon = { kind: "founder" as const, ownerKey: "adon" as const, email: "adon@oasisai.work", userId: "u-adon" };
  const atlas = { kind: "agent" as const, name: "atlas" as const };
  const business = { kind: "business" as const, owner_key: null };
  const ccBook = { kind: "personal" as const, owner_key: "cc" };
  const adonBook = { kind: "personal" as const, owner_key: "adon" };
  assert.equal(canAccessEntity(business, cc), true);
  assert.equal(canAccessEntity(business, adon), true);
  assert.equal(canAccessEntity(business, atlas), true);
  assert.equal(canAccessEntity(ccBook, cc), true);
  assert.equal(canAccessEntity(ccBook, adon), false, "Adon cannot see CC's personal book");
  assert.equal(canAccessEntity(adonBook, cc), false, "CC cannot see Adon's personal book");
  assert.equal(canAccessEntity(adonBook, adon), true);
  assert.equal(canAccessEntity(ccBook, atlas), false, "Atlas never reads a personal book");
  assert.equal(canAccessEntity(business, null), false);
  assert.equal(canAccessEntity({ kind: "business", owner_key: "cc" }, adon), false, "a malformed business row fails closed");
  const rows = [
    { email: "conaugh@oasisai.work", auth_user_id: "u-cc" },
    { email: "adon@oasisai.work", auth_user_id: "u-adon" },
    { email: "schneur@oasisai.work", auth_user_id: "u-mkt" },
  ];
  assert.equal(ownerKeyForUser("u-cc", rows), "cc");
  assert.equal(ownerKeyForUser("u-adon", rows), "adon");
  assert.equal(ownerKeyForUser("u-mkt", rows), null, "the marketing hire is a founder-portal user but not a finance owner");
  assert.equal(ownerKeyForUser("", rows), null);
  assert.equal(ownerKeyForUser("u-x", [{ email: "conaugh@oasisai.work", auth_user_id: "u-x" }, { email: "adon@oasisai.work", auth_user_id: "u-x" }]), null, "ambiguous id resolves to nobody");
  assert.equal(ownerKeyForEmail(" Conaugh@OASISAI.work "), "cc");
  assert.equal(isFinanceOwnerEmail("schneur@oasisai.work"), false);
});

// ── MRR ─────────────────────────────────────────────────────────────────
t("MRR normalises intervals and quantities", () => {
  assert.equal(monthlyCentsForItem({ unitAmountCents: 120000, quantity: 1, interval: "year", intervalCount: 1 }), 10000);
  assert.equal(monthlyCentsForItem({ unitAmountCents: 10000, quantity: 1, interval: "week", intervalCount: 1 }), 43333);
  assert.equal(monthlyCentsForItem({ unitAmountCents: 100, quantity: 1, interval: "day", intervalCount: 1 }), 3042);
  assert.equal(monthlyCentsForItem({ unitAmountCents: 30000, quantity: 3, interval: "month", intervalCount: 3 }), 30000);
  assert.equal(monthlyCentsForItem({ unitAmountCents: 50000, quantity: 2, interval: "month", intervalCount: 1 }), 100000);
  const sum = summarizeMrr(
    [
      { status: "active", currency: "USD", monthlyCents: 100000 },
      { status: "trialing", currency: "USD", monthlyCents: 50000 },
      { status: "past_due", currency: "USD", monthlyCents: 25000 },
      { status: "canceled", currency: "USD", monthlyCents: 99999 },
      { status: "incomplete", currency: "USD", monthlyCents: 99999 },
    ],
    null,
  );
  assert.deepEqual(sum, { mrr_cents: 175000, currency: "USD", active_subscriptions: 3, unconverted: [] });
  const mixed = summarizeMrr(
    [
      { status: "active", currency: "USD", monthlyCents: 10000 },
      { status: "active", currency: "CAD", monthlyCents: 10000 },
    ],
    parseRateMicro("1.40"),
  );
  assert.deepEqual(mixed, { mrr_cents: 24000, currency: "CAD", active_subscriptions: 2, unconverted: [] });
});

// ── collected: one definition, three views ──────────────────────────────
t("collected total, per-day (zero-filled) and per-customer agree; refunds net", () => {
  const rates = new Map([["2026-09-18", "1.4000"], ["2026-09-21", "1.3500"]]);
  const lookup = (d: string) => {
    const hit = rateForDate(rates, d);
    return hit ? parseRateMicro(hit.rate) : null;
  };
  const row = (p: Partial<CollectedRow>): CollectedRow => ({
    kind: "payment",
    occurredOn: "2026-09-21",
    amountCents: 10000,
    currency: "CAD",
    settlementCadCents: null,
    customerKey: "k",
    customerLabel: "Acme",
    livemode: true,
    ...p,
  });
  const rows: CollectedRow[] = [
    row({ occurredOn: "2026-09-18", currency: "USD", amountCents: 10000, settlementCadCents: 13950, customerKey: "c:usd", customerLabel: "US Client" }),
    row({ occurredOn: "2026-09-20", currency: "CAD", amountCents: 14000, customerKey: "c:acme", customerLabel: "Acme" }), // Sunday -> Friday's rate
    row({ occurredOn: "2026-09-21", currency: "CAD", amountCents: 27000, customerKey: "c:acme", customerLabel: "Acme" }),
    row({ occurredOn: "2026-09-21", kind: "refund", currency: "CAD", amountCents: 13500, customerKey: "c:acme", customerLabel: "Acme" }),
    row({ occurredOn: "2026-09-21", currency: "CAD", amountCents: 999999, livemode: false }), // test mode never counts
    row({ occurredOn: "2026-09-22", currency: "CAD", amountCents: 500, customerKey: "unknown", customerLabel: "" }),
  ];
  const total = summarizeCollected(rows, "2026-09-18", "2026-09-23", lookup);
  assert.equal(total.cad_cents, 13950 + 14000 + 27000 - 13500 + 500);
  // USD: 100.00 (own amount) + 140/1.40 + 270/1.35 - 135/1.35 + 5/1.35
  assert.equal(total.usd_cents, 10000 + 10000 + 20000 - 10000 + 370);
  assert.equal(total.payments, 4, "refunds and test-mode rows are not payments");
  assert.deepEqual(total.fx_missing_days, []);
  const byDay = collectedByDay(rows, "2026-09-18", "2026-09-23", lookup);
  assert.deepEqual(byDay.map((d) => d.date), ["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"]);
  assert.equal(byDay[1].cad_cents, 0, "zero-filled Saturday");
  assert.equal(byDay.reduce((a, d) => a + d.cad_cents, 0), total.cad_cents, "sum(byDay) == total (CAD)");
  assert.equal(byDay.reduce((a, d) => a + d.usd_cents, 0), total.usd_cents, "sum(byDay) == total (USD)");
  const byCustomer = collectedByCustomer(rows, "2026-09-18", "2026-09-23", lookup);
  assert.deepEqual(byCustomer.map((c) => c.customer), ["Acme", "US Client", "Unknown customer"]);
  assert.equal(byCustomer[0].usd_cents, 10000 + 20000 - 10000, "refund nets against its customer");
  assert.equal(byCustomer.reduce((a, c) => a + c.usd_cents, 0), total.usd_cents);
  const gap = summarizeCollected([row({ occurredOn: "2026-10-30" })], "2026-10-01", "2026-11-01", lookup);
  assert.deepEqual(gap.fx_missing_days, ["2026-10-30"], "a missing rate is reported, not guessed");
  assert.equal(gap.cad_cents, 10000, "the CAD side needs no rate");
  assert.equal(gap.usd_cents, 0);
});

// ── rules ───────────────────────────────────────────────────────────────
t("rules: priority order, direction, amount range, first match wins", () => {
  const base: Omit<RuleLike, "id" | "pattern" | "priority" | "setCategoryId"> = {
    matchField: "description",
    matchType: "contains",
    direction: "any",
    amountMinCents: null,
    amountMaxCents: null,
    active: true,
    setContactId: null,
  };
  const rules: RuleLike[] = [
    { ...base, id: "r2", pattern: "shopify", priority: 50, setCategoryId: "software" },
    { ...base, id: "r1", pattern: "stripe", priority: 10, direction: "in", setCategoryId: "transfer" },
    { ...base, id: "r3", pattern: "shopify", priority: 5, amountMinCents: 100000, setCategoryId: "big" },
  ];
  assert.equal(firstMatchingRule(rules, { description: "SHOPIFY* 4417 MTL", amountCents: -3900 })?.id, "r2");
  assert.equal(firstMatchingRule(rules, { description: "Shopify annual", amountCents: -120000 })?.id, "r3");
  assert.equal(firstMatchingRule(rules, { description: "STRIPE PAYOUT", amountCents: 50000 })?.id, "r1");
  assert.equal(firstMatchingRule(rules, { description: "STRIPE PAYOUT", amountCents: -50000 }), null, "direction in");
  assert.equal(suggestRulePattern("SHOPIFY* 4417283 MONTREAL QC"), "shopify montreal qc");
  assert.equal(suggestRulePattern("AMZN Mktp CA*2K4LM0 WWW.AMAZON.CA"), "amzn mktp ca");
});

// ── reports ─────────────────────────────────────────────────────────────
t("statements tie out: TB balances, BS balances, P&L and cash flow agree", () => {
  const acc = (id: string, code: string, type: ReportAccount["type"], subtype: string): ReportAccount => ({ id, code, name: id, type, subtype });
  const accounts = [
    acc("bank", "1000", "asset", "bank"),
    acc("stripe", "1050", "asset", "clearing"),
    acc("ar", "1100", "asset", "receivable"),
    acc("eq", "3000", "equity", "owner_equity"),
    acc("draw", "3100", "equity", "owner_draw"),
    acc("rev", "4000", "revenue", "revenue"),
    acc("fees", "5000", "expense", "expense"),
    acc("soft", "5100", "expense", "expense"),
  ];
  let n = 0;
  const e = (date: string, legs: Array<[string, number, number]>): ReportLine[] => {
    n += 1;
    return legs.map(([accountId, d, c]) => ({ entryId: `e${n}`, entryDate: date, accountId, cadDebitCents: d, cadCreditCents: c, memo: "", entryMemo: "", source: "t" }));
  };
  const lines = [
    ...e("2026-08-01", [["bank", 100000, 0], ["eq", 0, 100000]]),
    ...e("2026-09-02", [["ar", 50000, 0], ["rev", 0, 50000]]),
    ...e("2026-09-05", [["stripe", 50000, 0], ["ar", 0, 50000]]),
    ...e("2026-09-05", [["fees", 1480, 0], ["stripe", 0, 1480]]),
    ...e("2026-09-07", [["bank", 48520, 0], ["stripe", 0, 48520]]),
    ...e("2026-09-10", [["soft", 3900, 0], ["bank", 0, 3900]]),
    ...e("2026-09-15", [["draw", 20000, 0], ["bank", 0, 20000]]),
  ];
  const tb = trialBalance(accounts, lines, "2026-10-01");
  assert.equal(tb.balanced, true);
  const pl = profitAndLoss(accounts, lines, "2026-09-01", "2026-10-01");
  assert.equal(pl.totalRevenueCents, 50000);
  assert.equal(pl.totalExpenseCents, 5380);
  assert.equal(pl.netIncomeCents, 44620);
  const bs = balanceSheet(accounts, lines, "2026-10-01");
  assert.equal(bs.balanced, true);
  assert.equal(bs.currentEarningsCents, 44620);
  const cf = cashFlow(accounts, lines, "2026-09-01", "2026-10-01");
  assert.equal(cf.openingCashCents, 100000);
  assert.equal(cf.closingCashCents, 100000 + 50000 - 1480 - 3900 - 20000);
  assert.equal(cf.netFinancingCents, -20000, "a draw is financing");
  assert.equal(cf.netOperatingCents, 50000 - 1480 - 3900);
  const aging = arAging(
    [
      { id: "i1", number: "N1", contactName: "A", dueDate: "2026-09-30", balanceCents: 100, currency: "CAD" },
      { id: "i2", number: "N2", contactName: "B", dueDate: "2026-08-01", balanceCents: 200, currency: "CAD" },
      { id: "i3", number: "N3", contactName: "C", dueDate: "2026-05-01", balanceCents: 300, currency: "USD" },
    ],
    "2026-09-24",
  );
  assert.equal(aging.totals.CAD.current, 100);
  assert.equal(aging.totals.CAD["31-60"], 200);
  assert.equal(aging.totals.USD["90+"], 300);
  assert.equal(toCsv([["a,b", '"q"', "=HYPERLINK()", -5, "-12.50"]]), `"a,b","""q""",'=HYPERLINK(),-5,-12.50`);
});

t("owner parity is draws minus contributions, CAD", () => {
  const p = ownerParity([
    { ownerKey: "cc", kind: "draw", cadCents: 500000 },
    { ownerKey: "adon", kind: "draw", cadCents: 300000 },
    { ownerKey: "adon", kind: "contribution", cadCents: 50000 },
  ]);
  assert.equal(p.cc.netWithdrawnCents, 500000);
  assert.equal(p.adon.netWithdrawnCents, 250000);
  assert.equal(p.behind, "adon");
  assert.equal(p.equalizingCents, 250000);
});

// ── seed chart ──────────────────────────────────────────────────────────
t("seed charts are complete and unique", () => {
  for (const code of Object.values(SYS)) {
    assert.ok(BUSINESS_CHART.some((a) => a.code === code), `system account ${code} is in the business chart`);
  }
  for (const chart of [BUSINESS_CHART, PERSONAL_CHART]) {
    assert.equal(new Set(chart.map((a) => a.code)).size, chart.length, "codes are unique");
    assert.equal(new Set(chart.map((a) => a.name)).size, chart.length, "names are unique (categories are unique by name)");
  }
  assert.equal(ENTITY_SEEDS.filter((e) => e.kind === "business").length, 1);
  const stmts = seedStatements();
  assert.ok(stmts.every((s) => s.sql.includes("INSERT OR IGNORE")), "seeding is idempotent");
});

// ── validation ──────────────────────────────────────────────────────────
t("transaction validation shared by UI and Atlas", () => {
  const ok = validateTransactionInput({ date: "2026-09-10", description: "Figma", amount: "-15.00", currency: "USD" });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.amountCents, -1500);
  assert.equal(validateTransactionInput({ date: "2026-13-01", description: "x x", amount: 1 }).ok, false);
  assert.equal(validateTransactionInput({ date: "2026-09-10", description: "zero", amount: 0 }).ok, false);
  assert.equal(validateTransactionInput({ date: "2026-09-10", description: "eur", amount: 1, currency: "EUR" }).ok, false);
  const bulk = validateBulkTransactions([
    { date: "2026-09-10", description: "ok row", amount_cents: -100 },
    { date: "bad", description: "x", amount_cents: 5 },
  ]);
  assert.equal(bulk.valid.length, 1);
  assert.equal(bulk.errors[0].index, 1);
  assert.equal(validateBulkTransactions({}).fatal, "transactions must be an array");
  assert.equal(validateBillInput({ kind: "expense", vendor_name: "Figma", bill_date: "2026-09-10", subtotal: "15", category_id: "c" }).ok, false, "expense needs paid-from");
});

// ── stripe object mapping ───────────────────────────────────────────────
t("stripe payloads across API versions", () => {
  const ch = chargeFacts({
    id: "ch_1",
    object: "charge",
    amount: 5000,
    amount_refunded: 0,
    currency: "usd",
    created: 1_790_000_000,
    status: "succeeded",
    paid: true,
    livemode: true,
    payment_intent: "pi_1",
    balance_transaction: "txn_1",
    billing_details: { name: "Jane Doe", email: "jane@example.com" },
    metadata: { fin_invoice_id: "inv-1" },
  });
  assert.ok(ch);
  assert.equal(ch!.currency, "USD");
  assert.equal(ch!.balanceTxn, null, "an unexpanded balance transaction yields no facts");
  assert.equal(ch!.metadata.finInvoiceId, "inv-1");
  const pi = paymentIntentFacts({ id: "pi_1", currency: "cad", created: 1, amount_received: 100, charges: { data: [{ id: "ch_9", amount: 100, currency: "cad", created: 1 }] } });
  assert.equal(pi!.latestChargeId, "ch_9", "legacy charges.data shape");
  const sub = subscriptionFacts({
    id: "sub_1",
    status: "active",
    items: { data: [{ quantity: 2, price: { unit_amount: 1200, currency: "usd", recurring: { interval: "year", interval_count: 1 } } }] },
  });
  assert.equal(sub!.currency, "USD");
  assert.equal(sub!.items[0].quantity, 2);
  const inv = invoicePaidFacts({ id: "in_1", currency: "cad", amount_paid: 100, payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_7" } }] } });
  assert.equal(inv!.paymentIntentId, "pi_7", "2025-03-31 invoice.payments shape");
  assert.equal(customerLabel({ name: "", email: "" }), "Unknown customer");
});

// Live shapes, 2026-09-24 (account API 2025-07-30.basil): a CA$ charge whose
// balance transaction is in USD, no `invoice` key on the charge, and the
// subscription on invoice.parent.subscription_details.
t("stripe: settlement-currency balance transactions and subscription vs one-off invoices", () => {
  const bt = balanceTxnFacts({ id: "txn_1", object: "balance_transaction", amount: 7226, fee: 442, net: 6784, currency: "usd", created: 1_788_646_076, status: "available" });
  assert.deepEqual(bt, { id: "txn_1", amountCents: 7226, feeCents: 442, netCents: 6784, currency: "USD", created: 1_788_646_076 });
  assert.equal(balanceTxnFacts({ id: "txn_2", amount: 1, fee: 0, net: 1, currency: "cad" })!.created, null, "created is optional");

  const basil = chargeFacts({ id: "py_1", amount: 15000, currency: "cad", created: 1, status: "succeeded", paid: true, livemode: true, payment_intent: "pi_1" });
  assert.equal(basil!.chargeId, "py_1", "non-card payments (py_) are charges too");
  assert.equal(basil!.subscriptionInvoice, null, "basil: no invoice key -> unknown, never 'one-off'");
  const legacyNone = chargeFacts({ id: "ch_1", amount: 100, currency: "cad", created: 1, status: "succeeded", invoice: null });
  assert.equal(legacyNone!.subscriptionInvoice, false, "pre-basil invoice: null -> not an invoice payment");
  const legacyId = chargeFacts({ id: "ch_2", amount: 100, currency: "cad", created: 1, status: "succeeded", invoice: "in_2" });
  assert.equal(legacyId!.stripeInvoiceId, "in_2");
  assert.equal(legacyId!.subscriptionInvoice, null, "an invoice id alone does not say subscription");
  const legacyExpanded = chargeFacts({ id: "ch_3", amount: 100, currency: "cad", created: 1, status: "succeeded", invoice: { id: "in_3", subscription: "sub_3", billing_reason: "subscription_cycle" } });
  assert.equal(legacyExpanded!.stripeInvoiceId, "in_3");
  assert.equal(legacyExpanded!.subscriptionInvoice, true);

  const subBasil = stripeInvoiceFacts({ id: "in_4", billing_reason: "subscription_cycle", parent: { type: "subscription_details", subscription_details: { subscription: "sub_4" } } });
  assert.deepEqual(subBasil, { stripeInvoiceId: "in_4", subscriptionId: "sub_4", billingReason: "subscription_cycle", forSubscription: true });
  assert.equal(stripeInvoiceFacts({ id: "in_5", subscription: "sub_5", billing_reason: "manual" })!.forSubscription, true, "names a subscription");
  assert.equal(stripeInvoiceFacts({ id: "in_6", billing_reason: "subscription_create" })!.forSubscription, true, "billing_reason subscription_*");
  assert.equal(stripeInvoiceFacts({ id: "in_7", billing_reason: "manual", parent: null })!.forSubscription, false, "a one-off Stripe invoice");
  assert.equal(stripeInvoiceFacts("in_8"), null, "a bare id yields no facts");
  assert.equal(isSubscriptionInvoice({ subscriptionId: null, billingReason: "quote_accept" }), false);

  const paid = invoicePaidFacts({ id: "in_9", currency: "cad", amount_paid: 10000, billing_reason: "subscription_cycle", parent: { subscription_details: { subscription: "sub_9" } } });
  assert.equal(paid!.subscriptionId, "sub_9");
  assert.equal(paid!.billingReason, "subscription_cycle");
  assert.equal(paid!.forSubscription, true);
  assert.equal(invoicePaidFacts({ id: "in_10", currency: "cad", amount_paid: 10000, billing_reason: "manual" })!.forSubscription, false);

  const found = invoiceFromInvoicePayments({
    object: "list",
    data: [
      { id: "inpay_a", status: "canceled", invoice: { id: "in_old", billing_reason: "manual" } },
      { id: "inpay_b", status: "paid", invoice: { id: "in_11", billing_reason: "subscription_cycle", parent: { subscription_details: { subscription: "sub_11" } } } },
    ],
  });
  assert.equal(found.kind, "invoice");
  assert.equal(found.kind === "invoice" && found.invoice.stripeInvoiceId, "in_11", "the payment that PAID wins over an abandoned attempt");
  assert.deepEqual(invoiceFromInvoicePayments({ object: "list", data: [] }), { kind: "none" }, "no invoice -> a one-off payment");
  assert.deepEqual(invoiceFromInvoicePayments({ object: "list", data: [{ status: "paid", invoice: "in_12" }] }), { kind: "unknown", stripeInvoiceId: "in_12" });
  assert.deepEqual(invoiceFromInvoicePayments(null), { kind: "unknown", stripeInvoiceId: null });
});

console.log(`finances-core: ${passed} groups passed`);
