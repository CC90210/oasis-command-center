/**
 * /founders/finances/accounts — chart of accounts with balances, new
 * accounts, and (business) owner draws / contributions with the 50/50 view.
 */
import { Card, PageHeader } from "@/components/Card";
import { EntitySwitcher } from "@/components/founders/finances/EntitySwitcher";
import { ActionForm } from "@/components/founders/finances/ActionForm";
import { numClass, tableClass, tdClass } from "@/components/founders/finances/ui";
import { financePage, type SearchParams } from "@/lib/founders-finances/page-context";
import { loadLedger } from "@/lib/founders-finances/reports-io";
import { equitySummary } from "@/lib/founders-finances/bills-io";
import { entityAccounts } from "@/lib/founders-finances/access-io";
import { CASH_SUBTYPES } from "@/lib/founders-finances/chart";
import { naturalBalance } from "@/lib/founders-finances/ledger";
import { formatCents } from "@/lib/founders-finances/money";
import { addDays, torontoToday } from "@/lib/founders-finances/fx";
import { OWNER_LABEL } from "@/lib/founders-finances/access";

export const dynamic = "force-dynamic";

const TYPE_ORDER = ["asset", "liability", "equity", "revenue", "expense"] as const;
const TYPE_LABEL: Record<string, string> = { asset: "Assets", liability: "Liabilities", equity: "Equity", revenue: "Revenue", expense: "Expenses" };

export default async function AccountsPage({ searchParams }: { searchParams: SearchParams }) {
  const { viewer, entity, entities } = await financePage(searchParams);
  const today = torontoToday();
  const [{ accounts, lines }, rows] = await Promise.all([loadLedger(entity.id, addDays(today, 1)), entityAccounts(entity.id)]);
  const sums = new Map<string, { d: number; c: number }>();
  for (const l of lines) {
    const s = sums.get(l.accountId) || { d: 0, c: 0 };
    s.d += l.cadDebitCents;
    s.c += l.cadCreditCents;
    sums.set(l.accountId, s);
  }
  const business = entity.kind === "business";
  const equity = business ? await equitySummary(viewer, entity.slug) : null;
  const cashAccounts = rows.filter((a) => CASH_SUBTYPES.has(a.subtype));

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Accounts"
        subtitle="Balances are CAD equivalents, all time, from the ledger."
        action={<EntitySwitcher entities={entities} current={entity.slug} basePath="/founders/finances/accounts" />}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {TYPE_ORDER.map((type) => {
          const list = accounts.filter((a) => a.type === type);
          return (
            <Card key={type} title={TYPE_LABEL[type]} noPadding>
              <table className={tableClass}>
                <tbody>
                  {list.map((a) => {
                    const s = sums.get(a.id) || { d: 0, c: 0 };
                    const bal = naturalBalance(a.type, s.d, s.c);
                    return (
                      <tr key={a.id}>
                        <td className={`${tdClass} w-16 tabular-nums text-fg-dim`}>{a.code}</td>
                        <td className={tdClass}>
                          {a.name}
                          <span className="ml-2 text-[10px] uppercase tracking-wider text-fg-dim">{a.subtype.replace(/_/g, " ")}</span>
                        </td>
                        <td className={`${tdClass} ${numClass} ${bal === 0 ? "text-fg-dim" : "text-fg"}`}>{formatCents(bal, "CAD")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          );
        })}
        <Card title="Add an account">
          <ActionForm
            action="account.create"
            hidden={{ entity: entity.slug }}
            submitLabel="Add account"
            columns={2}
            fields={[
              { name: "code", label: "Code", required: true, placeholder: "5150" },
              { name: "name", label: "Name", required: true },
              { name: "type", label: "Type", type: "select", options: TYPE_ORDER.map((t) => ({ value: t, label: TYPE_LABEL[t] })) },
              {
                name: "subtype",
                label: "Kind",
                type: "select",
                options: [
                  { value: "", label: "Default for type" },
                  { value: "bank", label: "Bank account" },
                  { value: "cash", label: "Cash" },
                  { value: "credit_card", label: "Credit card" },
                  { value: "loan", label: "Loan" },
                  { value: "fixed_asset", label: "Equipment" },
                  { value: "investment", label: "Investment" },
                ],
              },
            ]}
          />
        </Card>
      </div>

      {equity && (
        <Card title="Owner draws & contributions" subtitle="CC and Adon own OASIS 50/50. Net withdrawn = draws minus money put in.">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(["cc", "adon"] as const).map((k) => (
              <div key={k} className="rounded-lg border border-bg-border bg-bg-elev p-4">
                <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">{OWNER_LABEL[k]}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">{formatCents(equity.parity[k].netWithdrawnCents, "CAD")}</div>
                <div className="mt-1 text-[11px] text-fg-dim">
                  drew {formatCents(equity.parity[k].drawsCents, "CAD")} · put in {formatCents(equity.parity[k].contributionsCents, "CAD")}
                </div>
              </div>
            ))}
            <div className="rounded-lg border border-bg-border bg-bg-elev p-4">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Parity</div>
              {equity.parity.behind ? (
                <p className="mt-1 text-sm">
                  {OWNER_LABEL[equity.parity.behind]} is behind by <span className="font-semibold tabular-nums">{formatCents(equity.parity.equalizingCents, "CAD")}</span>. A draw of that amount (or the other contributing it back) restores 50/50.
                </p>
              ) : (
                <p className="mt-1 text-sm text-status-engaged">Even.</p>
              )}
            </div>
          </div>
          <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ActionForm
              action="equity.create"
              hidden={{ entity: entity.slug }}
              submitLabel="Record"
              columns={2}
              fields={[
                { name: "owner_key", label: "Owner", type: "select", options: [{ value: "cc", label: "CC" }, { value: "adon", label: "Adon" }], defaultValue: viewer.ownerKey },
                { name: "kind", label: "Type", type: "select", options: [{ value: "draw", label: "Draw (money out to owner)" }, { value: "contribution", label: "Contribution (money in)" }] },
                { name: "amount", label: "Amount", type: "money", required: true },
                { name: "currency", label: "Currency", type: "select", options: [{ value: "CAD", label: "CAD" }, { value: "USD", label: "USD" }] },
                { name: "event_date", label: "Date", type: "date", defaultValue: today, required: true },
                { name: "cash_account_id", label: "Through account", type: "select", options: cashAccounts.map((a) => ({ value: a.id, label: a.name })) },
                { name: "memo", label: "Memo", span: 2 },
              ]}
            />
            <ul className="divide-y divide-bg-border/60 text-sm">
              {equity.events.length === 0 && <li className="py-2 text-fg-muted">No draws or contributions yet.</li>}
              {equity.events.slice(0, 15).map((e) => (
                <li key={e.id} className="flex justify-between gap-3 py-2">
                  <span>
                    <span className="tabular-nums text-fg-muted">{e.event_date}</span> · {OWNER_LABEL[e.owner_key]} {e.kind}
                    {e.memo && <span className="text-fg-dim"> · {e.memo}</span>}
                  </span>
                  <span className={`tabular-nums ${e.kind === "draw" ? "text-fg" : "text-status-engaged"}`}>{formatCents(e.amount_cents, e.currency)}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}
    </div>
  );
}
