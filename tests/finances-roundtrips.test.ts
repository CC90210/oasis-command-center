/**
 * tests/finances-roundtrips.test.ts — Finances tab-switch speed, pinned so it
 * cannot silently regress, plus the business-only, banner-chip and
 * recurring-expenses rules that shipped with it.
 *
 *  - Every page's data loader (lib/founders-finances/page-context.ts) runs
 *    against a REAL local libSQL file DB with migration 180 applied. Each Turso
 *    round trip is counted (db.ts countRoundTrips) and delayed by a fixed
 *    amount, so the SEQUENTIAL depth — the latency a founder actually waits —
 *    is measured separately from the total number of trips.
 *  - No loader touches the network: global fetch throws and is counted, and the
 *    fixture holds a USD payment on a day with no stored rate (the case that
 *    used to fetch the Bank of Canada inside the Overview render).
 *  - overview() still sweeps overdue invoices inline by default (Atlas's
 *    /summary relies on it); only sweep: "deferred" skips it.
 *  - GST/QST period totals are pinned to hand-computed figures, so the
 *    parallelised taxOverview() is shown to add up the same.
 *  - recurringMonthly(): the Overview's "Recurring expenses (monthly)" math.
 *  - financeBook() is the business book for both owners; no page reads
 *    ?entity=, builds an ?entity= link or lists books, and the "CC personal /
 *    private" book switcher component is deleted.
 *  - The "OASIS · Founders Portal" banner (tagline and Marketing/Finances
 *    chips included) does not render on /founders/finances/** and still does
 *    on Marketing; the founders layout keeps its gate and audience filter.
 *  - Every tab has its own loading.tsx skeleton.
 *
 * BEFORE (HEAD finance code as of 17114f3f, measured once on an earlier draft
 * of this fixture, warm seed; not re-run) — round trips / sequential:
 *   overview 17/14 + 1 Bank of Canada fetch · transactions 9/3 · invoices 8/4
 *   · bills 9/4 · accounts 6/5 · reports 4/4 · taxes 8/8 · settings 8/3 (+ a
 *   blocking Stripe GET /v1/account when a key is set) · invoice detail 8/5.
 *   Cold isolate: +1 ~200-statement seed write batch on the first page.
 *
 * Run: node --conditions=react-server --import tsx tests/finances-roundtrips.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";

// tsconfig.json sets jsx:"preserve" for Next, so tsx compiles component JSX
// with the classic runtime, which expects a global `React` (same as
// tests/delivery-pages.test.ts). Needed to render the portal banner below.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

// next/navigation and next/link pull the client router context
// (React.createContext), which does not exist under the react-server condition
// these tests run with (same stub as tests/_delivery-harness.ts). The loaders
// only need notFound; usePathname answers whatever the banner check sets.
function stubModule(id: string, exports: Record<string, unknown>) {
  const path = require.resolve(id);
  require.cache[path] = { id: path, filename: path, path: dirname(path), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
let currentPathname = "";
stubModule("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  usePathname: () => currentPathname,
});
stubModule("next/link", { __esModule: true, default: () => null });

const dbFile = join(mkdtempSync(join(tmpdir(), "finances-roundtrips-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.FOUNDERS_TENANT_IDS;

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
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 30).join("\n        ")}`);
  }
}

const root = join(__dirname, "..");
const cc = { kind: "founder" as const, ownerKey: "cc" as const, email: "conaugh@oasisai.work", userId: "u-cc" };
const adon = { kind: "founder" as const, ownerKey: "adon" as const, email: "adon@oasisai.work", userId: "u-adon" };

/** Injected per-trip latency. Local SQLite answers in a few ms, so trips that start within DELAY/2 of each other ran in parallel. */
const DELAY = 30;

