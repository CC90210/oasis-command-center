/**
 * tests/founders-finances-books-coverage.test.ts — Money is one section, and
 * every Money surface says what the book covers (2026-09-30, T5).
 *
 * WHY. On 2026-09-30 the OASIS book held Stripe revenue from 2026-01-20 but
 * operating expenses from 2026-09-01 only, no bank line, no opening balance
 * and no payout. The P&L, the Balance Sheet, the Accounts page, the month
 * tiles, the CSV export and the GST/QST tracker (a green "No action needed")
 * each presented it as final; "Recent transactions" said "Nothing recorded
 * yet" while September's bills and the 09-05 payment were on the books; and
 * Money was two overviews whose tabs lit no rail row.
 *
 * The REAL pages run against a local libSQL file with the finance migrations
 * and a real signed session (the tests/os-landings.test.ts harness):
 *   - September-only expenses and January revenue: the "Books incomplete"
 *     banner on /money, Accounts, Reports (and the CSV's first line), Taxes
 *     and Transactions; the /money month tiles say "Partial"; the threshold is
 *     "unconfirmed"; chequing says "Bank not connected: balances exclude
 *     deposits"; the September bills and the September payment are listed;
 *   - complete books (opening balance, payout, a bank import and costs from
 *     before the first revenue): no banner anywhere, the tiles are live, the
 *     threshold is a real level;
 *   - /founders/finances redirects to /money (and 404s a non-owner first);
 *     every Finances tab lights the Money row with a "Money › <tab>" crumb;
 *   - Quebec copy: no "GST/HST" on Settings or Taxes, the FPZ-500 line, and a
 *     current-quarter GST/QST prompt; /analytics counts every client stage as
 *     won and labels its stat "MRR (Stripe)";
 *   - recurring costs become bills DUE unless a founder confirmed who pays
 *     them; "Paid by CC personally" credits CC's contribution equity.
 *
 * Run: node --conditions=react-server --import tsx tests/founders-finances-books-coverage.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "books-coverage-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "books-coverage-test-secret-long-enough-0000001";
for (const k of ["OPERATOR_EMAIL", "OPERATOR_EMAIL_FALLBACK_ENABLED", "STRIPE_SECRET_KEY", "STRIPE_FINANCE_WEBHOOK_SECRET", "FINANCE_WISE_FEED_WRITES"]) delete process.env[k];
process.env.ADMIN_EMAILS = "adon@oasisai.work";

globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network disabled in test: ${String(input).slice(0, 80)}`);
}) as typeof fetch;

(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({
    get: (name: string) => (name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined),
    getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
    has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
  useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => "/money",
  useSearchParams: () => new URLSearchParams(),
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) => ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
// recharts ships class components, which react-server does not: a named stand-in (as tests/os-landings.test.ts).
stub(join(ROOT, "components", "founders", "finances", "InOutChart.tsx"), {
  InOutChart: (props: { data?: unknown[] }) => ReactNS.createElement("figure", { "data-chart": "InOutChart", "aria-label": `${(props.data ?? []).length} months` }),
});
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the real module is spread into the stub
const realServer = require("next/server") as Record<string, unknown>;
stub("next/server", { ...realServer, after: () => undefined });

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
process.env.FOUNDERS_TENANT_IDS = OASIS;
const CC_USER = { id: "0f000000-0000-4000-8000-000000000001", email: "conaugh@oasisai.work" };
const REP_USER = { id: "0f000000-0000-4000-8000-000000000004", email: "rep@oasisai.work" };
const cc = { kind: "founder" as const, ownerKey: "cc" as const, email: CC_USER.email, userId: CC_USER.id };

async function login(user: { id: string; email: string } | null): Promise<void> {
  if (!user) {
    sessionCookie = undefined;
    return;
  }
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
}

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

/** Every string and every React element in a returned (unrendered) page tree. */
type Found = { strings: string[]; elements: Array<{ type: unknown; props: Record<string, unknown> }> };
function walk(node: unknown, out: Found = { strings: [], elements: [] }, seen = new Set<unknown>()): Found {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.strings.push(String(node));
    return out;
  }
  if (typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out, seen);
    return out;
  }
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (el.$$typeof && el.props) {
    out.elements.push({ type: el.type, props: el.props });
    walk(el.props, out, seen);
    return out;
  }
  for (const v of Object.values(node as Record<string, unknown>)) walk(v, out, seen);
  return out;
}

/**
 * Render the page's own inner server components (by name: /money's Details and
 * EmptyActivity) so what they draw is in the tree. Everything else stays an
 * element: the banner and the activity table are asserted by their props, and
 * client components ("use client") are never called here.
 */
const EXPAND_NAMES = new Set(["Details", "EmptyActivity"]);
async function expand(node: unknown, depth = 0): Promise<unknown> {
  if (depth > 60 || node === null || node === undefined || typeof node !== "object") return node;
  if (Array.isArray(node)) return Promise.all(node.map((n) => expand(n, depth + 1)));
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (!el.$$typeof || !el.props) return node;
  if (typeof el.type === "function" && EXPAND_NAMES.has((el.type as { name: string }).name)) {
    return expand(await (el.type as (p: unknown) => unknown)(el.props), depth + 1);
  }
  const children = el.props.children === undefined ? undefined : await expand(el.props.children, depth + 1);
  return { ...el, props: { ...el.props, ...(children === undefined ? {} : { children }) } };
}

const code = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

