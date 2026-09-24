/**
 * /founders/finances/invoices — invoice list, new draft, customers.
 * Business book only: the personal books do not invoice.
 */
import Link from "next/link";
import { Card, PageHeader, Tag } from "@/components/Card";
import { EntitySwitcher } from "@/components/founders/finances/EntitySwitcher";
import { InvoiceEditor } from "@/components/founders/finances/InvoiceEditor";
import { ActionForm } from "@/components/founders/finances/ActionForm";
import { INVOICE_STATUS_TONE as STATUS_TONE, numClass, tableClass, tdClass, thClass } from "@/components/founders/finances/ui";
import { financePage, param, type SearchParams } from "@/lib/founders-finances/page-context";
import { listContacts, listInvoices, sweepOverdue } from "@/lib/founders-finances/invoices-io";
import { loadSettings } from "@/lib/founders-finances/settings-io";
import { query } from "@/lib/founders-finances/db";
import { formatCents } from "@/lib/founders-finances/money";
import { torontoToday } from "@/lib/founders-finances/fx";

export const dynamic = "force-dynamic";

export default async function InvoicesPage({ searchParams }: { searchParams: SearchParams }) {
  const { viewer, entity, entities, sp } = await financePage(searchParams);
  if (entity.kind !== "business") {
    return (
      <div className="space-y-6">
        <PageHeader title="Invoices" action={<EntitySwitcher entities={entities} current={entity.slug} basePath="/founders/finances/invoices" />} />
        <Card>
          <p className="text-sm text-fg-muted">Personal books do not send invoices. Switch to OASIS AI Solutions.</p>
        </Card>
      </div>
    );
  }
  await sweepOverdue(entity.id);
  const status = param(sp, "status");
  const [invoices, contacts, settings, revenueAccounts] = await Promise.all([
    listInvoices(viewer, entity.slug, status || undefined),
    listContacts(viewer, entity.slug, "customer"),
    loadSettings(entity.id),
    query<{ id: string; name: string }>(`SELECT id, name FROM fin_accounts WHERE entity_id = ? AND type = 'revenue' AND subtype = 'revenue' AND archived = 0 ORDER BY code`, [entity.id]),
  ]);
  const q = `entity=${entity.slug}`;
  const filters = ["", "draft", "sent", "overdue", "paid", "void"];

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Invoices"
        subtitle={settings.gst_qst_registered ? "GST/QST registered — taxes are added to new invoices." : "Not GST/QST registered — invoices carry no sales tax."}
        action={<EntitySwitcher entities={entities} current={entity.slug} basePath="/founders/finances/invoices" />}
      />

      <Card noPadding>
        <div className="flex flex-wrap gap-1 border-b border-bg-border px-4 py-2">
          {filters.map((f) => (
            <Link
              key={f || "all"}
              href={`/founders/finances/invoices?${q}${f ? `&status=${f}` : ""}`}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold ${status === f ? "bg-bg-elev text-fg" : "text-fg-muted hover:text-fg"}`}
            >
              {f ? f[0].toUpperCase() + f.slice(1) : "All"}
            </Link>
          ))}
        </div>
        {invoices.length === 0 ? (
          <p className="p-5 text-sm text-fg-muted">No invoices{status ? ` with status ${status}` : ""} yet.</p>
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
                    <td className={`${tdClass} ${numClass}`}>{formatCents(i.total_cents, i.currency)}</td>
                    <td className={`${tdClass} ${numClass}`}>{formatCents(i.balance_cents, i.currency)}</td>
                    <td className={tdClass}>
                      <Tag tone={STATUS_TONE[i.effective_status]}>{i.effective_status}</Tag>
                      {i.status !== "draft" && i.status !== "void" && !i.sent_at && <span className="ml-2 text-[11px] text-status-warm">not emailed</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="New invoice" subtitle={`Numbered ${settings.invoice_prefix}-YYYY-NNNN when issued. Terms: ${settings.payment_terms_days} days.`}>
        <InvoiceEditor
          entity={entity.slug}
          contacts={contacts.map((c) => ({ id: c.id, name: c.name, email: c.email }))}
          revenueAccounts={revenueAccounts}
          registered={settings.gst_qst_registered === 1}
          today={torontoToday()}
        />
      </Card>

      <Card title="Customers" subtitle={`${contacts.length} on file`}>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ul className="divide-y divide-bg-border/60 text-sm">
            {contacts.length === 0 && <li className="py-2 text-fg-muted">No customers yet.</li>}
            {contacts.map((c) => (
              <li key={c.id} className="flex justify-between gap-3 py-2">
                <span>{c.name}</span>
                <span className="truncate text-fg-muted">{c.email || "no email"}</span>
              </li>
            ))}
          </ul>
          <ActionForm
            action="contact.create"
            hidden={{ entity: entity.slug, kind: "customer" }}
            submitLabel="Add customer"
            columns={2}
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "email", label: "Billing email", type: "email" },
              { name: "company", label: "Company" },
              { name: "address", label: "Address", span: 2 },
            ]}
          />
        </div>
      </Card>
    </div>
  );
}
