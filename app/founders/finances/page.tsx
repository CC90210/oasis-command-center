/**
 * /founders/finances — Overview. Cash, this month, receivables, MRR and the
 * GST/QST threshold for the business; cash and spending for a personal book.
 * Every figure is read from the ledger (CAD equivalents at each day's rate);
 * nothing here is estimated for display.
 */
import Link from "next/link";
import { Card, PageHeader } from "@/components/Card";
import { EntitySwitcher } from "@/components/founders/finances/EntitySwitcher";
import { InOutChart } from "@/components/founders/finances/InOutChart";
import { amountTone, numClass, tdClass, thClass, tableClass } from "@/components/founders/finances/ui";
import { financePage, type SearchParams } from "@/lib/founders-finances/page-context";
import { overview } from "@/lib/founders-finances/reports-io";
import { listTransactions } from "@/lib/founders-finances/transactions-io";
import { revenueCollected, stripeMrr } from "@/lib/founders-finances/metrics";
import { formatCents } from "@/lib/founders-finances/money";
import { addDays } from "@/lib/founders-finances/fx";

export const dynamic = "force-dynamic";

function Figure({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-panel p-4">
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

const LEVEL_TONE: Record<string, string> = { ok: "text-status-engaged", watch: "text-status-info", warning: "text-status-warm", exceeded: "text-status-hot" };

export default async function FinancesOverview({ searchParams }: { searchParams: SearchParams }) {
  const { viewer, entity, entities } = await financePage(searchParams);
  const ov = await overview(viewer, entity.slug);
  const business = entity.kind === "business";
  const monthFrom = `${ov.today.slice(0, 7)}-01`;
  const [collected, mrr, recent] = await Promise.all([
    business ? revenueCollected({ from: monthFrom, to: addDays(ov.today, 1) }) : Promise.resolve(null),
    business ? stripeMrr() : Promise.resolve(null),
    listTransactions(viewer, entity.slug, { limit: 8 }),
  ]);
  const q = `?entity=${entity.slug}`;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Finances"
        subtitle={business ? "OASIS AI Solutions — the company's books, shared by both owners." : `${entity.name} — visible only to you.`}
        action={<EntitySwitcher entities={entities} current={entity.slug} basePath="/founders/finances" />}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Figure label="Cash on hand" value={formatCents(ov.cashTotal, "CAD")} hint="Bank + Stripe balance, CAD" />
        <Figure label="In this month" value={formatCents(ov.month.inCents, "CAD")} tone="text-status-engaged" hint="Transfers between your own accounts excluded" />
        <Figure label="Out this month" value={formatCents(ov.month.outCents, "CAD")} hint="Spending, draws and fees" />
        <Figure label="Net income, month" value={formatCents(ov.month.netCents, "CAD")} tone={amountTone(ov.month.netCents)} hint="Revenue minus expenses (accrual)" />
        {business && (
          <>
            <Figure label="Collected this month" value={formatCents(collected?.cad_cents ?? 0, "CAD")} hint={`${formatCents(collected?.usd_cents ?? 0, "USD")} · ${collected?.payments ?? 0} payment(s)${collected?.fx_missing_days.length ? ` · rate missing for ${collected.fx_missing_days.length} day(s)` : ""}`} />
            <Figure label="MRR (Stripe)" value={formatCents(mrr?.mrr_cents ?? 0, mrr?.currency || "CAD")} hint={mrr?.as_of ? `${mrr.active_subscriptions} subscription(s)` : "No subscription data yet — run a Stripe reconcile"} />
            <Figure label="Owed to you" value={perCurrency(ov.openAr)} hint="Issued invoices not yet paid" />
            <Figure label="Overdue" value={perCurrency(ov.overdueAr)} tone={ov.overdueCount ? "text-status-warm" : undefined} hint={`${ov.overdueCount} invoice(s)`} />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Money in and out" subtitle="Last six months, CAD" className="lg:col-span-2">
          <InOutChart data={ov.series} />
        </Card>
        <Card title="Accounts">
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
          {ov.unreviewed > 0 && (
            <Link href={`/founders/finances/transactions${q}&status=unreviewed`} className="mt-3 block text-xs text-[#1FE3F0] hover:underline">
              {ov.unreviewed} transaction(s) need a category
            </Link>
          )}
        </Card>
      </div>

      {ov.threshold && (
        <Card title="GST/QST small-supplier threshold" subtitle="Taxable revenue, last four calendar quarters (current quarter to date)">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <p className={`text-sm ${LEVEL_TONE[ov.threshold.level]}`}>{ov.threshold.message}</p>
            <Link href={`/founders/finances/taxes${q}`} className="text-xs text-fg-muted hover:text-fg">
              Details
            </Link>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-elev">
            <div
              className={`h-full ${ov.threshold.level === "ok" ? "bg-status-engaged" : ov.threshold.level === "watch" ? "bg-status-info" : ov.threshold.level === "warning" ? "bg-status-warm" : "bg-status-hot"}`}
              style={{ width: `${Math.min(100, Math.round(ov.threshold.pct * 100))}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-fg-dim">
            {formatCents(ov.threshold.totalCents, "CAD")} of {formatCents(ov.threshold.thresholdCents, "CAD")}
          </p>
        </Card>
      )}

      <Card title="Recent transactions" action={<Link href={`/founders/finances/transactions${q}`} className="text-xs text-fg-muted hover:text-fg">All transactions</Link>} noPadding>
        {recent.length === 0 ? (
          <p className="p-5 text-sm text-fg-muted">Nothing recorded yet. Import a bank statement or add a transaction on the Transactions tab.</p>
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
                    <td className={`${tdClass} tabular-nums text-fg-muted`}>{t.posted_date}</td>
                    <td className={tdClass}>{t.description}</td>
                    <td className={`${tdClass} text-fg-muted`}>{t.category_name || <span className="text-status-warm">Uncategorised</span>}</td>
                    <td className={`${tdClass} ${numClass} ${amountTone(t.amount_cents)}`}>{formatCents(t.amount_cents, t.currency)}</td>
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