async function main() {
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      primary_agent TEXT, updated_at TEXT, deactivated_at TEXT, invited_by TEXT, joined_at TEXT,
      manager_user_id TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
  `);
  for (const f of ["180_founders_finances.turso.sql", "184_finance_wise_payments.turso.sql", "185_finance_invoice_retainer.turso.sql", "bravo__190_ledger_core.sql", "bravo__193_stripe_payouts.sql"]) {
    await raw.executeMultiple(readFileSync(join(ROOT, "database/turso", f), "utf8"));
  }
  for (let d = 1; d <= 28; d++) {
    for (const m of ["01", "09"]) await raw.execute({ sql: `INSERT INTO fin_fx_rates (pair, rate_date, rate) VALUES ('USDCAD', ?, '1.3800')`, args: [`2026-${m}-${String(d).padStart(2, "0")}`] });
  }
  const stamp = "2026-09-01T00:00:00Z";
  await raw.batch(
    [
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [CC_USER.id, CC_USER.email] },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [REP_USER.id, REP_USER.email] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, agents_enabled, updated_at)
              VALUES ('p-cc', ?, ?, ?, 'owner', 1, ?, '["bravo"]', ?)`,
        args: [CC_USER.id, CC_USER.email, OASIS, stamp, stamp],
      },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, agents_enabled, updated_at)
              VALUES ('p-rep', ?, ?, ?, 'opener', 0, ?, '["bravo"]', ?)`,
        args: [REP_USER.id, REP_USER.email, OASIS, stamp, stamp],
      },
    ],
    "write",
  );

  const { ensureFinanceSeed } = await import("../lib/founders-finances/seed-io");
  await ensureFinanceSeed();
  const { accountId, categoryId, SYS, BUSINESS_ENTITY_ID: B } = await import("../lib/founders-finances/chart");
  const { buildPosting } = await import("../lib/founders-finances/ledger-io");
  const { writeBatch } = await import("../lib/founders-finances/db");
  const bills = await import("../lib/founders-finances/bills-io");
  const coverageMod = await import("../lib/founders-finances/books-coverage");
  const { BooksCoverageBanner } = await import("../components/founders/finances/BooksCoverageBanner");
  const { ActivityTable } = await import("../components/founders/finances/ActivityTable");
  const { KpiTile } = await import("../components/os/KpiTile");
  const MoneyPage = (await import("../app/money/page")).default;
  const OverviewRedirect = (await import("../app/founders/finances/(overview)/page")).default;
  const AccountsPage = (await import("../app/founders/finances/accounts/page")).default;
  const ReportsPage = (await import("../app/founders/finances/reports/page")).default;
  const TaxesPage = (await import("../app/founders/finances/taxes/page")).default;
  const TransactionsPage = (await import("../app/founders/finances/transactions/page")).default;
  const csvRoute = await import("../app/api/founders/finances/reports/route");

  const post = async (date: string, source: string, ref: string, lines: Array<[string, number, number]>) => {
    const p = await buildPosting({
      entityId: B,
      entryDate: date,
      memo: `${source} ${ref}`,
      source,
      sourceRef: ref,
      createdBy: "test",
      lines: lines.map(([code, d, c]) => ({ accountId: accountId(B, code), currency: "CAD", ...(d ? { debitCents: d } : { creditCents: c }) })),
    });
    await writeBatch(p.statements);
    return p.entryId;
  };

  // ── the production shape (2026-09-30): Stripe revenue from January, costs from September only ──
  await post("2026-01-20", "stripe_charge", "ch_jan", [[SYS.stripeClearing, 60000, 0], [SYS.subscriptionRevenue, 0, 60000]]);
  await post("2026-01-20", "stripe_fee", "ch_jan", [[SYS.stripeFees, 2000, 0], [SYS.stripeClearing, 0, 2000]]);
  const septPayEntry = await post("2026-09-05", "stripe_charge", "ch_sep", [[SYS.stripeClearing, 10000, 0], [SYS.subscriptionRevenue, 0, 10000]]);
  await raw.execute({
    sql: `INSERT INTO fin_payments (id, entity_id, kind, source, occurred_at, occurred_on, amount_cents, currency, settlement_cad_cents, livemode, customer_name, stripe_charge_id, entry_id, created_by)
          VALUES ('pay_sep', ?, 'payment', 'stripe', '2026-09-05T19:27:56Z', '2026-09-05', 10000, 'CAD', 10000, 1, 'September Client', 'ch_sep', ?, 'test')`,
    args: [B, septPayEntry],
  });
  const chequing = accountId(B, SYS.chequing);
  await bills.createBill(cc, B, { kind: "expense", vendor_name: "Office rent", bill_date: "2026-09-01", subtotal: "2695.13", currency: "CAD", category_id: categoryId(B, "5650"), paid_from_account_id: chequing });
  await bills.createBill(cc, B, { kind: "expense", vendor_name: "Google Workspace", bill_date: "2026-09-02", subtotal: "30.00", currency: "CAD", category_id: categoryId(B, "5100"), paid_from_account_id: chequing });

  const EXPENSE_GAP = "Operating expenses are recorded from Sep 1, 2026 only; revenue from Jan 20, 2026, so earlier costs are missing";
  const REVENUE_GAP = "Counts Stripe only; bank deposits and off-Stripe revenue are not recorded";
  const banners = (tree: unknown) => walk(tree).elements.filter((e) => e.type === BooksCoverageBanner);
  const assertBanner = (tree: unknown, where: string) => {
    const found = banners(tree);
    assert.equal(found.length, 1, `${where}: one Books-incomplete banner`);
    const cov = found[0].props.coverage as { complete: boolean; gaps: string[] };
    assert.equal(cov.complete, false, `${where}: incomplete`);
    assert.ok(cov.gaps.includes(EXPENSE_GAP), `${where}: ${cov.gaps.join(" | ")}`);
    assert.ok(cov.gaps.includes(REVENUE_GAP), `${where}: ${cov.gaps.join(" | ")}`);
    assert.ok(cov.gaps.some((g) => /Business chequing has no opening balance/.test(g)), `${where}: the cash gap too`);
  };
  const assertNoBanner = async (tree: unknown, where: string) => {
    for (const b of banners(tree)) {
      const rendered = BooksCoverageBanner(b.props as Parameters<typeof BooksCoverageBanner>[0]);
      assert.equal(rendered, null, `${where}: complete books render no banner`);
    }
  };
  const sp = (o: Record<string, string> = {}) => Promise.resolve(o);

  await login(CC_USER);

  // ── pure ──────────────────────────────────────────────────────────────
  await check("booksCoverage: January revenue and September-only expenses, no bank line, no opening balance, no payout: every gap named", async () => {
    const accounts = [
      { id: "B:1000", code: "1000", name: "Business chequing", type: "asset" as const, subtype: "bank" },
      { id: "B:1050", code: "1050", name: "Stripe clearing", type: "asset" as const, subtype: "clearing" },
      { id: "B:3900", code: "3900", name: "Retained earnings", type: "equity" as const, subtype: "retained_earnings" },
      { id: "B:4010", code: "4010", name: "Subscription revenue", type: "revenue" as const, subtype: "revenue" },
      { id: "B:5000", code: "5000", name: "Stripe fees", type: "expense" as const, subtype: "expense" },
      { id: "B:5650", code: "5650", name: "Rent & occupancy", type: "expense" as const, subtype: "expense" },
    ];
    let n = 0;
    const entry = (date: string, source: string, legs: Array<[string, number, number]>) => {
      n += 1;
      return legs.map(([accountId, d, c]) => ({ entryId: `e${n}`, entryDate: date, accountId, cadDebitCents: d, cadCreditCents: c, memo: "", entryMemo: "", source, status: "posted" }));
    };
    const lines = [
      ...entry("2026-01-20", "stripe_charge", [["B:1050", 60000, 0], ["B:4010", 0, 60000]]),
      ...entry("2026-01-20", "stripe_fee", [["B:5000", 2000, 0], ["B:1050", 0, 2000]]),
      ...entry("2026-09-01", "expense", [["B:5650", 269513, 0], ["B:1000", 0, 269513]]),
    ];
    const base = { accounts, bankLinesByAccount: {}, book: "business" as const, wiseWritesEnabled: false, today: "2026-09-30" };
    const cov = coverageMod.booksCoverage({ ...base, lines });
    assert.equal(cov.complete, false);
    assert.equal(cov.expensesFrom, "2026-09-01", "Stripe fees are not operating expenses");
    assert.equal(cov.revenueFrom, "2026-01-20");
    assert.deepEqual([cov.revenueSources.stripe, cov.revenueSources.other, cov.revenueSources.bankFrom, cov.revenueSources.complete], [true, false, null, false]);
    assert.equal(cov.revenueSources.note, REVENUE_GAP);
    assert.deepEqual(cov.openingBalances, { recorded: [], missing: ["Business chequing"] });
    assert.equal(cov.payoutsRecorded, false);
    assert.deepEqual(cov.gaps, [
      "Business chequing has no opening balance (recording one is not yet possible from the app while bank feed writes are off)",
      "Stripe payouts to the bank are not recorded",
      EXPENSE_GAP,
      REVENUE_GAP,
    ]);
    assert.deepEqual(cov.cash, coverageMod.cashCoverage({ ...base, lines }), "the cash half is cash-coverage, unchanged");
    // Complete: an opening balance, a payout into the bank, costs from before the first revenue, and bank lines imported from before it through this month.
    const janToSep = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
    const whole = coverageMod.booksCoverage({
      ...base,
      lines: [
        ...lines,
        ...entry("2026-01-01", "opening_balance", [["B:1000", 500000, 0], ["B:3900", 0, 500000]]),
        ...entry("2026-01-10", "expense", [["B:5650", 1000, 0], ["B:1000", 0, 1000]]),
        ...entry("2026-01-25", "bank_txn", [["B:1000", 58000, 0], ["B:1050", 0, 58000]]),
      ],
      bankLinesByAccount: { "B:1000": 40 },
      bankLinesFromByAccount: { "B:1000": "2026-01-02" },
      bankLinesToByAccount: { "B:1000": "2026-09-28" },
      bankLineMonthsByAccount: { "B:1000": janToSep },
    });
    assert.deepEqual([whole.complete, whole.gaps, whole.payoutsRecorded, whole.revenueSources.complete], [true, [], true, true]);
    // A bank import that starts after the first revenue still leaves the earlier months unconfirmed.
    const late = coverageMod.booksCoverage({ ...base, lines, bankLinesByAccount: { "B:1000": 2 }, bankLinesFromByAccount: { "B:1000": "2026-09-05" }, bankLinesToByAccount: { "B:1000": "2026-09-20" }, bankLineMonthsByAccount: { "B:1000": ["2026-09"] } });
    assert.ok(late.gaps.includes("Bank deposits are recorded from Sep 5, 2026 only; revenue before then counts Stripe only"), late.gaps.join(" | "));
    assert.equal(late.gaps.filter((g) => /^Bank deposits|^No bank line/.test(g)).length, 1, "it runs through this month: no continuity gap on top");
    // The old name is an alias of the same function.
    const cashAlias = await import("../lib/founders-finances/cash-coverage");
    assert.equal(cashAlias.cashCoverage, coverageMod.cashCoverage);
    assert.equal(cashAlias.incompleteBooksNote, coverageMod.incompleteBooksNote);
  });

  await check("booksCoverage: one old statement import (January only) is a start date, not a bank feed; a month with revenue and no cost is a gap; the threshold stays unconfirmed", async () => {
    const accounts = [
      { id: "B:1000", code: "1000", name: "Business chequing", type: "asset" as const, subtype: "bank" },
      { id: "B:1050", code: "1050", name: "Stripe clearing", type: "asset" as const, subtype: "clearing" },
      { id: "B:3900", code: "3900", name: "Retained earnings", type: "equity" as const, subtype: "retained_earnings" },
      { id: "B:4010", code: "4010", name: "Subscription revenue", type: "revenue" as const, subtype: "revenue" },
      { id: "B:5650", code: "5650", name: "Rent & occupancy", type: "expense" as const, subtype: "expense" },
    ];
    let n = 0;
    const entry = (date: string, source: string, legs: Array<[string, number, number]>) => {
      n += 1;
      return legs.map(([accountId, d, c]) => ({ entryId: `s${n}`, entryDate: date, accountId, cadDebitCents: d, cadCreditCents: c, memo: "", entryMemo: "", source, status: "posted" }));
    };
    // The review's probe: an opening balance and 12 bank lines imported from 2026-01-01, all in January; a January
    // expense; Stripe revenue on 01-20 and 09-05; a payout into the bank. Before the fix: complete, "ok, No action needed".
    const lines = [
      ...entry("2026-01-01", "opening_balance", [["B:1000", 500000, 0], ["B:3900", 0, 500000]]),
      ...entry("2026-01-10", "expense", [["B:5650", 1000, 0], ["B:1000", 0, 1000]]),
      ...entry("2026-01-20", "stripe_charge", [["B:1050", 10000, 0], ["B:4010", 0, 10000]]),
      ...entry("2026-01-25", "bank_txn", [["B:1000", 10000, 0], ["B:1050", 0, 10000]]),
      ...entry("2026-09-05", "stripe_charge", [["B:1050", 10000, 0], ["B:4010", 0, 10000]]),
      ...entry("2026-09-06", "bank_txn", [["B:1000", 10000, 0], ["B:1050", 0, 10000]]),
    ];
    const jan = { bankLinesByAccount: { "B:1000": 12 }, bankLinesFromByAccount: { "B:1000": "2026-01-01" }, bankLinesToByAccount: { "B:1000": "2026-01-31" }, bankLineMonthsByAccount: { "B:1000": ["2026-01"] } };
    const cov = coverageMod.booksCoverage({ accounts, lines, book: "business", wiseWritesEnabled: false, today: "2026-09-30", ...jan });
    const STALE = "Bank deposits into Business chequing are recorded from Jan 1, 2026 to Jan 31, 2026 only; revenue after that counts Stripe only";
    const BARE = "No operating expense is recorded for Sep 2026, a month with revenue, so its costs are missing";
    assert.equal(cov.complete, false);
    assert.equal(cov.revenueSources.complete, false);
    assert.deepEqual(cov.gaps, [BARE, STALE]);
    assert.equal(cov.revenueSources.note, STALE);
    const { smallSupplierStatus } = await import("../lib/founders-finances/tax");
    const threshold = smallSupplierStatus([{ label: "Q3 2026", revenueCents: 20000 }], cov.revenueSources);
    assert.equal(threshold.level, "unconfirmed");
    assert.doesNotMatch(threshold.message, /No action needed/);
    assert.match(threshold.message, /^Bank deposits into Business chequing are recorded from Jan 1, 2026 to Jan 31, 2026 only/);
    // A month skipped in the middle is named; the months around it are fine.
    const holed = coverageMod.booksCoverage({
      accounts,
      lines: [...lines, ...entry("2026-09-01", "expense", [["B:5650", 1000, 0], ["B:1000", 0, 1000]])],
      book: "business",
      wiseWritesEnabled: false,
      today: "2026-09-30",
      ...jan,
      bankLinesToByAccount: { "B:1000": "2026-09-28" },
      bankLineMonthsByAccount: { "B:1000": ["2026-01", "2026-02", "2026-04", "2026-05", "2026-06", "2026-08", "2026-09"] },
    });
    assert.deepEqual(holed.gaps, ["No bank line is imported into Business chequing for Mar 2026 and Jul 2026; revenue in those months counts Stripe only"]);
    // A new month with nothing imported yet is not on the books yet either.
    const everyMonth = { "B:1000": ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"] };
    const nextMonth = coverageMod.booksCoverage({
      accounts,
      lines: [...lines, ...entry("2026-09-01", "expense", [["B:5650", 1000, 0], ["B:1000", 0, 1000]])],
      book: "business",
      wiseWritesEnabled: false,
      today: "2026-10-02",
      ...jan,
      bankLinesToByAccount: { "B:1000": "2026-09-28" },
      bankLineMonthsByAccount: everyMonth,
    });
    assert.deepEqual(nextMonth.gaps, ["Bank deposits into Business chequing are recorded from Jan 1, 2026 to Sep 28, 2026 only; revenue after that counts Stripe only"]);
    // Imports every month through this one, and a cost in every month with revenue: complete, and the threshold a real level.
    const current = coverageMod.booksCoverage({
      accounts,
      lines: [...lines, ...entry("2026-09-01", "expense", [["B:5650", 1000, 0], ["B:1000", 0, 1000]])],
      book: "business",
      wiseWritesEnabled: false,
      today: "2026-09-30",
      ...jan,
      bankLinesToByAccount: { "B:1000": "2026-09-28" },
      bankLineMonthsByAccount: everyMonth,
    });
    assert.deepEqual([current.complete, current.gaps], [true, []]);
    assert.equal(smallSupplierStatus([{ label: "Q3 2026", revenueCents: 20000 }], current.revenueSources).level, "ok");
  });

  await check("bankBalanceExcludesDeposits: chequing below zero only because paid bills post against it with no deposit and no bank line", () => {
    const acct = { id: "B:1000", subtype: "bank" };
    const spend = [{ entryId: "x", entryDate: "2026-09-01", accountId: "B:1000", cadDebitCents: 0, cadCreditCents: 269513, memo: "", entryMemo: "", source: "expense", status: "posted" }];
    assert.equal(coverageMod.bankBalanceExcludesDeposits({ account: acct, balanceCents: -269513, lines: spend, bankLines: 0 }), true);
    const deposit = [...spend, { entryId: "y", entryDate: "2026-09-03", accountId: "B:1000", cadDebitCents: 100, cadCreditCents: 0, memo: "", entryMemo: "", source: "bank_txn", status: "posted" }];
    assert.equal(coverageMod.bankBalanceExcludesDeposits({ account: acct, balanceCents: -269413, lines: deposit, bankLines: 0 }), false, "a recorded deposit: a real negative");
    assert.equal(coverageMod.bankBalanceExcludesDeposits({ account: acct, balanceCents: -269513, lines: spend, bankLines: 3 }), false, "a bank feed: a real negative");
    assert.equal(coverageMod.bankBalanceExcludesDeposits({ account: acct, balanceCents: 5, lines: spend, bankLines: 0 }), false);
  });

  // ── incomplete books: the banner on every Money surface ────────────────
  await check("/money: Books incomplete banner, month tiles 'Partial', threshold unconfirmed, September's bills and payment listed", async () => {
    const tree = await expand(await MoneyPage());
    assertBanner(tree, "/money");
    const tiles = walk(tree).elements.filter((e) => e.type === KpiTile).map((e) => e.props as { label: string; status: string; emptyText?: string; hint?: string });
    for (const label of ["In this month", "Out this month", "Net this month"]) {
      const t = tiles.find((x) => x.label === label);
      assert.deepEqual([t?.status, t?.emptyText], ["no_data", "Partial"], `${label}: ${JSON.stringify(t)}`);
      assert.match(t?.hint ?? "", /^Recorded so far: /);
    }
    const text = walk(tree).strings.join("\n");
    assert.match(text, /Counts Stripe only; bank deposits and off-Stripe revenue are not recorded\. Recorded so far: /, "the threshold card says unconfirmed, with the counted figure");
    assert.doesNotMatch(text, /No action needed/);
    const activity = walk(tree).elements.find((e) => e.type === ActivityTable);
    assert.ok(activity, "Recent activity is drawn");
    const rows = activity!.props.rows as Array<{ kind: string; description: string; date: string }>;
    assert.deepEqual(
      rows.map((r) => [r.kind, r.description, r.date]),
      [
        ["payment", "September Client", "2026-09-05"],
        ["expense", "Google Workspace", "2026-09-02"],
        ["expense", "Office rent", "2026-09-01"],
      ],
    );
    assert.doesNotMatch(text, /Nothing recorded yet/);
    assert.ok(text.includes(coverageMod.BANK_NOT_CONNECTED), "the Accounts card says why chequing is negative");
  });

  await check("Accounts: the banner, and 'Bank not connected: balances exclude deposits' under chequing", async () => {
    const tree = await expand(await AccountsPage({ searchParams: sp() }));
    assertBanner(tree, "Accounts");
    const text = walk(tree).strings.join("\n");
    assert.equal(text.split(coverageMod.BANK_NOT_CONNECTED).length - 1, 1, "once, under chequing only");
    assert.match(text, /The books are incomplete, so these are not balances yet/);
  });

  await check("Reports: the banner and a non-final subtitle; the CSV opens with the gaps as a real '#' comment line", async () => {
    const tree = await expand(await ReportsPage({ searchParams: sp({ kind: "pnl", from: "2026-01-01", to: "2026-10-01" }) }));
    assertBanner(tree, "Reports");
    assert.match(walk(tree).strings.join("\n"), /not final while the books are incomplete/);
    const res = await csvRoute.GET(new Request("http://localhost/api/founders/finances/reports?kind=pnl&from=2026-01-01&to=2026-10-01"));
    assert.equal(res.status, 200);
    const csv = (await res.text()).replace(/^\uFEFF/, "");
    const lines = csv.split("\r\n");
    const first = lines[0];
    // "#" is the line's first character (a quoted cell would start with '"', which no comment-skipping importer skips).
    assert.match(first, /^# Books incomplete: /, first);
    assert.doesNotMatch(first, /[",]/, "no comma or quote: nothing for a CSV reader to split or unquote");
    const noCommas = (g: string) => g.replace(/,/g, "");
    assert.ok(first.includes(noCommas(EXPENSE_GAP)) && first.includes(noCommas(REVENUE_GAP)), first);
    assert.ok(first.includes("Sep 1 2026"), "a date keeps its words");
    assert.match(lines[1], /^OASIS AI Solutions/, "then the statement's own header");
    // A reader that skips '#' lines gets the statement exactly as a complete book's export starts.
    const skipped = lines.filter((l) => !l.startsWith("#"));
    assert.match(skipped[0], /^OASIS AI Solutions/);
    assert.ok(skipped.some((l) => /^Code,Account,Amount \(CAD\)$/.test(l)), "the statement's rows follow unchanged");
  });

  await check("Taxes: the banner, the threshold 'unconfirmed' without a bank feed, Quebec copy, no GST/HST", async () => {
    const tree = await expand(await TaxesPage({ searchParams: sp() }));
    assertBanner(tree, "Taxes");
    const text = walk(tree).strings.join("\n");
    assert.match(text, /^Counts Stripe only; bank deposits and off-Stripe revenue are not recorded\./m);
    assert.match(text, /GST and QST are both filed with Revenu Québec on one combined return \(FPZ-500\)\./);
    assert.doesNotMatch(text, /GST\/HST/);
    const { loadTaxesPage } = await import("../lib/founders-finances/page-context");
    const t = await loadTaxesPage(cc, {});
    assert.equal(t.threshold.level, "unconfirmed");
    assert.equal(t.threshold.revenueComplete, false);
  });

  await check("Transactions: the banner, and All activity lists the September bills and payment though no bank line exists", async () => {
    const tree = await expand(await TransactionsPage({ searchParams: sp() }));
    assertBanner(tree, "Transactions");
    const activity = walk(tree).elements.find((e) => e.type === ActivityTable);
    const rows = activity!.props.rows as Array<{ kind: string; description: string; amount_cents: number }>;
    assert.deepEqual(rows.map((r) => [r.kind, r.description, r.amount_cents]), [
      ["payment", "September Client", 10000],
      ["expense", "Google Workspace", -3000],
      ["expense", "Office rent", -269513],
    ]);
    // Filters apply to the activity too.
    const filtered = walk(await TransactionsPage({ searchParams: sp({ q: "rent" }) })).elements.find((e) => e.type === ActivityTable);
    assert.deepEqual((filtered!.props.rows as Array<{ description: string }>).map((r) => r.description), ["Office rent"]);
  });

  await check("no GST/HST string on Settings or Taxes; the GST number field says GST number", () => {
    for (const f of ["app/founders/finances/settings/page.tsx", "app/founders/finances/taxes/page.tsx"]) assert.doesNotMatch(code(f), /GST\/HST/, f);
    assert.match(code("app/founders/finances/settings/page.tsx"), /\{ name: "gst_number", label: "GST number"/);
  });

  // ── one Money section ─────────────────────────────────────────────────
  await check("/founders/finances redirects to /money for an owner, and 404s a non-owner before any redirect", async () => {
    await assert.rejects(OverviewRedirect(), /NEXT_REDIRECT;\/money$/);
    await login(REP_USER);
    try {
      await assert.rejects(OverviewRedirect(), /NEXT_HTTP_ERROR_FALLBACK;404/);
      await assert.rejects(MoneyPage(), /NEXT_HTTP_ERROR_FALLBACK;404/);
    } finally {
      await login(CC_USER);
    }
  });

  await check("every Finances tab lights the Money row and reads 'Money › <tab>'; the tab labels and match.ts agree", async () => {
    const { longestPrefixMatch, breadcrumbTrail, breadcrumbLabel, PATH_ALIASES } = await import("../lib/os/match");
    const { FINANCE_TABS } = await import("../components/founders/finances/FinanceTabs");
    const rows = [
      { id: "today", href: "/", label: "Today" },
      { id: "content", href: "/founders/marketing", label: "Content" },
      { id: "money", href: "/money", label: "Overview" },
      { id: "analytics", href: "/analytics", label: "Analytics" },
    ];
    assert.equal(FINANCE_TABS[0].href, "/money", "Overview is /money");
    const alias = PATH_ALIASES.find((a) => a.prefix === "/founders/finances")!;
    for (const tab of FINANCE_TABS) {
      const seg = tab.href === "/money" ? "" : tab.href.slice("/founders/finances/".length);
      assert.equal(alias.tabs[seg], tab.label, `match.ts and FinanceTabs agree on ${tab.href}`);
      const path = tab.href === "/money" ? "/founders/finances" : tab.href;
      assert.equal(longestPrefixMatch(path, rows)?.id, "money", `${path} lights Money`);
      assert.deepEqual(breadcrumbTrail(path, rows), ["Money", tab.label], path);
    }
    assert.equal(Object.keys(alias.tabs).length, FINANCE_TABS.length, "no tab only one of them knows");
    assert.deepEqual(breadcrumbTrail("/founders/finances/invoices/inv_1", rows), ["Money", "Invoices"], "an invoice lives under Invoices");
    assert.deepEqual(breadcrumbTrail("/money", rows), ["Money", "Overview"]);
    assert.equal(longestPrefixMatch("/money", rows)?.id, "money");
    // Everything else is unchanged.
    assert.equal(longestPrefixMatch("/founders/marketing/library", rows)?.id, "content");
    assert.equal(longestPrefixMatch("/founders/financesx", rows), null, "a path boundary, not a string prefix");
    assert.deepEqual(breadcrumbTrail("/analytics", rows), ["Analytics"]);
    assert.equal(breadcrumbLabel("/system-health", rows), "System health");
    assert.equal(breadcrumbLabel("/", rows), "Today");
    assert.equal(breadcrumbLabel("/founders/finances/taxes", rows), "Taxes");
    // A viewer whose rail has no Money row (their page is a 404) is never shown the section's name.
    const repRows = rows.filter((r) => r.id !== "money");
    assert.deepEqual(breadcrumbTrail("/founders/finances/taxes", repRows), ["Founders"]);
    assert.deepEqual(breadcrumbTrail("/money", repRows), ["Money"]);
    assert.equal(longestPrefixMatch("/founders/finances/taxes", repRows), null);
    // The header draws the whole trail.
    assert.match(code("components/os/ContentHeader.tsx"), /const trail = breadcrumbTrail\(pathname, entries\);/);
  });

  // ── Quebec prompt, /analytics ─────────────────────────────────────────
  await check("the tax quick action asks for the CURRENT quarter's Quebec GST/QST, never 'GST/HST' or a fixed quarter", async () => {
    const { taxQuarterPrompt, QUICK_ACTIONS, quickActionsFor } = await import("../lib/quick-actions");
    const { torontoToday } = await import("../lib/founders-finances/fx");
    const q3 = taxQuarterPrompt("2026-09-30");
    assert.match(q3, /Q3 2026 \(July 1, 2026 to September 30, 2026\)/);
    assert.match(q3, /FPZ-500/);
    assert.match(q3, /Revenu Québec/);
    assert.doesNotMatch(q3, /GST\/HST|Q2 2026/);
    assert.match(taxQuarterPrompt("2026-10-01"), /Q4 2026 \(October 1, 2026 to December 31, 2026\)/);
    assert.match(taxQuarterPrompt("2027-02-14"), /Q1 2027 \(January 1, 2027 to March 31, 2027\)/);
    const qa = QUICK_ACTIONS.find((q) => q.title === "What's owing on tax?")!;
    assert.equal(qa.prompt, taxQuarterPrompt(torontoToday()), "computed from today's date on every read");
    assert.doesNotMatch(qa.description, /GST\/HST/);
    const copy = quickActionsFor(["atlas"]).find((q) => q.title === "What's owing on tax?")!;
    assert.equal(Object.getOwnPropertyDescriptor(copy, "prompt")?.get, undefined, "pages get plain data, not a getter");
  });

  await check("/analytics: Won counts every client stage (Clients' own list); the stat is 'MRR (Stripe)' with a sync time", async () => {
    const { wonCount, stripeMrrHint } = await import("../app/analytics/mrr-state");
    assert.equal(wonCount({ won: 1, onboarding: 1, in_build: 1, client_review: 1, launched: 2, lost: 3, new: 5 }), 6);
    assert.equal(wonCount({ lost: 3 }), 0);
    const now = Date.parse("2026-09-30T12:00:00Z");
    assert.equal(stripeMrrHint({ lastSyncAt: "2026-09-30T09:00:00Z" }, now, null), "Last synced 3 hours ago");
    assert.equal(stripeMrrHint({ lastSyncAt: null }, now, "$72"), "Never synced · ≈ $72 USD");
    assert.equal(stripeMrrHint(null, now, null), "Stripe sync: couldn't check");
    const page = code("app/analytics/page.tsx");
    assert.match(page, /const won = pipeline \? wonCount\(pipeline\.stages\) : 0;/);
    assert.doesNotMatch(page, /stages\["won"\]/);
    assert.match(page, /label="MRR \(Stripe\)"/);
    assert.match(code("app/analytics/mrr-state.ts"), /import \{ CLIENT_STAGES \} from "@\/components\/os\/landings\/clients-model";/);
    // The in-app agent's mrr_today says when Stripe last synced, like every surface, never a bare boolean alone.
    const tool = code("lib/agent-tools.ts");
    const mrrTool = tool.slice(tool.indexOf("async mrr_today("), tool.indexOf("async today_plan("));
    assert.match(mrrTool, /const sync = m\.stripeSync\.ok \? stripeSyncLine\(m\.stripeSync\.lastSyncAt, Date\.now\(\)\) : null;/);
    assert.match(mrrTool, /stripe_sync: sync\s*\?/);
    assert.match(code("lib/agent-context.ts"), /const syncNote = \(r\.stripe_sync as \{ note\?: string \} \| undefined\)\?\.note;/);
  });

  // ── recurring costs and who paid ──────────────────────────────────────
  await check("a recurring cost with no confirmed paid-from becomes a bill DUE on its date, unpaid; chequing is not touched", async () => {
    const before = Number((await raw.execute({ sql: `SELECT COALESCE(SUM(cad_credit_cents), 0) FROM fin_journal_lines WHERE account_id = ?`, args: [chequing] })).rows[0][0]);
    const item = await bills.createRecurring(cc, B, { name: "Cloudflare", amount: "25.00", currency: "CAD", cadence: "monthly", next_run_on: "2026-09-10", category_id: categoryId(B, "5900") });
    const [row] = (await bills.listRecurring(cc, B)).filter((r) => r.id === item);
    assert.deepEqual([row.paid_from_account_id, row.paid_from_confirmed], [null, false], "no default account");
    const billId = await bills.recordRecurringNow(cc, item);
    const bill = (await raw.execute({ sql: `SELECT kind, status, due_date, paid_from_account_id, source FROM fin_bills WHERE id = ?`, args: [billId] })).rows[0];
    assert.deepEqual([bill.kind, bill.status, bill.due_date, bill.paid_from_account_id, bill.source], ["bill", "open", "2026-09-10", null, "recurring"]);
    const after = Number((await raw.execute({ sql: `SELECT COALESCE(SUM(cad_credit_cents), 0) FROM fin_journal_lines WHERE account_id = ?`, args: [chequing] })).rows[0][0]);
    assert.equal(after, before, "nothing booked as paid from chequing");
    assert.equal(await bills.recordRecurringNow(cc, item).then(async () => Number((await raw.execute({ sql: `SELECT COUNT(*) FROM fin_bills WHERE source = 'recurring' AND source_ref LIKE ?`, args: [`${item}:%`] })).rows[0][0])), 2, "the next due date is its own bill");
    // An existing item whose account was set without a founder's confirmation (the 2026-09 setup script) is not confirmed.
    await raw.execute({ sql: `UPDATE fin_recurring_items SET paid_from_account_id = ? WHERE id = ?`, args: [chequing, item] });
    const [set] = (await bills.listRecurring(cc, B)).filter((r) => r.id === item);
    assert.equal(set.paid_from_confirmed, false, "an account set without a confirmation is not confirmed");
    const third = await bills.recordRecurringNow(cc, item);
    assert.equal((await raw.execute({ sql: `SELECT kind FROM fin_bills WHERE id = ?`, args: [third] })).rows[0].kind, "bill");
    // A bill is paid from the account a founder names, never chequing by default.
    await assert.rejects(bills.payBill(cc, billId, { date: "2026-09-12" }), /choose the account the bill was paid from/);
  });

  await check("Bills & Expenses: 'Mark paid' asks the day the money left ('Paid on', up to today), never books the payment on the day of the click by itself", async () => {
    const BillsPage = (await import("../app/founders/finances/bills/page")).default;
    const { SelectAction } = await import("../components/founders/finances/SelectAction");
    const { torontoToday } = await import("../lib/founders-finances/fx");
    const tree = walk(await BillsPage({ searchParams: sp() }));
    const pay = tree.elements.filter((e) => e.type === SelectAction && e.props.action === "bill.pay").map((e) => e.props);
    assert.ok(pay.length >= 1, "an open bill has a Mark paid control (the recurring bills above are open)");
    for (const p of pay) {
      assert.deepEqual(p.date, { name: "date", label: "Paid on", defaultValue: torontoToday(), max: torontoToday() }, "a date field the founder can set");
      assert.ok(!("date" in (p.payload as Record<string, unknown>)), "the payload carries no fixed date that would override the founder's");
    }
  });

  await check("a confirmed paid-from books the recurring cost as paid from it; 'Paid by CC personally' credits CC's owner equity (3000) and counts as CC's contribution", async () => {
    const item = await bills.createRecurring(cc, B, { name: "ChatGPT", amount: "28.00", currency: "CAD", cadence: "monthly", next_run_on: "2026-09-15", category_id: categoryId(B, "5100"), paid_from_account_id: bills.PAID_BY_OWNER.cc });
    const [row] = (await bills.listRecurring(cc, B)).filter((r) => r.id === item);
    assert.deepEqual([row.paid_from_account_id, row.paid_from_confirmed, row.paid_by_owner], [accountId(B, SYS.equityCc), true, "cc"]);
    const billId = await bills.recordRecurringNow(cc, item);
    const bill = (await raw.execute({ sql: `SELECT kind, status, entry_id FROM fin_bills WHERE id = ?`, args: [billId] })).rows[0];
    assert.deepEqual([bill.kind, bill.status], ["expense", "paid"]);
    const legs = (await raw.execute({ sql: `SELECT account_id, cad_debit_cents, cad_credit_cents FROM fin_journal_lines WHERE entry_id = ? ORDER BY line_no`, args: [String(bill.entry_id)] })).rows;
    assert.deepEqual(
      legs.map((l) => [l.account_id, Number(l.cad_debit_cents), Number(l.cad_credit_cents)]),
      [[accountId(B, "5100"), 2800, 0], [accountId(B, SYS.equityCc), 0, 2800]],
      "Dr software / Cr Owner equity — CC",
    );
    const eq = await bills.equitySummary(cc, B);
    assert.equal(eq.parity.cc.contributionsCents, 2800, "CC's contribution");
    assert.ok(eq.events.some((e) => e.memo === "Paid ChatGPT personally" && e.owner_key === "cc" && e.kind === "contribution"));
    // Adon pays an open bill personally: 3010.
    const open = await bills.createBill(cc, B, { kind: "bill", vendor_name: "Notion", bill_date: "2026-09-20", due_date: "2026-09-30", subtotal: "12.00", currency: "CAD", category_id: categoryId(B, "5100") });
    await bills.payBill(cc, open, { account_id: bills.PAID_BY_OWNER.adon, date: "2026-09-21" });
    const paid = (await raw.execute({ sql: `SELECT status, paid_from_account_id FROM fin_bills WHERE id = ?`, args: [open] })).rows[0];
    assert.deepEqual([paid.status, paid.paid_from_account_id], ["paid", accountId(B, SYS.equityAdon)]);
    assert.equal((await bills.equitySummary(cc, B)).parity.adon.contributionsCents, 1200);
    // Voided: the contribution drops out.
    await bills.voidBill(cc, open);
    assert.equal((await bills.equitySummary(cc, B)).parity.adon.contributionsCents, 0);
    // Anything but a bank, cash or card account, or an owner, is refused as a paid-from.
    await assert.rejects(bills.payBill(cc, await bills.createBill(cc, B, { kind: "bill", vendor_name: "X", bill_date: "2026-09-20", subtotal: "1.00", currency: "CAD", category_id: categoryId(B, "5100") }), { account_id: accountId(B, "4000") }), /paid-from must be/);
    // The confirmation can be changed (and cleared) from Bills & Expenses.
    await bills.confirmRecurringPaidFrom(cc, item, { account_id: "" });
    const [cleared] = (await bills.listRecurring(cc, B)).filter((r) => r.id === item);
    assert.deepEqual([cleared.paid_from_account_id, cleared.paid_from_confirmed], [null, false]);
  });

  await check("materializeDueRecurring (for the recurring-draft job CC has yet to approve): every due date once, unconfirmed ones as bills due, a rerun adds nothing", async () => {
    const item = await bills.createRecurring(cc, B, { name: "Domain (catch-up)", amount: "10.00", currency: "CAD", cadence: "monthly", next_run_on: "2026-07-05", category_id: categoryId(B, "5100") });
    const first = await bills.materializeDueRecurring(cc, B, "2026-09-30");
    const mine = (await raw.execute({ sql: `SELECT kind, status, due_date FROM fin_bills WHERE source = 'recurring' AND source_ref LIKE ? ORDER BY due_date`, args: [`${item}:%`] })).rows;
    assert.deepEqual(mine.map((r) => [r.kind, r.status, r.due_date]), [["bill", "open", "2026-07-05"], ["bill", "open", "2026-08-05"], ["bill", "open", "2026-09-05"]]);
    assert.ok(first.created.length >= 3);
    const [row] = (await bills.listRecurring(cc, B)).filter((r) => r.id === item);
    assert.equal(row.next_run_on, "2026-10-05", "the schedule caught up");
    const again = await bills.materializeDueRecurring(cc, B, "2026-09-30");
    assert.deepEqual(again.created, [], "a rerun materializes nothing new");
    assert.equal(Number((await raw.execute({ sql: `SELECT COUNT(*) FROM fin_bills WHERE source = 'recurring' AND source_ref LIKE ?`, args: [`${item}:%`] })).rows[0][0]), 3, "idempotent");
  });

  await check("a personal book's recurring cost needs the account that pays it (a personal book holds no bills): refused without one, with what to do; confirmed, an expense from it", async () => {
    const P = "fin_ent_cc";
    const cat = categoryId(P, "5500");
    const billsOf = async () => Number((await raw.execute({ sql: `SELECT COUNT(*) FROM fin_bills WHERE entity_id = ?`, args: [P] })).rows[0][0]);
    await assert.rejects(
      bills.createRecurring(cc, P, { name: "Streaming", amount: "11.99", currency: "CAD", cadence: "monthly", next_run_on: "2026-09-10", category_id: cat }),
      /choose the account that pays this recurring cost: personal books record expenses, not bills/,
    );
    assert.equal(Number((await raw.execute({ sql: `SELECT COUNT(*) FROM fin_recurring_items WHERE entity_id = ?`, args: [P] })).rows[0][0]), 0, "no item without its account");
    // An item from before (no paid-from, never confirmed): "Record" and the materializer refuse it by name, and book nothing.
    await raw.execute({
      sql: `INSERT INTO fin_recurring_items (id, entity_id, kind, name, category_id, paid_from_account_id, amount_cents, currency, cadence, next_run_on, created_by)
            VALUES ('rec_personal_old', ?, 'expense', 'Gym', ?, NULL, 4500, 'CAD', 'monthly', '2026-09-05', 'test')`,
      args: [P, cat],
    });
    await assert.rejects(bills.recordRecurringNow(cc, "rec_personal_old"), /Confirm which account pays "Gym" first: a personal book records it as an expense paid from that account, never as a bill\./);
    await assert.rejects(bills.materializeDueRecurring(cc, P, "2026-09-30"), /recurring items not materialized: rec_personal_old@2026-09-05/);
    assert.equal(await billsOf(), 0, "nothing booked on the personal book");
    // "Not known" is no answer there either.
    await assert.rejects(bills.confirmRecurringPaidFrom(cc, "rec_personal_old", { account_id: "" }), /choose the account that pays this recurring cost/);
    // Confirmed: an expense paid from that account.
    await bills.confirmRecurringPaidFrom(cc, "rec_personal_old", { account_id: accountId(P, "1000") });
    const billId = await bills.recordRecurringNow(cc, "rec_personal_old");
    const bill = (await raw.execute({ sql: `SELECT kind, status, paid_from_account_id FROM fin_bills WHERE id = ?`, args: [billId] })).rows[0];
    assert.deepEqual([bill.kind, bill.status, bill.paid_from_account_id], ["expense", "paid", accountId(P, "1000")]);
  });

  // ── complete books: no banner ──────────────────────────────────────────
  await check("complete books (opening balance, payout, bank import and costs from before the first revenue): no banner anywhere, live tiles, a real threshold level", async () => {
    await post("2026-01-01", "opening_balance", "ob-1000", [[SYS.chequing, 500000, 0], [SYS.retained, 0, 500000]]);
    await post("2026-01-10", "expense", "jan-cost", [["5100", 1500, 0], [SYS.chequing, 0, 1500]]);
    await post("2026-01-25", "bank_txn", "po_jan", [[SYS.chequing, 58000, 0], [SYS.stripeClearing, 0, 58000]]);
    // Bank lines imported from before the first revenue, in every month through this one (a feed that continues).
    const { torontoToday } = await import("../lib/founders-finances/fx");
    const thisMonth = torontoToday().slice(0, 7);
    for (let m = "2026-01", i = 1; m <= thisMonth; i += 1) {
      await raw.execute({
        sql: `INSERT INTO fin_bank_transactions (id, entity_id, account_id, posted_date, description, amount_cents, currency, status, dedupe_hash, source, created_by)
              VALUES (?, ?, ?, ?, 'Statement line', 100, 'CAD', 'excluded', ?, 'import', 'test')`,
        args: [`bt-import-${i}`, B, chequing, `${m}-01`, `dh-${i}`],
      });
      const [y, mo] = m.split("-").map(Number);
      m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
    }
    const money = await expand(await MoneyPage());
    await assertNoBanner(money, "/money");
    const inTile = walk(money).elements.filter((e) => e.type === KpiTile).map((e) => e.props as { label: string; status: string }).find((t) => t.label === "In this month");
    assert.equal(inTile?.status, "live", "a whole book's month is a real month");
    await assertNoBanner(await expand(await AccountsPage({ searchParams: sp() })), "Accounts");
    await assertNoBanner(await expand(await ReportsPage({ searchParams: sp({ kind: "balance" }) })), "Reports");
    await assertNoBanner(await expand(await TaxesPage({ searchParams: sp() })), "Taxes");
    await assertNoBanner(await expand(await TransactionsPage({ searchParams: sp() })), "Transactions");
    const accountsText = walk(await AccountsPage({ searchParams: sp() })).strings.join("\n");
    assert.ok(!accountsText.includes(coverageMod.BANK_NOT_CONNECTED), "a deposit is on the books: no caveat");
    const { loadTaxesPage } = await import("../lib/founders-finances/page-context");
    const t = await loadTaxesPage(cc, {});
    assert.equal(t.threshold.level, "ok");
    assert.match(t.threshold.message, /No action needed/);
    const res = await csvRoute.GET(new Request("http://localhost/api/founders/finances/reports?kind=pnl&from=2026-01-01&to=2026-10-01"));
    assert.match((await res.text()).replace(/^\uFEFF/, "").split(/\r?\n/)[0], /^OASIS AI Solutions/, "complete books: no comment line");
  });

  if (failures) {
    console.error(`founders-finances-books-coverage: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("founders-finances-books-coverage: all checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
