/**
 * tests/finances-invoice-retainer.test.ts — one invoice, two prices: the
 * implementation (one-time, paid by Wise bank transfer) and the retainer
 * (monthly, paid by a Stripe RECURRING payment link).
 *
 * Runs the real modules against a REAL local libSQL file with migrations 180
 * and 184 applied, then applies migration 185 (NOT applied to any live
 * database) mid-run, so both sides of it are proven. The network is a router:
 * api.stripe.com and api.transferwise.com answer from fixtures (Stripe with
 * real idempotency-key replay, and a switch that answers 403 the way a
 * restricted key without Prices/Payment Links write does); anything else
 * throws. nodemailer is stubbed and records every email, so "nothing was
 * emailed" is counted, not assumed.
 *
 * Run: node --conditions=react-server --import tsx tests/finances-invoice-retainer.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(__dirname, "..");
const dbFile = join(mkdtempSync(join(tmpdir(), "finances-retainer-")), "test.db");
process.env.TURSO_DB_PATH = dbFile;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
for (const k of ["STRIPE_SECRET_KEY", "FOUNDERS_TENANT_IDS", "WISE_API_TOKEN", "WISE_PROFILE_ID", "INVOICE_FROM_EMAIL", "INVOICE_FROM_APP_PASSWORD", "INVOICE_FROM_NAME", "OASIS_MAIL_FROM", "OASIS_MAIL_APP_PASSWORD", "SUPPORT_GMAIL_USER", "SUPPORT_GMAIL_APP_PASSWORD"]) {
  delete process.env[k];
}
const PROFILE = "82000001";
process.env.WISE_API_TOKEN = "wise-test-token";
process.env.WISE_PROFILE_ID = PROFILE;
process.env.STRIPE_SECRET_KEY = "rk_live_retainer_test_only";
process.env.OASIS_MAIL_FROM = "billing@oasisai.work";
process.env.OASIS_MAIL_APP_PASSWORD = "test-only-password";

// ── the mailer: record, never send ─────────────────────────────────────────
type SentMail = { to: string; subject: string; text: string; html: string; attachments: Array<{ filename: string; content: Buffer }> };
const mails: SentMail[] = [];
let beforeMailSend: (() => Promise<void>) | null = null;
{
  const path = require.resolve("nodemailer");
  require.cache[path] = {
    id: path,
    filename: path,
    path: dirname(path),
    loaded: true,
    children: [],
    paths: [],
    exports: {
      createTransport: () => ({
        sendMail: async (m: SentMail) => {
          if (beforeMailSend) await beforeMailSend();
          mails.push(m);
          return { messageId: `<test-${mails.length}@oasisai.work>` };
        },
      }),
    },
  } as unknown as NodeModule;
}

// ── the network ────────────────────────────────────────────────────────────
type Json = Record<string, unknown>;
type StripeCall = { method: string; path: string; params: Record<string, string>; idem: string | null };
const stripeCalls: StripeCall[] = [];
/** GETs (a stored link's state), kept apart so "no Stripe write" still counts writes only. */
const stripeReads: string[] = [];
const stripe = {
  denyPricesAndLinks: false,
  /** Prices write granted, Payment Links still denied. */
  denyLinksOnly: false,
  /** Any other Stripe failure (400/401/404/409/429/5xx) on price and payment-link calls; `reads` also fails the GETs. */
  failWith: null as null | { status: number; message: string; reads?: boolean },
  /** Called on every Stripe write, before it is answered: lets a check look at the database at that moment. */
  onWrite: null as null | ((path: string) => Promise<void>),
  seq: 0,
  replay: new Map<string, Json>(),
  /** Every product Stripe made, including whether cleanup archived it. */
  products: new Map<string, Json>(),
  /** Every price Stripe made, as GET /v1/prices/:id returns it. */
  prices: new Map<string, Json>(),
  /** Stripe's live state of every payment link, as GET returns it. */
  links: new Map<string, { id: string; url: string; active: boolean; priceId: string; restrictions: { completed_sessions: { count: number; limit: number } } }>(),
};
/** What Stripe does when the client completes the checkout on a one-checkout link: counts it and switches the link off. */
function clientSubscribes(linkId: string) {
  const l = stripe.links.get(linkId)!;
  l.restrictions.completed_sessions.count += 1;
  if (l.restrictions.completed_sessions.count >= l.restrictions.completed_sessions.limit) l.active = false;
}
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
const statement = (cur: string) => ({
  accountHolder: { type: "BUSINESS", businessName: "OASISAI" },
  bankDetails: cur === "CAD" ? [cadDetails] : [],
  transactions: [],
  startOfStatementBalance: { value: 0, currency: cur },
  endOfStatementBalance: { value: 0, currency: cur },
});

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.host === "api.transferwise.com") {
    if (url.pathname === `/v4/profiles/${PROFILE}/balances`) {
      return json([
        { id: 11, currency: "CAD", amount: { value: 100, currency: "CAD" } },
        { id: 12, currency: "USD", amount: { value: 10, currency: "USD" } },
      ]);
    }
    const m = /^\/v1\/profiles\/\d+\/balance-statements\/(\d+)\/statement\.json$/.exec(url.pathname);
    if (m) return json(statement(m[1] === "11" ? "CAD" : "USD"));
    return json({ error: "not_found" }, 404);
  }
  if (url.host === "api.stripe.com") {
    const method = (init?.method || "GET").toUpperCase();
    const headers = (init?.headers || {}) as Record<string, string>;
    const idem = headers["Idempotency-Key"] ?? null;
    const params = Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : ""));
    if (method === "GET" && url.pathname === "/v1/account") return json({ id: "acct_test_oasis", settings: { dashboard: { display_name: "OASIS AI" } } });
    if (stripe.failWith && (method === "POST" || stripe.failWith.reads) && (url.pathname.startsWith("/v1/prices") || url.pathname.startsWith("/v1/payment_links"))) {
      if (method === "POST") stripeCalls.push({ method, path: url.pathname, params, idem });
      return json({ error: { type: "api_error", message: stripe.failWith.message } }, stripe.failWith.status);
    }
    if (method === "GET" && url.pathname.startsWith("/v1/products/")) {
      stripeReads.push(url.pathname);
      const p = stripe.products.get(url.pathname.split("/").pop() as string);
      return p ? json(structuredClone(p)) : json({ error: { message: "No such product" } }, 404);
    }
    if (method === "GET" && url.pathname.startsWith("/v1/prices/")) {
      stripeReads.push(url.pathname);
      const p = stripe.prices.get(url.pathname.split("/").pop() as string);
      return p ? json(structuredClone(p)) : json({ error: { message: "No such price" } }, 404);
    }
    if (method === "GET" && /\/v1\/payment_links\/[^/]+\/line_items$/.test(url.pathname)) {
      stripeReads.push(url.pathname);
      const id = url.pathname.split("/").at(-2) as string;
      const l = stripe.links.get(id);
      return l ? json({ object: "list", data: [{ object: "item", quantity: 1, price: { id: l.priceId } }], has_more: false }) : json({ error: { message: "No such payment_link" } }, 404);
    }
    if (method === "GET" && url.pathname.startsWith("/v1/payment_links/")) {
      stripeReads.push(url.pathname);
      const l = stripe.links.get(url.pathname.split("/").pop() as string);
      return l ? json({ object: "payment_link", livemode: true, ...structuredClone(l) }) : json({ error: { message: "No such payment_link" } }, 404);
    }
    if (method !== "POST") return json({ error: { message: "unexpected" } }, 404);
    stripeCalls.push({ method, path: url.pathname, params, idem });
    if (stripe.onWrite) await stripe.onWrite(url.pathname);
    // Stripe replays a request made with the same idempotency key.
    if (idem && stripe.replay.has(idem)) return json(stripe.replay.get(idem));
    const denied =
      (stripe.denyPricesAndLinks && (url.pathname === "/v1/prices" || url.pathname.startsWith("/v1/payment_links"))) ||
      (stripe.denyLinksOnly && url.pathname.startsWith("/v1/payment_links"));
    if (denied) {
      return json(
        {
          error: {
            type: "invalid_request_error",
            message:
              "The provided key 'rk_live_*********only' does not have the required permissions for this endpoint on account 'acct_test_oasis'. Having the 'rak_price_write' permission would allow this request to continue.",
          },
        },
        403,
      );
    }
    let body: Json;
    const n = ++stripe.seq;
    if (url.pathname === "/v1/products") {
      body = { id: `prod_${n}`, object: "product", name: params.name, livemode: true, active: true };
      stripe.products.set(body.id as string, body);
    }
    else if (url.pathname === "/v1/prices") {
      body = {
        id: `price_${n}`,
        object: "price",
        livemode: true,
        active: true,
        unit_amount: Number(params.unit_amount),
        currency: params.currency,
        product: params.product || null,
        recurring: params["recurring[interval]"] ? { interval: params["recurring[interval]"], interval_count: Number(params["recurring[interval_count]"] || 1) } : null,
      };
      stripe.prices.set(body.id as string, body);
    } else if (url.pathname === "/v1/payment_links") {
      const limit = Number(params["restrictions[completed_sessions][limit]"] || 0);
      const l = { id: `plink_${n}`, url: `https://buy.stripe.com/link_${n}`, active: true, priceId: params["line_items[0][price]"] || "", restrictions: { completed_sessions: { count: 0, limit } } };
      stripe.links.set(l.id, l);
      body = { object: "payment_link", livemode: true, ...structuredClone(l) };
    } else if (url.pathname.startsWith("/v1/payment_links/")) {
      const id = url.pathname.split("/").pop() as string;
      const l = stripe.links.get(id);
      if (l && params.active !== undefined) l.active = params.active !== "false";
      body = { id, object: "payment_link", active: l ? l.active : params.active !== "false" };
    } else if (url.pathname.startsWith("/v1/prices/")) {
      const id = url.pathname.split("/").pop() as string;
      const p = stripe.prices.get(id);
      if (p && params.active !== undefined) p.active = params.active !== "false";
      body = { id, object: "price", active: p?.active ?? params.active !== "false" };
    } else if (url.pathname.startsWith("/v1/products/")) {
      const id = url.pathname.split("/").pop() as string;
      const p = stripe.products.get(id);
      if (p && params.active !== undefined) p.active = params.active !== "false";
      body = { id, object: "product", active: p?.active ?? params.active !== "false" };
    } else return json({ error: { message: `unexpected ${url.pathname}` } }, 404);
    if (idem) stripe.replay.set(idem, body);
    return json(body);
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

/** Run one mutation immediately before the first matching local write batch. */
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
    return { result: await fn(), raced };
  } finally {
    delete client.batch;
  }
}

/** Run one mutation immediately before the first matching single DB execute. */
async function withExecuteRace<T>(match: (statementJson: string) => boolean, race: () => Promise<void>, fn: () => Promise<T>): Promise<{ result: T; raced: boolean }> {
  const { getTursoClient } = await import("../lib/turso");
  const client = getTursoClient() as unknown as Record<string, unknown>;
  const original = (Object.getPrototypeOf(client) as { execute: (...a: unknown[]) => Promise<unknown> }).execute;
  let raced = false;
  client.execute = async function (this: unknown, statement: unknown, ...rest: unknown[]) {
    if (!raced && match(JSON.stringify(statement))) {
      raced = true;
      await race();
    }
    return original.call(this, statement, ...rest);
  };
  try {
    return { result: await fn(), raced };
  } finally {
    delete client.execute;
  }
}

const cc = { kind: "founder" as const, ownerKey: "cc" as const, email: "conaugh@oasisai.work", userId: "u-cc" };

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
  return out.replace(/\s+/g, " ");
}

const RETAINER_REFUSED =
  "Stripe won't let this app create the retainer's card link yet: give the OASIS restricted key write access to Prices and Payment Links in Stripe → Developers → API keys, then send again. Nothing was emailed.";
const CARD_REFUSED =
  "Stripe won't let this app create the invoice's card payment link yet: give the OASIS restricted key write access to Prices and Payment Links in Stripe → Developers → API keys, then send again. Nothing was emailed.";

