/**
 * /founders/finances/bills — the business's bills (owed, paid later) and
 * expenses (already paid), receipts, and recurring expenses.
 *
 * Paid from: a bank, cash or card account, or "Paid by CC personally" /
 * "Paid by Adon personally" (that owner's contribution equity, bills-io.ts
 * resolvePaidFrom). Marking a bill paid asks which one; nothing defaults to
 * chequing. A recurring cost is recorded as a bill due on its date unless a
 * founder has confirmed which account pays it (bills-io.ts recordRecurringNow).
 */
import { Card, PageHeader, Tag } from "@/components/Card";
import { ActionForm } from "@/components/founders/finances/ActionForm";
import { ActionButton } from "@/components/founders/finances/ActionButton";
import { ReceiptUpload } from "@/components/founders/finances/ReceiptUpload";
import { SelectAction } from "@/components/founders/finances/SelectAction";
import { numClass, primaryButton, tableClass, tdClass, thClass } from "@/components/founders/finances/ui";
import { financePage, loadBillsPage, type SearchParams } from "@/lib/founders-finances/page-context";
import { PAID_BY_OWNER, PAID_BY_OWNER_LABEL } from "@/lib/founders-finances/bills-io";
import { REGISTER_SUBTYPES } from "@/lib/founders-finances/chart";
import { formatCents } from "@/lib/founders-finances/money";
import { torontoToday } from "@/lib/founders-finances/fx";

export const dynamic = "force-dynamic";

