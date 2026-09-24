/**
 * GET /api/internal/finance/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 * The CFO agent's read of the BUSINESS book (never a personal one):
 * cash by account, this month in/out, open and overdue invoices, revenue
 * collected for [from, to) (default: month to date), MRR and the GST/QST
 * small-supplier threshold. Bearer FINANCE_AGENT_TOKEN.
 */
import { NextResponse } from "next/server";
import { checkFinanceAgentAuth } from "@/lib/founders-finances/internal-auth";
import { financeErrorResponse } from "@/lib/founders-finances/http";
import { overview } from "@/lib/founders-finances/reports-io";
import { listInvoices } from "@/lib/founders-finances/invoices-io";
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
    const open = invoices.filter((i) => i.effective_status === "sent" || i.effective_status === "overdue");
    return NextResponse.json({
      ok: true,
      as_of: today,
      currency_note: "all *_cents are integer cents; cash and in/out are CAD equivalents",
      cash_by_account: ov.cashAccounts.map((a) => ({ code: a.code, name: a.name, balance_cad_cents: a.balanceCents })),
      cash_total_cad_cents: ov.cashTotal,
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
