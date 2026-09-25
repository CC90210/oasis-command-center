/**
 * /founders/finances — Overview of the OASIS AI Solutions book: cash, this
 * month, receivables, MRR, recurring costs and the GST/QST threshold. Every
 * figure is read from the ledger (CAD equivalents at each day's stored rate);
 * the one estimate on the page, recurring costs per month, says so.
 *
 * It sits in the (overview) route group (no effect on the URL) so that its
 * loading.tsx skeleton covers this page only. A loading.tsx directly in
 * app/founders/finances/ would wrap every tab and hide their own skeletons.
 */
import Link from "next/link";
import { after } from "next/server";
import type { ReactNode } from "react";
import { Card, PageHeader } from "@/components/Card";
import { InOutChart } from "@/components/founders/finances/InOutChart";
import { amountTone, numClass, primaryButton, tdClass, thClass, tableClass } from "@/components/founders/finances/ui";
import { financePage, loadOverviewPage, type SearchParams } from "@/lib/founders-finances/page-context";
import { sweepOverdue } from "@/lib/founders-finances/invoices-io";
import { formatCents } from "@/lib/founders-finances/money";

export const dynamic = "force-dynamic";

const linkClass = "text-[#1FE3F0] hover:underline";

function Figure({ label, value, hint, tone }: { label: string; value: string; hint?: ReactNode; tone?: string }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-panel p-4 shadow-card">
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">{label}</div>
      <div className={`mt-1.5 text-2xl font-semibold tabular-nums ${tone || "text-fg"}`}>{value}</div>
      {hint && <div className="mt-1 text-[11px] text-fg-dim">{hint}</div>}
    </div>
  );
}

function perCurrency(map: Record<string, number>): string {
  const entries = Object.entries(map).filter(([, v]) => v !== 0);
  return entries.length ? entries.map(([c, v]) => formatCents(v, c)).join(" + ") : formatCents(0, "CAD");
}

const CADENCE_LABEL: Record<string, string> = { weekly: "weekly", monthly: "monthly", quarterly: "quarterly", yearly: "yearly" };
const LEVEL_TONE: Record<string, string> = { ok: "text-status-engaged", watch: "text-status-info", warning: "text-status-warm", exceeded: "text-status-hot" };
const LEVEL_BAR: Record<string, string> = { ok: "bg-status-engaged", watch: "bg-status-info", warning: "bg-status-warm", exceeded: "bg-status-hot" };

