/**
 * /founders/finances/invoices — the business's invoice list, new draft,
 * customers. (invoices-io businessOnly() is still the server-side rule that a
 * personal book never invoices; this page only ever shows the business.)
 */
import Link from "next/link";
import { after } from "next/server";
import { Card, PageHeader, Tag } from "@/components/Card";
import { CustomersManager } from "@/components/founders/finances/CustomersManager";
import { InvoiceEditor } from "@/components/founders/finances/InvoiceEditor";
import {
  INVOICE_DISPLAY_STATUS_LABEL as STATUS_LABEL,
  INVOICE_DISPLAY_STATUS_TONE as STATUS_TONE,
  numClass,
  primaryButton,
  tableClass,
  tdClass,
  thClass,
} from "@/components/founders/finances/ui";
import { financePage, loadInvoicesPage, type SearchParams } from "@/lib/founders-finances/page-context";
import { sweepOverdue } from "@/lib/founders-finances/invoices-io";
import { retainerColumnsReady } from "@/lib/founders-finances/invoice-store";
import { formatCents } from "@/lib/founders-finances/money";
import { torontoToday } from "@/lib/founders-finances/fx";

export const dynamic = "force-dynamic";

export default async function InvoicesPage({ searchParams }: { searchParams: SearchParams }) {
  const { viewer, entity, sp } = await financePage(searchParams);
  // The migration-185 check runs beside the loader (memoised once it is there), so it adds no wait.
  const [{ status, invoices, contacts, activeContacts, settings, revenueAccounts }, retainerSupported] = await Promise.all([
    loadInvoicesPage(viewer, entity, sp),
    retainerColumnsReady(),
  ]);
  // Persisting "overdue" runs after the response: the list already shows
  // overdue from the due date (effective_status), so nothing here waits on it.
  after(() =>
    sweepOverdue(entity.id).then(
      () => undefined,
      (e: unknown) => console.error("[finances:invoices] overdue sweep failed", e instanceof Error ? e.message : e),
    ),
  );
  const filters = [
    { value: "", label: "All" },
    { value: "draft", label: STATUS_LABEL.draft },
    { value: "issued", label: STATUS_LABEL.issued },
    { value: "partially_paid", label: STATUS_LABEL.partially_paid },
    { value: "paid", label: STATUS_LABEL.paid },
    { value: "void", label: STATUS_LABEL.void },
    { value: "retainer", label: STATUS_LABEL.retainer },
  ] as const;
  const legacyFilterLabel = status === "sent" ? "Issued (legacy sent filter)" : status === "overdue" ? "Overdue (legacy filter)" : null;
  const selectedFilterLabel = filters.find((filter) => filter.value === status)?.label ?? legacyFilterLabel;
  const retainerNote = { none: "no link yet", not_emailed: "link not emailed yet", emailed: "link emailed" } as const;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Invoices"
        subtitle={`Bill a client and track what has been paid. ${settings.gst_qst_registered ? "GST/QST registered — tax is added to new invoices." : "Not GST/QST registered — invoices carry no sales tax."}`}
        action={
          <a href="#new-invoice" className={primaryButton}>
            New invoice
          </a>
        }
      />

      <Card noPadding>
        <div className="flex flex-wrap gap-1 border-b border-bg-border px-4 py-2">
          {legacyFilterLabel && <span className="rounded-md bg-bg-elev px-2.5 py-1 text-xs font-semibold text-fg">{legacyFilterLabel}</span>}
          {filters.map((filter) => (
            <Link
              key={filter.value || "all"}
              href={filter.value ? `/founders/finances/invoices?status=${filter.value}` : "/founders/finances/invoices"}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold ${status === filter.value ? "bg-bg-elev text-fg" : "text-fg-muted hover:text-fg"}`}
            >
              {filter.label}
            </Link>
          ))}
        </div>
        {invoices.length === 0 ? (
          <p className="p-5 text-sm text-fg-muted">
            No {selectedFilterLabel && status ? `${selectedFilterLabel.toLowerCase()} ` : ""}invoices yet.{" "}
            <a href="#new-invoice" className="text-[#1FE3F0] hover:underline">
              Create one below
            </a>
            .
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead>
                <tr>
                  <th className={thClass}>Number</th>
                  <th className={thClass}>Customer</th>
                  <th className={thClass}>Issued</th>
                  <th className={thClass}>Due</th>
                  <th className={`${thClass} ${numClass}`}>Total</th>
                  <th className={`${thClass} ${numClass}`}>Balance</th>
                  <th className={thClass}>Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id} className="hover:bg-bg-hover">
                    <td className={tdClass}>
                      <Link href={`/founders/finances/invoices/${i.id}`} className="font-semibold text-fg hover:underline">
                        {i.number || "Draft"}
                      </Link>
                    </td>
                    <td className={tdClass}>{i.contact_name}</td>
                    <td className={`${tdClass} tabular-nums text-fg-muted`}>{i.issue_date}</td>
                    <td className={`${tdClass} tabular-nums text-fg-muted`}>{i.due_date}</td>
                    <td className={`${tdClass} ${numClass}`}>
                      {formatCents(i.total_cents, i.currency)}
                      {i.retainer_cents > 0 && <div className="text-[11px] text-fg-dim">+ {formatCents(i.retainer_cents, i.currency)}/mo retainer</div>}
                    </td>
                    <td className={`${tdClass} ${numClass}`}>{formatCents(i.balance_cents, i.currency)}</td>
                    <td className={tdClass}>
                      <Tag tone={STATUS_TONE[i.display_status]}>{STATUS_LABEL[i.display_status]}</Tag>
                      {i.is_overdue && <span className="ml-2 text-[11px] font-semibold text-status-hot">Overdue</span>}
                      {i.status !== "draft" && i.status !== "void" && !i.sent_at && <span className="ml-2 text-[11px] text-status-warm">not emailed</span>}
                      {i.display_status === "retainer" && <div className="mt-0.5 text-[11px] text-fg-dim">nothing due now · {retainerNote[i.retainer_link]}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card id="new-invoice" title="New invoice" subtitle={`Numbered ${settings.invoice_prefix}-YYYY-NNNN when issued. Terms: ${settings.payment_terms_days} days.`}>
        <InvoiceEditor
          entity={entity.slug}
          contacts={activeContacts.map((c) => ({ id: c.id, name: c.name, email: c.email }))}
          revenueAccounts={revenueAccounts}
          registered={settings.gst_qst_registered === 1}
          today={torontoToday()}
          retainerSupported={retainerSupported}
        />
      </Card>

      <Card title="Customers" subtitle={`${activeContacts.length} active · ${contacts.length - activeContacts.length} archived`}>
        <CustomersManager entity={entity.slug} contacts={contacts} />
      </Card>
    </div>
  );
}
