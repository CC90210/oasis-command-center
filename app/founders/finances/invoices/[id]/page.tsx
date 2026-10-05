/**
 * /founders/finances/invoices/[id] — one invoice: edit (draft), issue, send
 * (PDF from the OASIS mailbox + card payment link), record a manual payment,
 * void, download the PDF, and its payment history.
 *
 * With a monthly retainer (migration 185) it shows "Due now" (the one-time
 * part — the only thing a manual payment can settle) and "Monthly retainer"
 * separately. The retainer has its own block whatever the invoice's status
 * (draft, open, paid, void): the monthly amount and, once its Stripe
 * recurring link exists, the link's LIVE state from Stripe — the link itself
 * is offered only while it is usable; once the client has subscribed (the
 * one-checkout link is spent) the block says so instead of offering it.
 * An issued invoice with nothing due now is labelled "retainer", not "sent":
 * it is not an open invoice.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, PageHeader, Tag } from "@/components/Card";
import { ActionButton } from "@/components/founders/finances/ActionButton";
import { ActionForm } from "@/components/founders/finances/ActionForm";
import { InvoiceEditor } from "@/components/founders/finances/InvoiceEditor";
import { INVOICE_STATUS_TONE, numClass, quietButton, tableClass, tdClass, thClass } from "@/components/founders/finances/ui";
import { FinanceNotFound, resolveFinanceViewer } from "@/lib/founders-finances/access-io";
import { loadInvoiceDetailPage } from "@/lib/founders-finances/page-context";
import { retainerLinkStatus, type RetainerLinkStatus } from "@/lib/founders-finances/invoices-io";
import { balanceDueCents, hasAmountDueNow, quantityMilliToString, storedLineBilling } from "@/lib/founders-finances/invoice";
import { retainerColumnsReady } from "@/lib/founders-finances/invoice-store";
import { centsToDecimalString, formatCents } from "@/lib/founders-finances/money";
import { CASH_SUBTYPES } from "@/lib/founders-finances/chart";
import { torontoToday } from "@/lib/founders-finances/fx";

export const dynamic = "force-dynamic";

const linkClass = "break-all text-[#1FE3F0] hover:underline";

/** The retainer block: the monthly amount and what the link can (or can't) still do, in plain words. */
function RetainerBlock({
  monthlyCents,
  currency,
  status,
  isDraft,
  isVoid,
}: {
  monthlyCents: number;
  currency: string;
  status: RetainerLinkStatus;
  isDraft: boolean;
  isVoid: boolean;
}) {
  const now = formatCents(monthlyCents, currency);
  let tag: { tone: "neutral" | "engaged" | "info" | "warm" | "hot"; label: string };
  let body: ReactNode;
  if (status.state === "none") {
    tag = { tone: "neutral", label: "no link yet" };
    body = isDraft
      ? "The Stripe link is created in OASIS's Stripe account when you send the invoice, before it gets its number."
      : "No link yet: it is created in OASIS's Stripe account the next time the invoice is emailed.";
  } else {
    const made = formatCents(status.linkCents, status.linkCurrency);
    if (status.state === "used") {
      tag = { tone: "engaged", label: "client has subscribed" };
      body = (
        <>
          The client used the link to start automatic monthly card payments of {made}/month, so the link is spent (Stripe switched it off after that one checkout).
          Their card is charged each month through Stripe; change or cancel the subscription in Stripe.
          {status.stale && <span className="text-status-warm"> The retainer on this invoice now says {now}/month: change the amount on their subscription in Stripe.</span>}
        </>
      );
    } else if (status.state === "active" && !status.stale) {
      tag = { tone: "info", label: "active, not used yet" };
      body = (
        <>
          The client hasn&apos;t used it yet; they use it once to start automatic monthly card payments.{" "}
          <a className={linkClass} href={status.url} target="_blank" rel="noreferrer">
            {status.url}
          </a>
        </>
      );
    } else if (status.state === "active") {
      tag = { tone: "warm", label: "made for another amount" };
      body = `This link was made for ${made}/month and the retainer is now ${now}/month, so it isn't offered here: sending the invoice again replaces it and switches this one off.`;
    } else if (status.state === "switched_off") {
      tag = { tone: "neutral", label: "link off" };
      body = isVoid
        ? "The link was switched off when the invoice was voided. A subscription the client already started keeps running until you cancel it in Stripe."
        : "The link was switched off in Stripe before the client used it, so nobody has subscribed with it: sending the invoice again emails a fresh link.";
    } else {
      tag = { tone: "warm", label: "can't tell" };
      body = `The app can't tell whether the client has used the link, so it isn't offered here. ${status.reason ?? ""} Sending again checks it with Stripe first and never emails a dead link.`;
    }
  }
  return (
    <Card title="Monthly retainer" subtitle="Paid by card, automatically every month through Stripe; never part of the balance due.">
      <div className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold tabular-nums">{now}/month</span>
          <Tag tone={tag.tone}>{tag.label}</Tag>
        </div>
        <p className="text-fg-muted">{body}</p>
      </div>
    </Card>
  );
}

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await resolveFinanceViewer();
  if (!viewer) notFound();
  const { id } = await params;
  let d;
  let retainerSupported = false;
  try {
    [d, retainerSupported] = await Promise.all([loadInvoiceDetailPage(viewer, id), retainerColumnsReady()]);
  } catch (e) {
    if (e instanceof FinanceNotFound) notFound();
    throw e;
  }
  const { invoice: inv, lines, contact, payments, settings, effectiveStatus, listStatus, accounts, contacts, retainerMonthlyCents: retainer, retainerLinkUrl } = d;
  // Stripe's live view of the retainer link (never throws; `none` without asking Stripe when there is no link).
  const linkStatus = await retainerLinkStatus(inv);
  const balance = inv.status === "void" ? 0 : balanceDueCents({ totalCents: inv.total_cents, amountPaidCents: inv.amount_paid_cents });
  // A retainer-only invoice has nothing due now: nothing to record, and no one-time card link to offer.
  const dueNow = hasAmountDueNow({ totalCents: inv.total_cents, retainerMonthlyCents: retainer });
  const depositAccounts = accounts.filter((a) => CASH_SUBTYPES.has(a.subtype));
  const isDraft = inv.status === "draft";
  const open = effectiveStatus === "sent" || effectiveStatus === "overdue";
  const revenueAccounts = accounts.filter((a) => a.type === "revenue" && a.subtype === "revenue").map((a) => ({ id: a.id, name: a.name }));

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title={inv.number || "Draft invoice"}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Tag tone={listStatus === "retainer" ? "accent" : INVOICE_STATUS_TONE[listStatus]}>{listStatus === "retainer" ? "retainer set up" : listStatus}</Tag>
            <span>{contact?.name}</span>
            <span className="text-fg-dim">·</span>
            {retainer > 0 ? (
              <span>
                {dueNow ? `${formatCents(inv.total_cents, inv.currency)} due ${inv.due_date}` : "nothing due now"} · {formatCents(retainer, inv.currency)}/mo retainer
              </span>
            ) : (
              <span>
                {formatCents(inv.total_cents, inv.currency)} · due {inv.due_date}
              </span>
            )}
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
        <Card
          title={isDraft ? "Issue and send" : "Send again"}
          subtitle={
            retainer > 0
              ? `Emails the PDF from the OASIS mailbox with two parts: ${dueNow ? "the amount due now (paid as the invoice says) and " : ""}the monthly retainer's Stripe link, which the client uses once to set up automatic monthly card payments.`
              : "Emails the PDF from the OASIS mailbox. A card payment link is created in OASIS's Stripe account unless you untick it."
          }
        >
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
                ...(dueNow
                  ? [
                      {
                        name: "payment_link",
                        label: retainer > 0 ? "Include a card link for the amount due now (Stripe)" : "Include a card payment link (Stripe)",
                        type: "checkbox" as const,
                        defaultValue: true,
                      },
                    ]
                  : []),
              ]}
            />
            {isDraft && (
              <div className="flex items-center gap-3 border-t border-bg-border pt-3 text-xs text-fg-muted">
                <ActionButton action="invoice.finalize" payload={{ invoice_id: inv.id }} label="Issue without emailing" confirm="Issue this invoice now? It gets its number and is booked as a receivable." />
                <span>Numbers it and books the receivable; email it later.</span>
              </div>
            )}
            {/* A draft's card link was never emailed and may be for an old amount: only an issued invoice's link is shown. */}
            {!isDraft && inv.stripe_payment_link_url && (
              <p className="text-xs text-fg-muted">
                Payment link: <a className="text-[#1FE3F0] hover:underline" href={inv.stripe_payment_link_url} target="_blank" rel="noreferrer">{inv.stripe_payment_link_url}</a>
              </p>
            )}
          </div>
        </Card>
      )}

      {(retainer > 0 || linkStatus.state !== "none") && (
        <RetainerBlock monthlyCents={retainer} currency={inv.currency} status={linkStatus} isDraft={isDraft} isVoid={inv.status === "void"} />
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
              {lines.map((l) => {
                const monthly = storedLineBilling(l.billing) === "monthly";
                const per = monthly ? "/mo" : "";
                return (
                  <tr key={l.id}>
                    <td className={tdClass}>
                      {l.description}
                      {monthly && (
                        <span className="ml-2">
                          <Tag tone="info">monthly</Tag>
                        </span>
                      )}
                    </td>
                    <td className={`${tdClass} ${numClass}`}>{quantityMilliToString(l.quantity_milli)}</td>
                    <td className={`${tdClass} ${numClass}`}>{formatCents(l.unit_price_cents, inv.currency)}{per}</td>
                    <td className={`${tdClass} ${numClass}`}>{formatCents(l.amount_cents, inv.currency)}{per}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="text-sm">
              <tr>
                <td colSpan={3} className="px-3 pt-3 text-right text-fg-muted">{retainer > 0 ? "One-time subtotal" : "Subtotal"}</td>
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
                <td colSpan={3} className="px-3 text-right font-semibold">{retainer > 0 ? "Due now" : "Total"} {inv.currency}</td>
                <td className="px-3 text-right font-semibold tabular-nums">{formatCents(inv.total_cents, inv.currency)}</td>
              </tr>
              <tr>
                <td colSpan={3} className={`px-3 text-right text-fg-muted ${retainer > 0 ? "" : "pb-3"}`}>Balance due</td>
                <td className={`px-3 text-right tabular-nums ${retainer > 0 ? "" : "pb-3"}`}>{formatCents(balance, inv.currency)}</td>
              </tr>
              {retainer > 0 && (
                <tr>
                  <td colSpan={3} className="px-3 pb-3 text-right font-semibold">
                    Monthly retainer {inv.currency}
                    <div className="text-[11px] font-normal text-fg-dim">card, automatic every month through Stripe; not part of the balance</div>
                  </td>
                  <td className="px-3 pb-3 text-right align-top font-semibold tabular-nums">{formatCents(retainer, inv.currency)}/mo</td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      </Card>

      {open && dueNow && (
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
            retainerSupported={retainerSupported}
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
                billing: storedLineBilling(l.billing),
              })),
            }}
          />
        </Card>
      )}

      {(isDraft || (open && inv.amount_paid_cents === 0)) && (
        <div className="flex justify-end">
          <ActionButton
            action="invoice.void"
            payload={{ invoice_id: inv.id }}
            label="Void invoice"
            tone="danger"
            confirm={`Void this invoice? An issued invoice's receivable is reversed; the number stays used.${
              retainerLinkUrl ? " Its retainer link stops working; a subscription the client already started keeps running until you cancel it in Stripe." : ""
            }`}
          />
        </div>
      )}
    </div>
  );
}
