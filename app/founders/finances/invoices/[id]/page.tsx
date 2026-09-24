/**
 * /founders/finances/invoices/[id] — one invoice: edit (draft), issue, send
 * (PDF from the OASIS mailbox + card payment link), record a manual payment,
 * void, download the PDF, and its payment history.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, PageHeader, Tag } from "@/components/Card";
import { ActionButton } from "@/components/founders/finances/ActionButton";
import { ActionForm } from "@/components/founders/finances/ActionForm";
import { InvoiceEditor } from "@/components/founders/finances/InvoiceEditor";
import { INVOICE_STATUS_TONE, numClass, quietButton, tableClass, tdClass, thClass } from "@/components/founders/finances/ui";
import { FinanceNotFound, resolveFinanceViewer, entityAccounts } from "@/lib/founders-finances/access-io";
import { getInvoiceDetail, listContacts } from "@/lib/founders-finances/invoices-io";
import { balanceDueCents, quantityMilliToString } from "@/lib/founders-finances/invoice";
import { centsToDecimalString, formatCents } from "@/lib/founders-finances/money";
import { CASH_SUBTYPES } from "@/lib/founders-finances/chart";
import { torontoToday } from "@/lib/founders-finances/fx";

export const dynamic = "force-dynamic";

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await resolveFinanceViewer();
  if (!viewer) notFound();
  const { id } = await params;
  let d;
  try {
    d = await getInvoiceDetail(viewer, id);
  } catch (e) {
    if (e instanceof FinanceNotFound) notFound();
    throw e;
  }
  const { invoice: inv, lines, contact, payments, settings, effectiveStatus } = d;
  const balance = inv.status === "void" ? 0 : balanceDueCents({ totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents });
  const accounts = await entityAccounts(inv.entity_id);
  const depositAccounts = accounts.filter((a) => CASH_SUBTYPES.has(a.subtype));
  const isDraft = inv.status === "draft";
  const open = effectiveStatus === "sent" || effectiveStatus === "overdue";
  const contacts = isDraft ? await listContacts(viewer, inv.entity_id, "customer") : [];
  const revenueAccounts = accounts.filter((a) => a.type === "revenue" && a.subtype === "revenue").map((a) => ({ id: a.id, name: a.name }));

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title={inv.number || "Draft invoice"}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Tag tone={INVOICE_STATUS_TONE[effectiveStatus]}>{effectiveStatus}</Tag>
            <span>{contact?.name}</span>
            <span className="text-fg-dim">·</span>
            <span>
              {formatCents(inv.total_cents, inv.currency)} · due {inv.due_date}
            </span>
            {inv.sent_at ? (
              <span className="text-fg-dim">
                · emailed {inv.sent_at.slice(0, 10)} to {inv.sent_to}
              </span>
            ) : inv.number ? (
              <span className="text-status-warm">· issued, not emailed yet</span>
            ) : null}
          </span>
        }
        action={
          <div className="flex flex-wrap gap-2">
            <a href={`/api/founders/finances/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer" className={quietButton}>
              {isDraft ? "Preview PDF" : "PDF"}
            </a>
            <Link href="/founders/finances/invoices" className={quietButton}>
              All invoices
            </Link>
          </div>
        }
      />

      {(isDraft || open) && (
        <Card title={isDraft ? "Issue and send" : "Send again"} subtitle="Emails the PDF from the OASIS mailbox. A card payment link is created in OASIS's Stripe account unless you untick it.">
          <div className="space-y-4">
            <ActionForm
              action="invoice.send"
              hidden={{ invoice_id: inv.id }}
              submitLabel={isDraft ? "Issue & email" : "Email again"}
              confirm={isDraft ? "Issue this invoice (it gets its number and is booked as a receivable) and email it?" : undefined}
              resetOnSuccess={false}
              columns={2}
              fields={[
                { name: "to", label: "Send to", type: "email", defaultValue: contact?.email || "", required: true },
                { name: "payment_link", label: "Include a card payment link (Stripe)", type: "checkbox", defaultValue: true },
              ]}
            />
            {isDraft && (
              <div className="flex items-center gap-3 border-t border-bg-border pt-3 text-xs text-fg-muted">
                <ActionButton action="invoice.finalize" payload={{ invoice_id: inv.id }} label="Issue without emailing" confirm="Issue this invoice now? It gets its number and is booked as a receivable." />
                <span>Numbers it and books the receivable; email it later.</span>
              </div>
            )}
            {inv.stripe_payment_link_url && (
              <p className="text-xs text-fg-muted">
                Payment link: <a className="text-[#1FE3F0] hover:underline" href={inv.stripe_payment_link_url} target="_blank" rel="noreferrer">{inv.stripe_payment_link_url}</a>
              </p>
            )}
          </div>
        </Card>
      )}

      <Card title="Lines" noPadding>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead>
              <tr>
                <th className={thClass}>Description</th>
                <th className={`${thClass} ${numClass}`}>Qty</th>
                <th className={`${thClass} ${numClass}`}>Unit price</th>
                <th className={`${thClass} ${numClass}`}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className={tdClass}>{l.description}</td>
                  <td className={`${tdClass} ${numClass}`}>{quantityMilliToString(l.quantity_milli)}</td>
                  <td className={`${tdClass} ${numClass}`}>{formatCents(l.unit_price_cents, inv.currency)}</td>
                  <td className={`${tdClass} ${numClass}`}>{formatCents(l.amount_cents, inv.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="text-sm">
              <tr>
                <td colSpan={3} className="px-3 pt-3 text-right text-fg-muted">Subtotal</td>
                <td className="px-3 pt-3 text-right tabular-nums">{formatCents(inv.subtotal_cents, inv.currency)}</td>
              </tr>
              {inv.tax_registered_snapshot === 1 && (
                <>
                  <tr>
                    <td colSpan={3} className="px-3 text-right text-fg-muted">GST 5% {settings.gst_number && `(${settings.gst_number})`}</td>
                    <td className="px-3 text-right tabular-nums">{formatCents(inv.gst_cents, inv.currency)}</td>
                  </tr>
                  <tr>
                    <td colSpan={3} className="px-3 text-right text-fg-muted">QST 9.975% {settings.qst_number && `(${settings.qst_number})`}</td>
                    <td className="px-3 text-right tabular-nums">{formatCents(inv.qst_cents, inv.currency)}</td>
                  </tr>
                </>
              )}
              <tr>
                <td colSpan={3} className="px-3 text-right font-semibold">Total {inv.currency}</td>
                <td className="px-3 text-right font-semibold tabular-nums">{formatCents(inv.total_cents, inv.currency)}</td>
              </tr>
              <tr>
                <td colSpan={3} className="px-3 pb-3 text-right text-fg-muted">Balance due</td>
                <td className="px-3 pb-3 text-right tabular-nums">{formatCents(balance, inv.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      {open && (
        <Card title="Record a payment" subtitle="E-transfer, cheque or wire. Posts to the bank account you choose and clears the receivable.">
          <ActionForm
            action="invoice.mark_paid"
            hidden={{ invoice_id: inv.id }}
            submitLabel="Record payment"
            columns={inv.currency === "USD" ? 4 : 3}
            fields={[
              { name: "amount", label: `Amount (${inv.currency})`, type: "money", defaultValue: centsToDecimalString(balance), required: true },
              { name: "date", label: "Received on", type: "date", defaultValue: torontoToday(), required: true },
              { name: "deposit_account_id", label: "Deposited to", type: "select", options: depositAccounts.map((a) => ({ value: a.id, label: a.name })) },
              ...(inv.currency === "USD"
                ? [{ name: "received_cad", label: "CAD that landed", type: "money" as const, hint: "Leave blank to use that day's Bank of Canada rate (marked as estimated)." }]
                : []),
              { name: "reference", label: "Reference", placeholder: "Interac ref, cheque #", span: 2 },
            ]}
          />
        </Card>
      )}

      {payments.length > 0 && (
        <Card title="Payments" noPadding>
          <table className={tableClass}>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className={`${tdClass} tabular-nums text-fg-muted`}>{p.occurred_on}</td>
                  <td className={tdClass}>{p.kind === "refund" ? "Refund" : p.source === "stripe" ? "Stripe" : "Manual"} {p.description && <span className="text-fg-dim">· {p.description}</span>}</td>
                  <td className={`${tdClass} ${numClass}`}>{formatCents((p.kind === "refund" ? -1 : 1) * p.amount_cents, p.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {isDraft && (
        <Card title="Edit draft">
          <InvoiceEditor
            entity={inv.entity_id}
            contacts={contacts.map((c) => ({ id: c.id, name: c.name, email: c.email }))}
            revenueAccounts={revenueAccounts}
            registered={settings.gst_qst_registered === 1}
            today={torontoToday()}
            initial={{
              invoiceId: inv.id,
              contactId: inv.contact_id,
              issueDate: inv.issue_date,
              dueDate: inv.due_date,
              currency: inv.currency,
              notes: inv.notes,
              lines: lines.map((l) => ({
                description: l.description,
                quantity: quantityMilliToString(l.quantity_milli),
                unit_price: centsToDecimalString(l.unit_price_cents),
                taxable: l.taxable === 1,
                revenue_account_id: l.revenue_account_id,
              })),
            }}
          />
        </Card>
      )}

      {(isDraft || (open && inv.amount_paid_cents === 0)) && (
        <div className="flex justify-end">
          <ActionButton action="invoice.void" payload={{ invoice_id: inv.id }} label="Void invoice" tone="danger" confirm="Void this invoice? An issued invoice's receivable is reversed; the number stays used." />
        </div>
      )}
    </div>
  );
}