async function main() {
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(readFileSync(join(root, "database/turso/180_founders_finances.turso.sql"), "utf8"));
  // Stripe ingest writes the Business Ledger in its own batches (bravo__190); the books read Stripe payouts and the payout account (bravo__193).
  await raw.executeMultiple(readFileSync(join(root, "database/turso/bravo__190_ledger_core.sql"), "utf8"));
  await raw.executeMultiple(readFileSync(join(root, "database/turso/bravo__193_stripe_payouts.sql"), "utf8"));
  await raw.executeMultiple(readFileSync(join(root, "database/turso/184_finance_wise_payments.turso.sql"), "utf8"));
  await raw.executeMultiple(readFileSync(join(root, "database/turso/bravo__226_finance_invoice_send_claim.sql"), "utf8"));

  const { addDays, torontoToday } = await import("../lib/founders-finances/fx");
  const today = torontoToday();
  const inv = await import("../lib/founders-finances/invoice");
  const paymentMethods = await import("../lib/founders-finances/wise");
  const { composeInvoiceEmail } = await import("../lib/founders-finances/invoice-email");
  const { renderInvoicePdf } = await import("../lib/founders-finances/invoice-pdf");
  const { ensureFinanceSeed } = await import("../lib/founders-finances/seed-io");
  const access = await import("../lib/founders-finances/access-io");
  const invoices = await import("../lib/founders-finances/invoices-io");
  const stripeIngest = await import("../lib/founders-finances/stripe-ingest");
  const { chargeFacts } = await import("../lib/founders-finances/stripe-map");
  const store = await import("../lib/founders-finances/invoice-store");
  const { accountId, SYS, BUSINESS_ENTITY_ID: B } = await import("../lib/founders-finances/chart");

  await ensureFinanceSeed();
  await raw.execute({ sql: `UPDATE fin_settings SET stripe_account_id = 'acct_test_oasis' WHERE entity_id = ?`, args: [B] });

  const one = async <T = Record<string, unknown>>(sql: string, args: Array<string | number> = []) => (await raw.execute({ sql, args })).rows[0] as unknown as T;
  const count = async (sql: string, args: Array<string | number> = []) => Number((await raw.execute({ sql, args })).rows[0][0]);
  const row = async (id: string) => (await store.loadInvoice(id))!;
  const ar = accountId(B, SYS.ar);
  const lastMail = () => mails[mails.length - 1];
  const pdfOf = async (m: SentMail) => pdfText(new Uint8Array(m.attachments[0].content));
  const stripeSince = (mark: number, path?: string) => stripeCalls.slice(mark).filter((c) => (path ? c.path === path : true));

  await check("payment modes: Stripe supports one-time/monthly/both, Wise is one-time only, Hybrid requires both rails", async () => {
    const valid = (method: "wise" | "stripe" | "wise_stripe", oneTimeCents: number, monthlyCents: number) =>
      paymentMethods.invoicePaymentModeError(method, { oneTimeCents, monthlyCents });
    assert.equal(valid("stripe", 100, 0), null);
    assert.equal(valid("stripe", 0, 100), null);
    assert.equal(valid("stripe", 100, 100), null);
    assert.equal(valid("wise", 100, 0), null);
    assert.match(String(valid("wise", 0, 100)), /one-time amount/i);
    assert.match(String(valid("wise", 100, 100)), /monthly retainer.*Hybrid/i);
    assert.match(String(valid("wise_stripe", 100, 0)), /both.*one-time implementation.*monthly retainer/i);
    assert.match(String(valid("wise_stripe", 0, 100)), /both.*one-time implementation.*monthly retainer/i);
    assert.equal(valid("wise_stripe", 100, 100), null);
    assert.equal(paymentMethods.PAYMENT_METHOD_LABEL.wise_stripe, "Hybrid — implementation by bank + monthly retainer by card");
    assert.equal(paymentMethods.offersCard("wise_stripe"), false);
    assert.equal(paymentMethods.offersBankTransfer("wise_stripe"), true);
  });

  // ── pure: the split ─────────────────────────────────────────────────────
  await check("totals: one-time and monthly are totalled separately; with no monthly line nothing changes", async () => {
    const mixed = inv.computeInvoiceTotals(
      [
        { description: "Implementation", quantity: "1", unitPrice: "2000.00" },
        { description: "Retainer", quantity: "1", unitPrice: "500.00", billing: "monthly" },
      ],
      { registered: false },
    );
    assert.equal(mixed.totalCents, 200000, "top level = one-time only");
    assert.equal(mixed.subtotalCents, 200000);
    assert.equal(mixed.monthly.totalCents, 50000);
    assert.deepEqual(mixed.lines.map((l) => l.billing), ["one_time", "monthly"]);

    const taxed = inv.computeInvoiceTotals(
      [
        { description: "Implementation", quantity: "1", unitPrice: "1000.00" },
        { description: "Retainer", quantity: "1", unitPrice: "200.00", billing: "monthly" },
      ],
      { registered: true },
    );
    assert.deepEqual([taxed.gstCents, taxed.qstCents, taxed.totalCents], [5000, 9975, 114975], "tax on the one-time part only");
    assert.deepEqual([taxed.monthly.gstCents, taxed.monthly.qstCents, taxed.monthly.totalCents], [1000, 1995, 22995], "the retainer carries its own tax");

    const allMonthly = inv.computeInvoiceTotals([{ description: "Retainer", quantity: "1", unitPrice: "750", billing: "monthly" }], { registered: false });
    assert.equal(allMonthly.totalCents, 0);
    assert.equal(allMonthly.monthly.totalCents, 75000);

    const plain = inv.computeInvoiceTotals([{ description: "Build", quantity: "2", unitPrice: "100" }], { registered: false });
    assert.equal(plain.totalCents, 20000);
    assert.deepEqual(plain.monthly, { subtotalCents: 0, taxableSubtotalCents: 0, gstCents: 0, qstCents: 0, totalCents: 0 });
    assert.throws(() => inv.computeInvoiceTotals([{ description: "x", quantity: "1", unitPrice: "1", billing: "weekly" as never }], { registered: false }), /one-time or monthly/);
  });

  await check("status: nothing due now is never overdue; a one-time balance still is", async () => {
    assert.equal(inv.effectiveInvoiceStatus({ status: "sent", dueDate: "2026-01-01", totalCents: 0, amountPaidCents: 0 }, "2026-09-24"), "sent");
    assert.equal(inv.effectiveInvoiceStatus({ status: "sent", dueDate: "2026-01-01", totalCents: 100, amountPaidCents: 0 }, "2026-09-24"), "overdue");
    assert.equal(inv.hasAmountDueNow({ totalCents: 0, retainerMonthlyCents: 50000 }), false, "retainer-only");
    assert.equal(inv.hasAmountDueNow({ totalCents: 0, retainerMonthlyCents: 0 }), true, "no retainer: today's behaviour");
    assert.equal(inv.hasAmountDueNow({ totalCents: 100, retainerMonthlyCents: 50000 }), true);
    assert.deepEqual(
      [inv.oneTimePayVerb(true, false), inv.oneTimePayVerb(true, true), inv.oneTimePayVerb(false, true), inv.oneTimePayVerb(false, false)],
      ["pay by bank transfer", "pay by bank transfer or card", "pay by card", "pay as follows"],
    );
  });

  await check("founder lifecycle: Draft, Issued, Partially paid, Paid, Void, retainer-only, and overdue as a warning", async () => {
    const state = (
      status: "draft" | "sent" | "overdue" | "paid" | "void",
      totalCents: number,
      amountPaidCents: number,
      retainerMonthlyCents = 0,
      dueDate = "2026-10-20",
    ) => inv.invoiceDisplayState({ status, dueDate, totalCents, amountPaidCents, retainerMonthlyCents }, "2026-10-14");

    assert.deepEqual(state("draft", 10000, 0), { displayStatus: "draft", isOverdue: false });
    assert.deepEqual(state("sent", 10000, 0), { displayStatus: "issued", isOverdue: false });
    assert.deepEqual(state("sent", 10000, 2500), { displayStatus: "partially_paid", isOverdue: false });
    assert.deepEqual(state("sent", 10000, 10000), { displayStatus: "paid", isOverdue: false });
    assert.deepEqual(state("void", 10000, 0), { displayStatus: "void", isOverdue: false });
    assert.deepEqual(state("sent", 0, 0, 50000), { displayStatus: "retainer", isOverdue: false });
    assert.deepEqual(state("sent", 10000, 0, 0, "2026-10-13"), { displayStatus: "issued", isOverdue: true });
    assert.deepEqual(state("sent", 10000, 2500, 0, "2026-10-13"), { displayStatus: "partially_paid", isOverdue: true });
  });

  await check("email/PDF composer: no retainer = byte-for-byte today's email", async () => {
    const args = {
      kind: "invoice" as const,
      sellerName: "OASIS AI Solutions",
      customerName: "Acme",
      number: "OASIS-2026-0011",
      totalCents: 100000,
      balanceCents: 100000,
      currency: "CAD",
      dueDate: "2026-10-08",
      paymentLinkUrl: "https://buy.stripe.com/x",
      paymentInstructions: "",
      bankTransfer: null,
    };
    assert.deepEqual(composeInvoiceEmail({ ...args, retainer: null }), composeInvoiceEmail(args));
    assert.deepEqual(composeInvoiceEmail({ ...args, retainer: { monthlyCents: 0, linkUrl: "https://x" } }), composeInvoiceEmail(args), "a zero retainer is no retainer");
    const plainPdf = await pdfText(
      await renderInvoicePdf({
        seller: { legalName: "OASIS AI Solutions", addressLines: [], email: "", gstNumber: "", qstNumber: "" },
        invoice: { number: "OASIS-2026-0011", status: "sent", issueDate: "2026-09-24", dueDate: "2026-10-08", currency: "CAD", subtotalCents: 100000, gstCents: 0, qstCents: 0, totalCents: 100000, amountPaidCents: 0, taxRegistered: false, notes: "", paymentLinkUrl: null, paymentInstructions: "" },
        customer: { name: "Acme", company: "", email: "", address: "" },
        lines: [{ description: "Build", quantityMilli: 1000, unitPriceCents: 100000, amountCents: 100000 }],
      }),
    );
    assert.match(plainPdf, /Total CAD/);
    assert.doesNotMatch(plainPdf, /Due now|retainer|\/mo/i);
  });

  // ── before migration 185 ─────────────────────────────────────────────────
  let preId = "";
  await check("before migration 185: every line is one-time, a monthly line is refused in plain English, the flow is today's", async () => {
    store.resetRetainerColumnMemo();
    assert.equal(await store.retainerColumnsReady(), false);
    await assert.rejects(
      invoices.createDraftInvoice(cc, "oasis", {
        new_contact: { name: "Early", email: "ap@early.test" },
        currency: "CAD",
        lines: [{ description: "Retainer", quantity: 1, unit_price: "500", billing: "monthly" }],
      }),
      (e: unknown) => e instanceof access.FinanceInputError && /migration 185/.test(e.message) && /one-time/.test(e.message),
    );
    preId = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Old Style", email: "ap@oldstyle.test" },
      currency: "CAD",
      lines: [
        { description: "Build", quantity: 1, unit_price: "900" },
        { description: "Setup", quantity: 1, unit_price: "100", billing: "one_time" },
      ],
    });
    const d = await row(preId);
    assert.equal(d.total_cents, 100000);
    assert.equal("retainer_monthly_cents" in d, false, "no retainer column is read or written");
    assert.equal("billing" in (await store.loadInvoiceLines(preId))[0], false);
    const mark = stripeCalls.length;
    const sent = await invoices.sendInvoice(cc, preId);
    assert.equal(sent.retainerLinkUrl, null);
    assert.equal(sent.bankTransfer, true);
    assert.equal(stripeSince(mark).length, 0, "a Wise invoice with no retainer touches no Stripe write");
    const m = lastMail();
    assert.match(m.text, /Pay by bank transfer \(Wise\):/);
    assert.doesNotMatch(m.text, /retainer|Implementation —/i);
    const f = await row(preId);
    const expected = composeInvoiceEmail({
      kind: "invoice",
      sellerName: (await one<{ legal_name: string }>(`SELECT legal_name FROM fin_settings WHERE entity_id = ?`, [B])).legal_name,
      customerName: "Old Style",
      number: f.number as string,
      totalCents: 100000,
      balanceCents: 100000,
      currency: "CAD",
      dueDate: f.due_date,
      paymentLinkUrl: null,
      paymentInstructions: "",
      bankTransfer: m.text.includes("Institution number") ? invoicesBankLines(m.text) : null,
    });
    assert.equal(m.text, expected.text, "the pre-185 invoice email is exactly today's composition");
    const recog = await one<{ d: number; c: number }>(
      `SELECT SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM fin_journal_lines WHERE entry_id = ?`,
      [f.recognition_entry_id as string],
    );
    assert.deepEqual([Number(recog.d), Number(recog.c)], [100000, 100000]);
  });

  // ── migration 185 ────────────────────────────────────────────────────────
  await check("migration 185 applies additively: old lines read one-time, old invoices have no retainer, the CHECKs hold", async () => {
  await raw.executeMultiple(readFileSync(join(root, "database/turso/185_finance_invoice_retainer.turso.sql"), "utf8"));
    store.resetRetainerColumnMemo();
    assert.equal(await store.retainerColumnsReady(), true);
    assert.equal((await store.loadInvoiceLines(preId))[0].billing, "one_time");
    assert.equal(Number((await row(preId)).retainer_monthly_cents), 0);
    await assert.rejects(raw.execute({ sql: `UPDATE fin_invoice_lines SET billing = 'weekly' WHERE invoice_id = ?`, args: [preId] }), /CHECK constraint/);
    await assert.rejects(raw.execute({ sql: `UPDATE fin_invoices SET retainer_monthly_cents = -1 WHERE id = ?`, args: [preId] }), /CHECK constraint/);
  });

  await check("draft writes reject dishonest payment-mode and line combinations; an old invalid draft cannot issue until corrected", async () => {
    const base = (name: string, payment_method: "wise" | "stripe" | "wise_stripe", lines: Json[]) => ({
      new_contact: { name, email: `${name.toLowerCase().replace(/\s+/g, "-")}@example.test` },
      currency: "CAD",
      payment_method,
      lines,
    });
    const oneTime = [{ description: "Implementation", quantity: 1, unit_price: "100" }];
    const monthly = [{ description: "Retainer", quantity: 1, unit_price: "50", billing: "monthly" }];
    const both = [...oneTime, ...monthly];
    await assert.rejects(invoices.createDraftInvoice(cc, "oasis", base("Wise monthly", "wise", monthly)), /one-time amount/i);
    await assert.rejects(invoices.createDraftInvoice(cc, "oasis", base("Wise mixed", "wise", both)), /monthly retainer.*Hybrid/i);
    await assert.rejects(invoices.createDraftInvoice(cc, "oasis", base("Hybrid once", "wise_stripe", oneTime)), /both.*one-time implementation.*monthly retainer/i);
    await assert.rejects(invoices.createDraftInvoice(cc, "oasis", base("Hybrid monthly", "wise_stripe", monthly)), /both.*one-time implementation.*monthly retainer/i);

    const legacy = await invoices.createDraftInvoice(cc, "oasis", base("Legacy invalid", "wise", oneTime));
    await raw.execute({ sql: `UPDATE fin_invoices SET payment_method = 'wise_stripe' WHERE id = ?`, args: [legacy] });
    await assert.rejects(invoices.finalizeInvoice(cc, legacy), /both.*one-time implementation.*monthly retainer/i);
    await assert.rejects(invoices.sendInvoice(cc, legacy), /both.*one-time implementation.*monthly retainer/i);
    const legacyRow = await row(legacy);
    await invoices.updateDraftInvoice(cc, legacy, {
      contact_id: legacyRow.contact_id,
      currency: "CAD",
      payment_method: "wise_stripe",
      lines: both,
    });
    assert.equal((await row(legacy)).status, "draft", "an invalid old draft remains editable so it can be corrected");
  });

  await check("invoice list/detail expose founder lifecycle and founder plus legacy filters stay valid", async () => {
    const make = async (name: string, monthly = false) =>
      invoices.createDraftInvoice(cc, "oasis", {
        new_contact: { name, email: `${name.toLowerCase().replace(/\s+/g, "-")}@example.test` },
        currency: "CAD",
        payment_method: monthly ? "stripe" : "wise",
        lines: [{ description: monthly ? "Monthly service" : "Project", quantity: 1, unit_price: "100.00", ...(monthly ? { billing: "monthly" } : {}) }],
      });
    const issuedId = await make("Lifecycle Issued");
    const partialId = await make("Lifecycle Partial");
    const paidId = await make("Lifecycle Paid");
    const retainerId = await make("Lifecycle Retainer", true);
    try {
      await raw.batch([
        { sql: `UPDATE fin_invoices SET status = 'sent', due_date = ?, amount_paid_cents = 0 WHERE id = ?`, args: [addDays(today, 1), issuedId] },
        { sql: `UPDATE fin_invoices SET status = 'sent', due_date = ?, amount_paid_cents = 2500 WHERE id = ?`, args: [addDays(today, -1), partialId] },
        { sql: `UPDATE fin_invoices SET status = 'sent', due_date = ?, amount_paid_cents = total_cents WHERE id = ?`, args: [addDays(today, -1), paidId] },
        { sql: `UPDATE fin_invoices SET status = 'sent', due_date = ?, amount_paid_cents = 0 WHERE id = ?`, args: [addDays(today, -1), retainerId] },
      ]);

      const all = await invoices.listInvoices(cc, "oasis");
      const lifecycle = (id: string) => {
        const found = all.find((item) => item.id === id);
        assert.ok(found);
        return found;
      };
      assert.deepEqual(
        [lifecycle(issuedId).display_status, lifecycle(issuedId).is_overdue, lifecycle(issuedId).list_status],
        ["issued", false, "sent"],
      );
      assert.deepEqual(
        [lifecycle(partialId).display_status, lifecycle(partialId).is_overdue, lifecycle(partialId).list_status],
        ["partially_paid", true, "overdue"],
      );
      assert.deepEqual(
        [lifecycle(paidId).display_status, lifecycle(paidId).is_overdue, lifecycle(paidId).list_status],
        ["paid", false, "paid"],
      );
      assert.deepEqual(
        [lifecycle(retainerId).display_status, lifecycle(retainerId).is_overdue, lifecycle(retainerId).list_status],
        ["retainer", false, "retainer"],
      );

      assert.ok((await invoices.listInvoices(cc, "oasis", "issued")).some((item) => item.id === issuedId), "founder Issued filter");
      assert.ok((await invoices.listInvoices(cc, "oasis", "partially_paid")).some((item) => item.id === partialId), "founder Partially paid filter");
      assert.ok((await invoices.listInvoices(cc, "oasis", "sent")).some((item) => item.id === issuedId), "legacy sent filter");
      assert.ok((await invoices.listInvoices(cc, "oasis", "overdue")).some((item) => item.id === partialId), "legacy overdue filter");

      const detail = await invoices.getInvoiceDetail(cc, partialId);
      assert.deepEqual([detail.displayStatus, detail.isOverdue, detail.listStatus], ["partially_paid", true, "overdue"]);
    } finally {
      await raw.execute({
        sql: `UPDATE fin_invoices SET status = 'draft', amount_paid_cents = 0 WHERE id IN (?, ?, ?, ?)`,
        args: [issuedId, partialId, paidId, retainerId],
      });
    }
  });

  // ── mixed invoice: implementation + retainer ─────────────────────────────
  const mixedLines = [
    { description: "AI receptionist implementation", quantity: 1, unit_price: "2000.00" },
    { description: "Monthly retainer: hosting, support, tuning", quantity: 1, unit_price: "500.00", billing: "monthly" },
  ];
  let mixedId = "";
  await check("a mixed draft stores the one-time total as the invoice total and the retainer separately", async () => {
    mixedId = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Acme Dental", email: "ap@acme.test" }, currency: "CAD", payment_method: "wise_stripe", lines: mixedLines });
    const d = await row(mixedId);
    assert.equal(d.total_cents, 200000);
    assert.equal(Number(d.retainer_monthly_cents), 50000);
    assert.equal(d.payment_method, "wise_stripe");
    assert.deepEqual((await store.loadInvoiceLines(mixedId)).map((l) => l.billing), ["one_time", "monthly"]);
    const list = await invoices.listInvoices(cc, "oasis");
    const r = list.find((x) => x.id === mixedId)!;
    assert.equal(r.retainer_cents, 50000);
    assert.equal(r.balance_cents, 200000, "the balance is the one-time part only");
  });

  await check("a Stripe 403 refuses the send in one plain sentence, emails nothing, and leaves a DRAFT: no number used, nothing booked", async () => {
    stripe.denyPricesAndLinks = true;
    try {
      const before = mails.length;
      const nextNumber = async () => Number((await one<{ n: number }>(`SELECT invoice_next_number AS n FROM fin_settings WHERE entity_id = ?`, [B])).n);
      const seq = await nextNumber();
      await assert.rejects(invoices.sendInvoice(cc, mixedId), (e: unknown) => e instanceof access.FinanceInputError && e.message === RETAINER_REFUSED);
      assert.equal(mails.length, before, "nothing was emailed");
      const d = await row(mixedId);
      assert.equal(d.sent_at, null);
      assert.equal(d.stripe_retainer_link_url, null);
      assert.equal(d.status, "draft", "the links are made BEFORE the invoice is numbered: a refused link leaves a draft, never an issued invoice nobody was sent");
      assert.equal(d.number, null);
      assert.equal(d.recognition_entry_id, null);
      assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source_ref = ?`, [mixedId]), 0, "no receivable booked");
      assert.equal(await nextNumber(), seq, "no invoice number used up");

      // The one-off card link path says the same kind of sentence (it used to surface Stripe's raw 403), and stays a draft too.
      const cardId = await invoices.createDraftInvoice(cc, "oasis", {
        new_contact: { name: "Card Only", email: "ap@cardonly.test" },
        currency: "CAD",
        payment_method: "stripe",
        lines: [{ description: "Audit", quantity: 1, unit_price: "300" }],
      });
      await assert.rejects(invoices.sendInvoice(cc, cardId), (e: unknown) => e instanceof access.FinanceInputError && e.message === CARD_REFUSED);
      assert.equal(mails.length, before, "still nothing emailed");
      const c = await row(cardId);
      assert.deepEqual([c.status, c.number, c.recognition_entry_id], ["draft", null, null]);
      assert.equal(await nextNumber(), seq);
      const { financeErrorResponse } = await import("../lib/founders-finances/http");
      const res = financeErrorResponse(new access.FinanceInputError(RETAINER_REFUSED), "test");
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { ok: false, error: "invalid_input", message: RETAINER_REFUSED }, "the founder sees the sentence, not a raw error");
    } finally {
      stripe.denyPricesAndLinks = false;
    }
  });

  await check("every other Stripe failure (400/401/404/409/429/5xx) reaches the founder as one plain sentence; Stripe's own words stay in the server log", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Massive Dynamic", email: "ap@massive.test" }, currency: "CAD", payment_method: "wise_stripe", lines: mixedLines });
    const RAW = "Invalid API Key provided: rk_live_*********only";
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...a: unknown[]) => {
      logged.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" "));
    };
    const why: Record<number, RegExp> = {
      400: /Stripe said the request was invalid: check the amounts and details, then send again/,
      401: /Stripe rejected the OASIS Stripe key .*: replace it with a current restricted key .*, then send again/,
      404: /Stripe couldn't find what it was asked for .*: check the key is OASIS's live key .*, then send again/,
      409: /Stripe was still busy with another request .*: wait a few seconds, then send again/,
      429: /Stripe is limiting how fast this app can make requests: wait a minute, then send again/,
      500: /Stripe had a problem on its side: send again in a few minutes/,
      503: /Stripe had a problem on its side: send again in a few minutes/,
    };
    try {
      for (const [status, re] of Object.entries(why)) {
        stripe.failWith = { status: Number(status), message: `${RAW} [${status}]` };
        const before = mails.length;
        logged.length = 0;
        await assert.rejects(invoices.sendInvoice(cc, id), (e: unknown) => {
          assert.ok(e instanceof access.FinanceInputError, `${status}: a founder-facing sentence, not ${String(e)}`);
          const msg = (e as Error).message;
          assert.match(msg, /^The retainer's card link couldn't be set up because /, `${status}: says what failed`);
          assert.match(msg, re, `${status}: says why and what to do — ${msg}`);
          assert.ok(msg.endsWith("Nothing was emailed."), msg);
          assert.doesNotMatch(msg, /HTTP|Stripe POST|rk_live|Invalid API Key|\/v1\//, `${status}: none of Stripe's raw words`);
          return true;
        });
        assert.equal(mails.length, before, `${status}: nothing was emailed`);
        assert.equal((await row(id)).status, "draft", `${status}: still a draft`);
        assert.ok(logged.some((l) => l.includes(`${RAW} [${status}]`)), `${status}: Stripe's message is in the server log`);
      }
      // Through any Finances route (financeErrorResponse): a plain sentence, the raw message logged only.
      const { financeErrorResponse } = await import("../lib/founders-finances/http");
      const { StripeApiError } = await import("../lib/founders-finances/stripe-io");
      for (const status of [400, 401, 403, 404, 409, 429, 500]) {
        logged.length = 0;
        const res = financeErrorResponse(new StripeApiError(status, null, `Stripe POST /v1/prices failed: HTTP ${status} — ${RAW}`), "test");
        const body = (await res.json()) as { error: string; message: string };
        assert.equal(body.error, "stripe_error");
        assert.match(body.message, /^The request to Stripe failed because /);
        assert.doesNotMatch(body.message, /HTTP|Stripe POST|rk_live|Invalid API Key|\/v1\//, `${status}: ${body.message}`);
        assert.ok(logged.some((l) => l.includes(RAW)), `${status}: logged`);
      }
    } finally {
      console.error = consoleError;
      stripe.failWith = null;
    }
  });

  let mixedRetainerUrl = "";
  let mixedRetainerLink = "";
  let mixedRetainerPrice = "";
  await check("send: AR and revenue at issue are the one-time part only; the retainer link is a recurring monthly price with the invoice's metadata", async () => {
    const mark = stripeCalls.length;
    const before = mails.length;
    // The invoice's status at the moment each price / link is made: all before it is numbered.
    const statusAtWrite: string[] = [];
    stripe.onWrite = async (path) => {
      if (path === "/v1/prices" || path === "/v1/payment_links") statusAtWrite.push((await row(mixedId)).status);
    };
    let sent;
    try {
      sent = await invoices.sendInvoice(cc, mixedId);
    } finally {
      stripe.onWrite = null;
    }
    assert.deepEqual(statusAtWrite, ["draft", "draft"], "the price and the link were made while the invoice was still a draft");
    assert.equal(mails.length, before + 1);
    const d = await row(mixedId);
    assert.equal(d.status, "sent");
    assert.ok(d.recognition_entry_id);
    const arDebit = await count(`SELECT COALESCE(SUM(debit_cents), 0) FROM fin_journal_lines WHERE entry_id = ? AND account_id = ?`, [d.recognition_entry_id as string, ar]);
    const revenue = await count(
      `SELECT COALESCE(SUM(l.credit_cents), 0) FROM fin_journal_lines l JOIN fin_accounts a ON a.id = l.account_id WHERE l.entry_id = ? AND a.type = 'revenue'`,
      [d.recognition_entry_id as string],
    );
    assert.equal(arDebit, 200000, "AR = the implementation only");
    assert.equal(revenue, 200000, "revenue at issue = the implementation only; the retainer is booked when Stripe collects it");

    const prices = stripeSince(mark, "/v1/prices");
    const links = stripeSince(mark, "/v1/payment_links");
    // The product was created during the refused attempt (Products write is allowed) and is reused, not duplicated.
    assert.equal(stripeCalls.filter((c) => c.path === "/v1/products" && c.params["metadata[fin_retainer_invoice_id]"] === mixedId).length, 1);
    assert.equal(prices.length, 1, "no one-off card price: this invoice is paid by bank transfer");
    assert.equal(links.length, 1);
    const price = prices[0].params;
    assert.equal(price["recurring[interval]"], "month");
    assert.equal(price.unit_amount, "50000");
    assert.equal(price.currency, "cad");
    assert.equal(price.product, d.stripe_retainer_product_id);
    const link = links[0].params;
    assert.equal(link["line_items[0][price]"], d.stripe_retainer_price_id);
    assert.equal(link["metadata[fin_retainer_invoice_id]"], mixedId);
    assert.equal(link["metadata[fin_retainer_invoice_number]"], undefined, "made before the invoice had a number: the id only");
    assert.equal(link["subscription_data[metadata][fin_retainer_invoice_id]"], mixedId);
    assert.equal(link["subscription_data[metadata][fin_retainer_invoice_number]"], undefined);
    assert.equal(link["subscription_data[metadata][fin_contact_id]"], d.contact_id);
    // Once issued, the number is added to the link itself (Payment Links write — what the send already used).
    const numbered = stripeSince(mark, `/v1/payment_links/${d.stripe_retainer_link_id}`);
    assert.equal(numbered.length, 1);
    assert.equal(numbered[0].params["metadata[fin_retainer_invoice_number]"], d.number);
    assert.match(numbered[0].params["after_completion[hosted_confirmation][custom_message]"], new RegExp(`\\(invoice ${d.number}\\) is set up`));
    assert.match(numbered[0].params.inactive_message, new RegExp(`on invoice ${d.number} is no longer active`));
    assert.equal(numbered[0].params.active, undefined, "adding the number never switches the link off");
    assert.equal(stripe.links.get(d.stripe_retainer_link_id as string)!.active, true);
    for (const c of [...prices, ...links]) {
      assert.equal(
        Object.keys(c.params).some((k) => /\bfin_invoice_id\]/.test(k)),
        false,
        "a retainer charge must never carry fin_invoice_id: the Stripe ingest would settle the one-time AR with it",
      );
    }
    assert.match(links[0].idem || "", new RegExp(`^fin-rplink-${mixedId}-`), "idempotent, keyed to the invoice");
    assert.equal(sent.retainerLinkUrl, d.stripe_retainer_link_url);
    assert.equal(Number(d.stripe_retainer_link_cents), 50000);
    assert.equal(d.stripe_retainer_link_currency, "CAD");
    assert.equal(sent.paymentLinkUrl, null);
    mixedRetainerUrl = d.stripe_retainer_link_url as string;
    mixedRetainerLink = d.stripe_retainer_link_id as string;
    mixedRetainerPrice = d.stripe_retainer_price_id as string;
  });

  await check("email + PDF: two separate sections, both links, Due now and Monthly retainer shown apart", async () => {
    const m = lastMail();
    const d = await row(mixedId);
    assert.match(m.text, new RegExp(`Implementation — CA\\$2,000\\.00 due by ${d.due_date}: pay by bank transfer`));
    assert.match(m.text, /Institution number: 621/);
    assert.match(m.text, new RegExp(`Payment reference: ${d.number}`));
    assert.match(m.text, /Monthly retainer — CA\$500\.00\/month: set up automatic monthly card payments/);
    assert.ok(m.text.includes(mixedRetainerUrl));
    assert.match(m.text, /Due now: CA\$2,000\.00/);
    assert.match(m.text, /Monthly retainer: CA\$500\.00\/month/);
    assert.ok(m.text.indexOf("Implementation —") < m.text.indexOf("Monthly retainer —"), "implementation first");
    assert.ok(m.html.includes(`href="${mixedRetainerUrl}"`));
    assert.match(m.html, /Set up monthly payments/);
    const pdf = await pdfOf(m);
    assert.match(pdf, /Implementation . CA\$2,000\.00 due by/);
    assert.match(pdf, /Monthly retainer . CA\$500\.00\/month: set up automatic monthly card payments/);
    assert.ok(pdf.includes(mixedRetainerUrl), "the PDF carries the retainer link");
    assert.match(pdf, /Institution number/);
    assert.match(pdf, /Due now CAD/);
    assert.match(pdf, /Monthly retainer CAD/);
    assert.match(pdf, /CA\$500\.00\/mo/);
    assert.doesNotMatch(pdf, /Total CAD/);
  });

  await check("resend reuses the retainer link; a changed amount replaces it and switches the old one off", async () => {
    let mark = stripeCalls.length;
    const reads = stripeReads.length;
    await invoices.sendInvoice(cc, mixedId);
    assert.equal(stripeSince(mark).length, 0, "same amount + currency: no Stripe write at all");
    const exactReads = [
      `/v1/payment_links/${mixedRetainerLink}`,
      `/v1/payment_links/${mixedRetainerLink}/line_items`,
      `/v1/prices/${(await row(mixedId)).stripe_retainer_price_id}`,
      `/v1/products/${(await row(mixedId)).stripe_retainer_product_id}`,
    ];
    assert.deepEqual(stripeReads.slice(reads), [...exactReads, ...exactReads], "the full recurring chain is checked on reuse and immediately before SMTP");
    assert.ok(lastMail().text.includes(mixedRetainerUrl));

    // A retainer corrected after issue (the stored figure is what the link must charge).
    await raw.execute({ sql: `UPDATE fin_invoices SET retainer_monthly_cents = 60000 WHERE id = ?`, args: [mixedId] });
    mark = stripeCalls.length;
    const sent = await invoices.sendInvoice(cc, mixedId);
    const calls = stripeSince(mark);
    assert.deepEqual(
      calls.map((c) => c.path),
      [`/v1/payment_links/${mixedRetainerLink}`, `/v1/prices/${mixedRetainerPrice}`, "/v1/prices", "/v1/payment_links"],
      "the old checkout and stale Price are confirmed off before their replacements are created",
    );
    assert.equal(calls[0].params.active, "false");
    assert.equal(calls[1].params.active, "false");
    assert.equal(calls[2].params.unit_amount, "60000");
    assert.equal(calls[2].params["recurring[interval]"], "month");
    const d = await row(mixedId);
    assert.notEqual(d.stripe_retainer_link_url, mixedRetainerUrl);
    assert.equal(Number(d.stripe_retainer_link_cents), 60000);
    assert.equal(sent.retainerLinkUrl, d.stripe_retainer_link_url);
    assert.ok(lastMail().text.includes(d.stripe_retainer_link_url as string));
    assert.ok(!lastMail().text.includes(mixedRetainerUrl), "the old link is not handed out");
    assert.match(lastMail().text, /Monthly retainer — CA\$600\.00\/month/);

    // Back to the first amount (within Stripe's 24h idempotency window): Stripe replays the first
    // price, but the link must be NEW — replaying the first link would hand out a switched-off one.
    await raw.execute({ sql: `UPDATE fin_invoices SET retainer_monthly_cents = 50000 WHERE id = ?`, args: [mixedId] });
    const second = d.stripe_retainer_link_id as string;
    const back = await invoices.sendInvoice(cc, mixedId);
    assert.ok(back.retainerLinkUrl && back.retainerLinkUrl !== mixedRetainerUrl && back.retainerLinkUrl !== d.stripe_retainer_link_url);
    const live = stripe.links.get((await row(mixedId)).stripe_retainer_link_id as string)!;
    assert.equal(live.active, true, "the link emailed is live");
    assert.equal(stripe.links.get(second)!.active, false, "the 600 link is switched off");
    assert.equal(stripe.links.get(mixedRetainerLink)!.active, false, "the first link stays off");
  });

  await check("Hybrid is honest: implementation by bank and monthly retainer by card, never a one-time card link", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Globex", email: "ap@globex.test" }, currency: "CAD", payment_method: "wise_stripe", lines: mixedLines });
    const mark = stripeCalls.length;
    const sent = await invoices.sendInvoice(cc, id);
    const prices = stripeSince(mark, "/v1/prices");
    assert.equal(prices.length, 1);
    assert.equal(prices[0].params["recurring[interval]"], "month");
    assert.equal(prices[0].params.unit_amount, "50000");
    assert.equal(sent.paymentLinkUrl, null, "Hybrid never creates a one-time card link");
    assert.ok(sent.retainerLinkUrl);
    const m = lastMail();
    assert.match(m.text, /Implementation — CA\$2,000\.00 due by .*: pay by bank transfer/);
    assert.doesNotMatch(m.text, /Or pay by card:/);
    assert.ok(m.text.includes(sent.retainerLinkUrl as string));
    const pdf = await pdfOf(m);
    assert.ok(pdf.includes(sent.retainerLinkUrl as string), "the recurring link is on the PDF");
    assert.doesNotMatch(pdf, /PAY BY CARD.*implementation/i);
  });

  await check("Hybrid: a key without Payment Links write leaves a draft; once allowed, only the recurring link is made before the number", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Tyrell", email: "ap@tyrell.test" }, currency: "CAD", payment_method: "wise_stripe", lines: mixedLines });
    stripe.denyLinksOnly = true;
    const before = mails.length;
    try {
      await assert.rejects(invoices.sendInvoice(cc, id), (e: unknown) => e instanceof access.FinanceInputError && e.message === RETAINER_REFUSED);
    } finally {
      stripe.denyLinksOnly = false;
    }
    let d = await row(id);
    assert.deepEqual([d.status, d.number, d.recognition_entry_id], ["draft", null, null]);
    assert.equal(mails.length, before);

    const statusAtWrite: string[] = [];
    stripe.onWrite = async (path) => {
      if (path === "/v1/prices" || path === "/v1/payment_links") statusAtWrite.push((await row(id)).status);
    };
    const mark = stripeCalls.length;
    let sent;
    try {
      sent = await invoices.sendInvoice(cc, id);
    } finally {
      stripe.onWrite = null;
    }
    assert.deepEqual(statusAtWrite, ["draft"], "the recurring link is made while it is a draft; its saved product/price were kept from the refused attempt");
    d = await row(id);
    assert.equal(d.status, "sent");
    const made = stripeSince(mark, "/v1/payment_links");
    assert.equal(made.length, 1);
    for (const c of made) assert.equal(Object.keys(c.params).some((k) => /number/.test(k)), false, "made before the number existed: the invoice id only");
    const numberedRetainer = stripeSince(mark, `/v1/payment_links/${d.stripe_retainer_link_id}`);
    assert.equal(d.stripe_payment_link_id, null);
    assert.equal(numberedRetainer.length, 1);
    assert.equal(numberedRetainer[0].params["metadata[fin_retainer_invoice_number]"], d.number);
    assert.equal(sent.paymentLinkUrl, null);
    assert.ok(lastMail().text.includes(sent.retainerLinkUrl as string));
  });

  await check("a pre-issuance failure strictly retires every new checkout and a draft PDF/status exposes no payable URL", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Cleanup before issue", email: "ap@cleanup-before-issue.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [
        { description: "Implementation", quantity: 1, unit_price: "800" },
        { description: "Support", quantity: 1, unit_price: "95", billing: "monthly" },
      ],
    });
    const linksBefore = new Set(stripe.links.keys());
    const mailsBefore = mails.length;
    const saved = process.env.OASIS_MAIL_APP_PASSWORD;
    delete process.env.OASIS_MAIL_APP_PASSWORD;
    try {
      await assert.rejects(invoices.sendInvoice(cc, id));
    } finally {
      process.env.OASIS_MAIL_APP_PASSWORD = saved;
    }
    const made = [...stripe.links.values()].filter((link) => !linksBefore.has(link.id));
    assert.equal(made.length, 2, "one one-time and one recurring checkout were created before mailbox validation failed");
    assert.ok(made.every((link) => link.active === false), "every newly created checkout is confirmed off");
    const draft = await row(id);
    assert.deepEqual([draft.status, draft.number, draft.stripe_payment_link_id, draft.stripe_payment_link_url], ["draft", null, null, null]);
    assert.deepEqual([draft.stripe_retainer_link_id, draft.stripe_retainer_link_url], [null, null]);
    assert.equal(mails.length, mailsBefore);
    assert.deepEqual(await invoices.retainerLinkStatus(draft), { state: "none" });
    const pdf = await pdfText((await invoices.invoicePdfBytes(cc, id)).bytes);
    for (const link of made) assert.ok(!pdf.includes(link.url), "a draft PDF never prints a checkout URL");
  });

  await check("Stripe-only money due cannot be emailed without its required card checkout", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "No rail opt-out", email: "ap@no-rail-opt-out.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Implementation", quantity: 1, unit_price: "650" }],
    });
    const before = mails.length;
    const writes = stripeCalls.length;
    await assert.rejects(
      invoices.sendInvoice(cc, id, { paymentLink: false }),
      (e: unknown) => e instanceof access.FinanceInputError && /card payment link is required/i.test(e.message) && /nothing was emailed/i.test(e.message),
    );
    assert.equal(mails.length, before);
    assert.equal(stripeCalls.length, writes, "the invalid opt-out is refused before Stripe writes");
    assert.equal((await row(id)).status, "draft");
  });

  await check("the durable email claim makes a concurrent void lose visibly before SMTP in every payment mode", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Claimed Wise", email: "ap@claimed-wise.test" },
      currency: "CAD",
      payment_method: "wise",
      lines: [{ description: "Implementation", quantity: 1, unit_price: "710" }],
    });
    const before = mails.length;
    let voidError: unknown;
    beforeMailSend = async () => {
      try {
        await invoices.voidInvoice(cc, id);
      } catch (e) {
        voidError = e;
      }
    };
    try {
      await invoices.sendInvoice(cc, id);
    } finally {
      beforeMailSend = null;
    }
    assert.ok(voidError instanceof access.FinanceInputError);
    assert.match((voidError as Error).message, /email attempt.*unresolved/i);
    assert.match((voidError as Error).message, /since \d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch((voidError as Error).message, /send_[a-z0-9]/i, "the private claim token is never shown");
    const sent = await row(id);
    assert.equal(sent.status, "sent");
    assert.equal(sent.send_claim_token, null);
    assert.equal(mails.length, before + 1);
  });

  await check("an old unresolved email claim never expires silently and blocks send, void, delete, and edit with one diagnostic", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Stuck claim", email: "ap@stuck-claim.test" },
      currency: "CAD",
      payment_method: "wise",
      lines: [{ description: "Implementation", quantity: 1, unit_price: "720" }],
    });
    await raw.execute({
      sql: `UPDATE fin_invoices SET send_claim_token = 'private_never_show', send_claimed_at = '2020-01-02T03:04:05.000Z' WHERE id = ?`,
      args: [id],
    });
    const expected = /email attempt.*unresolved since 2020-01-02T03:04:05\.000Z.*verify the mailbox/i;
    for (const run of [
      () => invoices.sendInvoice(cc, id),
      () => invoices.voidInvoice(cc, id),
      () => invoices.deleteDraftInvoice(cc, id),
      () => invoices.updateDraftInvoice(cc, id, { contact_id: (row(id) as unknown), currency: "CAD", lines: [] }),
    ]) {
      await assert.rejects(run, (e: unknown) => e instanceof access.FinanceInputError && expected.test(e.message) && !e.message.includes("private_never_show"));
    }
    assert.equal((await row(id)).send_claim_token, "private_never_show");
  });

  await check("finalize with a send expectation never returns a raced non-draft invoice", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Finalize race", email: "ap@finalize-race.test" },
      currency: "CAD",
      payment_method: "wise",
      lines: [{ description: "Implementation", quantity: 1, unit_price: "730" }],
    });
    const draft = await row(id);
    await raw.execute({ sql: `UPDATE fin_invoices SET status = 'void' WHERE id = ?`, args: [id] });
    await assert.rejects(
      invoices.finalizeInvoice(cc, id, {
        totalCents: draft.total_cents,
        monthlyCents: 0,
        currency: draft.currency,
        contactId: draft.contact_id,
        cardLinkVerified: false,
        sendClaimToken: "send_expected",
      }),
      (e: unknown) => e instanceof access.FinanceInputError && e.message === invoices.ISSUE_CHANGED_DURING_SEND,
    );
  });

  await check("recurring object writes lose safely to delete/void and retire every orphan", async () => {
    const run = async (terminal: "delete" | "void") => {
      const id = await invoices.createDraftInvoice(cc, "oasis", {
        new_contact: { name: `Retainer ${terminal}`, email: `ap@retainer-${terminal}.test` },
        currency: "CAD",
        payment_method: "stripe",
        lines: [{ description: "Support", quantity: 1, unit_price: "120", billing: "monthly" }],
      });
      if (terminal === "void") await invoices.finalizeInvoice(cc, id);
      const snapshot = await row(id);
      const productsBefore = new Set(stripe.products.keys());
      const pricesBefore = new Set(stripe.prices.keys());
      const linksBefore = new Set(stripe.links.keys());
      stripe.onWrite = async (path) => {
        if (path !== "/v1/payment_links") return;
        stripe.onWrite = null;
        if (terminal === "delete") await invoices.deleteDraftInvoice(cc, id);
        else await invoices.voidInvoice(cc, id);
      };
      try {
        await assert.rejects(invoices.ensureRetainerLink(snapshot), /changed|deleted|void/i);
      } finally {
        stripe.onWrite = null;
      }
      const madeProducts = [...stripe.products.values()].filter((p) => !productsBefore.has(String(p.id)));
      const madePrices = [...stripe.prices.values()].filter((p) => !pricesBefore.has(String(p.id)));
      const madeLinks = [...stripe.links.values()].filter((l) => !linksBefore.has(l.id));
      assert.equal(madeProducts.length, 1);
      assert.equal(madePrices.length, 1);
      assert.equal(madeLinks.length, 1);
      assert.equal(madeProducts[0].active, false, "orphan product archived");
      assert.equal(madePrices[0].active, false, "orphan price archived");
      assert.equal(madeLinks[0].active, false, "orphan checkout strictly retired");
      if (terminal === "delete") assert.equal(await count(`SELECT COUNT(*) FROM fin_invoices WHERE id = ?`, [id]), 0);
      else assert.equal((await row(id)).status, "void");
    };
    await run("delete");
    await run("void");
  });

  await check("identical concurrent recurring-link callers adopt one idempotent winner and never switch it off", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Concurrent recurring", email: "ap@concurrent-recurring.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Support", quantity: 1, unit_price: "140", billing: "monthly" }],
    });
    const snapshot = await row(id);
    const waiters = new Map<string, { count: number; release: () => void; promise: Promise<void> }>();
    const pair = (path: string) => {
      let state = waiters.get(path);
      if (!state) {
        let release = () => {};
        const promise = new Promise<void>((resolve) => { release = resolve; });
        state = { count: 0, release, promise };
        waiters.set(path, state);
      }
      return state;
    };
    stripe.onWrite = async (path) => {
      if (!["/v1/products", "/v1/prices", "/v1/payment_links"].includes(path)) return;
      const state = pair(path);
      state.count += 1;
      if (state.count === 1) await state.promise;
      else state.release();
    };
    const mark = stripeCalls.length;
    let results: [Awaited<ReturnType<typeof invoices.ensureRetainerLink>>, Awaited<ReturnType<typeof invoices.ensureRetainerLink>>];
    try {
      results = await Promise.all([invoices.ensureRetainerLink(snapshot), invoices.ensureRetainerLink(snapshot)]);
    } finally {
      stripe.onWrite = null;
    }
    assert.deepEqual(results[0], results[1]);
    const winner = await row(id);
    assert.equal(results[0].kind, "link");
    assert.ok(results[0].kind === "link" && results[0].url === winner.stripe_retainer_link_url);
    assert.equal(stripe.links.get(winner.stripe_retainer_link_id as string)?.active, true);
    assert.equal(
      stripeSince(mark).filter((c) => c.path === `/v1/payment_links/${winner.stripe_retainer_link_id}` && c.params.active === "false").length,
      0,
      "the shared winner is never deactivated",
    );
    assert.equal(await count(`SELECT COUNT(*) FROM fin_audit_log WHERE object_id = ? AND action = 'invoice.retainer_link_created'`, [id]), 1);
  });

  await check("recurring links are exposed only after exact live Link -> Price -> Product proof", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Exact recurring", email: "ap@exact-recurring.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Support", quantity: 1, unit_price: "175", billing: "monthly" }],
    });
    const sent = await invoices.sendInvoice(cc, id);
    let stored = await row(id);
    const originalLink = stored.stripe_retainer_link_id as string;
    const originalUrl = stored.stripe_retainer_link_url as string;
    const originalPrice = stored.stripe_retainer_price_id as string;
    const originalProduct = stored.stripe_retainer_product_id as string;
    assert.equal(sent.retainerLinkUrl, originalUrl);

    stripe.links.get(originalLink)!.priceId = "price_wrong_binding";
    let status = await invoices.retainerLinkStatus(await row(id));
    assert.equal(status.state, "unknown");
    assert.ok(status.state !== "none" && status.url === null && /does not match|verify/i.test(status.reason || ""));
    assert.ok(!(await pdfText((await invoices.invoicePdfBytes(cc, id)).bytes)).includes(originalUrl));
    const reads = stripeReads.length;
    const replaced = await invoices.sendInvoice(cc, id);
    stored = await row(id);
    assert.ok(replaced.retainerLinkUrl && replaced.retainerLinkUrl !== originalUrl);
    assert.equal(stripe.links.get(originalLink)!.active, false);
    assert.ok(stripeReads.slice(reads).filter((path) => path === `/v1/payment_links/${originalLink}`).length >= 2, "replacement GET-confirms shutdown");
    assert.equal(stripe.products.get(originalProduct)?.active, true, "a bad link never archives its still-valid Product");
    assert.equal(stripe.prices.get(originalPrice)?.active, true, "a bad link never archives its still-valid Price");

    const wrongAmountLink = stored.stripe_retainer_link_id as string;
    const wrongAmountUrl = stored.stripe_retainer_link_url as string;
    const wrongAmountPrice = stored.stripe_retainer_price_id as string;
    stripe.prices.get(wrongAmountPrice)!.unit_amount = 17501;
    status = await invoices.retainerLinkStatus(await row(id));
    assert.equal(status.state, "unknown");
    assert.ok(status.state !== "none" && status.url === null);
    const fixed = await invoices.sendInvoice(cc, id);
    stored = await row(id);
    assert.ok(fixed.retainerLinkUrl && fixed.retainerLinkUrl !== wrongAmountUrl);
    assert.notEqual(stored.stripe_retainer_price_id, wrongAmountPrice, "a wrong-amount Price is never reused");
    assert.equal(stripe.prices.get(wrongAmountPrice)!.active, false, "the orphan wrong Price is archived");
    assert.equal(stripe.links.get(wrongAmountLink)!.active, false);

    const product = stripe.products.get(stored.stripe_retainer_product_id as string)!;
    product.livemode = false;
    status = await invoices.retainerLinkStatus(await row(id));
    assert.equal(status.state, "unknown");
    assert.ok(status.state !== "none" && status.url === null, "a test-mode/mismatched Product never releases the stored URL");
    product.livemode = true;

    const page = readFileSync(join(root, "app/founders/finances/invoices/[id]/page.tsx"), "utf8");
    assert.match(page, /verifiedOneTimePaymentLink/);
    assert.doesNotMatch(page, /href=\{inv\.stripe_payment_link_url\}/, "the detail page never renders raw one-time storage");
    assert.equal(stripe.products.get(originalProduct)?.active, true, "replacing a bad link never archives a still-shared valid Product");
  });

  await check("editing a draft retires a now-wrong live card link immediately; send creates the replacement; Issue without emailing drops an unchecked one", async () => {
    const { InvoiceMailerNotConfigured } = await import("../lib/founders-finances/invoice-email");
    const withoutMailbox = async (id: string) => {
      const saved = process.env.OASIS_MAIL_APP_PASSWORD;
      delete process.env.OASIS_MAIL_APP_PASSWORD;
      try {
        await assert.rejects(invoices.sendInvoice(cc, id), InvoiceMailerNotConfigured);
      } finally {
        process.env.OASIS_MAIL_APP_PASSWORD = saved;
      }
    };
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Wonka", email: "ap@wonka-card.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Audit", quantity: 1, unit_price: "300" }],
    });
    const linksBeforeFailure = new Set(stripe.links.keys());
    await withoutMailbox(id);
    let d = await row(id);
    assert.deepEqual([d.status, d.number], ["draft", null], "no mailbox: refused before it was numbered");
    const firstLink = [...stripe.links.values()].find((link) => !linksBeforeFailure.has(link.id))!;
    const first = { id: firstLink.id, url: firstLink.url };
    assert.equal(firstLink.active, false, "the failed pre-issue attempt strictly retires its checkout");
    assert.deepEqual([d.stripe_price_id, d.stripe_payment_link_id, d.stripe_payment_link_url], [null, null, null]);

    const editReads = stripeReads.length;
    const editWrites = stripeCalls.length;
    await invoices.updateDraftInvoice(cc, id, { contact_id: d.contact_id, currency: "CAD", payment_method: "stripe", lines: [{ description: "Audit", quantity: 1, unit_price: "400" }] });
    d = await row(id);
    assert.equal(stripe.links.get(first.id)!.active, false, "the failed attempt's checkout stays off");
    assert.deepEqual([d.stripe_price_id, d.stripe_payment_link_id, d.stripe_payment_link_url], [null, null, null]);
    assert.deepEqual(stripeSince(editWrites), [], "editing has no stale local checkout to retire again");
    assert.deepEqual(stripeReads.slice(editReads), []);
    const reads = stripeReads.length;
    const mark = stripeCalls.length;
    const sent = await invoices.sendInvoice(cc, id);
    const sendReads = stripeReads.slice(reads);
    assert.equal(sendReads.some((path) => path.includes(first.id)), false, "send never inspects or reuses the retired checkout");
    assert.equal(sendReads.length, 3, "the fresh Link -> Price chain is checked immediately before SMTP");
    assert.equal(stripeSince(mark, "/v1/prices")[0].params.unit_amount, "40000");
    assert.ok(sent.paymentLinkUrl && sent.paymentLinkUrl !== first.url, "a new link for the new amount");
    assert.equal(stripe.links.get(first.id)!.active, false, "the old amount's link is switched off");
    assert.ok(!lastMail().text.includes(first.url) && !lastMail().html.includes(first.url));
    d = await row(id);
    assert.equal(d.total_cents, 40000);

    // Same amount: a failed pre-issue attempt was retired, so retry makes a fresh link.
    const id2 = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Gringotts", email: "ap@gringotts.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Audit", quantity: 1, unit_price: "250" }],
    });
    const linksBeforeSecondFailure = new Set(stripe.links.keys());
    await withoutMailbox(id2);
    const retired = [...stripe.links.values()].find((link) => !linksBeforeSecondFailure.has(link.id))!;
    assert.equal(retired.active, false);
    assert.equal((await row(id2)).stripe_payment_link_url, null);
    const mark2 = stripeCalls.length;
    const sent2 = await invoices.sendInvoice(cc, id2);
    assert.ok(sent2.paymentLinkUrl && sent2.paymentLinkUrl !== retired.url);
    assert.deepEqual(stripeSince(mark2).map((c) => c.path), ["/v1/prices", "/v1/payment_links", `/v1/payment_links/${(await row(id2)).stripe_payment_link_id}`]);

    // Issue without emailing: the draft's unchecked link is dropped (and switched off), the next send makes a numbered one.
    const id3 = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Nakatomi", email: "ap@nakatomi.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Audit", quantity: 1, unit_price: "275" }],
    });
    const draftBefore = await row(id3);
    await invoices.ensurePaymentLink(draftBefore, draftBefore);
    const draftLink = await row(id3);
    const f = await invoices.finalizeInvoice(cc, id3);
    assert.equal(f.status, "sent");
    assert.deepEqual([f.stripe_payment_link_id, f.stripe_payment_link_url, f.stripe_price_id], [null, null, null]);
    assert.equal(stripe.links.get(draftLink.stripe_payment_link_id as string)!.active, false, "the never-emailed draft link is switched off");
    const mark3 = stripeCalls.length;
    const sent3 = await invoices.sendInvoice(cc, id3);
    assert.ok(sent3.paymentLinkUrl && sent3.paymentLinkUrl !== draftLink.stripe_payment_link_url);
    assert.equal(stripeSince(mark3, "/v1/payment_links")[0].params["metadata[fin_invoice_number]"], f.number, "made after issue: carries the number from the start");

    const id4 = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Strict issue", email: "ap@strict-issue.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Audit", quantity: 1, unit_price: "325" }],
    });
    const strictDraft = await row(id4);
    await invoices.ensurePaymentLink(strictDraft, strictDraft);
    stripe.failWith = { status: 503, message: "cannot confirm shutdown", reads: true };
    const logged = console.error;
    console.error = () => {};
    try {
      await assert.rejects(invoices.finalizeInvoice(cc, id4), /old card link.*draft was not changed/i);
    } finally {
      console.error = logged;
      stripe.failWith = null;
    }
    const unissued = await row(id4);
    assert.deepEqual([unissued.status, unissued.number, unissued.recognition_entry_id], ["draft", null, null], "failed shutdown consumes no number and posts nothing");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_audit_log WHERE object_id = ? AND action = 'invoice.issued'`, [id4]), 0);
  });

  await check("an issued Stripe link is live-checked before every reuse and a stale one is retired before its replacement is created", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Waystar", email: "ap@waystar.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Audit", quantity: 1, unit_price: "900" }],
    });
    await invoices.sendInvoice(cc, id);
    let d = await row(id);
    const original = { link: d.stripe_payment_link_id as string, price: d.stripe_price_id as string, url: d.stripe_payment_link_url as string };
    const reads = stripeReads.length;
    const mark = stripeCalls.length;
    const reused = await invoices.sendInvoice(cc, id);
    assert.equal(reused.paymentLinkUrl, original.url);
    const exactReads = [`/v1/payment_links/${original.link}`, `/v1/payment_links/${original.link}/line_items`, `/v1/prices/${original.price}`];
    assert.deepEqual(stripeReads.slice(reads), [...exactReads, ...exactReads], "the one-time chain is checked on reuse and immediately before SMTP");
    assert.equal(stripeSince(mark).length, 0, "a verified exact issued link is reused without a write");

    stripe.prices.get(original.price)!.unit_amount = 99999;
    let sawOldOffBeforeCreate = false;
    stripe.onWrite = async (path) => {
      if (path === "/v1/prices") sawOldOffBeforeCreate = stripe.links.get(original.link)?.active === false;
    };
    try {
      const replaced = await invoices.sendInvoice(cc, id);
      assert.ok(replaced.paymentLinkUrl && replaced.paymentLinkUrl !== original.url);
    } finally {
      stripe.onWrite = null;
    }
    d = await row(id);
    assert.equal(sawOldOffBeforeCreate, true, "the old link is confirmed off before Stripe is asked to create the replacement");
    assert.equal(stripe.links.get(original.link)!.active, false);
    assert.equal(stripe.prices.get(d.stripe_price_id as string)!.unit_amount, 90000);
  });

  await check("a stored Payment Link must actually point at its stored Price before a PDF or email can expose it", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Tyrell", email: "ap@tyrell.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Implementation", quantity: 1, unit_price: "725" }],
    });
    await invoices.sendInvoice(cc, id);
    const before = await row(id);
    const oldId = before.stripe_payment_link_id as string;
    const oldUrl = before.stripe_payment_link_url as string;
    stripe.links.get(oldId)!.priceId = "price_for_some_other_invoice";
    const downloaded = await pdfText((await invoices.invoicePdfBytes(cc, id)).bytes);
    assert.ok(!downloaded.includes(oldUrl), "the read-only PDF fails closed when Stripe says the link binds another Price");
    const resent = await invoices.sendInvoice(cc, id);
    assert.ok(resent.paymentLinkUrl && resent.paymentLinkUrl !== oldUrl, "send replaces rather than reusing the mismatched link");
    assert.equal(stripe.links.get(oldId)!.active, false);
  });

  await check("concurrent identical card-link requests adopt Stripe's idempotent winner and never deactivate it", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Stark", email: "ap@stark.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Implementation", quantity: 1, unit_price: "810" }],
    });
    const snapshot = await row(id);
    let arrivals = 0;
    let release!: () => void;
    const bothAtLink = new Promise<void>((resolve) => {
      release = resolve;
    });
    stripe.onWrite = async (path) => {
      if (path !== "/v1/payment_links") return;
      arrivals += 1;
      if (arrivals === 2) release();
      else await bothAtLink;
    };
    const mark = stripeCalls.length;
    try {
      const urls = await Promise.all([invoices.ensurePaymentLink(snapshot, snapshot), invoices.ensurePaymentLink(snapshot, snapshot)]);
      assert.equal(urls[0], urls[1]);
      const stored = await row(id);
      assert.equal(stored.stripe_payment_link_url, urls[0]);
      assert.equal(stripe.links.get(stored.stripe_payment_link_id as string)!.active, true);
      assert.equal(
        stripeSince(mark).filter((c) => c.path === `/v1/payment_links/${stored.stripe_payment_link_id}` && c.params.active === "false").length,
        0,
        "the CAS loser must not switch off the same idempotent object the winner stored",
      );
    } finally {
      stripe.onWrite = null;
    }
  });

  await check("an out-of-band partial payment retires and clears the full-value link; resend makes an exact remaining-balance link", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Soylent Bank", email: "ap@soylent-bank.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Implementation", quantity: 1, unit_price: "1000" }],
    });
    await invoices.sendInvoice(cc, id);
    const before = await row(id);
    const oldLink = before.stripe_payment_link_id as string;
    const oldUrl = before.stripe_payment_link_url as string;
    const oldRetainer = [before.stripe_retainer_link_id, before.stripe_retainer_link_url];
    const mark = stripeCalls.length;
    const reads = stripeReads.length;
    await invoices.markInvoicePaidManually(cc, id, { amount: "250", reference: "Interac PARTIAL" });
    const partial = await row(id);
    assert.equal(partial.amount_paid_cents, 25000);
    assert.equal(partial.status, "sent");
    assert.equal(stripe.links.get(oldLink)!.active, false, "the full-value link cannot remain live");
    assert.deepEqual([partial.stripe_price_id, partial.stripe_payment_link_id, partial.stripe_payment_link_url], [null, null, null]);
    assert.deepEqual([partial.stripe_retainer_link_id, partial.stripe_retainer_link_url], oldRetainer, "one-time retirement never touches retainer fields");
    assert.deepEqual(stripeSince(mark).map((c) => [c.path, c.params.active]), [[`/v1/payment_links/${oldLink}`, "false"]]);
    assert.deepEqual(stripeReads.slice(reads), [`/v1/payment_links/${oldLink}`], "Stripe confirms the link is inactive before the payment is written");

    const resent = await invoices.sendInvoice(cc, id);
    const after = await row(id);
    assert.ok(resent.paymentLinkUrl && resent.paymentLinkUrl !== oldUrl);
    assert.equal(stripe.prices.get(after.stripe_price_id as string)!.unit_amount, 75000, "the fresh link equals the remaining balance exactly");
  });

  await check("if Stripe cannot confirm link retirement, an external payment has no bookkeeping effects", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Massive Bank", email: "ap@massive-bank.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Implementation", quantity: 1, unit_price: "600" }],
    });
    await invoices.sendInvoice(cc, id);
    const before = await row(id);
    const paymentCount = await count(`SELECT COUNT(*) FROM fin_payments WHERE invoice_id = ?`, [id]);
    stripe.failWith = { status: 503, message: "upstream unavailable" };
    const logged = console.error;
    console.error = () => {};
    try {
      await assert.rejects(
        invoices.markInvoicePaidManually(cc, id, { amount: "100", reference: "Wire PARTIAL" }),
        (e: unknown) => e instanceof access.FinanceInputError && /couldn't safely turn off.*card link/i.test(e.message) && /not recorded/i.test(e.message),
      );
    } finally {
      console.error = logged;
      stripe.failWith = null;
    }
    const after = await row(id);
    assert.deepEqual([after.status, after.amount_paid_cents, after.stripe_payment_link_id], [before.status, before.amount_paid_cents, before.stripe_payment_link_id]);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE invoice_id = ?`, [id]), paymentCount);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'invoice_payment' AND source_ref IN (SELECT id FROM fin_payments WHERE invoice_id = ?)`, [id]), 0);
  });

  await check("link clearing and manual payment bookkeeping share one atomic batch and a retry records exactly once", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Globex Bank", email: "ap@globex-bank.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Implementation", quantity: 1, unit_price: "640" }],
    });
    await invoices.sendInvoice(cc, id);
    const before = await row(id);
    const oldLink = before.stripe_payment_link_id as string;
    const { getTursoClient } = await import("../lib/turso");
    const client = getTursoClient() as unknown as Record<string, unknown>;
    const original = (Object.getPrototypeOf(client) as { batch: (...a: unknown[]) => Promise<unknown> }).batch;
    let injected = false;
    client.batch = async function (this: unknown, stmts: unknown, ...rest: unknown[]) {
      if (!injected && JSON.stringify(stmts).includes("invoice.paid_manually")) {
        injected = true;
        throw new Error("forced payment batch failure");
      }
      return original.call(this, stmts, ...rest);
    };
    try {
      await assert.rejects(invoices.markInvoicePaidManually(cc, id, { amount: "100", reference: "atomic" }), /forced payment batch failure/);
    } finally {
      delete client.batch;
    }
    const failed = await row(id);
    assert.equal(stripe.links.get(oldLink)!.active, false, "Stripe shutdown necessarily happens first");
    assert.deepEqual(
      [failed.amount_paid_cents, failed.stripe_payment_link_id, failed.stripe_payment_link_url],
      [before.amount_paid_cents, before.stripe_payment_link_id, before.stripe_payment_link_url],
      "the failed DB transaction retains the exact link reference and changes no balance",
    );
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE invoice_id = ?`, [id]), 0);
    await invoices.markInvoicePaidManually(cc, id, { amount: "100", reference: "atomic retry" });
    const retried = await row(id);
    assert.equal(retried.amount_paid_cents, 10000);
    assert.deepEqual([retried.stripe_price_id, retried.stripe_payment_link_id, retried.stripe_payment_link_url], [null, null, null]);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE invoice_id = ?`, [id]), 1);
  });

  await check("a partial Stripe payment retries strict old-link retirement on the existing-payment path", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Stripe Retry", email: "ap@stripe-retry.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Implementation", quantity: 1, unit_price: "1000" }],
    });
    await invoices.sendInvoice(cc, id);
    const before = await row(id);
    const charge = chargeFacts({
      id: "ch_partial_retire_retry",
      object: "charge",
      amount: 25000,
      amount_captured: 25000,
      amount_refunded: 0,
      currency: "cad",
      created: Math.floor(Date.now() / 1000),
      status: "succeeded",
      paid: true,
      livemode: true,
      payment_intent: "pi_partial_retire_retry",
      customer: null,
      description: "Partial invoice payment",
      billing_details: { name: "Stripe Retry", email: "ap@stripe-retry.test" },
      payment_method_details: { type: "card" },
      balance_transaction: null,
      metadata: { fin_invoice_id: id, fin_entity_id: B, fin_invoice_price_id: before.stripe_price_id },
      refunds: { object: "list", data: [], has_more: false },
    })!;
    charge.subscriptionInvoice = false;
    stripe.failWith = { status: 503, message: "cannot retire old link", reads: true };
    const logged = console.error;
    console.error = () => {};
    try {
      await assert.rejects(
        stripeIngest.recordStripeCharge(charge, { fetchFees: false }),
        (e: unknown) => e instanceof Error && /Stripe recorded the payment, but the invoice's old card link could not be safely retired/.test(e.message),
      );
    } finally {
      console.error = logged;
      stripe.failWith = null;
    }
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE stripe_charge_id = 'ch_partial_retire_retry'`), 1);
    assert.equal((await row(id)).amount_paid_cents, 25000);
    assert.equal((await row(id)).stripe_payment_link_id, before.stripe_payment_link_id, "failed retirement remains retryable from the stored reference");
    const retry = await stripeIngest.recordStripeCharge(charge, { fetchFees: false });
    assert.equal(retry.created, false);
    const after = await row(id);
    assert.equal(after.amount_paid_cents, 25000);
    assert.deepEqual([after.stripe_price_id, after.stripe_payment_link_id, after.stripe_payment_link_url], [null, null, null]);
    assert.equal(stripe.links.get(before.stripe_payment_link_id as string)!.active, false);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_payments WHERE stripe_charge_id = 'ch_partial_retire_retry'`), 1);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'stripe_charge' AND source_ref = 'ch_partial_retire_retry'`), 1);
  });

  await check("a draft whose lines change while its links are being made is NOT issued (the link would charge another amount); sent again, the link is remade", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Hanso", email: "ap@hanso.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Audit", quantity: 1, unit_price: "500" }],
    });
    const linksBefore = new Set(stripe.links.keys());
    stripe.onWrite = async (path) => {
      if (path === "/v1/payment_links") await raw.execute({ sql: `UPDATE fin_invoice_lines SET unit_price_cents = 60000, amount_cents = 60000 WHERE invoice_id = ?`, args: [id] });
    };
    const before = mails.length;
    try {
      await assert.rejects(invoices.sendInvoice(cc, id), (e: unknown) => e instanceof access.FinanceInputError && e.message === invoices.ISSUE_CHANGED_DURING_SEND);
    } finally {
      stripe.onWrite = null;
    }
    const d = await row(id);
    assert.deepEqual([d.status, d.number, d.recognition_entry_id], ["draft", null, null]);
    assert.deepEqual([d.stripe_price_id, d.stripe_payment_link_id, d.stripe_payment_link_url], [null, null, null]);
    assert.equal(mails.length, before, "nothing was emailed");
    const retired = [...stripe.links.values()].find((link) => !linksBefore.has(link.id))!;
    assert.equal(retired.active, false, "the checkout made for the old line total was retired during cleanup");
    const sent = await invoices.sendInvoice(cc, id);
    const f = await row(id);
    assert.equal(f.total_cents, 60000);
    assert.equal(stripe.prices.get(f.stripe_price_id as string)?.unit_amount, 60000, "the link emailed charges what was issued");
    assert.equal(stripe.links.get(retired.id)!.active, false, "the 500 link stays off");
    assert.ok(sent.paymentLinkUrl !== retired.url);
  });

  // ── Prices write granted, Payment Links not: the price is kept, not re-made ──
  let keptId = "";
  await check("a price Stripe made before it refused the link is saved and reused on the retry, even after the idempotency window", async () => {
    keptId = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Hooli", email: "ap@hooli.test" }, currency: "CAD", payment_method: "wise_stripe", lines: mixedLines });
    stripe.denyLinksOnly = true;
    const before = mails.length;
    let mark = stripeCalls.length;
    try {
      await assert.rejects(invoices.sendInvoice(cc, keptId), (e: unknown) => e instanceof access.FinanceInputError && e.message === RETAINER_REFUSED);
    } finally {
      stripe.denyLinksOnly = false;
    }
    assert.equal(mails.length, before, "nothing was emailed");
    assert.deepEqual(stripeSince(mark).map((c) => c.path), ["/v1/products", "/v1/prices", "/v1/payment_links"]);
    const madePrice = stripeSince(mark, "/v1/prices")[0];
    let d = await row(keptId);
    assert.ok(d.stripe_retainer_price_id?.startsWith("price_"), "the price is saved the moment Stripe creates it");
    assert.equal(Number(d.stripe_retainer_price_cents), 50000);
    assert.equal(d.stripe_retainer_price_currency, "CAD");
    assert.equal(d.stripe_retainer_link_url, null);

    assert.deepEqual([d.status, d.number], ["draft", null], "refused before it was numbered");

    // More than 24 hours later Stripe no longer replays the price's idempotency key.
    stripe.replay.delete(madePrice.idem as string);
    mark = stripeCalls.length;
    const sent = await invoices.sendInvoice(cc, keptId);
    d = await row(keptId);
    assert.deepEqual(
      stripeSince(mark).map((c) => c.path),
      ["/v1/payment_links", `/v1/payment_links/${d.stripe_retainer_link_id}`],
      "no second product, no second price: the link, then (once numbered) the number added to it",
    );
    const link = stripeSince(mark)[0].params;
    assert.equal(link["line_items[0][price]"], d.stripe_retainer_price_id);
    assert.match(link.inactive_message, /no longer active\. If you already set up your monthly card payments with it, there is nothing more to do/);
    assert.equal(mails.length, before + 1);
    assert.ok(lastMail().text.includes(sent.retainerLinkUrl as string));
  });

  // ── after the client has used the retainer link ─────────────────────────
  await check("once the client has subscribed, a re-send says the retainer is set up and never emails the used-up link", async () => {
    const used = await row(keptId);
    clientSubscribes(used.stripe_retainer_link_id as string);
    const mark = stripeCalls.length;
    const sent = await invoices.sendInvoice(cc, keptId);
    assert.equal(stripeSince(mark).length, 0, "nothing is created");
    assert.equal(sent.retainerLinkUrl, null);
    assert.equal(sent.retainerAlreadySetUp, true);
    const m = lastMail();
    assert.ok(!m.text.includes(used.stripe_retainer_link_url as string), "the used link is not in the email");
    assert.ok(!m.html.includes(used.stripe_retainer_link_url as string));
    assert.match(m.text, /Monthly retainer — CA\$500\.00\/month: automatic monthly card payments are already set up/);
    assert.match(m.text, /Implementation — CA\$2,000\.00 due by .*: pay by bank transfer/, "the implementation is still asked for");
    assert.match(m.text, /Institution number: 621/);
    assert.doesNotMatch(m.html, /Set up monthly payments/);
    const pdf = await pdfOf(m);
    assert.ok(!pdf.includes(used.stripe_retainer_link_url as string), "nor in the PDF");
    assert.match(pdf, /automatic monthly card payments are already set up/);

    // A changed amount after the client subscribed would start a SECOND subscription: refused.
    await raw.execute({ sql: `UPDATE fin_invoices SET retainer_monthly_cents = 55000 WHERE id = ?`, args: [keptId] });
    const before = mails.length;
    await assert.rejects(
      invoices.sendInvoice(cc, keptId),
      (e: unknown) =>
        e instanceof access.FinanceInputError &&
        /already set up monthly card payments of CA\$500\.00\/month/.test(e.message) &&
        /change the amount on their subscription in Stripe/.test(e.message) &&
        e.message.endsWith("Nothing was emailed."),
    );
    assert.equal(mails.length, before);
    assert.equal(stripeSince(mark).length, 0, "no new price or link");
    await raw.execute({ sql: `UPDATE fin_invoices SET retainer_monthly_cents = 50000 WHERE id = ?`, args: [keptId] });
  });

  await check("a retainer-only invoice whose link was used has nothing left to send; a link switched off UNUSED gets a fresh one; a link whose use Stripe can't report is refused — a dead link is never emailed", async () => {
    const onlyLines = [{ description: "Monthly retainer", quantity: 1, unit_price: "400", billing: "monthly" }];
    const usedId = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Pied Piper", email: "ap@piedpiper.test" }, currency: "CAD", payment_method: "stripe", lines: onlyLines });
    await invoices.sendInvoice(cc, usedId);
    clientSubscribes((await row(usedId)).stripe_retainer_link_id as string);
    const before = mails.length;
    await assert.rejects(
      invoices.sendInvoice(cc, usedId),
      (e: unknown) => e instanceof access.FinanceInputError && /already set up the monthly card payments/.test(e.message) && e.message.endsWith("Nothing was emailed."),
    );
    assert.equal(mails.length, before);

    const offId = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Aviato", email: "ap@aviato.test" }, currency: "CAD", payment_method: "stripe", lines: onlyLines });
    await invoices.sendInvoice(cc, offId);
    const off = await row(offId);
    const deadUrl = off.stripe_retainer_link_url as string;
    stripe.links.get(off.stripe_retainer_link_id as string)!.active = false; // switched off in the Stripe dashboard, never used
    let mark = stripeCalls.length;
    const again = await invoices.sendInvoice(cc, offId);
    assert.equal(mails.length, before + 2, "the first send and the re-send");
    assert.ok(again.retainerLinkUrl && again.retainerLinkUrl !== deadUrl, "the client has not subscribed: a fresh link");
    assert.ok(!lastMail().text.includes(deadUrl) && !lastMail().html.includes(deadUrl), "the dead link is never emailed");
    assert.ok(lastMail().text.includes(again.retainerLinkUrl as string));
    const fresh = await row(offId);
    assert.equal(stripe.links.get(fresh.stripe_retainer_link_id as string)!.active, true, "the link emailed is live");
    assert.deepEqual(stripeSince(mark).map((c) => c.path), ["/v1/payment_links"], "the saved price is reused, and the old link is already off: one new link, nothing else");

    // Its one-payment limit removed in Stripe: whether the client subscribed can't be told, so nothing is emailed.
    delete (stripe.links.get(fresh.stripe_retainer_link_id as string) as { restrictions?: unknown }).restrictions;
    mark = stripeCalls.length;
    await assert.rejects(
      invoices.sendInvoice(cc, offId),
      (e: unknown) => e instanceof access.FinanceInputError && e.message === invoices.RETAINER_LINK_STATE_UNKNOWN,
    );
    assert.match(invoices.RETAINER_LINK_STATE_UNKNOWN, /can't tell whether they already subscribed/);
    assert.equal(mails.length, before + 2, "nothing more was emailed");
    assert.equal(stripeSince(mark).length, 0, "no new link either");
  });

  await check("the invoice page's retainer block reads Stripe's live link state, and the downloadable PDF never prints a dead link", async () => {
    const lines = [{ description: "Monthly retainer", quantity: 1, unit_price: "350", billing: "monthly" }];
    const id = await invoices.createDraftInvoice(cc, "oasis", { new_contact: { name: "Soylent", email: "ap@soylent.test" }, currency: "CAD", payment_method: "stripe", lines });
    assert.deepEqual(await invoices.retainerLinkStatus(await row(id)), { state: "none" }, "a draft has no link until it is sent");
    const reads = stripeReads.length;
    await invoices.retainerLinkStatus(await row(id));
    assert.equal(stripeReads.length, reads, "no link: Stripe is not asked");
    const sent = await invoices.sendInvoice(cc, id);
    const url = sent.retainerLinkUrl as string;
    const r = await row(id);
    const st = await invoices.retainerLinkStatus(r);
    assert.equal(st.state, "active");
    assert.ok(st.state !== "none" && st.url === url && st.stale === false && st.linkCents === 35000 && st.reason === null);
    assert.ok((await pdfText((await invoices.invoicePdfBytes(cc, id)).bytes)).includes(url), "a live link is printed");

    // The page shows it whatever the invoice's status: the block is not inside the draft/open-only send card.
    const page = readFileSync(join(root, "app/founders/finances/invoices/[id]/page.tsx"), "utf8");
    assert.match(page, /Promise\.all\(\[retainerLinkStatus\(inv\), verifiedOneTimePaymentLink\(inv\)\]\)/);
    assert.match(page, /\{\(retainer > 0 \|\| linkStatus\.state !== "none"\) && \(\s*<RetainerBlock /);
    assert.match(page, /client has subscribed/);

    // Amount changed since the link was made: stale, not offered.
    await raw.execute({ sql: `UPDATE fin_invoices SET retainer_monthly_cents = 36000 WHERE id = ?`, args: [id] });
    const stale = await invoices.retainerLinkStatus(await row(id));
    assert.ok(stale.state === "unknown" && stale.stale === true && stale.url === null);
    assert.ok(!(await pdfText((await invoices.invoicePdfBytes(cc, id)).bytes)).includes(url), "a link for another amount is not printed");
    await raw.execute({ sql: `UPDATE fin_invoices SET retainer_monthly_cents = 35000 WHERE id = ?`, args: [id] });

    // The client subscribes: "client has subscribed / link used", and the PDF says it is set up instead of printing the spent link.
    clientSubscribes(r.stripe_retainer_link_id as string);
    assert.equal((await invoices.retainerLinkStatus(await row(id))).state, "used");
    const usedPdf = await pdfText((await invoices.invoicePdfBytes(cc, id)).bytes);
    assert.ok(!usedPdf.includes(url));
    assert.match(usedPdf, /automatic monthly card payments are already set up/);

    // Stripe can't be asked: "unknown" with a plain reason (Stripe's words in the log only), never a throw, never the link.
    const consoleError = console.error;
    console.error = () => {};
    stripe.failWith = { status: 503, message: "raw upstream failure", reads: true };
    try {
      const unknown = await invoices.retainerLinkStatus(await row(id));
      assert.equal(unknown.state, "unknown");
      assert.ok(unknown.state !== "none" && unknown.reason && /problem on its side/.test(unknown.reason) && !/raw upstream/.test(unknown.reason));
      assert.ok(!(await pdfText((await invoices.invoicePdfBytes(cc, id)).bytes)).includes(url));
    } finally {
      stripe.failWith = null;
      console.error = consoleError;
    }
  });

  // ── retainer-only invoice ────────────────────────────────────────────────
  let onlyId = "";
  await check("an all-monthly invoice issues with nothing due and books nothing; it is never overdue", async () => {
    onlyId = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Initech", email: "ap@initech.test" },
      issue_date: addDays(today, -40),
      due_date: addDays(today, -26),
      currency: "USD",
      payment_method: "stripe",
      lines: [{ description: "Monthly retainer", quantity: 1, unit_price: "750", billing: "monthly" }],
    });
    const f = await invoices.finalizeInvoice(cc, onlyId);
    assert.equal(f.status, "sent");
    assert.ok(f.number);
    assert.equal(f.total_cents, 0);
    assert.equal(Number(f.retainer_monthly_cents), 75000);
    assert.equal(f.recognition_entry_id, null);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source_ref = ?`, [onlyId]), 0, "no entry (and no USD rate needed)");
    await invoices.sweepOverdue(B);
    assert.equal((await row(onlyId)).status, "sent", "the sweep leaves it alone");
    const listed = (await invoices.listInvoices(cc, "oasis")).find((x) => x.id === onlyId)!;
    assert.equal(listed.effective_status, "sent");
    assert.equal(listed.list_status, "retainer", "listed as a retainer set-up, not as an open invoice");
    assert.equal(listed.retainer_link, "none");
    assert.equal(listed.balance_cents, 0);
    const ids = async (status: string) => (await invoices.listInvoices(cc, "oasis", status)).map((x) => x.id);
    assert.equal((await ids("sent")).includes(onlyId), false, "the open (sent) filter leaves it out");
    assert.equal((await ids("overdue")).includes(onlyId), false);
    assert.equal((await ids("retainer")).includes(onlyId), true, "found under its own filter");
    assert.equal((await ids("sent")).includes(mixedId), true, "an invoice with money due now is still open");
    const detail = await invoices.getInvoiceDetail(cc, onlyId);
    assert.equal(detail.listStatus, "retainer");
    const listPage = readFileSync(join(root, "app/founders/finances/invoices/page.tsx"), "utf8");
    const financeUi = readFileSync(join(root, "components/founders/finances/ui.ts"), "utf8");
    assert.match(listPage, /STATUS_LABEL\[i\.display_status\]/, "the list renders the founder-facing label");
    assert.match(financeUi, /retainer: "Retainer set up"/, "the list labels it plainly");
    const plan = await invoices.remindOverdue(cc, { send: false });
    assert.equal(plan.some((p) => p.invoice_id === onlyId), false, "never chased");
    await assert.rejects(invoices.markInvoicePaidManually(cc, onlyId, {}), (e: unknown) => e instanceof access.FinanceInputError && /nothing due now/.test(e.message));
  });

  await check("an all-monthly invoice emails only the retainer: no bank details, no one-off card link", async () => {
    const mark = stripeCalls.length;
    const sent = await invoices.sendInvoice(cc, onlyId);
    const prices = stripeSince(mark, "/v1/prices");
    assert.equal(prices.length, 1);
    assert.equal(prices[0].params["recurring[interval]"], "month");
    assert.equal(prices[0].params.currency, "usd");
    assert.equal(prices[0].params.unit_amount, "75000");
    assert.equal(sent.paymentLinkUrl, null);
    assert.equal(sent.bankTransfer, false);
    const m = lastMail();
    assert.match(m.text, /nothing is due now/);
    assert.doesNotMatch(m.text, /Implementation —|Institution number|Payment reference/);
    assert.match(m.text, /Monthly retainer — US\$750\.00\/month: set up automatic monthly card payments/);
    assert.match(m.text, /Due now: US\$0\.00/);
    const pdf = await pdfOf(m);
    assert.doesNotMatch(pdf, /Implementation/);
    assert.ok(pdf.includes(sent.retainerLinkUrl as string));
    const listed = (await invoices.listInvoices(cc, "oasis")).find((x) => x.id === onlyId)!;
    assert.deepEqual([listed.list_status, listed.retainer_link], ["retainer", "emailed"]);
  });

  await check("Atlas's summary: a retainer-only invoice is never an open invoice; it is reported apart with its monthly amount and link state", async () => {
    process.env.FINANCE_AGENT_TOKEN = "retainer-test-finance-agent-token-0123";
    const route = await import("../app/api/internal/finance/summary/route");
    const res = await route.GET(new Request("http://localhost/api/internal/finance/summary", { headers: { authorization: `Bearer ${process.env.FINANCE_AGENT_TOKEN}` } }));
    const body = (await res.json()) as {
      ok: boolean;
      open_invoices: Array<{ id: string; balance_cents: number }>;
      retainer_invoices: Array<Record<string, unknown>>;
    };
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.open_invoices.some((i) => i.id === onlyId), false, "nothing is due on it: not open");
    assert.ok(body.open_invoices.every((i) => i.balance_cents > 0), "every open invoice has money due now");
    const only = await row(onlyId);
    assert.deepEqual(
      body.retainer_invoices.find((i) => i.id === onlyId),
      { id: onlyId, number: only.number, customer: "Initech", status: "retainer", monthly_cents: 75000, currency: "USD", link: "emailed" },
    );
    assert.ok(body.open_invoices.some((i) => i.id === keptId), "a mixed invoice with its implementation unpaid is still open");
  });

  // ── GST/QST on a retainer ────────────────────────────────────────────────
  await check("registered: a retainer that would carry GST/QST is refused in a sentence (the Stripe feed can't split its tax); an untaxed one issues", async () => {
    const TAX_REFUSED = inv.RETAINER_TAX_REFUSED;
    assert.match(TAX_REFUSED, /counted as income instead of tax owed/);
    const taxed = inv.computeInvoiceTotals([{ description: "Retainer", quantity: "1", unitPrice: "200", billing: "monthly" }], { registered: true });
    assert.equal(inv.retainerTaxRefusal(taxed), TAX_REFUSED);
    assert.equal(inv.retainerTaxRefusal(inv.computeInvoiceTotals([{ description: "Retainer", quantity: "1", unitPrice: "200", billing: "monthly" }], { registered: false })), null);
    assert.equal(inv.retainerTaxRefusal(inv.computeInvoiceTotals([{ description: "Build", quantity: "1", unitPrice: "200" }], { registered: true })), null, "one-time tax is booked properly: never refused");

    // Saved while NOT registered: allowed (no tax is computed).
    const earlyId = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Stark", email: "ap@stark.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Monthly retainer", quantity: 1, unit_price: "300", billing: "monthly" }],
    });
    await raw.execute({ sql: `UPDATE fin_settings SET gst_qst_registered = 1, gst_number = '123456789RT0001', qst_number = '1234567890TQ0001' WHERE entity_id = ?`, args: [B] });
    try {
      await assert.rejects(
        invoices.createDraftInvoice(cc, "oasis", {
          new_contact: { name: "Wayne", email: "ap@wayne.test" },
          currency: "CAD",
          payment_method: "stripe",
          lines: [{ description: "Monthly retainer", quantity: 1, unit_price: "300", billing: "monthly" }],
        }),
        (e: unknown) => e instanceof access.FinanceInputError && e.message === TAX_REFUSED,
      );
      // Registration switched on after the draft was saved: refused when it is sent, before anything is numbered, created or emailed.
      const before = mails.length;
      const mark = stripeCalls.length;
      await assert.rejects(invoices.sendInvoice(cc, earlyId), (e: unknown) => e instanceof access.FinanceInputError && e.message === TAX_REFUSED);
      assert.equal(mails.length, before);
      assert.equal(stripeSince(mark).length, 0);
      const early = await row(earlyId);
      assert.equal(early.status, "draft");
      assert.equal(early.number, null);

      // A monthly line not marked taxable (e.g. zero-rated for a non-resident client) issues normally.
      const zeroId = await invoices.createDraftInvoice(cc, "oasis", {
        new_contact: { name: "Wonka Inc", email: "ap@wonka.test" },
        currency: "USD",
        payment_method: "stripe",
        lines: [{ description: "Monthly retainer (zero-rated export)", quantity: 1, unit_price: "300", billing: "monthly", taxable: false }],
      });
      const f = await invoices.finalizeInvoice(cc, zeroId);
      assert.equal(f.status, "sent");
      assert.equal(Number(f.retainer_monthly_cents), 30000, "no tax in the retainer");
      assert.equal(f.recognition_entry_id, null);
    } finally {
      await raw.execute({ sql: `UPDATE fin_settings SET gst_qst_registered = 0 WHERE entity_id = ?`, args: [B] });
    }
  });

  // ── overdue reminders chase the one-time balance only ────────────────────
  await check("overdue reminders chase the one-time balance, never the retainer", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Umbrella", email: "ap@umbrella.test" },
      issue_date: addDays(today, -40),
      due_date: addDays(today, -10),
      currency: "CAD",
      payment_method: "wise_stripe",
      lines: [
        { description: "Implementation", quantity: 1, unit_price: "1200" },
        { description: "Retainer", quantity: 1, unit_price: "300", billing: "monthly" },
      ],
    });
    await invoices.finalizeInvoice(cc, id);
    const before = mails.length;
    const plans = await invoices.remindOverdue(cc, { send: true });
    const plan = plans.find((p) => p.invoice_id === id)!;
    assert.equal(plan.action, "sent", JSON.stringify(plan));
    assert.equal(plan.balance_cents, 120000);
    assert.equal(mails.length, before + 1);
    const m = lastMail();
    assert.match(m.subject, /past due/);
    assert.match(m.text, /for CA\$1,200\.00 was due/);
    assert.doesNotMatch(m.text, /retainer|CA\$300/i, "the reminder asks for the implementation only");
  });

  await check("an overdue reminder claim loses safely when payment or void wins after the initial query", async () => {
    const run = async (winner: "payment" | "void") => {
      const email = `ap@reminder-${winner}-race.test`;
      const id = await invoices.createDraftInvoice(cc, "oasis", {
        new_contact: { name: `Reminder ${winner} race`, email },
        issue_date: addDays(today, -30),
        due_date: addDays(today, -5),
        currency: "CAD",
        payment_method: "wise",
        lines: [{ description: "Implementation", quantity: 1, unit_price: "815" }],
      });
      await invoices.finalizeInvoice(cc, id);
      const mailMark = mails.length;
      const raced = await withExecuteRace(
        (statement) => statement.includes("send_claim_token") && statement.includes(id),
        async () => {
          if (winner === "payment") await invoices.markInvoicePaidManually(cc, id, {});
          else await invoices.voidInvoice(cc, id);
        },
        () => invoices.remindOverdue(cc, { send: true }),
      );
      assert.equal(raced.raced, true);
      const plan = raced.result.find((p) => p.invoice_id === id)!;
      assert.equal(plan.action, "failed", JSON.stringify(plan));
      assert.match(plan.reason || "", /changed before.*claim|cannot be sent|changed/i);
      assert.equal(mails.slice(mailMark).some((m) => m.to === email), false, "the stale reminder never reaches the customer");
      assert.equal((await row(id)).status, winner === "payment" ? "paid" : "void");
    };
    await run("payment");
    await run("void");
  });

  await check("an overdue reminder's email AND its attached PDF carry the one-time balance only — no retainer section, total or link — while the invoice email kept both", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Cyberdyne", email: "ap@cyberdyne.test" },
      issue_date: addDays(today, -30),
      due_date: addDays(today, -5),
      currency: "CAD",
      payment_method: "wise_stripe",
      lines: [
        { description: "Implementation", quantity: 1, unit_price: "1800" },
        { description: "Hosting and support", quantity: 1, unit_price: "450", billing: "monthly" },
      ],
    });
    const sent = await invoices.sendInvoice(cc, id);
    const link = sent.retainerLinkUrl as string;
    const original = lastMail();
    assert.ok(original.text.includes(link));
    const originalPdf = await pdfOf(original);
    assert.ok(originalPdf.includes(link), "the invoice's own PDF carries the retainer link");
    assert.match(originalPdf, /Monthly retainer . CA\$450\.00\/month/);
    assert.match(originalPdf, /Implementation . CA\$1,800\.00 due by/);

    const before = mails.length;
    const plan = (await invoices.remindOverdue(cc, { send: true })).find((p) => p.invoice_id === id)!;
    assert.equal(plan.action, "sent", JSON.stringify(plan));
    assert.equal(plan.balance_cents, 180000);
    assert.equal(mails.length, before + 1);
    const m = lastMail();
    assert.match(m.subject, /past due/);
    for (const body of [m.text, m.html]) {
      assert.ok(!body.includes(link), "no retainer link in the reminder email");
      assert.doesNotMatch(body, /retainer|CA\$450/i);
    }
    const pdf = await pdfOf(m);
    assert.ok(!pdf.includes(link), "no retainer link in the reminder's PDF");
    assert.doesNotMatch(pdf, /retainer|\/mo|Hosting and support|CA\$450/i, "no retainer line, total or section in the reminder's PDF");
    assert.match(pdf, /Implementation/);
    assert.match(pdf, /Total CAD/);
    assert.ok(pdf.includes("CA$1,800.00"));
    assert.match(pdf, /Institution number/, "it still says how to pay the one-time balance");
  });

  await check("Wise reminders retire legacy one-time links and downloaded PDFs never print them", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Legacy Wise", email: "ap@legacy-wise.test" },
      issue_date: addDays(today, -30),
      due_date: addDays(today, -4),
      currency: "CAD",
      payment_method: "wise",
      lines: [{ description: "Implementation", quantity: 1, unit_price: "990" }],
    });
    await invoices.finalizeInvoice(cc, id);
    const priceId = `price_legacy_${stripe.seq + 1}`;
    const linkId = `plink_legacy_${stripe.seq + 1}`;
    const url = `https://buy.stripe.com/legacy_${stripe.seq + 1}`;
    stripe.prices.set(priceId, { id: priceId, object: "price", livemode: true, unit_amount: 99000, currency: "cad" });
    stripe.links.set(linkId, { id: linkId, url, active: true, priceId, restrictions: { completed_sessions: { count: 0, limit: 1 } } });
    await raw.execute({ sql: `UPDATE fin_invoices SET stripe_price_id = ?, stripe_payment_link_id = ?, stripe_payment_link_url = ? WHERE id = ?`, args: [priceId, linkId, url, id] });
    assert.ok(!(await pdfText((await invoices.invoicePdfBytes(cc, id)).bytes)).includes(url), "wrong-mode PDF omits without trusting the stored URL");
    const before = mails.length;
    const plan = (await invoices.remindOverdue(cc, { send: true })).find((p) => p.invoice_id === id)!;
    assert.equal(plan.action, "sent", JSON.stringify(plan));
    assert.equal(mails.length, before + 1);
    const mail = lastMail();
    assert.ok(!mail.text.includes(url) && !mail.html.includes(url));
    assert.ok(!(await pdfOf(mail)).includes(url));
    assert.equal(stripe.links.get(linkId)!.active, false);
    const after = await row(id);
    assert.deepEqual([after.stripe_price_id, after.stripe_payment_link_id, after.stripe_payment_link_url], [null, null, null]);
  });

  await check("deleting a linked draft strictly shuts down and confirms both links; uncertainty preserves it", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Delete linked", email: "ap@delete-linked.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [
        { description: "Implementation", quantity: 1, unit_price: "700" },
        { description: "Support", quantity: 1, unit_price: "90", billing: "monthly" },
      ],
    });
    let linked = await row(id);
    await invoices.ensureRetainerLink(linked);
    linked = await row(id);
    await invoices.ensurePaymentLink(linked, linked);
    linked = await row(id);
    assert.equal(linked.status, "draft");
    assert.ok(linked.stripe_payment_link_id && linked.stripe_retainer_link_id);
    stripe.failWith = { status: 503, message: "shutdown unavailable", reads: true };
    const logged = console.error;
    console.error = () => {};
    try {
      await assert.rejects(invoices.deleteDraftInvoice(cc, id), /not deleted/);
    } finally {
      console.error = logged;
      stripe.failWith = null;
    }
    assert.equal(await count(`SELECT COUNT(*) FROM fin_invoices WHERE id = ?`, [id]), 1);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_invoice_lines WHERE invoice_id = ?`, [id]), 2);

    const reads = stripeReads.length;
    await invoices.deleteDraftInvoice(cc, id);
    assert.equal(stripe.links.get(linked.stripe_payment_link_id as string)!.active, false);
    assert.equal(stripe.links.get(linked.stripe_retainer_link_id as string)!.active, false);
    assert.deepEqual(stripeReads.slice(reads), [
      `/v1/payment_links/${linked.stripe_payment_link_id}`,
      `/v1/payment_links/${linked.stripe_retainer_link_id}`,
    ]);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_invoices WHERE id = ?`, [id]), 0);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_invoice_lines WHERE invoice_id = ?`, [id]), 0);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_audit_log WHERE object_id = ? AND action = 'invoice.draft_deleted'`, [id]), 1);

    const partial = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Partial retainer", email: "ap@partial-retainer.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [{ description: "Support", quantity: 1, unit_price: "50", billing: "monthly" }],
    });
    await raw.execute({ sql: `UPDATE fin_invoices SET stripe_retainer_link_url = 'https://buy.stripe.com/missing-id' WHERE id = ?`, args: [partial] });
    console.error = () => {};
    try {
      await assert.rejects(invoices.deleteDraftInvoice(cc, partial), /not deleted/);
    } finally {
      console.error = logged;
    }
    assert.equal(await count(`SELECT COUNT(*) FROM fin_invoices WHERE id = ?`, [partial]), 1, "a URL without its Stripe id fails closed");
  });

  // ── paid, void, books ────────────────────────────────────────────────────
  await check("paid = the one-time balance paid; the retainer link stays live", async () => {
    const mark = stripeCalls.length;
    await invoices.markInvoicePaidManually(cc, mixedId, { reference: "Wise TRANSFER-1" });
    const d = await row(mixedId);
    assert.equal(d.status, "paid");
    assert.equal(d.amount_paid_cents, 200000);
    assert.equal(stripeSince(mark).length, 0, "no link was switched off: the client may not have subscribed yet");
    assert.ok(d.stripe_retainer_link_url);
  });

  await check("voiding a retainer invoice switches its link off", async () => {
    const d = await row(onlyId);
    const mark = stripeCalls.length;
    const reads = stripeReads.length;
    await invoices.voidInvoice(cc, onlyId);
    assert.deepEqual(
      stripeSince(mark).map((c) => [c.path, c.params.active]),
      [[`/v1/payment_links/${d.stripe_retainer_link_id}`, "false"]],
    );
    assert.deepEqual(stripeReads.slice(reads), [`/v1/payment_links/${d.stripe_retainer_link_id}`], "void GET-confirms the link is really off");
    assert.equal((await row(onlyId)).status, "void");
  });

  await check("a void PDF says VOID and exposes no Wise, card, retainer, or amount-due rail", async () => {
    for (const method of ["stripe", "wise_stripe"] as const) {
      const id = await invoices.createDraftInvoice(cc, "oasis", {
        new_contact: { name: `Void PDF ${method}`, email: `ap@void-pdf-${method}.test` },
        currency: "CAD",
        payment_method: method,
        lines: [
          { description: "Implementation", quantity: 1, unit_price: "925" },
          { description: "Support", quantity: 1, unit_price: "85", billing: "monthly" },
        ],
      });
      const sent = await invoices.sendInvoice(cc, id);
      const urls = [sent.paymentLinkUrl, sent.retainerLinkUrl].filter(Boolean) as string[];
      await invoices.voidInvoice(cc, id);
      const pdf = await pdfText((await invoices.invoicePdfBytes(cc, id)).bytes);
      assert.match(pdf, /VOID/);
      assert.match(pdf, /VOID . amount due CAD CA\$0\.00/);
      assert.doesNotMatch(pdf, /PAY BY BANK TRANSFER|Institution number|PAY ONLINE|MONTHLY CARD PAYMENTS|set up automatic monthly/i);
      for (const url of urls) assert.ok(!pdf.includes(url));
    }
  });

  await check("void strictly shuts down both links before a CAS-gated reversal; Stripe failure and a DB race have zero bookkeeping effects", async () => {
    const id = await invoices.createDraftInvoice(cc, "oasis", {
      new_contact: { name: "Strict Void", email: "ap@strict-void.test" },
      currency: "CAD",
      payment_method: "stripe",
      lines: [
        { description: "Implementation", quantity: 1, unit_price: "1100" },
        { description: "Support", quantity: 1, unit_price: "125", billing: "monthly" },
      ],
    });
    await invoices.sendInvoice(cc, id);
    const before = await row(id);
    const auditBefore = await count(`SELECT COUNT(*) FROM fin_audit_log WHERE object_id = ? AND action = 'invoice.voided'`, [id]);
    stripe.failWith = { status: 503, message: "shutdown unavailable", reads: true };
    const logged = console.error;
    console.error = () => {};
    try {
      await assert.rejects(invoices.voidInvoice(cc, id), /not voided/);
    } finally {
      console.error = logged;
      stripe.failWith = null;
    }
    assert.equal((await row(id)).status, "sent");
    assert.equal((await raw.execute({ sql: `SELECT status FROM fin_journal_entries WHERE id = ?`, args: [before.recognition_entry_id] })).rows[0].status, "posted");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_audit_log WHERE object_id = ? AND action = 'invoice.voided'`, [id]), auditBefore);

    const raced = await withRace(
      (batch) => batch.includes("invoice.voided") && batch.includes(id),
      () => raw.execute({ sql: `UPDATE fin_invoices SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`, args: [id] }).then(() => undefined),
      () => assert.rejects(invoices.voidInvoice(cc, id), /changed while it was being voided/),
    );
    assert.equal(raced.raced, true);
    assert.equal(stripe.links.get(before.stripe_payment_link_id as string)!.active, false);
    assert.equal(stripe.links.get(before.stripe_retainer_link_id as string)!.active, false);
    assert.equal((await row(id)).status, "sent");
    assert.equal((await raw.execute({ sql: `SELECT status FROM fin_journal_entries WHERE id = ?`, args: [before.recognition_entry_id] })).rows[0].status, "posted");
    assert.equal(await count(`SELECT COUNT(*) FROM fin_journal_entries WHERE source = 'reversal' AND source_ref = ?`, [before.recognition_entry_id]), 0);
    assert.equal(await count(`SELECT COUNT(*) FROM fin_audit_log WHERE object_id = ? AND action = 'invoice.voided'`, [id]), auditBefore);
    await invoices.voidInvoice(cc, id);
    assert.equal((await row(id)).status, "void");
  });

  await check("the books balance, and AR is exactly the open one-time balances", async () => {
    const byCur = (await raw.execute(`SELECT currency, SUM(debit_cents) AS d, SUM(credit_cents) AS c, SUM(cad_debit_cents) AS cd, SUM(cad_credit_cents) AS cc FROM fin_journal_lines GROUP BY currency`)).rows;
    assert.ok(byCur.length > 0);
    for (const r of byCur) {
      assert.equal(Number(r.d), Number(r.c), `${r.currency} debits = credits`);
      assert.equal(Number(r.cd), Number(r.cc), `${r.currency} CAD equivalents balance`);
    }
    const arBal = await count(`SELECT COALESCE(SUM(debit_cents - credit_cents), 0) FROM fin_journal_lines WHERE account_id = ? AND currency = 'CAD'`, [ar]);
    const open = await count(`SELECT COALESCE(SUM(total_cents - amount_paid_cents), 0) FROM fin_invoices WHERE currency = 'CAD' AND status IN ('sent', 'overdue', 'paid')`);
    assert.equal(arBal, open, "AR = one-time totals less payments; no retainer is in it");
    const retainers = await count(`SELECT COALESCE(SUM(retainer_monthly_cents), 0) FROM fin_invoices WHERE status <> 'void'`);
    assert.ok(retainers > 0);
    const revenue = await count(
      `SELECT COALESCE(SUM(l.credit_cents - l.debit_cents), 0) FROM fin_journal_lines l JOIN fin_accounts a ON a.id = l.account_id WHERE a.type = 'revenue' AND l.currency = 'CAD'`,
    );
    const oneTime = await count(`SELECT COALESCE(SUM(total_cents), 0) FROM fin_invoices WHERE currency = 'CAD' AND status IN ('sent', 'overdue', 'paid')`);
    assert.equal(revenue, oneTime, "revenue booked = the one-time totals; the retainers are not in it");
  });

  if (failures > 0) {
    console.log(`finances-invoice-retainer: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("finances-invoice-retainer: all passed");
  process.exit(0);
}

/** The Wise rows as the plain-text email prints them ("  Label: value"), for recomposing the expected email. */
function invoicesBankLines(text: string): Array<{ label: string; value: string }> {
  const start = text.indexOf("Pay by bank transfer (Wise):");
  const end = text.indexOf("Please include the payment reference");
  return text
    .slice(start, end)
    .split("\n")
    .slice(1)
    .filter((l) => l.startsWith("  "))
    .map((l) => {
      const i = l.indexOf(": ");
      return { label: l.slice(2, i), value: l.slice(i + 2) };
    });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
