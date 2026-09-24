/**
 * POST /api/founders/finances/actions — every Finances write from the UI.
 *
 * Body: { action: "<name>", ...fields }. One route, one gate: the caller must
 * resolve as a finance owner (CC or Adon by auth user id) or it is a 404, and
 * every handler below re-checks the entity the row belongs to
 * (access-io.requireEntity / requireRowEntity) — so a personal book is
 * refused even to a signed-in owner who is not its owner. Validation is the
 * same pure rules the internal API uses.
 */
import { NextResponse } from "next/server";
import { methodNotHere } from "@/lib/founders/method-guard";
import { resolveFinanceViewer } from "@/lib/founders-finances/access-io";
import { financeErrorResponse, readJsonObject } from "@/lib/founders-finances/http";
import * as txns from "@/lib/founders-finances/transactions-io";
import * as invoices from "@/lib/founders-finances/invoices-io";
import * as bills from "@/lib/founders-finances/bills-io";
import * as settings from "@/lib/founders-finances/settings-io";
import { reconcileStripe } from "@/lib/founders-finances/stripe-ingest";
import { refreshFxRates } from "@/lib/founders-finances/fx-io";
import { addDays, isIsoDate, torontoToday } from "@/lib/founders-finances/fx";
import type { FinanceViewer } from "@/lib/founders-finances/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Body = Record<string, unknown>;
type Result = Record<string, unknown>;
type Handler = (viewer: Extract<FinanceViewer, { kind: "founder" }>, b: Body) => Promise<Result>;

const str = (v: unknown) => (typeof v === "string" ? v : "");

const HANDLERS: Record<string, Handler> = {
  "txn.create": async (v, b) => ({ id: await txns.createManualTransaction(v, str(b.entity), b), message: "Transaction recorded." }),
  "txn.categorize": async (v, b) => {
    await txns.categorizeTransaction(v, str(b.txn_id), str(b.category_id));
    return {};
  },
  "txn.approve": async (v, b) => {
    await txns.approveDraft(v, str(b.txn_id), str(b.category_id) || undefined);
    return {};
  },
  "txn.exclude": async (v, b) => {
    await txns.excludeTransaction(v, str(b.txn_id));
    return { message: "Excluded from the books." };
  },
  "txn.rule_from": async (v, b) => {
    const r = await txns.createRuleFromTransaction(v, str(b.txn_id), b);
    return { ...r, message: `Rule created; applied to ${r.applied} other transaction(s).` };
  },
  "rule.create": async (v, b) => ({ id: await txns.createRule(v, str(b.entity), b), message: "Rule created." }),
  "rule.toggle": async (v, b) => {
    await txns.setRuleActive(v, str(b.rule_id), b.active === true || b.active === "true");
    return {};
  },
  "rules.apply": async (v, b) => ({ applied: await txns.applyRulesToUnreviewed(v, str(b.entity)), message: "Rules applied." }),
  "contact.create": async (v, b) => ({ id: await invoices.createContact(v, str(b.entity), b), message: "Contact added." }),
  "invoice.create": async (v, b) => {
    const id = await invoices.createDraftInvoice(v, str(b.entity), b);
    return { id, redirect: `/founders/finances/invoices/${id}` };
  },
  "invoice.update": async (v, b) => {
    await invoices.updateDraftInvoice(v, str(b.invoice_id), b);
    return { message: "Draft saved." };
  },
  "invoice.finalize": async (v, b) => {
    const inv = await invoices.finalizeInvoice(v, str(b.invoice_id));
    return { number: inv.number, message: `Issued as ${inv.number}.` };
  },
  "invoice.send": async (v, b) => {
    const r = await invoices.sendInvoice(v, str(b.invoice_id), { to: str(b.to) || undefined, paymentLink: b.payment_link !== false && b.payment_link !== "false" });
    return { ...r, message: `Emailed ${r.number} to ${r.emailedTo}${r.paymentLinkUrl ? " with a card payment link" : ""}.` };
  },
  "invoice.mark_paid": async (v, b) => ({ paymentId: await invoices.markInvoicePaidManually(v, str(b.invoice_id), b), message: "Payment recorded." }),
  "invoice.void": async (v, b) => {
    await invoices.voidInvoice(v, str(b.invoice_id));
    return { message: "Invoice voided." };
  },
  "bill.create": async (v, b) => ({ id: await bills.createBill(v, str(b.entity), b), message: b.kind === "bill" ? "Bill recorded." : "Expense recorded." }),
  "bill.pay": async (v, b) => {
    await bills.payBill(v, str(b.bill_id), b);
    return { message: "Bill paid." };
  },
  "bill.void": async (v, b) => {
    await bills.voidBill(v, str(b.bill_id));
    return { message: "Voided." };
  },
  "equity.create": async (v, b) => ({ id: await bills.recordEquityEvent(v, str(b.entity), b), message: "Recorded." }),
  "recurring.create": async (v, b) => ({ id: await bills.createRecurring(v, str(b.entity), b), message: "Recurring expense added." }),
  "recurring.record": async (v, b) => ({ id: await bills.recordRecurringNow(v, str(b.item_id)), message: "Recorded and rescheduled." }),
  "account.create": async (v, b) => ({ id: await settings.createAccount(v, str(b.entity), b), message: "Account added." }),
  "settings.update": async (v, b) => {
    await settings.updateSettings(v, str(b.entity), b);
    return { message: "Settings saved." };
  },
  "stripe.pin": async (v, b) => ({ account: await settings.pinStripeAccount(v, str(b.entity), str(b.account_id)), message: "Stripe account confirmed." }),
  "stripe.reconcile": async (_v, b) => {
    const days = Number(b.days) || 30;
    const summary = await reconcileStripe({ days });
    return { summary, message: `Reconciled ${summary.days} days: ${summary.payments_recorded} new payment(s), ${summary.refunds_recorded} refund(s), ${summary.subscriptions_upserted} subscription(s).` };
  },
  "fx.refresh": async (_v, b) => {
    const to = isIsoDate(b.to) ? (b.to as string) : torontoToday();
    const from = isIsoDate(b.from) ? (b.from as string) : addDays(to, -30);
    const r = await refreshFxRates(from, to);
    return { ...r, message: `Stored ${r.observations} Bank of Canada rate(s).` };
  },
};

export async function POST(req: Request) {
  const viewer = await resolveFinanceViewer().catch(() => null);
  if (!viewer) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const body = await readJsonObject(req);
  if (!body) return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  const handler = HANDLERS[str(body.action)];
  if (!handler) return NextResponse.json({ ok: false, error: "unknown_action" }, { status: 400 });
  try {
    const result = await handler(viewer, body);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return financeErrorResponse(e, `action:${str(body.action)}`);
  }
}

export const GET = methodNotHere;
export const PUT = methodNotHere;
export const PATCH = methodNotHere;
export const DELETE = methodNotHere;
