/**
 * ClientMoneyPanel — the record's Money tab: what OASIS's books say about this
 * client (lib/os/customers/money.ts). Read-only; every figure is integer cents
 * per currency, so each total is the exact sum of the rows behind it.
 *
 * A client that is not in the books says so and says how to link it (a Stripe
 * customer id or the email the payments carry), never a row of zeros.
 */
import Link from "next/link";
import { Card, EmptyState } from "@/components/Card";
import { formatCents } from "@/lib/os/customers/activity";
import type { ClientMoney } from "@/lib/os/customers/money";

function amounts(list: ReadonlyArray<{ currency: string; cents: number }>, none: string): string {
  return list.length ? list.map((a) => formatCents(a.cents, a.currency)).join(" + ") : none;
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "None";
}

function Figure({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl border border-hairline bg-bg-panel px-4 py-3">
      <div className="text-xs text-fg-dim">{label}</div>
      <div className={`mt-1 text-base font-semibold tabular-nums ${tone === "warn" ? "text-status-hot" : "text-fg"}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-fg-dim">{hint}</div>}
    </div>
  );
}

export function ClientMoneyPanel({ money, canOpenMoney }: { money: ClientMoney | null; canOpenMoney: boolean }) {
  if (money === null) {
    return (
      <Card>
        <EmptyState message="This client is not linked to the books yet: it has no Stripe customer and no email. Add either with Edit details, and its payments, subscriptions and invoices appear here." />
      </Card>
    );
  }
  const matched = money.matchedBy.map((m) => (m === "stripe_customer" ? "Stripe customer" : "email")).join(" and ");
  const nothing = money.paymentCount === 0 && money.refundCount === 0 && money.subscriptions.length === 0 && money.invoices.length === 0;
  return (
    <div className="space-y-6">
      <p className="text-[13px] text-fg-muted">
        From OASIS&rsquo;s books, matched by {matched}.{" "}
        {canOpenMoney && (
          <Link href="/money" prefetch={false} className="text-accent hover:underline">
            Open Money
          </Link>
        )}
      </p>
      {nothing ? (
        <Card>
          <EmptyState message={`No payments, subscriptions or invoices in the books match this client's ${matched}.`} />
        </Card>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Figure
              label="Collected, all time"
              value={amounts(money.collected, "Nothing yet")}
              hint={`${money.paymentCount} payment${money.paymentCount === 1 ? "" : "s"}${money.refundCount ? `, ${money.refundCount} refund${money.refundCount === 1 ? "" : "s"}` : ""}; live mode`}
            />
            <Figure
              label="Monthly recurring"
              value={amounts(money.mrr, "No active subscription")}
              hint={money.cancelAtPeriodEnd ? "set to cancel at the end of the period" : undefined}
              tone={money.cancelAtPeriodEnd ? "warn" : undefined}
            />
            <Figure label="Next renewal" value={day(money.nextRenewal)} />
            <Figure
              label="Overdue"
              value={money.overdueInvoices ? `${money.overdueInvoices} invoice${money.overdueInvoices === 1 ? "" : "s"}` : "None"}
              hint={money.outstanding.length ? `${amounts(money.outstanding, "")} still owed` : undefined}
              tone={money.overdueInvoices || money.failedPayments ? "warn" : undefined}
            />
          </section>
          {money.failedPayments > 0 && (
            <p role="alert" className="rounded-xl border border-status-hot/30 px-4 py-3 text-[13px] text-status-hot">
              {money.failedPayments} subscription payment{money.failedPayments === 1 ? "" : "s"} failed (Stripe marks the
              subscription past due or unpaid).
            </p>
          )}
          <Card title="Invoices" noPadding>
            {money.invoices.length === 0 ? (
              <p className="px-4 py-4 text-[13px] text-fg-muted">No invoices for this client in the books.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-hairline text-left text-xs text-fg-dim">
                      <th className="px-4 py-2 font-medium">Invoice</th>
                      <th className="px-4 py-2 font-medium">Issued</th>
                      <th className="px-4 py-2 font-medium">Due</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 text-right font-medium">Total</th>
                      <th className="px-4 py-2 text-right font-medium">Paid</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-hairline">
                    {money.invoices.map((i) => (
                      <tr key={i.id}>
                        <td className="px-4 py-2.5 font-mono text-xs text-fg-muted">{i.number ?? "Draft"}</td>
                        <td className="px-4 py-2.5 text-fg-muted">{i.issue_date}</td>
                        <td className="px-4 py-2.5 text-fg-muted">{i.due_date}</td>
                        <td className={`px-4 py-2.5 ${i.overdue ? "text-status-hot" : "text-fg-muted"}`}>{i.overdue ? "Overdue" : i.status}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{formatCents(i.total_cents, i.currency)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{formatCents(i.amount_paid_cents, i.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {money.subscriptions.length > 0 && (
            <Card title="Subscriptions" noPadding>
              <ul className="divide-y divide-hairline">
                {money.subscriptions.map((sub, idx) => (
                  <li key={`${sub.status}-${idx}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <span className="text-fg">{formatCents(sub.monthly_cents, sub.currency)} a month</span>
                    <span className="text-xs text-fg-dim">
                      {sub.status}
                      {sub.current_period_end ? ` · period ends ${day(sub.current_period_end)}` : ""}
                      {sub.cancel_at_period_end ? " · cancels at period end" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
