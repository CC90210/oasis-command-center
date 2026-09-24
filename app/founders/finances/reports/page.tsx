/**
 * /founders/finances/reports — P&L, Balance Sheet, Trial Balance, Cash Flow,
 * General Ledger, AR aging. Entity + date range; CSV export of the same data.
 */
import Link from "next/link";
import { Card, PageHeader } from "@/components/Card";
import { EntitySwitcher } from "@/components/founders/finances/EntitySwitcher";
import { inputClass, labelClass, numClass, quietButton, tableClass, tdClass, thClass } from "@/components/founders/finances/ui";
import { financePage, param, type SearchParams } from "@/lib/founders-finances/page-context";
import { REPORT_KINDS, runReport, type ReportKind } from "@/lib/founders-finances/reports-io";
import { entityAccounts } from "@/lib/founders-finances/access-io";
import { AGING_BUCKETS, type AccountRow } from "@/lib/founders-finances/reports";
import { formatCents } from "@/lib/founders-finances/money";

export const dynamic = "force-dynamic";

const LABEL: Record<ReportKind, string> = {
  pnl: "Profit & Loss",
  balance: "Balance Sheet",
  trial: "Trial Balance",
  cashflow: "Cash Flow",
  ledger: "General Ledger",
  aging: "AR Aging",
};

const cad = (c: number) => formatCents(c, "CAD");

function Rows({ title, rows, total }: { title: string; rows: AccountRow[]; total: number }) {
  return (
    <>
      <tr>
        <td colSpan={3} className="px-3 pb-1 pt-4 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">{title}</td>
      </tr>
      {rows.map((r) => (
        <tr key={r.accountId}>
          <td className={`${tdClass} w-16 text-fg-dim`}>{r.code}</td>
          <td className={tdClass}>{r.name}</td>
          <td className={`${tdClass} ${numClass}`}>{cad(r.amountCents)}</td>
        </tr>
      ))}
      <tr>
        <td />
        <td className="px-3 py-2 font-semibold">Total {title.toLowerCase()}</td>
        <td className="px-3 py-2 text-right font-semibold tabular-nums">{cad(total)}</td>
      </tr>
    </>
  );
}

