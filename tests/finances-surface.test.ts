/**
 * tests/finances-surface.test.ts — the Finances surface: navigation, gates,
 * the invoice PDF and email, and CSV exports.
 *
 *  - Finances is a sibling of Marketing in the founders nav, and Marketing's
 *    sub-chips never render on a Finances page (nor the reverse).
 *  - Every Finances page, UI route and internal route has its gate — asserted
 *    over the tree, so a route added later without one fails here.
 *  - The PDF shows NO tax lines and NO registration numbers while
 *    unregistered, and both once registered (text extracted with pdfjs).
 *  - The invoice mailer refuses loudly with no mailbox, and refuses a mailbox
 *    on another company's domain.
 *
 * Run: node --conditions=react-server --import tsx tests/finances-surface.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { FOUNDERS_NAV, FOUNDERS_PORTAL, portalForPath, visibleFoundersSections } from "../lib/portals/registry";
import { isPublic } from "../middleware";
import { renderInvoicePdf, winAnsiSafe, type InvoicePdfInput } from "../lib/founders-finances/invoice-pdf";
import { composeInvoiceEmail, resolveInvoiceMailbox, InvoiceMailerNotConfigured } from "../lib/founders-finances/invoice-email";
import { pnlRows, trialRows } from "../lib/founders-finances/report-csv";
import { toCsv } from "../lib/founders-finances/reports";
import { bearerMatches } from "../lib/founders-finances/internal-auth";

const root = join(__dirname, "..");

async function main() {
  // ── navigation ──────────────────────────────────────────────────────────
  const fin = FOUNDERS_NAV.find((n) => n.href === "/founders/finances");
  assert.ok(fin, "Finances is in the founders nav");
  assert.equal(fin!.label, "Finances");
  assert.equal(fin!.icon, "Landmark");
  assert.equal(fin!.audience, "finance_owners", "hidden from the marketing hire the portal admits");
  assert.ok(FOUNDERS_NAV.some((n) => n.href === "/founders/marketing"), "Marketing is still there");
  assert.equal(portalForPath("lib/founders-finances/metrics.ts"), "founders");
  assert.equal(portalForPath("app/founders/finances/page.tsx"), "founders");

  const labelsOn = (p: string) => visibleFoundersSections(p, FOUNDERS_PORTAL.sections).chips.map((s) => s.label);
  assert.deepEqual(labelsOn("/founders/finances"), ["Marketing", "Finances"], "no Marketing sub-chips on Finances");
  assert.deepEqual(labelsOn("/founders/finances/reports"), ["Marketing", "Finances"]);
  assert.deepEqual(labelsOn("/founders/marketing/library"), ["Marketing", "Finances", "Library", "Train", "Performance"]);
  assert.equal(visibleFoundersSections("/founders/marketing/performance", FOUNDERS_PORTAL.sections).active, "/founders/marketing/performance");
  assert.equal(visibleFoundersSections("/founders/finances/taxes", FOUNDERS_PORTAL.sections).active, "/founders/finances");
  assert.equal(labelsOn("/founders/marketingx").includes("Library"), false, "prefix match needs a path boundary");

  const rootLayout = readFileSync(join(root, "app/layout.tsx"), "utf8");
  assert.match(rootLayout, /isFinanceOwnerEmail\(profile\?\.email\)/, "the sidebar filters the Finances row by owner email");
  const foundersLayout = readFileSync(join(root, "app/founders/layout.tsx"), "utf8");
  assert.match(foundersLayout, /FoundersPortalBanner/, "banner + chips; hidden on Finances (tests/finances-roundtrips.test.ts)");
  assert.match(foundersLayout, /isFinanceOwnerEmail\(founder\.email\)/, "the header chip is filtered the same way");

  // ── gates, over the whole tree ──────────────────────────────────────────
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  };
  const financeLayout = readFileSync(join(root, "app/founders/finances/layout.tsx"), "utf8");
  assert.match(financeLayout, /resolveFinanceViewer\(\)/);
  assert.match(financeLayout, /notFound\(\)/);
  const pages = walk(join(root, "app/founders/finances")).filter((f) => f.endsWith("page.tsx"));
  assert.ok(pages.length >= 9, `expected the 8 tabs + invoice detail, found ${pages.length}`);
  for (const p of pages) {
    const src = readFileSync(p, "utf8");
    assert.ok(/financePage\(|resolveFinanceViewer\(/.test(src), `${p} must resolve the finance viewer itself (defence in depth)`);
  }
  const uiRoutes = walk(join(root, "app/api/founders/finances")).filter((f) => f.endsWith("route.ts"));
  assert.ok(uiRoutes.length >= 5);
  for (const r of uiRoutes) {
    const src = readFileSync(r, "utf8");
    assert.match(src, /resolveFinanceViewer\(\)/, `${r} must gate on the finance viewer`);
    assert.match(src, /status: 404/, `${r} must answer 404, never 403`);
  }
  const internal = walk(join(root, "app/api/internal/finance")).filter((f) => f.endsWith("route.ts"));
  assert.equal(internal.length, 7, "summary, stripe-reconcile, fx-refresh, transactions, invoices/remind-overdue, wise-reconcile, wise-sync");
  for (const r of internal) {
    const src = readFileSync(r, "utf8");
    assert.match(src, /const denied = checkFinanceAgentAuth\(req\);\s*if \(denied\) return denied;/, `${r} must check FINANCE_AGENT_TOKEN first`);
  }
  assert.equal(isPublic("/api/internal/finance/summary"), true, "Atlas has no session: middleware must let the bearer check run");
  assert.equal(isPublic("/api/internal/finance/invoices/remind-overdue"), true);
  assert.equal(isPublic("/api/internal/finance"), false);
  assert.equal(isPublic("/api/internal/financials"), false);
  assert.equal(isPublic("/api/founders/finances/actions"), false, "the UI routes stay behind the session");
  assert.equal(isPublic("/api/webhooks/stripe-finance"), true);

  const token = "x".repeat(32);
  assert.equal(bearerMatches(`Bearer ${token}`, token), true);
  assert.equal(bearerMatches(`Bearer ${token}x`, token), false);
  assert.equal(bearerMatches(token, token), false, "the Bearer scheme is required");
  assert.equal(bearerMatches(null, token), false);

  // ── invoice PDF ─────────────────────────────────────────────────────────
  const base: InvoicePdfInput = {
    seller: { legalName: "OASIS AI Solutions", addressLines: ["6993 Decarie Blvd", "Montreal, QC  H3W 0B5"], email: "conaugh@oasisai.work", gstNumber: "123456789RT0001", qstNumber: "1234567890TQ0001" },
    invoice: {
      number: "OASIS-2026-0007",
      status: "sent",
      issueDate: "2026-09-24",
      dueDate: "2026-10-08",
      currency: "CAD",
      subtotalCents: 268000,
      gstCents: 0,
      qstCents: 0,
      totalCents: 268000,
      amountPaidCents: 0,
      taxRegistered: false,
      notes: "Project Phoenix — phase 1 ✓",
      paymentLinkUrl: "https://buy.stripe.com/test_link",
      paymentInstructions: "Interac e-Transfer to billing@oasisai.work",
    },
    customer: { name: "Contoso Ltée", company: "", email: "billing@contoso.test", address: "" },
    lines: Array.from({ length: 40 }, (_, i) => ({ description: `Line ${i + 1} — automation work`, quantityMilli: 1500, unitPriceCents: 12000, amountCents: 18000 })),
  };
  const text = async (bytes: Uint8Array): Promise<string> => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: false,
      standardFontDataUrl: join(root, "node_modules", "pdfjs-dist", "standard_fonts") + "/",
    }).promise;
    let out = "";
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      out += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
    }
    return out;
  };
  const unregistered = await renderInvoicePdf(base);
  assert.equal(Buffer.from(unregistered.slice(0, 5)).toString(), "%PDF-");
  const t1 = await text(unregistered);
  assert.match(t1, /OASIS-2026-0007/);
  assert.match(t1, /Contoso Ltée/, "Latin-1 accents survive");
  assert.match(t1, /buy\.stripe\.com/, "the payment link is printed");
  assert.match(t1, /Page 2 of/, "40 lines paginate");
  assert.doesNotMatch(t1, /GST|QST/, "unregistered: no tax lines, no registration numbers");
  assert.doesNotMatch(t1, /123456789RT0001/);
  const registered = await renderInvoicePdf({ ...base, invoice: { ...base.invoice, taxRegistered: true, gstCents: 13400, qstCents: 26733, totalCents: 308133 } });
  const t2 = await text(registered);
  assert.match(t2, /GST 5% \(123456789RT0001\)/);
  assert.match(t2, /QST 9\.975% \(1234567890TQ0001\)/);
  assert.equal(winAnsiSafe("✓ ok 😀 é"), "? ok ? é", "characters the standard fonts cannot draw are replaced, not thrown on");

  // ── invoice email ───────────────────────────────────────────────────────
  for (const k of ["INVOICE_FROM_EMAIL", "INVOICE_FROM_APP_PASSWORD", "OASIS_MAIL_FROM", "OASIS_MAIL_APP_PASSWORD"]) delete process.env[k];
  await assert.rejects(resolveInvoiceMailbox(null), InvoiceMailerNotConfigured, "no mailbox is a loud error");
  process.env.INVOICE_FROM_EMAIL = "billing@sunbizfunding.com";
  process.env.INVOICE_FROM_APP_PASSWORD = "abcd efgh ijkl mnop";
  await assert.rejects(resolveInvoiceMailbox(null), /Refusing to send an OASIS invoice/, "another company's mailbox is refused");
  process.env.INVOICE_FROM_EMAIL = "billing@oasisai.work";
  const mb = await resolveInvoiceMailbox(null);
  assert.equal(mb.from, "billing@oasisai.work");
  assert.equal(mb.password, "abcdefghijklmnop", "spaces in an app password are stripped");
  assert.equal(mb.source, "invoice_env");
  delete process.env.INVOICE_FROM_EMAIL;
  delete process.env.INVOICE_FROM_APP_PASSWORD;
  const mail = composeInvoiceEmail({
    kind: "invoice",
    sellerName: "OASIS AI Solutions",
    customerName: "Contoso <script>",
    number: "OASIS-2026-0007",
    totalCents: 268000,
    balanceCents: 268000,
    currency: "CAD",
    dueDate: "2026-10-08",
    paymentLinkUrl: "https://buy.stripe.com/x",
    paymentInstructions: "",
  });
  assert.equal(mail.subject, "Invoice OASIS-2026-0007 from OASIS AI Solutions");
  assert.match(mail.text, /CA\$2,680\.00/);
  assert.doesNotMatch(mail.html, /<script>/, "customer text is escaped in HTML");
  const reminder = composeInvoiceEmail({ ...{ kind: "reminder" as const, sellerName: "OASIS AI Solutions", customerName: "", number: "N", totalCents: 1, balanceCents: 1, currency: "USD", dueDate: "2026-01-01", paymentLinkUrl: null, paymentInstructions: "" } });
  assert.match(reminder.subject, /past due/);

  // ── CSV exports ─────────────────────────────────────────────────────────
  const csv = toCsv(
    pnlRows({
      revenue: [{ accountId: "a", code: "4000", name: "Service revenue", type: "revenue", subtype: "revenue", amountCents: 268000 }],
      expenses: [{ accountId: "b", code: "5100", name: "Software, SaaS", type: "expense", subtype: "expense", amountCents: 1999 }],
      totalRevenueCents: 268000,
      totalExpenseCents: 1999,
      netIncomeCents: 266001,
    }),
  );
  assert.match(csv, /4000,Service revenue,2680\.00/);
  assert.match(csv, /5100,"Software, SaaS",19\.99/);
  assert.match(csv, /Net income,,2660\.01/);
  const tb = toCsv(trialRows({ rows: [{ accountId: "a", code: "1000", name: "Bank", type: "asset", debitCents: 5, creditCents: 0 }], totalDebitCents: 5, totalCreditCents: 5, balanced: true }));
  assert.match(tb, /1000,Bank,0\.05,/);

  // ── CI runs this suite ──────────────────────────────────────────────────
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const t of ["finances-core", "finances-io", "finances-surface"]) {
    assert.ok(pkg.scripts["test:finances"]?.includes(`tests/${t}.test.ts`), `test:finances runs ${t}`);
  }
  assert.match(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"), /npm run test:finances/, "CI runs test:finances");

  console.log("finances-surface: all assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