async function main() {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(readFileSync(join(root, "database/turso/180_founders_finances.turso.sql"), "utf8"));

  const { torontoToday, addDays, FX_LOOKBACK_DAYS } = await import("../lib/founders-finances/fx");
  const today = torontoToday();
  // Rates stop more than FX_LOOKBACK_DAYS before today, so a USD payment dated
  // today has no usable stored rate (HEAD fetched one from the Bank of Canada).
  const newestRate = addDays(today, -(FX_LOOKBACK_DAYS + 2));
  for (let i = 0; i < 12; i++) {
    await raw.execute({ sql: `INSERT INTO fin_fx_rates (pair, rate_date, rate) VALUES ('USDCAD', ?, '1.3700')`, args: [addDays(newestRate, -i)] });
  }

  const seedIo = await import("../lib/founders-finances/seed-io");
  const db = await import("../lib/founders-finances/db");
  const pc = await import("../lib/founders-finances/page-context");
  const reportsIo = await import("../lib/founders-finances/reports-io");
  const txns = await import("../lib/founders-finances/transactions-io");
  const invoices = await import("../lib/founders-finances/invoices-io");
  const bills = await import("../lib/founders-finances/bills-io");
  const settingsIo = await import("../lib/founders-finances/settings-io");
  const { categoryId, accountId, SYS, BUSINESS_ENTITY_ID: B } = await import("../lib/founders-finances/chart");
  const { getTursoClient } = await import("../lib/turso");

  await seedIo.ensureFinanceSeed();
  const entity = await pc.financeBook(cc);

  // ── fixture ─────────────────────────────────────────────────────────────
  await txns.createManualTransaction(cc, B, { date: addDays(today, -2), amount: "-49.00", description: "Figma", category_id: categoryId(B, "5100") });
  await txns.createManualTransaction(cc, B, { date: addDays(today, -1), amount: "1200.00", description: "Client deposit" });
  const overdueInv = await invoices.createDraftInvoice(cc, B, { new_contact: { name: "Contoso", email: "b@contoso.test" }, issue_date: addDays(today, -40), currency: "CAD", lines: [{ description: "Build", quantity: 1, unit_price: "2500" }] });
  await invoices.finalizeInvoice(cc, overdueInv);
  const draftInv = await invoices.createDraftInvoice(cc, B, { new_contact: { name: "Initech", email: "ap@initech.test" }, issue_date: today, currency: "USD", lines: [{ description: "Audit", quantity: 1, unit_price: "400" }] });
  await bills.createBill(cc, B, { kind: "expense", vendor_name: "Turso", bill_date: newestRate, subtotal: "27.99", currency: "USD", category_id: categoryId(B, "5900"), paid_from_account_id: accountId(B, SYS.chequing) });
  await bills.createRecurring(cc, B, { name: "Turso", amount: "27.99", currency: "USD", cadence: "monthly", category_id: categoryId(B, "5900") });
  await bills.createRecurring(cc, B, { name: "Domains", amount: "30.00", currency: "USD", cadence: "yearly", category_id: categoryId(B, "5100") });
  await bills.createRecurring(cc, B, { name: "Office", amount: "2750.00", currency: "CAD", cadence: "monthly", category_id: categoryId(B, "5600") });
  await raw.execute({
    sql: `INSERT INTO fin_payments (id, entity_id, kind, source, occurred_at, occurred_on, amount_cents, currency, livemode, customer_name, created_by)
          VALUES ('pay_no_rate', ?, 'payment', 'manual', ?, ?, 10000, 'USD', 1, 'Acme', 'test')`,
    args: [B, `${today}T15:00:00Z`, today],
  });
  assert.equal(networkCalls, 0, "the fixture itself made no network call");

  // ── latency injection: every trip waits DELAY ms, and its start is kept ──
  // getTursoClient() is lib/perf's instrumenting Proxy, whose execute/batch
  // call target.execute/batch. Assigning through the Proxy sets an own
  // property on the libSQL client underneath, so the wrapper sits below the
  // instrumentation; the original is the client class's prototype method.
  const client = getTursoClient() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  let starts: number[] = [];
  let slow = false;
  for (const name of ["execute", "batch"] as const) {
    const original = (Object.getPrototypeOf(client) as Record<string, (...a: unknown[]) => Promise<unknown>>)[name];
    assert.equal(typeof original, "function", `libSQL client has a prototype ${name}`);
    client[name] = async function (this: unknown, ...a: unknown[]) {
      if (slow) {
        starts.push(Date.now());
        await new Promise((r) => setTimeout(r, DELAY));
      }
      return original.apply(this, a);
    };
  }
  const waves = (ts: number[]) => {
    let n = 0;
    let waveStart = -Infinity;
    for (const t of [...ts].sort((a, b) => a - b)) {
      if (t - waveStart > DELAY / 2) {
        n += 1;
        waveStart = t;
      }
    }
    return n;
  };
  async function measure<T>(fn: () => Promise<T>) {
    starts = [];
    const net0 = networkCalls;
    slow = true;
    try {
      const r = await db.countRoundTrips(fn);
      return { ...r, depth: waves(starts), network: networkCalls - net0 };
    } finally {
      slow = false;
    }
  }

  // ── round trips per page ────────────────────────────────────────────────
  // Bounds are the measured AFTER figures; a change that adds a trip or a
  // sequential step fails here and has to justify itself.
  const sp = {};
  const PAGES: Array<{ name: string; trips: number; depth: number; run: () => Promise<unknown> }> = [
    { name: "overview", trips: 16, depth: 2, run: () => pc.loadOverviewPage(cc, entity) },
    { name: "transactions", trips: 5, depth: 1, run: () => pc.loadTransactionsPage(cc, entity, sp) },
    { name: "invoices", trips: 4, depth: 1, run: () => pc.loadInvoicesPage(cc, entity, sp) },
    { name: "bills", trips: 6, depth: 1, run: () => pc.loadBillsPage(cc, entity) },
    { name: "accounts", trips: 3, depth: 1, run: () => pc.loadAccountsPage(cc, entity) },
    { name: "reports", trips: 2, depth: 1, run: () => pc.loadReportsPage(cc, entity, sp) },
    { name: "taxes", trips: 6, depth: 1, run: () => pc.loadTaxesPage(cc, sp) },
    { name: "settings", trips: 5, depth: 1, run: () => pc.loadSettingsPage(cc, entity) },
    { name: "invoice detail", trips: 8, depth: 3, run: () => pc.loadInvoiceDetailPage(cc, draftInv) },
  ];
  const table: Record<string, { trips: number; sequential: number; network: number; ms: number }> = {};
  for (const p of PAGES) {
    await check(`${p.name}: at most ${p.trips} round trips, ${p.depth} sequential, no network`, async () => {
      const t0 = Date.now();
      const m = await measure(p.run);
      table[p.name] = { trips: m.trips, sequential: m.depth, network: m.network, ms: Date.now() - t0 };
      assert.equal(m.network, 0, `${p.name} made a network call during render`);
      assert.ok(m.trips <= p.trips, `${p.name}: ${m.trips} round trips > bound ${p.trips}\n${m.sql.join("\n")}`);
      assert.ok(m.depth <= p.depth, `${p.name}: ${m.depth} sequential round trips > bound ${p.depth}\n${m.sql.join("\n")}`);
    });
  }
  console.table(table);

  await check("the Overview reports a USD payment's missing rate instead of fetching it", async () => {
    const net0 = networkCalls;
    const { collected } = await pc.loadOverviewPage(cc, entity);
    assert.ok(collected.fx_missing_days.includes(today), `today (${today}) listed as missing: ${JSON.stringify(collected.fx_missing_days)}`);
    assert.equal(collected.usd_cents, 10000);
    assert.equal(networkCalls - net0, 0);
  });

  // ── cold isolate: the seed gate is one read, not a write ────────────────
  await check("cold isolate: the seed check is one read when every seeded row exists", async () => {
    seedIo.resetFinanceSeedMemo();
    const m = await measure(() => seedIo.ensureFinanceSeed());
    assert.equal(m.trips, 1, m.sql.join("\n"));
    assert.doesNotMatch(m.sql[0], /^batch/, "no write batch when the seed is present");
  });

  await check("cold isolate: a missing seeded row is written back", async () => {
    await raw.execute({ sql: `DELETE FROM fin_rules WHERE id = (SELECT id FROM fin_rules WHERE entity_id = ? ORDER BY id LIMIT 1)`, args: [B] });
    const before = Number((await raw.execute({ sql: `SELECT COUNT(*) AS n FROM fin_rules`, args: [] })).rows[0].n);
    seedIo.resetFinanceSeedMemo();
    const m = await measure(() => seedIo.ensureFinanceSeed());
    const after = Number((await raw.execute({ sql: `SELECT COUNT(*) AS n FROM fin_rules`, args: [] })).rows[0].n);
    assert.equal(m.trips, 2, "the presence read, then the batch");
    assert.equal(after, before + 1);
  });

  // ── overview(): inline sweep stays the default ──────────────────────────
  await check("overview(): sweeps inline by default; only 'deferred' skips the write", async () => {
    const status = async () => String((await raw.execute({ sql: `SELECT status FROM fin_invoices WHERE id = ?`, args: [overdueInv] })).rows[0].status);
    await raw.execute({ sql: `UPDATE fin_invoices SET status = 'sent' WHERE id = ?`, args: [overdueInv] });
    const deferred = await reportsIo.overview(cc, B, { sweep: "deferred" });
    assert.equal(await status(), "sent", "deferred does not write");
    const inline = await reportsIo.overview(cc, B);
    assert.equal(await status(), "overdue", "the default still persists overdue");
    assert.equal(deferred.overdueCount, 1, "overdue is computed from the due date either way");
    assert.deepEqual(deferred.overdueAr, inline.overdueAr);
  });

  // ── tax totals unchanged ────────────────────────────────────────────────
  await check("taxOverview(): GST/QST period totals match hand-computed figures", async () => {
    await settingsIo.updateSettings(cc, B, { gst_qst_registered: true, gst_number: "123456789RT0001", qst_number: "1234567890TQ0001", registration_effective_date: addDays(today, -1) });
    const taxed = await invoices.createDraftInvoice(cc, B, { new_contact: { name: "Globex", email: "ap@globex.test" }, issue_date: today, currency: "CAD", lines: [{ description: "Build", quantity: 1, unit_price: "1000.00" }] });
    await invoices.finalizeInvoice(cc, taxed);
    await bills.createBill(cc, B, { kind: "expense", vendor_name: "Staples", bill_date: today, subtotal: "200.00", gst: "10.00", qst: "19.95", currency: "CAD", category_id: categoryId(B, "5600"), paid_from_account_id: accountId(B, SYS.chequing) });
    const t = await pc.loadTaxesPage(cc, { from: today, to: addDays(today, 1) });
    assert.equal(t.period.gstCollectedCents, 5000, "5% of 1,000.00");
    assert.equal(t.period.qstCollectedCents, 9975, "9.975% of 1,000.00");
    assert.equal(t.period.gstItcCents, 1000);
    assert.equal(t.period.qstItrCents, 1995);
    assert.equal(t.period.gstNetCents, 4000);
    assert.equal(t.period.qstNetCents, 7980);
    const labels = t.threshold.quarters.map((x: { label: string }) => x.label);
    assert.deepEqual(labels, [...labels].sort(), "quarters stay in calendar order after the parallel reads");
  });

  // ── recurring expenses, monthly ─────────────────────────────────────────
  await check("recurringMonthly(): cadence normalisation, USD at the stored rate, exclusions", async () => {
    const row = (id: string, amount_cents: number, currency: string, cadence: string, active = 1) => ({ id, name: id, amount_cents, currency, cadence, active });
    const rate = { date: "2026-09-23", rate: "1.3700" };
    const r = pc.recurringMonthly(
      [
        row("office", 275000, "CAD", "monthly"),
        row("turso", 2799, "USD", "monthly"),
        row("domains", 3000, "USD", "yearly"),
        row("accountant", 30000, "CAD", "quarterly"),
        row("cleaning", 10000, "CAD", "weekly"),
        row("cancelled", 99900, "CAD", "monthly", 0),
        row("euro", 5000, "EUR", "monthly"),
      ],
      rate,
    );
    const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
    assert.equal(by.cancelled, undefined, "inactive items are left out");
    assert.equal(by.office.monthlyCadCents, 275000);
    assert.equal(by.turso.monthlyCadCents, 3835, "27.99 US$ x 1.37 = 38.3463 → 38.35");
    assert.equal(by.domains.monthlyCents, 250, "yearly / 12");
    assert.equal(by.domains.monthlyCadCents, 343, "2.50 US$ x 1.37 = 3.425 → 3.43 (half away from zero)");
    assert.equal(by.accountant.monthlyCadCents, 10000, "quarterly / 3");
    assert.equal(by.cleaning.monthlyCadCents, 43333, "weekly x 52 / 12");
    assert.equal(by.euro.monthlyCadCents, null, "no EUR rate: shown, not totalled");
    assert.equal(r.unconverted, 1);
    assert.equal(r.totalCadCents, 275000 + 3835 + 343 + 10000 + 43333);
    assert.deepEqual(r.rate, rate, "the rate is reported when a USD item used it");
    assert.deepEqual(r.items.map((i) => i.id), ["office", "cleaning", "accountant", "turso", "domains", "euro"], "largest first, unconverted last");

    const noRate = pc.recurringMonthly([row("office", 275000, "CAD", "monthly"), row("turso", 2799, "USD", "monthly")], null);
    assert.equal(noRate.totalCadCents, 275000);
    assert.equal(noRate.unconverted, 1, "USD with no stored rate is flagged, not guessed");
    assert.equal(pc.recurringMonthly([row("office", 275000, "CAD", "monthly")], rate).rate, null, "no USD item: no rate line");

    const { recurring } = await pc.loadOverviewPage(cc, entity);
    assert.deepEqual(
      recurring.items.map((i) => [i.name, i.monthlyCadCents]),
      [["Office", 275000], ["Turso", 3835], ["Domains", 343]],
      "the Overview card converts the fixture's USD items at the latest stored rate",
    );
    assert.equal(recurring.rate?.date, newestRate);
  });

  // ── business only ───────────────────────────────────────────────────────
  await check("business only: both owners resolve to the OASIS AI Solutions book", async () => {
    for (const v of [cc, adon]) {
      const book = await pc.financeBook(v);
      assert.equal(book.id, B);
      assert.equal(book.kind, "business");
    }
  });

  await check("business only: no Finances page reads ?entity=, builds an ?entity= link or renders the book switcher", async () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(name)) out.push(full);
      }
      return out;
    };
    // The "CC personal / private" book switcher is deleted, not just unused.
    assert.equal(existsSync(join(root, "components/founders/finances/EntitySwitcher.tsx")), false, "the book switcher component is gone");
    const surfaces = [...walk(join(root, "app/founders/finances")), ...walk(join(root, "components/founders/finances")), join(root, "lib/founders-finances/page-context.ts")];
    assert.ok(surfaces.length > 15, "walked the Finances surface");
    assert.ok(surfaces.some((f) => /[\\/]bills[\\/]page\.tsx$/.test(f)), "Bills & Expenses is among them");
    for (const f of surfaces) {
      // Code only: a comment may say why ?entity= is gone.
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
      assert.doesNotMatch(src, /EntitySwitcher|visibleEntities\(/, `${f} still lists or switches books`);
      assert.doesNotMatch(src, /[?&]entity=|param\(sp, "entity"\)|get\("entity"\)|name="entity"/, `${f} still reads or builds ?entity=`);
    }
  });

  // ── founders portal banner ──────────────────────────────────────────────
  await check("the founders portal banner is gone on /founders/finances/** and still on Marketing", async () => {
    const { FoundersPortalBanner, foundersBannerHidden } = await import("../components/founders/FoundersPortalBanner");
    const { FoundersSectionNav } = await import("../components/founders/FoundersSectionNav");
    const { FOUNDERS_PORTAL } = await import("../lib/portals/registry");
    const financePaths = ["/founders/finances", "/founders/finances/", "/founders/finances/bills", "/founders/finances/taxes", "/founders/finances/invoices/inv_1"];
    const otherPaths = ["/founders/marketing", "/founders/marketing/library", "/founders"];
    for (const p of financePaths) assert.equal(foundersBannerHidden(p), true, p);
    for (const p of [...otherPaths, "/founders/financesx"]) assert.equal(foundersBannerHidden(p), false, p);

    // Render it (a plain function call with the pathname stubbed at the top).
    type El = { type: unknown; props: { children?: unknown; sections?: unknown } };
    const render = (path: string) => {
      currentPathname = path;
      return FoundersPortalBanner({ label: FOUNDERS_PORTAL.label, tagline: FOUNDERS_PORTAL.tagline, sections: FOUNDERS_PORTAL.sections }) as El | null;
    };
    const nodes = (n: unknown): El[] => (Array.isArray(n) ? n.flatMap(nodes) : n && typeof n === "object" && "props" in n ? [n as El, ...nodes((n as El).props.children)] : []);
    const text = (n: unknown): string =>
      typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(text).join(" ") : n && typeof n === "object" && "props" in n ? text((n as El).props.children) : "";
    for (const p of financePaths) assert.equal(render(p), null, `${p}: no banner, no chips`);
    for (const p of otherPaths) {
      const el = render(p);
      assert.ok(el, `${p}: the banner renders`);
      assert.match(text(el), new RegExp(FOUNDERS_PORTAL.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${p}: wordmark`);
      assert.ok(text(el).includes(FOUNDERS_PORTAL.tagline), `${p}: tagline`);
      const nav = nodes(el).find((x) => x.type === FoundersSectionNav);
      assert.ok(nav, `${p}: section chips`);
      assert.deepEqual(nav!.props.sections, FOUNDERS_PORTAL.sections, "the chips get exactly the sections the layout passed");
    }

    // The layout keeps the founder gate and filters the sections on the
    // server, and no longer draws the banner itself.
    const layout = readFileSync(join(root, "app/founders/layout.tsx"), "utf8");
    assert.match(layout, /const founder = await resolveFounder\(\);\s*if \(!founder\) notFound\(\);/, "founder gate intact");
    assert.match(layout, /<FoundersPortalBanner[\s\S]*?sections=\{FOUNDERS_PORTAL\.sections\.filter\([\s\S]*?isFinanceOwnerEmail\(founder\.email\)/, "audience filter intact, on the server");
    assert.doesNotMatch(layout, /rgba\(31,227,240/, "the banner markup lives only in FoundersPortalBanner");
  });

  // ── every tab has its own skeleton ──────────────────────────────────────
  await check("every Finances tab has its own loading.tsx, and none sits above the tabs", async () => {
    const { FINANCE_TABS } = await import("../components/founders/finances/FinanceTabs");
    const financesDir = join(root, "app/founders/finances");
    // A loading.tsx directly in finances/ would wrap every tab and hide theirs;
    // the Overview's lives in its (overview) route group instead.
    assert.equal(existsSync(join(financesDir, "loading.tsx")), false, "no loading.tsx directly under app/founders/finances");
    for (const t of FINANCE_TABS) {
      const rel = t.href.replace(/^\/founders\/finances\/?/, "");
      const dir = rel ? join(financesDir, ...rel.split("/")) : join(financesDir, "(overview)");
      assert.ok(existsSync(join(dir, "page.tsx")), `${t.href}: page.tsx expected in ${dir}`);
      assert.ok(existsSync(join(dir, "loading.tsx")), `${t.href}: no loading.tsx in ${dir}`);
    }
  });

  if (failures) {
    console.error(`finances-roundtrips: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("finances-roundtrips: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