export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const { viewer, entity, entities, sp } = await financePage(searchParams);
  const kindRaw = param(sp, "kind") as ReportKind;
  const kind: ReportKind = REPORT_KINDS.includes(kindRaw) ? kindRaw : "pnl";
  const account = param(sp, "account") || null;
  const r = await runReport(viewer, entity.slug, kind, { from: param(sp, "from") || undefined, to: param(sp, "to") || undefined, accountId: account });
  const accounts = kind === "ledger" ? await entityAccounts(entity.id) : [];
  const base = `entity=${entity.slug}&from=${r.from}&to=${r.to}`;
  const csvHref = `/api/founders/finances/reports?${base}&kind=${kind}${account ? `&account=${encodeURIComponent(account)}` : ""}`;
  const pointInTime = kind === "balance" || kind === "trial" || kind === "aging";

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Reports"
        subtitle={pointInTime ? `As of the end of ${r.to} (exclusive), CAD` : `${r.from} to ${r.to} (exclusive), CAD`}
        action={<EntitySwitcher entities={entities} current={entity.slug} basePath="/founders/finances/reports" />}
      />

      <Card>
        <div className="mb-4 flex flex-wrap gap-1">
          {REPORT_KINDS.map((k) => (
            <Link key={k} href={`/founders/finances/reports?${base}&kind=${k}`} className={`rounded-md px-2.5 py-1 text-xs font-semibold ${k === kind ? "bg-bg-elev text-fg" : "text-fg-muted hover:text-fg"}`}>
              {LABEL[k]}
            </Link>
          ))}
        </div>
        <form method="GET" className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <input type="hidden" name="entity" value={entity.slug} />
          <input type="hidden" name="kind" value={kind} />
          {!pointInTime && (
            <div>
              <label className={labelClass}>From</label>
              <input type="date" name="from" defaultValue={r.from} className={inputClass} />
            </div>
          )}
          <div>
            <label className={labelClass}>{pointInTime ? "As of (before)" : "To (before)"}</label>
            <input type="date" name="to" defaultValue={r.to} className={inputClass} />
          </div>
          {kind === "ledger" && (
            <div className="col-span-2">
              <label className={labelClass}>Account</label>
              <select name="account" defaultValue={account || ""} className={inputClass}>
                <option value="">All accounts</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex items-end gap-2">
            <button type="submit" className={quietButton}>
              Run
            </button>
            <a href={csvHref} className={quietButton}>
              Export CSV
            </a>
          </div>
        </form>
      </Card>

      <Card title={LABEL[kind]} noPadding>
        <div className="overflow-x-auto">
          {r.kind === "pnl" && (
            <table className={tableClass}>
              <tbody>
                <Rows title="Revenue" rows={r.data.revenue} total={r.data.totalRevenueCents} />
                <Rows title="Expenses" rows={r.data.expenses} total={r.data.totalExpenseCents} />
                <tr className="border-t border-bg-border">
                  <td />
                  <td className="px-3 py-3 font-bold">Net income</td>
                  <td className={`px-3 py-3 text-right font-bold tabular-nums ${r.data.netIncomeCents < 0 ? "text-status-hot" : "text-status-engaged"}`}>{cad(r.data.netIncomeCents)}</td>
                </tr>
              </tbody>
            </table>
          )}
          {r.kind === "balance" && (
            <table className={tableClass}>
              <tbody>
                <Rows title="Assets" rows={r.data.assets} total={r.data.totalAssetsCents} />
                <Rows title="Liabilities" rows={r.data.liabilities} total={r.data.totalLiabilitiesCents} />
                <Rows title="Equity" rows={[...r.data.equity, { accountId: "earnings", code: "", name: "Current earnings", type: "equity", subtype: "", amountCents: r.data.currentEarningsCents }]} total={r.data.totalEquityCents} />
                <tr>
                  <td colSpan={3} className={`px-3 py-3 text-xs ${r.data.balanced ? "text-status-engaged" : "text-status-hot"}`}>
                    {r.data.balanced ? "Assets = liabilities + equity." : "Out of balance — this is a bug; the ledger enforces balance on every entry."}
                  </td>
                </tr>
              </tbody>
            </table>
          )}
          {r.kind === "trial" && (
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Code</th>
                  <th className={thClass}>Account</th>
                  <th className={`${thClass} ${numClass}`}>Debit</th>
                  <th className={`${thClass} ${numClass}`}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {r.data.rows.map((row) => (
                  <tr key={row.accountId}>
                    <td className={`${tdClass} text-fg-dim`}>{row.code}</td>
                    <td className={tdClass}>{row.name}</td>
                    <td className={`${tdClass} ${numClass}`}>{row.debitCents ? cad(row.debitCents) : ""}</td>
                    <td className={`${tdClass} ${numClass}`}>{row.creditCents ? cad(row.creditCents) : ""}</td>
                  </tr>
                ))}
                <tr>
                  <td />
                  <td className="px-3 py-3 font-semibold">Total {r.data.balanced ? "" : "(OUT OF BALANCE)"}</td>
                  <td className="px-3 py-3 text-right font-semibold tabular-nums">{cad(r.data.totalDebitCents)}</td>
                  <td className="px-3 py-3 text-right font-semibold tabular-nums">{cad(r.data.totalCreditCents)}</td>
                </tr>
              </tbody>
            </table>
          )}
          {r.kind === "cashflow" && (
            <table className={tableClass}>
              <tbody>
                <tr>
                  <td />
                  <td className="px-3 py-2 text-fg-muted">Opening cash</td>
                  <td className="px-3 py-2 text-right tabular-nums">{cad(r.data.openingCashCents)}</td>
                </tr>
                <Rows title="Operating" rows={r.data.operating} total={r.data.netOperatingCents} />
                <Rows title="Investing" rows={r.data.investing} total={r.data.netInvestingCents} />
                <Rows title="Financing" rows={r.data.financing} total={r.data.netFinancingCents} />
                <tr className="border-t border-bg-border">
                  <td />
                  <td className="px-3 py-3 font-bold">Closing cash</td>
                  <td className="px-3 py-3 text-right font-bold tabular-nums">{cad(r.data.closingCashCents)}</td>
                </tr>
              </tbody>
            </table>
          )}
          {r.kind === "ledger" &&
            (r.data.length === 0 ? (
              <p className="p-5 text-sm text-fg-muted">No activity in this range.</p>
            ) : (
              r.data.map((s) => (
                <div key={s.account.id} className="border-b border-bg-border pb-2">
                  <div className="flex justify-between px-3 pt-4 text-sm font-semibold">
                    <span>
                      {s.account.code} {s.account.name}
                    </span>
                    <span className="text-fg-muted">opening {cad(s.openingCents)}</span>
                  </div>
                  <table className={tableClass}>
                    <tbody>
                      {s.rows.map((row, i) => (
                        <tr key={`${row.entryId}-${i}`}>
                          <td className={`${tdClass} w-28 tabular-nums text-fg-muted`}>{row.date}</td>
                          <td className={tdClass}>
                            {row.memo} <span className="text-[10px] uppercase tracking-wider text-fg-dim">{row.source}</span>
                          </td>
                          <td className={`${tdClass} ${numClass}`}>{row.debitCents ? cad(row.debitCents) : ""}</td>
                          <td className={`${tdClass} ${numClass}`}>{row.creditCents ? cad(row.creditCents) : ""}</td>
                          <td className={`${tdClass} ${numClass} text-fg-muted`}>{cad(row.balanceCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="px-3 text-right text-xs text-fg-muted">closing {cad(s.closingCents)}</div>
                </div>
              ))
            ))}
          {r.kind === "aging" && (
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Invoice</th>
                  <th className={thClass}>Customer</th>
                  <th className={thClass}>Due</th>
                  {AGING_BUCKETS.map((b) => (
                    <th key={b} className={`${thClass} ${numClass}`}>
                      {b}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.data.rows.map((row) => (
                  <tr key={row.id}>
                    <td className={tdClass}>{row.number}</td>
                    <td className={tdClass}>{row.contactName}</td>
                    <td className={`${tdClass} tabular-nums text-fg-muted`}>{row.dueDate}</td>
                    {AGING_BUCKETS.map((b) => (
                      <td key={b} className={`${tdClass} ${numClass}`}>
                        {row.bucket === b ? formatCents(row.balanceCents, row.currency) : ""}
                      </td>
                    ))}
                  </tr>
                ))}
                {Object.entries(r.data.totals).map(([cur, t]) => (
                  <tr key={cur}>
                    <td colSpan={3} className="px-3 py-2 font-semibold">
                      Total {cur}
                    </td>
                    {AGING_BUCKETS.map((b) => (
                      <td key={b} className="px-3 py-2 text-right font-semibold tabular-nums">
                        {formatCents(t[b], cur)}
                      </td>
                    ))}
                  </tr>
                ))}
                {r.data.rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-5 text-sm text-fg-muted">
                      Nothing outstanding.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}
