/**
 * GET /api/internal/finance/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 * The CFO agent's read of the BUSINESS book (never a personal one):
 * cash by account, this month in/out, open and overdue invoices, revenue
 * collected for [from, to) (default: month to date), MRR and the GST/QST
 * small-supplier threshold. Bearer FINANCE_AGENT_TOKEN.
 *
 * cash_coverage says whether the cash total is a balance at all: with
 * complete:false (no opening balance, Stripe payouts never booked) it is a
 * ledger sum, and `gaps` says what is missing.
 *
 * open_invoices = invoices with money owed now. An issued invoice that only
 * sets up a monthly retainer (nothing due now) is never in it: it is listed
 * under retainer_invoices, with its monthly amount and whether its Stripe
 * link has been made / emailed.
 */
import { NextResponse } from "next/server";
import { checkFinanceAgentAuth } from "@/lib/founders-finances/internal-auth";
import { financeErrorResponse } from "@/lib/founders-finances/http";
import { overview } from "@/lib/founders-finances/reports-io";
import { listInvoices } from "@/lib/founders-finances/invoices-io";
import { isOpenListStatus } from "@/lib/founders-finances/invoice";
import { revenueCollected, stripeMrr } from "@/lib/founders-finances/metrics";
import { addDays, isIsoDate, torontoToday } from "@/lib/founders-finances/fx";
import { BUSINESS_ENTITY_ID } from "@/lib/founders-finances/chart";
import type { FinanceViewer } from "@/lib/founders-finances/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ATLAS: FinanceViewer = { kind: "agent", name: "atlas" };

export async function GET(req: Request) {
  const denied = checkFinanceAgentAuth(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const today = torontoToday();
  const from = isIsoDate(url.searchParams.get("from")) ? (url.searchParams.get("from") as string) : `${today.slice(0, 7)}-01`;
  const to = isIsoDate(url.searchParams.get("to")) ? (url.searchParams.get("to") as string) : addDays(today, 1);
  if (to <= from) return NextResponse.json({ ok: false, error: "invalid_input", message: "to must be after from" }, { status: 400 });
  try {
    const [ov, invoices, collected, mrr] = await Promise.all([
      overview(ATLAS, BUSINESS_ENTITY_ID),
      listInvoices(ATLAS, BUSINESS_ENTITY_ID),
      revenueCollected({ from, to }),
      stripeMrr(),
    ]);
    // Open = money owed now. An issued invoice that only sets up a monthly retainer is not open (nothing is due on it):
    // it is reported apart, with what the app knows of its link.
    const open = invoices.filter((i) => isOpenListStatus(i.list_status));
    const retainers = invoices.filter((i) => i.list_status === "retainer");
    return NextResponse.json({
      ok: true,
      as_of: today,
      currency_note: "all *_cents are integer cents; cash and in/out are CAD equivalents",
      cash_by_account: ov.cashAccounts.map((a) => ({ code: a.code, name: a.name, balance_cad_cents: a.balanceCents })),
      cash_total_cad_cents: ov.cashTotal,
      // Whether cash_total_cad_cents may be called cash on hand. complete:false
      // means the books miss part of an account's story (cash-coverage.ts), so
      // the total is a ledger sum and must not be reported as a balance.
      cash_coverage: { complete: ov.coverage.complete, gaps: ov.coverage.gaps },
      // What the whole book covers (books-coverage.ts): expenses from, revenue
      // sources, opening balances, payouts. complete:false means every
      // revenue, expense and profit figure here is what is recorded so far,
      // not the business's result, and the threshold may be "unconfirmed".
      books_coverage: {
        complete: ov.books.complete,
        gaps: ov.books.gaps,
        expenses_from: ov.books.expensesFrom,
        revenue_from: ov.books.revenueFrom,
        revenue_complete: ov.books.revenueSources.complete,
      },
      month: { in_cad_cents: ov.month.inCents, out_cad_cents: ov.month.outCents, revenue_cad_cents: ov.month.revenueCents, expense_cad_cents: ov.month.expenseCents },
      open_invoices: open.map((i) => ({
        id: i.id,
        number: i.number,
        customer: i.contact_name,
        status: i.effective_status,
        due_date: i.due_date,
        balance_cents: i.balance_cents,
        currency: i.currency,
      })),
      retainer_invoices: retainers.map((i) => ({
        id: i.id,
        number: i.number,
        customer: i.contact_name,
        status: i.list_status,
        monthly_cents: i.retainer_cents,
        currency: i.currency,
        link: i.retainer_link,
      })),
      overdue: { count: ov.overdueCount, by_currency_cents: ov.overdueAr },
      revenue_collected: { from, to, ...collected },
      mrr,
      threshold: ov.threshold,
      unreviewed_transactions: ov.unreviewed,
    });
  } catch (e) {
    return financeErrorResponse(e, "internal:summary");
  }
}
