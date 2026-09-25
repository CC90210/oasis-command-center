/**
 * /founders/finances/transactions — the business's money-in/out register:
 * filters, categorise (posts to the ledger), exclude, "make a rule from this",
 * manual entry, statement import, Atlas drafts to approve, and Stripe activity.
 */
import Link from "next/link";
import { Card, PageHeader, Tag } from "@/components/Card";
import { ActionForm } from "@/components/founders/finances/ActionForm";
import { ActionButton } from "@/components/founders/finances/ActionButton";
import { CategorizeCell } from "@/components/founders/finances/CategorizeCell";
import { ImportPanel } from "@/components/founders/finances/ImportPanel";
import { ReceiptUpload } from "@/components/founders/finances/ReceiptUpload";
import { amountTone, inputClass, labelClass, numClass, primaryButton, quietButton, tableClass, tdClass, thClass } from "@/components/founders/finances/ui";
import { financePage, loadTransactionsPage, type SearchParams } from "@/lib/founders-finances/page-context";
import { REGISTER_SUBTYPES } from "@/lib/founders-finances/chart";
import { formatCents } from "@/lib/founders-finances/money";
import { suggestRulePattern } from "@/lib/founders-finances/rules";
import { torontoToday } from "@/lib/founders-finances/fx";

export const dynamic = "force-dynamic";

const STATUS_TONE = { unreviewed: "warm", posted: "engaged", excluded: "neutral", draft: "info" } as const;

