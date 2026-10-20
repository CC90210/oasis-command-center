/**
 * tests/finances-io.test.ts — FOUNDERS > Finances I/O against a REAL local
 * libSQL database with migration 180 applied.
 *
 * Drives the real modules and the real route handlers (webhook, internal API)
 * — no mocks of our own code. Network is disabled (global fetch throws), and
 * no Stripe key is configured, so every path that would call Stripe or the
 * Bank of Canada takes its offline branch, which is itself under test:
 * fees recorded as pending, rates read from the seeded table. The one
 * exception is a webhook delivery: an event is booked only once a key of the
 * pinned account proves it is that account's (stripe-ingest.ts
 * stripeEventOrigin), so `deliver` holds such a key for the delivery. Stripe
 * then knows the event and no other object (every other read is a 404, the
 * same "Stripe could not say" branch). The reconcile checks hold the key the
 * same way (`reconcile`), and Stripe then also lists the charges the check
 * gives it (and no refund, subscription or payout).
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
delete process.env.SUPPORT_GMAIL_USER;
delete process.env.SUPPORT_GMAIL_APP_PASSWORD;

// The fixtures below are dated 2026-09-19 .. 2026-09-25, and the rules under
// test (collection windows, books coverage, stale-event handling) compare
// them with the current date. Freeze the clock at the moment the fixtures were
// written, so the suite cannot expire at a day boundary: on 2026-10-01 it did
// (AR no longer cleared, coverage "unconfirmed") and turned every PR red while
// the code under test was unchanged. Everything that reads Date.now() or
// `new Date()` sees 2026-09-24T12:00:00Z; explicit dates still parse normally.
const FROZEN_NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    // @ts-expect-error Date's constructor overloads cannot be expressed as a spread.
    super(...(args.length ? args : [FROZEN_NOW]));
  }
  static override now(): number {
    return FROZEN_NOW;
  }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;

/** The pinned account's key, held only while `deliver` posts an event. */
const STRIPE_KEY = "rk_live_finances_io_test_only";
/** Every network call but a Stripe read made with that key. */
let networkCalls = 0;
/** Telegram messages, kept only while a check that expects them turns this on. */
let telegramSent: Array<{ chat: string; text: string }> | null = null;
/** Every send that reached Telegram while `telegramSent` is on, taken or refused. */
let telegramCalls = 0;
/** Which sends Telegram refuses (HTTP 403): the reason it gives, or null to take the message. */
let telegramRefuses: ((send: { token: string; chat: string }) => string | null) | null = null;
/** While set, Telegram does not answer until it settles. */
let telegramHold: Promise<void> | null = null;
/** The charges Stripe lists while a reconcile runs; null at any other time, when Stripe knows no list. `reconcile` sets it for the one call. */
let stripeCharges: unknown[] | null = null;
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
  const url = new URL(String(input));
  const sink = telegramSent;
  if (sink && url.host === "api.telegram.org" && url.pathname.endsWith("/sendMessage")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: unknown; text?: unknown };
    telegramCalls += 1;
    if (telegramHold) await telegramHold;
    const refusal = telegramRefuses?.({ token: url.pathname.split("/")[1].slice("bot".length), chat: String(body.chat_id) });
    if (refusal) return new Response(JSON.stringify({ ok: false, error_code: 403, description: refusal }), { status: 403, headers: { "content-type": "application/json" } });
    sink.push({ chat: String(body.chat_id), text: String(body.text) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sink.length } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.host === "api.stripe.com" && process.env.STRIPE_SECRET_KEY === STRIPE_KEY && (init?.method || "GET").toUpperCase() === "GET") {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/v1/account") return json({ id: "acct_test_oasis", settings: { dashboard: { display_name: "OASIS AI" } } });
    if (url.pathname.startsWith("/v1/events/")) return json({ id: decodeURIComponent(url.pathname.slice("/v1/events/".length)), object: "event" });
    // What a reconcile lists: the charges a check gave it, and no refund, subscription or payout.
    // Only while one runs: the webhook checks rely on these reads being a 404.
    if (stripeCharges) {
      if (url.pathname === "/v1/charges") return json({ object: "list", data: stripeCharges, has_more: false });
      if (["/v1/refunds", "/v1/subscriptions", "/v1/payouts"].includes(url.pathname)) return json({ object: "list", data: [], has_more: false });
    }
    return json({ error: { type: "invalid_request_error", message: "No such object" } }, 404);
  }
  networkCalls += 1;
  throw new Error(`network disabled in test: ${String(input).slice(0, 80)}`);
}) as typeof fetch;

/**
 * A Worker's request context, so lib/os/runs/keepalive.ts takes the path it
 * takes in production (ctx.waitUntil) and the check can see what the webhook
 * left running after its answer.
 */