export default async function FinancesOverview({ searchParams }: { searchParams: SearchParams }) {
  const { viewer, entity } = await financePage(searchParams);
  const { ov, collected, mrr, recent, recurring, stripePinned } = await loadOverviewPage(viewer, entity);
  // Persisting "overdue" is bookkeeping, not display (overdue is recomputed
  // from the due date above), so it runs after the page has been sent.
  after(() =>
    sweepOverdue(entity.id).then(
      () => undefined,
      (e: unknown) => console.error("[finances:overview] overdue sweep failed", e instanceof Error ? e.message : e),
    ),
  );
  const hasMrr = mrr.as_of !== null;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Overview"
        subtitle="OASIS AI Solutions at a glance — cash, this month, what you're owed and what you pay every month. CAD unless marked US$."
        action={
          <Link href="/founders/finances/invoices#new-invoice" className={primaryButton}>
            New invoice
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Figure label="Cash on hand" value={formatCents(ov.cashTotal, "CAD")} hint="Bank and Stripe balances" />
        <Figure label="In this month" value={formatCents(ov.month.inCents, "CAD")} tone="text-status-engaged" hint="Transfers between your own accounts excluded" />
        <Figure label="Out this month" value={formatCents(ov.month.outCents, "CAD")} hint="Spending, draws and fees" />
        <Figure label="Net income this month" value={formatCents(ov.month.netCents, "CAD")} tone={amountTone(ov.month.netCents)} hint="Revenue minus expenses" />
        <Figure
          label="Collected this month"
          value={formatCents(collected.cad_cents, "CAD")}
          hint={
            <>
              {formatCents(collected.usd_cents, "USD")} · {collected.payments} payment{collected.payments === 1 ? "" : "s"}
              {collected.fx_missing_days.length > 0 && (
                <>
                  {" · "}
                  <Link href="/founders/finances/settings#exchange-rates" className={linkClass}>
                    rate missing for {collected.fx_missing_days.length} day{collected.fx_missing_days.length === 1 ? "" : "s"}
                  </Link>
                </>
              )}
            </>
          }
        />
        <Figure
          label="MRR"
          value={formatCents(mrr.mrr_cents, mrr.currency || "CAD")}
          hint={
            hasMrr ? (
              `${mrr.active_subscriptions} active subscription${mrr.active_subscriptions === 1 ? "" : "s"} in Stripe`
            ) : (
              <Link href="/founders/finances/settings#stripe" className={linkClass}>
                {stripePinned ? "No subscriptions yet — reconcile in Settings" : "Connect Stripe in Settings"}
              </Link>
            )
          }
        />
        <Figure label="Owed to you" value={perCurrency(ov.openAr)} hint="Invoices sent, not yet paid" />
        <Figure label="Overdue" value={perCurrency(ov.overdueAr)} tone={ov.overdueCount ? "text-status-warm" : undefined} hint={`${ov.overdueCount} invoice${ov.overdueCount === 1 ? "" : "s"} past due`} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Money in and out" subtitle="Last six months, CAD" className="lg:col-span-2">
          <InOutChart data={ov.series} />
        </Card>
        <Card title="Accounts" subtitle="Balances today, CAD">
          {ov.cashAccounts.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No balances yet.{" "}
              <Link href="/founders/finances/transactions#import" className={linkClass}>
                Import a bank statement
              </Link>{" "}
              to start.
            </p>
          ) : (
            <ul className="divide-y divide-bg-border/60">
              {ov.cashAccounts.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-fg-muted">{a.name}</span>
                  <span className={`tabular-nums ${a.subtype === "credit_card" && a.balanceCents > 0 ? "text-status-warm" : "text-fg"}`}>
                    {formatCents(a.balanceCents, "CAD")}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {ov.unreviewed > 0 && (
            <Link href="/founders/finances/transactions?status=unreviewed" className={`mt-3 block text-xs ${linkClass}`}>
              {ov.unreviewed} transaction{ov.unreviewed === 1 ? "" : "s"} need a category
            </Link>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title="Recurring expenses (monthly)"
          subtitle={
            recurring.rate
              ? `Estimate in CAD. US$ converted at the ${recurring.rate.date} Bank of Canada rate (${recurring.rate.rate}).`
              : "Estimate in CAD. Yearly costs divided by 12."
          }
          action={
            <Link href="/founders/finances/bills#recurring" className="text-xs text-fg-muted hover:text-fg">
              Manage
            </Link>
          }
          noPadding
        >
          {recurring.items.length === 0 ? (
            <p className="p-5 text-sm text-fg-muted">
              Nothing recurring yet.{" "}
              <Link href="/founders/finances/bills#recurring" className={linkClass}>
                Add your subscriptions and rent
              </Link>{" "}
              on Bills &amp; Expenses.
            </p>
          ) : (
            <table className={tableClass}>
              <tbody>
                {recurring.items.map((r) => (
                  <tr key={r.id}>
                    <td className={tdClass}>
                      {r.name}
                      <div className="text-[11px] text-fg-dim">
                        {formatCents(r.amountCents, r.currency)} {CADENCE_LABEL[r.cadence] || r.cadence}
                      </div>
                    </td>
                    <td className={`${tdClass} ${numClass}`}>
                      {r.monthlyCadCents === null ? <span className="text-status-warm">{formatCents(r.monthlyCents, r.currency)}</span> : formatCents(r.monthlyCadCents, "CAD")}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="px-3 py-2.5 font-semibold">Total per month</td>
                  <td className={`px-3 py-2.5 font-semibold ${numClass}`}>{formatCents(recurring.totalCadCents, "CAD")}</td>
                </tr>
              </tbody>
            </table>
          )}
          {recurring.unconverted > 0 && (
            <p className="border-t border-bg-border px-3 py-2 text-[11px] text-status-warm">
              {recurring.unconverted} item{recurring.unconverted === 1 ? " is" : "s are"} not in the total: no exchange rate stored.{" "}
              <Link href="/founders/finances/settings#exchange-rates" className={linkClass}>
                Fetch rates in Settings
              </Link>
            </p>
          )}
        </Card>

        {ov.threshold && (
          <Card
            title="GST/QST registration threshold"
            subtitle="Taxable revenue over the last four calendar quarters, current quarter to date"
            action={
              <Link href="/founders/finances/taxes" className="text-xs text-fg-muted hover:text-fg">
                Details
              </Link>
            }
          >
            <p className={`text-sm ${LEVEL_TONE[ov.threshold.level]}`}>{ov.threshold.message}</p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-elev">
              <div className={`h-full ${LEVEL_BAR[ov.threshold.level]}`} style={{ width: `${Math.min(100, Math.round(ov.threshold.pct * 100))}%` }} />
            </div>
            <p className="mt-2 text-xs text-fg-dim">
              {formatCents(ov.threshold.totalCents, "CAD")} of {formatCents(ov.threshold.thresholdCents, "CAD")}
            </p>
          </Card>
        )}
      </div>

      <Card
        title="Recent transactions"
        action={
          <Link href="/founders/finances/transactions" className="text-xs text-fg-muted hover:text-fg">
            All transactions
          </Link>
        }
        noPadding
      >
        {recent.length === 0 ? (
          <p className="p-5 text-sm text-fg-muted">
            Nothing recorded yet.{" "}
            <Link href="/founders/finances/transactions#import" className={linkClass}>
              Import a bank statement
            </Link>{" "}
            or add a transaction on the Transactions tab.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Date</th>
                  <th className={thClass}>Description</th>
                  <th className={thClass}>Category</th>
                  <th className={`${thClass} ${numClass}`}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((t) => (
                  <tr key={t.id}>
                    <td className={`${tdClass} whitespace-nowrap tabular-nums text-fg-muted`}>{t.posted_date}</td>
                    <td className={tdClass}>{t.description}</td>
                    <td className={`${tdClass} text-fg-muted`}>{t.category_name || <span className="text-status-warm">Uncategorised</span>}</td>
                    <td className={`${tdClass} ${numClass} whitespace-nowrap ${amountTone(t.amount_cents)}`}>{formatCents(t.amount_cents, t.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
