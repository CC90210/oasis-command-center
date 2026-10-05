/**
 * /founders/finances/taxes — GST/QST registration status, the CA$30,000
 * small-supplier threshold tracker, and the period report (collected minus
 * input tax credits) that becomes meaningful once OASIS registers.
 *
 * Quebec: OASIS is in Montreal, so GST and QST are both filed with Revenu
 * Québec on one combined return (FPZ-500); the page never names the HST, the
 * harmonized tax of other provinces. The threshold reads "unconfirmed"
 * while the books cannot hold every sale (no bank deposit recorded from
 * before the first revenue: books-coverage.ts), and the banner says why.
 */
import Link from "next/link";
import { Card, PageHeader } from "@/components/Card";
import { BooksCoverageBanner } from "@/components/founders/finances/BooksCoverageBanner";
import { inputClass, labelClass, numClass, quietButton, tableClass, tdClass } from "@/components/founders/finances/ui";
import { financePage, loadTaxesPage, type SearchParams } from "@/lib/founders-finances/page-context";
import { formatCents } from "@/lib/founders-finances/money";
import type { ThresholdLevel } from "@/lib/founders-finances/tax";

export const dynamic = "force-dynamic";

const LEVEL: Record<ThresholdLevel, { tone: string; bar: string }> = {
  ok: { tone: "text-status-engaged", bar: "bg-status-engaged" },
  watch: { tone: "text-status-info", bar: "bg-status-info" },
  warning: { tone: "text-status-warm", bar: "bg-status-warm" },
  exceeded: { tone: "text-status-hot", bar: "bg-status-hot" },
  unconfirmed: { tone: "text-status-warm", bar: "bg-status-warm" },
};

export default async function TaxesPage({ searchParams }: { searchParams: SearchParams }) {
  const { viewer, sp } = await financePage(searchParams);
  const t = await loadTaxesPage(viewer, sp);
  const registered = t.settings.gst_qst_registered === 1;
  const lv = LEVEL[t.threshold.level];
  const cad = (c: number) => formatCents(c, "CAD");

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader title="Taxes" subtitle="GST/QST for OASIS AI Solutions: how close the business is to having to register, and what it would owe each period." />

      <BooksCoverageBanner coverage={t.coverage} figures="The revenue and tax figures on this page" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="Registration">
          {registered ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-fg-muted">GST number</dt>
                <dd className="tabular-nums">{t.settings.gst_number}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-fg-muted">QST number</dt>
                <dd className="tabular-nums">{t.settings.qst_number}</dd>
              </div>
              {t.settings.registration_effective_date && (
                <div className="flex justify-between">
                  <dt className="text-fg-muted">Since</dt>
                  <dd>{t.settings.registration_effective_date}</dd>
                </div>
              )}
              <p className="pt-2 text-xs text-fg-dim">New invoices charge GST 5% and QST 9.975%, both on the pre-tax amount.</p>
            </dl>
          ) : (
            <div className="space-y-2 text-sm">
              <p>Not registered — small supplier. Invoices carry no GST or QST.</p>
              <p className="text-xs text-fg-dim">
                When you register, enter both numbers in{" "}
                <Link href="/founders/finances/settings#company" className="text-[#1FE3F0] hover:underline">
                  Settings
                </Link>
                . Tax then applies to invoices issued from that point.
              </p>
            </div>
          )}
        </Card>

        <Card title="Small-supplier threshold" subtitle="Worldwide taxable revenue, CAD — including zero-rated sales to US clients" className="lg:col-span-2">
          <p className={`text-sm ${lv.tone}`}>{t.threshold.message}</p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-elev">
            <div className={`h-full ${lv.bar}`} style={{ width: `${Math.min(100, Math.round(t.threshold.pct * 100))}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-fg-dim">
            <span>{t.threshold.revenueComplete ? cad(t.threshold.totalCents) : `${cad(t.threshold.totalCents)} recorded so far`}</span>
            <span>75% {cad(2_250_000)} · 90% {cad(2_700_000)} · {cad(t.threshold.thresholdCents)}</span>
          </div>
          <table className={`${tableClass} mt-4`}>
            <tbody>
              {t.threshold.quarters.map((q) => (
                <tr key={q.label}>
                  <td className={`${tdClass} text-fg-muted`}>{q.label}</td>
                  <td className={`${tdClass} ${numClass}`}>{cad(q.revenueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-fg-dim">
            The current quarter is included to date, which is stricter than the statutory test (completed quarters). Crossing CA$30,000 in any single quarter requires registration from the sale that crossed it.
          </p>
        </Card>
      </div>

      <Card title="GST/QST period report" subtitle={registered ? "Tax collected on sales minus tax paid on purchases (input tax credits / refunds)." : "Shown for completeness — all zero until OASIS is registered."}>
        <form method="GET" className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div>
            <label className={labelClass}>From</label>
            <input type="date" name="from" defaultValue={t.from} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>To (before)</label>
            <input type="date" name="to" defaultValue={t.to} className={inputClass} />
          </div>
          <div className="flex items-end">
            <button type="submit" className={quietButton}>
              Run
            </button>
          </div>
        </form>
        <table className={tableClass}>
          <thead>
            <tr className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">
              <th className="px-3 py-2 text-left" />
              <th className="px-3 py-2 text-right">GST</th>
              <th className="px-3 py-2 text-right">QST</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={tdClass}>Collected on sales</td>
              <td className={`${tdClass} ${numClass}`}>{cad(t.period.gstCollectedCents)}</td>
              <td className={`${tdClass} ${numClass}`}>{cad(t.period.qstCollectedCents)}</td>
            </tr>
            <tr>
              <td className={tdClass}>Paid on purchases (ITC / ITR)</td>
              <td className={`${tdClass} ${numClass}`}>{cad(t.period.gstItcCents)}</td>
              <td className={`${tdClass} ${numClass}`}>{cad(t.period.qstItrCents)}</td>
            </tr>
            <tr>
              <td className="px-3 py-2 font-semibold">Net to remit (negative = refund)</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">{cad(t.period.gstNetCents)}</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">{cad(t.period.qstNetCents)}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3 text-[11px] text-fg-dim">
          GST and QST are both filed with Revenu Québec on one combined return (FPZ-500). Figures are CAD equivalents at each transaction&rsquo;s own-day rate.
        </p>
      </Card>
    </div>
  );
}