export default async function TransactionsPage({ searchParams }: { searchParams: SearchParams }) {
  const { viewer, entity, sp } = await financePage(searchParams);
  const { filters, rows, accounts, categories, imports, payments } = await loadTransactionsPage(viewer, entity, sp);
  const registerAccounts = accounts.filter((a) => REGISTER_SUBTYPES.has(a.subtype));
  const catOptions = categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
  const drafts = rows.filter((r) => r.status === "draft").length;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Transactions"
        subtitle="Every dollar in and out of the business. Pick a category to post a transaction to the books; uncategorised rows and Atlas drafts stay out until you do."
        action={
          <a href="#add-transaction" className={primaryButton}>
            Add a transaction
          </a>
        }
      />

      <Card>
        <form method="GET" className="grid grid-cols-2 gap-3 md:grid-cols-7">
          <div className="col-span-2">
            <label className={labelClass}>Search</label>
            <input name="q" defaultValue={filters.q} className={inputClass} placeholder="Description, payee, memo" />
          </div>
          <div>
            <label className={labelClass}>Account</label>
            <select name="account" defaultValue={filters.accountId || ""} className={inputClass}>
              <option value="">All</option>
              {registerAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Category</label>
            <select name="category" defaultValue={filters.categoryId || ""} className={inputClass}>
              <option value="">All</option>
              <option value="none">Uncategorised</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Status</label>
            <select name="status" defaultValue={filters.status || ""} className={inputClass}>
              <option value="">All</option>
              <option value="unreviewed">Unreviewed</option>
              <option value="draft">Drafts (Atlas)</option>
              <option value="posted">Posted</option>
              <option value="excluded">Excluded</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>From</label>
            <input type="date" name="from" defaultValue={filters.from} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>To (before)</label>
            <input type="date" name="to" defaultValue={filters.to} className={inputClass} />
          </div>
          <div className="col-span-2 flex items-end gap-2 md:col-span-7">
            <button type="submit" className={quietButton}>
              Filter
            </button>
            <Link href="/founders/finances/transactions" className="text-xs text-fg-muted hover:text-fg">
              Clear
            </Link>
            {drafts > 0 && <span className="text-xs text-status-info">{drafts} draft{drafts === 1 ? "" : "s"} from Atlas waiting for approval</span>}
          </div>
        </form>
      </Card>

      <Card title={`Register (${rows.length})`} noPadding>
        {rows.length === 0 ? (
          <p className="p-5 text-sm text-fg-muted">
            No transactions match.{" "}
            <a href="#import" className="text-[#1FE3F0] hover:underline">
              Import a statement
            </a>{" "}
            or{" "}
            <a href="#add-transaction" className="text-[#1FE3F0] hover:underline">
              add one
            </a>
            .
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Date</th>
                  <th className={thClass}>Description</th>
                  <th className={thClass}>Account</th>
                  <th className={`${thClass} ${numClass}`}>Amount</th>
                  <th className={thClass}>Category</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass} />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className={`${tdClass} whitespace-nowrap tabular-nums text-fg-muted`}>{t.posted_date}</td>
                    <td className={tdClass}>
                      <div>{t.description}</div>
                      {(t.payee || t.memo) && <div className="text-[11px] text-fg-dim">{[t.payee, t.memo].filter(Boolean).join(" · ")}</div>}
                      <div className="text-[10px] uppercase tracking-wider text-fg-dim">{t.source}</div>
                    </td>
                    <td className={`${tdClass} text-fg-muted`}>{t.account_name}</td>
                    <td className={`${tdClass} ${numClass} whitespace-nowrap ${amountTone(t.amount_cents)}`}>{formatCents(t.amount_cents, t.currency)}</td>
                    <td className={tdClass}>
                      {t.status === "excluded" ? (
                        <span className="text-xs text-fg-dim">—</span>
                      ) : (
                        <CategorizeCell txnId={t.id} current={t.category_id} categories={catOptions} status={t.status} />
                      )}
                    </td>
                    <td className={tdClass}>
                      <Tag tone={STATUS_TONE[t.status]}>{t.status}</Tag>
                    </td>
                    <td className={`${tdClass} space-y-1 whitespace-nowrap text-right`}>
                      {t.category_id && t.status === "posted" && (
                        <ActionButton
                          action="txn.rule_from"
                          payload={{ txn_id: t.id, category_id: t.category_id, pattern: suggestRulePattern(t.description) }}
                          label="Make rule"
                          confirm={`Always categorise transactions containing "${suggestRulePattern(t.description)}" as ${t.category_name}?`}
                        />
                      )}
                      {t.status !== "excluded" && <ActionButton action="txn.exclude" payload={{ txn_id: t.id }} label="Exclude" confirm="Exclude this transaction from the books? Its ledger entry is reversed." />}
                      <div>
                        <ReceiptUpload ownerType="transaction" ownerId={t.id} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card id="add-transaction" title="Add a transaction" subtitle="Negative amount = money out.">
          <ActionForm
            action="txn.create"
            hidden={{ entity: entity.slug }}
            submitLabel="Record"
            columns={2}
            fields={[
              { name: "date", label: "Date", type: "date", required: true, defaultValue: torontoToday() },
              { name: "amount", label: "Amount", type: "money", required: true, placeholder: "-49.00" },
              { name: "description", label: "Description", required: true, span: 2 },
              { name: "account_id", label: "Account", type: "select", options: registerAccounts.map((a) => ({ value: a.id, label: a.name })) },
              { name: "currency", label: "Currency", type: "select", options: [{ value: "CAD", label: "CAD" }, { value: "USD", label: "USD" }] },
              { name: "category_id", label: "Category", type: "select", options: [{ value: "", label: "Decide later" }, ...categories.map((c) => ({ value: c.id, label: `${c.name} (${c.kind})` }))], span: 2 },
              { name: "memo", label: "Memo", span: 2 },
            ]}
          />
        </Card>
        <Card id="import" title="Import a bank or card statement" subtitle="CSV from any Canadian bank, or OFX/QFX. Rows already imported are skipped.">
          <ImportPanel entity={entity.slug} accounts={registerAccounts.map((a) => ({ id: a.id, name: a.name }))} />
          {imports.length > 0 && (
            <ul className="mt-4 space-y-1 text-xs text-fg-dim">
              {imports.slice(0, 5).map((i) => (
                <li key={i.id}>
                  {i.created_at.slice(0, 10)} · {i.filename} · {i.rows_inserted} added, {i.rows_duplicate} skipped · {i.created_by}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Stripe and invoice payments" subtitle="Money received, recorded automatically from Stripe or when you mark an invoice paid." noPadding>
        {payments.length === 0 ? (
          <p className="p-5 text-sm text-fg-muted">
            No payments recorded yet. Stripe payments arrive on their own once Stripe is{" "}
            <Link href="/founders/finances/settings#stripe" className="text-[#1FE3F0] hover:underline">
              connected in Settings
            </Link>
            ; invoice payments appear when you mark an invoice paid.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Date</th>
                  <th className={thClass}>Customer</th>
                  <th className={thClass}>Source</th>
                  <th className={`${thClass} ${numClass}`}>Amount</th>
                  <th className={`${thClass} ${numClass}`}>CAD</th>
                  <th className={`${thClass} ${numClass}`}>Fee</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => {
                  const sign = p.kind === "refund" ? -1 : 1;
                  return (
                    <tr key={p.id}>
                      <td className={`${tdClass} tabular-nums text-fg-muted`}>{p.occurred_on}</td>
                      <td className={tdClass}>
                        {p.customer_name || p.customer_email || "Unknown customer"}
                        {p.invoice_number && <span className="ml-2 text-[11px] text-fg-dim">{p.invoice_number}</span>}
                      </td>
                      <td className={`${tdClass} text-fg-muted`}>
                        {p.kind === "refund" ? "Refund" : p.source === "stripe" ? "Stripe" : "Manual"}
                        {!p.entry_id && <span className="ml-2 text-[11px] text-status-warm">not yet posted</span>}
                      </td>
                      <td className={`${tdClass} ${numClass} ${amountTone(sign * p.amount_cents)}`}>{formatCents(sign * p.amount_cents, p.currency)}</td>
                      <td className={`${tdClass} ${numClass} text-fg-muted`}>{p.settlement_cad_cents === null ? "—" : formatCents(sign * p.settlement_cad_cents, "CAD")}</td>
                      <td className={`${tdClass} ${numClass} text-fg-muted`}>
                        {p.fee_cad_cents !== null ? formatCents(p.fee_cad_cents, "CAD") : p.fee_status === "pending" ? <span className="text-status-warm">pending</span> : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