export default async function BillsPage({ searchParams }: { searchParams: SearchParams }) {
  const { viewer, entity } = await financePage(searchParams);
  const { bills, accounts, categories, settings, recurring, attachments } = await loadBillsPage(viewer, entity);
  const payFrom = accounts.filter((a) => REGISTER_SUBTYPES.has(a.subtype));
  // Every paid-from answer a founder can give: the business's own accounts, then an owner who paid personally.
  const paidFromOptions = [
    ...payFrom.map((a) => ({ value: a.id, label: a.name })),
    ...(entity.kind === "business"
      ? [
          { value: PAID_BY_OWNER.cc, label: PAID_BY_OWNER_LABEL.cc },
          { value: PAID_BY_OWNER.adon, label: PAID_BY_OWNER_LABEL.adon },
        ]
      : []),
  ];
  const expenseCats = categories.filter((c) => c.kind === "expense");
  const registered = settings.gst_qst_registered === 1;
  const today = torontoToday();

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Bills & Expenses"
        subtitle={`What the business pays: one-off expenses, bills due later, and monthly costs. ${registered ? "GST/QST you pay is tracked as input tax credits." : "Not registered — GST/QST you pay is part of the cost."}`}
        action={
          <a href="#recurring" className={primaryButton}>
            Add a recurring cost
          </a>
        }
      />

      <Card id="record" title="Record a bill or expense">
        <ActionForm
          action="bill.create"
          hidden={{ entity: entity.slug }}
          submitLabel="Record"
          columns={4}
          fields={[
            {
              name: "kind",
              label: "Type",
              type: "select",
              options: [
                { value: "expense", label: "Expense (already paid)" },
                { value: "bill", label: "Bill (pay later)" },
              ],
            },
            { name: "vendor_name", label: "Vendor", required: true },
            { name: "bill_date", label: "Date", type: "date", defaultValue: today, required: true },
            { name: "due_date", label: "Due (bills)", type: "date" },
            { name: "subtotal", label: "Amount before tax", type: "money", required: true },
            { name: "gst", label: "GST paid", type: "money", placeholder: "0.00" },
            { name: "qst", label: "QST paid", type: "money", placeholder: "0.00" },
            { name: "currency", label: "Currency", type: "select", options: [{ value: "CAD", label: "CAD" }, { value: "USD", label: "USD" }] },
            { name: "category_id", label: "Category", type: "select", required: true, options: expenseCats.map((c) => ({ value: c.id, label: c.name })) },
            { name: "paid_from_account_id", label: "Paid from (expenses)", type: "select", options: [{ value: "", label: "Choose (expenses only)" }, ...paidFromOptions] },
            { name: "reference", label: "Reference / invoice #" },
            { name: "memo", label: "Memo" },
          ]}
        />
      </Card>

      <Card title={`Bills & expenses (${bills.length})`} noPadding>
        {bills.length === 0 ? (
          <p className="p-5 text-sm text-fg-muted">
            Nothing recorded yet.{" "}
            <a href="#record" className="text-[#1FE3F0] hover:underline">
              Record your first expense
            </a>{" "}
            with the form above.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Date</th>
                  <th className={thClass}>Vendor</th>
                  <th className={thClass}>Category</th>
                  <th className={`${thClass} ${numClass}`}>Total</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Receipt</th>
                  <th className={thClass} />
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id}>
                    <td className={`${tdClass} tabular-nums text-fg-muted`}>{b.bill_date}</td>
                    <td className={tdClass}>
                      {b.vendor_name}
                      <div className="text-[11px] text-fg-dim">
                        {b.kind}
                        {b.reference && ` · ${b.reference}`}
                        {b.due_date && b.status === "open" && ` · due ${b.due_date}`}
                      </div>
                    </td>
                    <td className={`${tdClass} text-fg-muted`}>{b.category_name}</td>
                    <td className={`${tdClass} ${numClass}`}>{formatCents(b.total_cents, b.currency)}</td>
                    <td className={tdClass}>
                      <Tag tone={b.status === "paid" ? "engaged" : b.status === "open" ? (b.due_date && b.due_date < today ? "hot" : "warm") : "neutral"}>{b.status}</Tag>
                    </td>
                    <td className={tdClass}>
                      {attachments
                        .filter((a) => a.owner_id === b.id)
                        .map((a) => (
                          <a key={a.id} href={`/api/founders/finances/attachments?id=${a.id}`} target="_blank" rel="noreferrer" className="block text-xs text-[#1FE3F0] hover:underline">
                            {a.filename}
                          </a>
                        ))}
                      <ReceiptUpload ownerType="bill" ownerId={b.id} />
                    </td>
                    <td className={`${tdClass} space-y-1 text-right`}>
                      {b.status === "open" && (
                        <div>
                          {/* The day the money left, not the day of the click: the Wise feed links its line by that day. */}
                          <SelectAction
                            action="bill.pay"
                            payload={{ bill_id: b.id }}
                            name="account_id"
                            options={paidFromOptions}
                            placeholder="Paid from…"
                            label="Mark paid"
                            date={{ name: "date", label: "Paid on", defaultValue: today, max: today }}
                          />
                        </div>
                      )}
                      {b.status !== "void" && <ActionButton action="bill.void" payload={{ bill_id: b.id }} label="Void" confirm="Void this and reverse its ledger entries?" />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        id="recurring"
        title="Recurring expenses"
        subtitle="Subscriptions, rent and other fixed costs. Record each one when it comes due: it is booked as paid only from the account you confirmed pays it, otherwise as a bill to pay."
      >
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ul className="divide-y divide-bg-border/60 text-sm">
            {recurring.length === 0 && <li className="py-2 text-fg-muted">None yet. Add each subscription and the rent with the form.</li>}
            {recurring.map((r) => {
              const paidBy = r.paid_by_owner ? PAID_BY_OWNER_LABEL[r.paid_by_owner] : r.paid_from_name;
              return (
                <li key={r.id} className="space-y-1.5 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {r.name} <span className="text-fg-dim">· {r.cadence} · {r.category_name}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className={`tabular-nums ${r.next_run_on <= today ? "text-status-warm" : "text-fg-muted"}`}>
                        {formatCents(r.amount_cents, r.currency)} · next {r.next_run_on}
                      </span>
                      {r.active === 1 && r.next_run_on <= today && (
                        <ActionButton action="recurring.record" payload={{ item_id: r.id }} label={r.paid_from_confirmed ? "Record as paid" : "Record as a bill"} />
                      )}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    {r.paid_from_confirmed ? (
                      <span className="text-fg-muted">{r.paid_by_owner ? paidBy : `Paid from ${paidBy}`} (confirmed)</span>
                    ) : (
                      <span className="text-status-warm">
                        Paid from: not confirmed{paidBy ? ` (set to ${paidBy}, never confirmed)` : ""}. Each due date is recorded as a bill to pay.
                      </span>
                    )}
                    <SelectAction
                      action="recurring.confirm"
                      payload={{ item_id: r.id }}
                      name="account_id"
                      options={paidFromOptions}
                      placeholder={r.paid_from_confirmed ? "Change to…" : "Which account pays it?"}
                      label="Confirm"
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          <ActionForm
            action="recurring.create"
            hidden={{ entity: entity.slug }}
            submitLabel="Add recurring"
            columns={2}
            fields={[
              { name: "name", label: "Name", required: true, placeholder: "Figma, Vercel, rent…" },
              { name: "amount", label: "Amount", type: "money", required: true },
              { name: "currency", label: "Currency", type: "select", options: [{ value: "CAD", label: "CAD" }, { value: "USD", label: "USD" }] },
              { name: "cadence", label: "Every", type: "select", options: ["monthly", "weekly", "quarterly", "yearly"].map((c) => ({ value: c, label: c })) },
              { name: "category_id", label: "Category", type: "select", required: true, options: expenseCats.map((c) => ({ value: c.id, label: c.name })) },
              {
                name: "paid_from_account_id",
                label: "Paid from",
                type: "select",
                options: [{ value: "", label: "Not confirmed yet: record each as a bill to pay" }, ...paidFromOptions],
                hint: "Choosing an account confirms it pays this cost.",
              },
              { name: "next_run_on", label: "Next due", type: "date", defaultValue: today },
            ]}
          />
        </div>
      </Card>
    </div>
  );
}