const keptAlive: Array<Promise<unknown>> = [];
(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("__cloudflare-context__")] = {
  env: {},
  cf: {},
  ctx: { waitUntil: (work: Promise<unknown>) => void keptAlive.push(work), passThroughOnException: () => undefined },
};
/** Wait for everything kept alive past a webhook's answer, as the platform lets it finish. */
async function settled() {
  while (keptAlive.length > 0) await Promise.all(keptAlive.splice(0));
}

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
  // Stripe ingest writes the Business Ledger in its own batches (bravo__190); the books read Stripe payouts and the payout account (bravo__193).
  await raw.executeMultiple(readFileSync(join(__dirname, "../database/turso/bravo__190_ledger_core.sql"), "utf8"));
  await raw.executeMultiple(readFileSync(join(__dirname, "../database/turso/bravo__193_stripe_payouts.sql"), "utf8"));
  // The cards a purchase alert that cannot be sent leaves (lib/notify/agent-alert.ts):
  // agent_alerts as the live database defines it (tests/workspace-alerts.test.ts
  // holds the same DDL), minus the tenants foreign key: this database has no tenants table.
  await raw.executeMultiple(`
    CREATE TABLE "agent_alerts" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
      "tenant_id" TEXT NOT NULL,
      "alert_type" TEXT NOT NULL,
      "severity" TEXT NOT NULL DEFAULT 'info',
      "subject_type" TEXT,
      "subject_id" TEXT,
      "title" TEXT NOT NULL,
      "body" TEXT,
      "payload" TEXT NOT NULL DEFAULT '{}',
      "dedup_key" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "resolved_at" TEXT,
      "resolved_by" TEXT,
      PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX "agent_alerts_pkey" ON "agent_alerts" (id);
    CREATE INDEX "idx_agent_alerts_open" ON "agent_alerts" (tenant_id, severity, created_at DESC) WHERE (resolved_at IS NULL);
    CREATE INDEX "idx_agent_alerts_subject" ON "agent_alerts" (tenant_id, subject_type, subject_id);
    CREATE UNIQUE INDEX "idx_agent_alerts_dedup" ON "agent_alerts" (tenant_id, dedup_key) WHERE ((dedup_key IS NOT NULL) AND (resolved_at IS NULL));
  `);
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
    process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
    try {
      const res = await webhook.POST(new Request("http://localhost/api/webhooks/stripe-finance", { method: "POST", headers: { "stripe-signature": `t=${ts},v1=${sig}` }, body: payload }));
      return { status: res.status, body: (await res.json()) as Record<string, unknown>, event };
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
    }
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
  /** A payment intent the public checkout started, as Stripe sends it for a purchase on /pricing. */
  const checkoutSale = (n: string, p: { amount?: number; name?: string; email?: string } = {}) => {
    const amount = p.amount ?? 750000;
    const metadata = { oasis_checkout: "public_funnel_v1", oasis_offer_id: "enterprise-fleet", oasis_option_id: "foundation", oasis_order_id: `ord_${n}` };
    return {
      id: `pi_${n}`,
      object: "payment_intent",
      amount_received: amount,
      currency: "cad",
      created: epoch("2026-09-22T15:00:00Z"),
      livemode: true,
      latest_charge: charge({ id: `ch_${n}`, amount, pi: `pi_${n}`, name: p.name, email: p.email, metadata }),
      metadata,
    };
  };
  /** What the alert is handed for such a purchase, for a check that calls it directly. */
  const purchase = (n: string) => ({
    sale: { orderId: `ord_${n}`, offerId: "enterprise-fleet", optionId: "foundation" },
    paymentIntentId: `pi_${n}`,
    amountCents: 750000,
    currency: "cad",
    customerName: "Bo Direct",
    customerEmail: "bo@buyer.test",
  });
  /**
   * A charge as the reconcile lists it, its payment intent created `ageSec`
   * before the frozen now. `marked: false` is a payment the checkout did not
   * start; `intent` "bare" leaves the intent as an unexpanded id, "unreadable"
   * as an object that has the marker and nothing else.
   */
  const listedCharge = (n: string, p: { ageSec: number; marked?: boolean; intent?: "bare" | "unreadable" }) => {
    const created = Math.floor(FROZEN_NOW / 1000) - p.ageSec;
    const sale = checkoutSale(n, { name: "Lia Late", email: "lia@buyer.test" });
    const intent =
      p.intent === "bare"
        ? `pi_${n}`
        : p.intent === "unreadable"
          ? { metadata: sale.metadata }
          : { ...sale, created, latest_charge: `ch_${n}`, metadata: p.marked === false ? {} : sale.metadata };
    return { ...charge({ id: `ch_${n}`, amount: 750000, pi: `pi_${n}`, created, name: "Lia Late", email: "lia@buyer.test" }), payment_intent: intent };
  };
  /** The daily reconcile over the charges Stripe lists, holding the pinned account's key as `deliver` does. */
  async function reconcile(listed: unknown[]) {
    const { reconcileStripe } = await import("../lib/founders-finances/stripe-ingest");
    stripeCharges = listed;
    process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
    try {
      return await reconcileStripe({ days: 30 });
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      stripeCharges = null;
    }
  }
  const SALES_ENV = ["OASIS_SALES_TELEGRAM_BOT_TOKEN", "OASIS_SALES_TELEGRAM_CHAT_ID", "OASIS_TELEGRAM_BOT_TOKEN", "OASIS_TELEGRAM_CHAT_ID"];
  /**
   * The sales group (-100777, its own bot), CC's chat (4242, his bot) and a
   * recording Telegram, for a check that expects messages. `sent` is what
   * Telegram took.
   */
  async function withTelegram(fn: (sent: Array<{ chat: string; text: string }>) => Promise<void>) {
    Object.assign(process.env, {
      OASIS_SALES_TELEGRAM_BOT_TOKEN: "123456:sales-test-token",
      OASIS_SALES_TELEGRAM_CHAT_ID: "-100777",
      OASIS_TELEGRAM_BOT_TOKEN: "999:operator-test-token",
      OASIS_TELEGRAM_CHAT_ID: "4242",
    });
    const sent: Array<{ chat: string; text: string }> = [];
    telegramSent = sent;
    telegramCalls = 0;
    try {
      await fn(sent);
    } finally {
      telegramSent = null;
      telegramRefuses = null;
      telegramHold = null;
      for (const key of SALES_ENV) delete process.env[key];
    }
  }
  /** Run `fn` with console.error captured, for a check that expects the code under test to say a failure aloud. */
  async function logged<T>(fn: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
    const saved = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, (_k, v) => (v instanceof Error ? v.message : v)))).join(" "));
    };
    try {
      return { result: await fn(), errors };
    } finally {
      console.error = saved;
    }
  }
  /** `work`'s answer, or "stuck" when it has not answered within `ms`. */
  async function within<T>(ms: number, work: Promise<T>): Promise<T | "stuck"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<"stuck">((resolve) => (timer = setTimeout(() => resolve("stuck"), ms)))]);
    } finally {
      clearTimeout(timer);
    }
  }
  /** What a message must be for Telegram's HTML mode to take it: under the 4,096 cut, no raw markup, no entity cut in half. */
  const wholeTelegramHtml = (text: string) => text.length < 4096 && !/[<>]|&(?!(?:amp|lt|gt);)/.test(text);

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

  // Production has OASIS's Stripe account pinned (Finances › Settings). Since
  // 2026-09-30 a webhook event reaches the books only from the pinned account
  // (stripe-ingest.ts stripeEventOrigin): `deliver` holds that account's key,
  // and Stripe finds each event in it.
  await raw.execute({ sql: `UPDATE fin_settings SET stripe_account_id = 'acct_test_oasis' WHERE entity_id = ?`, args: [B] });

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
    assert.equal(networkCalls, 0, "nothing but reads of the pinned Stripe account: no write, no other host");
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

    // The other order: the intent (with fin_invoice_id) arrives first, then the charge.
    const id2 = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Initech", email: "ap@initech.test" }, issue_date: "2026-09-22", currency: "CAD", lines: [{ description: "Audit", quantity: 1, unit_price: "400" }] });
    await invoices.finalizeInvoice(cc, id2);
    const c2 = charge({ id: "ch_inv2", amount: 40000, pi: "pi_inv2", created, name: "Initech" });
    await deliver("payment_intent.succeeded", { id: "pi_inv2", object: "payment_intent", amount_received: 40000, currency: "cad", created, livemode: true, latest_charge: c2, metadata: { fin_invoice_id: id2 } }, { created });
    await deliver("charge.succeeded", c2, { created });
    assert.equal((await raw.execute({ sql: `SELECT status FROM fin_invoices WHERE id = ?`, args: [id2] })).rows[0].status, "paid");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE stripe_charge_id = 'ch_inv2'`), 1);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'stripe_invoice_link'`), 1, "only the first order needed a reclass");
    const day2 = await metrics.revenueCollected({ from: "2026-09-22", to: "2026-09-23" });
    assert.equal(day2.payments, 2);
    assert.equal(day2.cad_cents, invoiceStripeTotal + 40000);
    assert.equal(await count(`SELECT fee_status = 'pending' FROM fin_payments WHERE stripe_charge_id = 'ch_inv2'`), 1, "no balance transaction and no key: fee left pending, not guessed");
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
    // Refund with no itemised list and no Stripe key: one delta row, dated by the EVENT, not "now".
    const refundedAt = epoch("2026-09-12T13:00:00Z");
    await deliver("charge.succeeded", charge({ id: "ch_delta", amount: 3000, created: epoch("2026-09-11T12:00:00Z"), name: "Delta Co" }));
    await deliver("charge.refunded", charge({ id: "ch_delta", amount: 3000, refunded: 1000, created: epoch("2026-09-11T12:00:00Z"), name: "Delta Co" }), { created: refundedAt });
    await deliver("charge.refunded", charge({ id: "ch_delta", amount: 3000, refunded: 1000, created: epoch("2026-09-11T12:00:00Z"), name: "Delta Co" }), { created: refundedAt });
    const delta = (await raw.execute(`SELECT occurred_on, amount_cents, stripe_refund_id FROM fin_payments WHERE kind = 'refund' AND parent_payment_id = (SELECT id FROM fin_payments WHERE stripe_charge_id = 'ch_delta')`)).rows;
    assert.equal(delta.length, 1, "a second identical event adds nothing (capped)");
    assert.equal(delta[0].occurred_on, "2026-09-12", "dated by the charge.refunded event, not by when it was processed");
    assert.equal(Number(delta[0].amount_cents), 1000);
    assert.equal((await metrics.revenueCollected({ from: "2026-09-11", to: "2026-09-13" })).cad_cents, 2000);
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
    // A bank statement was imported (rbc.csv, above) with lines dated before
    // the first revenue, so the books can hold every sale and the tracker may
    // say "under" (books-coverage.ts; without an import it is "unconfirmed").
    assert.equal(body.threshold.level, "ok");
    assert.equal((body as unknown as { threshold: { revenueComplete: boolean } }).threshold.revenueComplete, true);
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

  await check("a purchase on the public checkout tells the sales desk once per event, in escaped words, whichever event booked the payment; any other payment, and a test-mode one, tells no one", async () => {
    // 2026-10-19 audit: a buyer could pay on oasisai.work/pricing and the team
    // was never told (lib/checkout/paid-alert.ts). The alert goes out after the
    // webhook's answer, kept alive, so each check waits for it (settled).
    const { cad: formatCad } = await import("../lib/checkout/catalog");
    await withTelegram(async (sent) => {
      const sale = {
        id: "pi_sale_1",
        object: "payment_intent",
        amount_received: 750000,
        currency: "cad",
        created: epoch("2026-09-22T15:00:00Z"),
        livemode: true,
        latest_charge: charge({ id: "ch_sale_1", amount: 750000, pi: "pi_sale_1", name: "Ann <Smith> & Co", email: "ann@buyer.test" }),
        metadata: { oasis_checkout: "public_funnel_v1", oasis_offer_id: "enterprise-fleet", oasis_option_id: "foundation", oasis_order_id: "ord_sale_1" },
      };
      const first = await deliver("payment_intent.succeeded", sale, { id: "evt_sale_1" });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      await settled();
      assert.equal(sent.length, 1, "one message to the sales desk");
      const msg = sent[0];
      assert.equal(msg.chat, "-100777", "the sales group, not another lane");
      assert.match(msg.text, /^New purchase on oasisai\.work\/pricing\n/);
      assert.ok(msg.text.includes(`${formatCad(750000)} paid`), msg.text);
      assert.ok(msg.text.includes("Ann &lt;Smith&gt; &amp; Co &lt;ann@buyer.test&gt;"), `the buyer, escaped: ${msg.text}`);
      assert.ok(msg.text.includes("Order ord_sale_1"));
      assert.ok(msg.text.includes("Next: reach out to book the kickoff."));

      const again = await deliver("payment_intent.succeeded", sale, { id: "evt_sale_1" });
      assert.equal(again.status, 200);
      await settled();
      assert.equal(sent.length, 1, "Stripe's redelivery of the same event tells no one again");

      await deliver("payment_intent.succeeded", { ...sale, id: "pi_plain_1", latest_charge: charge({ id: "ch_plain_1", amount: 1000, pi: "pi_plain_1" }), metadata: {} });
      await settled();
      assert.equal(sent.length, 1, "a payment the public checkout did not start tells no one");

      // Stripe sends charge.succeeded and payment_intent.succeeded in either
      // order. When the charge books the payment first, the intent's event
      // only matches it, and the sales desk is still told. The charge carries
      // the checkout's marker too, so this also fails if charge.succeeded ever
      // alerts: it would send a second message for every purchase.
      const secondMeta = { ...sale.metadata, oasis_order_id: "ord_sale_2" };
      const second = { ...sale, id: "pi_sale_2", latest_charge: charge({ id: "ch_sale_2", amount: 150000, pi: "pi_sale_2", metadata: secondMeta }), metadata: secondMeta };
      const booked = await deliver("charge.succeeded", second.latest_charge, { id: "evt_sale_2_charge" });
      assert.match(String((booked.body as { detail?: string }).detail), /^payment recorded /, JSON.stringify(booked.body));
      await settled();
      assert.equal(sent.length, 1, "the charge's own event tells no one");
      const matched = await deliver("payment_intent.succeeded", second, { id: "evt_sale_2" });
      assert.match(String((matched.body as { detail?: string }).detail), /^payment matched /, JSON.stringify(matched.body));
      await settled();
      assert.equal(sent.length, 2, "the intent's event tells the sales desk though the payment was already booked");
      assert.ok(sent[1].text.includes("Order ord_sale_2"));

      // A test-mode purchase never reaches the alert: the webhook ignores
      // test-mode events before dispatch.
      await deliver("payment_intent.succeeded", { ...sale, id: "pi_test_1", livemode: false, latest_charge: { ...charge({ id: "ch_test_1", amount: 1000, pi: "pi_test_1" }), livemode: false } }, { id: "evt_sale_test", livemode: false });
      await settled();
      assert.equal(sent.length, 2, "a test-mode purchase tells no one");
      assert.equal(telegramCalls, 2, "and nothing else reached Telegram");
    });
    assert.equal(await count(`SELECT COUNT(*) FROM agent_alerts WHERE alert_type = 'checkout_purchase_alert_failed'`), 0, "an alert that was delivered leaves no card");
  });

  await check("the purchase alert goes out after the webhook's answer: Stripe does not wait for Telegram, and the event is already marked processed", async () => {
    // Telegram not answering held the webhook for 16 seconds (two 8-second
    // attempts) with the event still unmarked (review of #718).
    await withTelegram(async (sent) => {
      let release: () => void = () => undefined;
      telegramHold = new Promise<void>((resolve) => (release = resolve));
      const delivery = deliver("payment_intent.succeeded", checkoutSale("hold_1"), { id: "evt_hold_1" });
      try {
        const answered = await within(5000, delivery);
        assert.notEqual(answered, "stuck", "the webhook answered Stripe while Telegram had not");
        const res = answered as Awaited<typeof delivery>;
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.status, "processed");
        assert.equal(sent.length, 0, "Telegram had taken nothing when Stripe was answered");
        assert.equal(await count(`SELECT COUNT(*) FROM fin_stripe_events WHERE event_id = 'evt_hold_1' AND status = 'processed'`), 1, "the event was already marked processed");
        assert.equal(keptAlive.length, 1, "the send was handed to the platform to finish after the answer");
      } finally {
        release();
        await delivery.catch(() => undefined);
      }
      await settled();
      assert.equal(sent.length, 1, "the alert went out once Telegram answered");
      assert.equal(sent[0].chat, "-100777");
    });
  });

  await check("an event whose booking or processed mark failed tells no one; Stripe's retry of it tells the sales desk once", async () => {
    // The alert follows the books and the mark (review of #718). Sent earlier,
    // an event that failed would alert again on every retry.
    await withTelegram(async (sent) => {
      for (const failure of [
        { name: "booking", cause: /booking down/, trigger: `CREATE TRIGGER booking_down BEFORE INSERT ON fin_payments WHEN NEW.stripe_payment_intent_id = 'pi_booking_down' BEGIN SELECT RAISE(ABORT, 'booking down'); END`, drop: `DROP TRIGGER booking_down` },
        { name: "mark", cause: /mark down/, trigger: `CREATE TRIGGER mark_down BEFORE UPDATE ON fin_stripe_events WHEN NEW.event_id = 'evt_mark_down' AND NEW.status = 'processed' BEGIN SELECT RAISE(ABORT, 'mark down'); END`, drop: `DROP TRIGGER mark_down` },
      ]) {
        const sale = checkoutSale(`${failure.name}_down`);
        const id = `evt_${failure.name}_down`;
        await raw.execute(failure.trigger);
        const first = await logged(async () => {
          const res = await deliver("payment_intent.succeeded", sale, { id });
          await settled();
          return res;
        });
        assert.equal(first.result.status, 500, `${failure.name}: Stripe is told to retry`);
        assert.ok(first.errors.some((line) => failure.cause.test(line)), `${failure.name}: the failure is logged: ${first.errors.join(" | ")}`);
        assert.equal(telegramCalls, 0, `${failure.name}: nothing reached Telegram before the books and the mark were done`);
        await raw.execute(failure.drop);
        const retry = await deliver("payment_intent.succeeded", sale, { id });
        assert.equal(retry.status, 200, JSON.stringify(retry.body));
        await settled();
        assert.equal(sent.length, 1, `${failure.name}: the retry tells the sales desk once`);
        assert.ok(sent[0].text.includes(`Order ord_${failure.name}_down`));
        const again = await deliver("payment_intent.succeeded", sale, { id });
        await settled();
        assert.equal(again.body.status, "duplicate");
        assert.equal(sent.length, 1, `${failure.name}: a redelivery of the marked event tells no one`);
        sent.length = 0;
        telegramCalls = 0;
      }
    });
  });

  await check("a purchase alert Telegram refuses leaves a card in Needs you naming the order, the buyer and the amount, and never fails the booking", async () => {
    // The bot removed from the sales group, its DM to CC refusing too: two log
    // lines and nothing else, for a sale of up to CAD 15,000 (review of #718).
    const { cad: formatCad } = await import("../lib/checkout/catalog");
    const { OASIS_OPERATOR_TENANT_ID } = await import("../lib/platform-operator");
    const { alertPublicCheckoutPaid } = await import("../lib/checkout/paid-alert");
    const cardsFor = async (order: string) =>
      (await raw.execute({ sql: `SELECT * FROM agent_alerts WHERE alert_type = 'checkout_purchase_alert_failed' AND subject_id = ? AND resolved_at IS NULL`, args: [order] })).rows;
    const telegramOutcome = (card: { payload: unknown }) => (JSON.parse(String(card.payload)) as { telegram?: string }).telegram;
    await withTelegram(async (sent) => {
      // The sales bot is refused in every chat; CC's own bot still works.
      telegramRefuses = ({ token }) => (token.startsWith("123456:") ? "Forbidden: bot was kicked from the supergroup chat" : null);
      const one = await logged(async () => {
        const res = await deliver("payment_intent.succeeded", checkoutSale("fail_1", { name: "Ann <Smith> & Co", email: "ann@buyer.test" }), { id: "evt_fail_1" });
        await settled();
        return res;
      });
      assert.equal(one.result.status, 200, "the webhook still answers Stripe: the books come first");
      assert.equal(one.result.body.status, "processed");
      assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE stripe_charge_id = 'ch_fail_1'`), 1, "the payment is in the books");
      assert.ok(one.errors.some((line) => line.includes("the sales desk was not told of a purchase") && line.includes("ord_fail_1")), `the failure is logged: ${one.errors.join(" | ")}`);
      const cards = await cardsFor("ord_fail_1");
      assert.equal(cards.length, 1, "one card for the order");
      const card = cards[0];
      assert.equal(card.tenant_id, OASIS_OPERATOR_TENANT_ID, "in the OASIS workspace, where CC and Adon read Needs you");
      assert.equal(card.severity, "urgent");
      assert.equal(card.subject_type, "checkout_order");
      assert.match(String(card.title), /the sales desk was not told/);
      for (const part of [formatCad(750000), "Ann <Smith> & Co <ann@buyer.test>", "Order ord_fail_1", "Stripe pi_fail_1", "bot was kicked from the supergroup chat"]) {
        assert.ok(String(card.body).includes(part), `the card names ${part}: ${card.body}`);
      }
      assert.equal(telegramCalls, 3, "the sales group, then CC's DM, both refused; then the card paged CC's own bot");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].chat, "4242");
      assert.ok(sent[0].text.includes("the sales desk was not told") && sent[0].text.includes("Ann &lt;Smith&gt; &amp; Co"), sent[0].text);
      assert.equal(telegramOutcome(card), "Sent to Telegram", "the card records that the page reached CC");

      // Telegram refusing everything: the card is still the record.
      telegramRefuses = () => "Forbidden: bot was blocked by the user";
      sent.length = 0;
      const two = await logged(async () => {
        const res = await deliver("payment_intent.succeeded", checkoutSale("fail_2", { amount: 150000 }), { id: "evt_fail_2" });
        await settled();
        return res;
      });
      assert.equal(two.result.status, 200);
      assert.equal(sent.length, 0);
      const [card2] = await cardsFor("ord_fail_2");
      assert.ok(card2, "a card for the second order");
      assert.match(String(telegramOutcome(card2)), /^Not sent: Telegram said: Forbidden: bot was blocked by the user/, "the card says its own page failed too");
      assert.equal((await cardsFor("ord_fail_1")).length, 1, "the first order's card is its own");

      // A send that throws leaves a card too, and the same order failing again refreshes its card.
      const thrown = await logged(async () => {
        assert.equal(await alertPublicCheckoutPaid(purchase("fail_2"), async () => { throw new Error("telegram down"); }), false);
        assert.equal(await alertPublicCheckoutPaid(purchase("fail_3"), async () => { throw new Error("telegram down"); }), false);
      });
      assert.equal((await cardsFor("ord_fail_2")).length, 1, "one open card per order, however often its alert fails");
      assert.match(String((await cardsFor("ord_fail_3"))[0]?.body), /telegram down/, "a throwing send leaves a card with its reason");
      assert.ok(thrown.errors.some((line) => line.includes("ord_fail_3")), "and logs it");

      // The card store being down too: nothing throws, and the log still names the sale.
      await raw.execute(`ALTER TABLE agent_alerts RENAME TO agent_alerts_offline`);
      try {
        const down = await logged(() => alertPublicCheckoutPaid(purchase("fail_4"), async () => ({ delivered: false, outcome: "Not sent" })));
        assert.equal(down.result, false);
        assert.ok(down.errors.some((line) => line.includes("no card could be written") && line.includes("ord_fail_4") && line.includes("pi_fail_4") && line.includes("750000")), down.errors.join(" | "));
      } finally {
        await raw.execute(`ALTER TABLE agent_alerts_offline RENAME TO agent_alerts`);
      }

      // Input that breaks the words themselves: still nothing throws, and the log names the sale.
      const broken = await logged(() => alertPublicCheckoutPaid({ ...purchase("fail_5"), currency: undefined as unknown as string }, async () => ({ delivered: true, outcome: "Sent to Telegram" })));
      assert.equal(broken.result, false);
      assert.ok(broken.errors.some((line) => line.includes("could not leave a card") && line.includes("ord_fail_5") && line.includes("pi_fail_5")), broken.errors.join(" | "));
    });
  });

  await check("a buyer's 1,000-character name reaches the sales desk whole, and so does the page about a refused alert", async () => {
    // A message is cut at 4,096 characters, and 1,000 "&" escape to 5,000: the
    // cut fell inside "&amp;" and Telegram refused the alert (review of #718).
    const { alertPublicCheckoutPaid } = await import("../lib/checkout/paid-alert");
    const name = "&".repeat(1000);
    await withTelegram(async (sent) => {
      await deliver("payment_intent.succeeded", checkoutSale("noisy_1", { name, email: `${name}@buyer.test` }), { id: "evt_noisy_1" });
      await settled();
      assert.equal(sent.length, 1);
      assert.ok(wholeTelegramHtml(sent[0].text), `${sent[0].text.length} characters, ending ${sent[0].text.slice(-60)}`);
      assert.ok(sent[0].text.includes("Next: reach out to book the kickoff."), "nothing after the buyer was cut off");
    });
    // When the alert is refused, the card pages CC with the same buyer text, and
    // with the reason the send failed: both are cut too.
    await withTelegram(async (sent) => {
      telegramRefuses = ({ token }) => (token.startsWith("123456:") ? "Forbidden: bot was kicked from the supergroup chat" : null);
      await logged(async () => {
        await deliver("payment_intent.succeeded", checkoutSale("noisy_2", { name, email: `${name}@buyer.test` }), { id: "evt_noisy_2" });
        await settled();
        await alertPublicCheckoutPaid(purchase("noisy_3"), async () => {
          throw new Error(name);
        });
      });
      assert.equal(sent.length, 2, "CC's chat took both pages");
      for (const page of sent) {
        assert.ok(wholeTelegramHtml(page.text), `${page.text.length} characters, ending ${page.text.slice(-60)}`);
        assert.ok(page.text.includes("resolve this card."), "nothing after the cut text was lost");
      }
    });
  });

  await check("the purchase alert's words: an unknown offer says so, buyer text is cut before it is escaped, and a failed send never throws", async () => {
    const { paidAlertText, alertPublicCheckoutPaid, publicCheckoutSale } = await import("../lib/checkout/paid-alert");
    assert.equal(publicCheckoutSale({ metadata: { oasis_checkout: "something_else" } }), null);
    assert.equal(publicCheckoutSale(null), null);
    const base = { sale: { orderId: "o1", offerId: "nope", optionId: "x" }, paymentIntentId: "pi_words", amountCents: 12345, currency: "usd", customerName: "", customerEmail: "" };
    const text = paidAlertText(base);
    assert.match(text, /^New purchase on oasisai\.work\/pricing\n/);
    assert.ok(text.includes("nope / x (not in the catalog)"));
    assert.ok(text.includes("123.45 USD paid"));
    assert.ok(text.includes("Buyer: no name or email on the payment; see Stripe"));
    // The reconcile's late alert says so in its first line and is otherwise the same words.
    const late = paidAlertText({ ...base, late: true });
    assert.equal(late.split("\n")[0], "Late: a purchase on oasisai.work/pricing the webhook never reported");
    assert.equal(late.split("\n").slice(1).join("\n"), text.split("\n").slice(1).join("\n"), "the rest is the same words");
    // The buyer types the name and the email, and a message is cut at 4,096
    // characters: 1,000 "&" escape to 5,000 and the cut fell inside "&amp;",
    // which Telegram refuses (review of #718). Free text is cut BEFORE it is
    // escaped, so the whole message is far under the limit.
    const amps = "&".repeat(1000);
    const noisy = paidAlertText({ ...base, sale: { orderId: amps, offerId: amps, optionId: amps }, customerName: amps, customerEmail: `${amps}@buyer.test` });
    assert.ok(wholeTelegramHtml(noisy), `${noisy.length} characters`);
    assert.ok(noisy.includes(`Buyer: ${"&amp;".repeat(120)}... &lt;${"&amp;".repeat(254)}...&gt;`), "the name is kept to 120 characters and the email to 254");
    assert.ok(noisy.includes(`${"&amp;".repeat(64)}... / ${"&amp;".repeat(64)}... (not in the catalog)`), "an unknown offer's ids are kept to 64");
    assert.ok(noisy.includes(`Order ${"&amp;".repeat(64)}...\n`), "so is the order id");
    // A cut never lands inside an emoji, which would leave half of one in the JSON.
    const grin = String.fromCodePoint(0x1f600);
    const emoji = paidAlertText({ ...base, customerName: `a${grin.repeat(200)}` });
    assert.ok(emoji.includes(`Buyer: a${grin.repeat(119)}...`), "cut on a whole character");
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(emoji), "no half of an emoji");
    const failed = await logged(async () => {
      assert.equal(await alertPublicCheckoutPaid(base, async () => ({ delivered: false, outcome: "Not sent" })), false);
      assert.equal(await alertPublicCheckoutPaid(base, async () => { throw new Error("telegram down"); }), false);
    });
    assert.equal(failed.errors.filter((line) => line.includes("the sales desk was not told of a purchase")).length, 2, "each failed send is logged");
  });

  await check("the late-alert window opens after 30 minutes and closes before 48 hours, to the second", async () => {
    const { inLateAlertWindow } = await import("../lib/checkout/paid-alert");
    const now = Date.UTC(2026, 8, 24, 12, 0, 0);
    const at = (ageSec: number) => inLateAlertWindow(Math.floor(now / 1000) - ageSec, now);
    assert.deepEqual(
      [29 * 60 + 59, 30 * 60, 30 * 60 + 1, 47 * 3600 + 59 * 60 + 59, 48 * 3600, 48 * 3600 + 1].map(at),
      [false, false, true, true, false, false],
      "more than 30 minutes and less than 48 hours, neither end included",
    );
    assert.equal(at(-60), false, "an intent from the future is not late");
  });

  await check("the reconcile tells the sales desk, late and once, of a checkout purchase it booked itself 30 minutes to 48 hours after the intent; any other payment tells no one", async () => {
    // The webhook never reported these, so the reconcile books them (review of #718).
    const { cad: formatCad } = await import("../lib/checkout/catalog");
    const M = 60;
    const H = 3600;
    const cases: Array<{ n: string; ageSec: number; marked?: boolean; intent?: "bare" | "unreadable"; alert: boolean }> = [
      { n: "late_2h", ageSec: 2 * H, alert: true },
      { n: "late_just_over_30m", ageSec: 30 * M + 20, alert: true },
      { n: "late_just_under_48h", ageSec: 48 * H - M, alert: true },
      { n: "late_just_under_30m", ageSec: 29 * M + 40, alert: false },
      { n: "late_10m", ageSec: 10 * M, alert: false },
      { n: "late_just_over_48h", ageSec: 48 * H + M, alert: false },
      { n: "late_history", ageSec: 10 * 24 * H, alert: false },
      { n: "late_unmarked", ageSec: 2 * H, marked: false, alert: false },
      { n: "late_bare_intent", ageSec: 2 * H, intent: "bare", alert: false },
      { n: "late_unreadable_intent", ageSec: 2 * H, intent: "unreadable", alert: false },
    ];
    const toldAbout = cases.filter((c) => c.alert).map((c) => `ord_${c.n}`).sort();
    await withTelegram(async (sent) => {
      const run = await logged(() => reconcile(cases.map((c) => listedCharge(c.n, c))));
      assert.equal(run.result.payments_recorded, cases.length, "the reconcile books every one of them, announced or not");
      for (const c of cases) assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE stripe_charge_id = ?`, [`ch_${c.n}`]), 1, `${c.n} is in the books`);
      assert.deepEqual(sent.map((m) => /Order (ord_\w+)/.exec(m.text)?.[1]).sort(), toldAbout, "exactly the in-window checkout purchases are announced, once each");
      assert.equal(telegramCalls, toldAbout.length, "and nothing else reached Telegram");
      for (const m of sent) {
        assert.equal(m.chat, "-100777", "the sales group");
        assert.match(m.text, /^Late: a purchase on oasisai\.work\/pricing the webhook never reported\n/);
        assert.ok(m.text.includes(`${formatCad(750000)} paid`), m.text);
        assert.ok(m.text.includes("Buyer: Lia Late &lt;lia@buyer.test&gt;"), m.text);
        assert.ok(m.text.includes("Next: reach out to book the kickoff."));
      }
      assert.ok(!run.errors.some((line) => line.includes("[checkout.paid-alert]")), `no alert failure: ${run.errors.join(" | ")}`);
      assert.equal(keptAlive.length, 0, "the cron awaits the send: nothing is left to the platform");

      // A second run finds every payment in the books: nothing is announced twice.
      const again = await logged(() => reconcile(cases.map((c) => listedCharge(c.n, c))));
      assert.equal(again.result.payments_recorded, 0);
      assert.equal(sent.length, toldAbout.length, "a second reconcile tells no one again");
    });
    assert.equal(await count(`SELECT COUNT(*) FROM agent_alerts WHERE alert_type = 'checkout_purchase_alert_failed' AND subject_id LIKE 'ord_late_%'`), 0, "delivered, so no card");
  });

  await check("a checkout purchase the webhook already booked tells no one when the reconcile lists it", async () => {
    // charge.succeeded books the payment and never alerts; the reconcile then
    // finds it in the books (created: false).
    await withTelegram(async (sent) => {
      const listed = listedCharge("late_booked", { ageSec: 2 * 3600 });
      const booked = await deliver("charge.succeeded", { ...listed, payment_intent: "pi_late_booked" }, { id: "evt_late_booked" });
      assert.match(String((booked.body as { detail?: string }).detail), /^payment recorded /, JSON.stringify(booked.body));
      await settled();
      const run = await logged(() => reconcile([listed]));
      assert.equal(run.result.payments_recorded, 0, "the books already had it");
      assert.equal(sent.length, 0, "so no one is told");
      assert.equal(telegramCalls, 0);
    });
  });

  await check("a late alert Telegram refuses leaves the same card, and the reconcile still books the payment", async () => {
    const { OASIS_OPERATOR_TENANT_ID } = await import("../lib/platform-operator");
    await withTelegram(async (sent) => {
      // The sales bot is refused in every chat; CC's own bot still works.
      telegramRefuses = ({ token }) => (token.startsWith("123456:") ? "Forbidden: bot was kicked from the supergroup chat" : null);
      const run = await logged(() => reconcile([listedCharge("late_refused", { ageSec: 2 * 3600 })]));
      assert.equal(run.result.payments_recorded, 1, "the reconcile finished and booked the payment");
      assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE stripe_charge_id = 'ch_late_refused'`), 1);
      assert.ok(run.errors.some((line) => line.includes("the sales desk was not told of a purchase") && line.includes("ord_late_refused")), run.errors.join(" | "));
      const cards = (await raw.execute({ sql: `SELECT tenant_id, severity, title, body FROM agent_alerts WHERE alert_type = 'checkout_purchase_alert_failed' AND subject_id = 'ord_late_refused' AND resolved_at IS NULL` })).rows;
      assert.equal(cards.length, 1, "one card for the order");
      assert.equal(cards[0].tenant_id, OASIS_OPERATOR_TENANT_ID);
      assert.equal(cards[0].severity, "urgent");
      assert.match(String(cards[0].title), /the sales desk was not told/);
      for (const part of ["Order ord_late_refused", "Stripe pi_late_refused", "Lia Late <lia@buyer.test>", "bot was kicked from the supergroup chat"]) {
        assert.ok(String(cards[0].body).includes(part), `the card names ${part}: ${cards[0].body}`);
      }
      assert.equal(sent.length, 1, "only the card's page reached CC");
      assert.ok(sent[0].text.includes("the sales desk was not told") && !sent[0].text.startsWith("Late:"), sent[0].text);
    });
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
