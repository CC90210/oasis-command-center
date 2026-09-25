"use client";

/**
 * Create / edit a draft invoice. Totals preview runs the SAME pure function
 * the server uses (computeInvoiceTotals), so what you see is what gets
 * stored — the server still recomputes and is the only authority.
 *
 * "How the client pays" — bank transfer (Wise, the default for a one-off
 * invoice), card (Stripe) or both. Whether Wise can supply details for the
 * chosen currency is asked of the server (GET /api/founders/finances/wise
 * ?view=editor) after render, so the form never waits on Wise; when it
 * cannot, the reason is shown and the invoice falls back to the card link.
 */

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { computeInvoiceTotals } from "@/lib/founders-finances/invoice";
import { formatCents } from "@/lib/founders-finances/money";
import {
  DEFAULT_NEW_INVOICE_METHOD,
  INVOICE_PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  offersBankTransfer,
  parsePaymentMethod,
  type InvoicePaymentMethod,
} from "@/lib/founders-finances/wise";
import { postFinanceAction } from "./ActionForm";
import { inputClass, labelClass, primaryButton, quietButton } from "./ui";

type Line = { description: string; quantity: string; unit_price: string; taxable: boolean; revenue_account_id: string };
type WiseInfo = { methodSupported: boolean; available: boolean; reason: string | null };

export function InvoiceEditor({
  entity,
  contacts,
  revenueAccounts,
  registered,
  today,
  initial,
}: {
  entity: string;
  contacts: Array<{ id: string; name: string; email: string }>;
  revenueAccounts: Array<{ id: string; name: string }>;
  registered: boolean;
  today: string;
  initial?: {
    invoiceId: string;
    contactId: string;
    issueDate: string;
    dueDate: string;
    currency: "CAD" | "USD";
    notes: string;
    lines: Line[];
    /** Optional: when omitted, the editor reads the stored method from the server. */
    paymentMethod?: InvoicePaymentMethod;
  };
}) {
  const router = useRouter();
  const defaultAccount = revenueAccounts[0]?.id || "";
  const [contactId, setContactId] = useState(initial?.contactId || contacts[0]?.id || "__new");
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [issueDate, setIssueDate] = useState(initial?.issueDate || today);
  const [dueDate, setDueDate] = useState(initial?.dueDate || "");
  const [currency, setCurrency] = useState<"CAD" | "USD">(initial?.currency || "CAD");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [lines, setLines] = useState<Line[]>(
    initial?.lines?.length ? initial.lines : [{ description: "", quantity: "1", unit_price: "", taxable: true, revenue_account_id: defaultAccount }],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // null while an edited draft's stored method is still loading: nothing is sent, so it cannot be overwritten.
  const [method, setMethod] = useState<InvoicePaymentMethod | null>(initial ? initial.paymentMethod ?? null : DEFAULT_NEW_INVOICE_METHOD);
  const [wise, setWise] = useState<WiseInfo | null>(null);
  const invoiceId = initial?.invoiceId;

  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams({ view: "editor", currency });
    if (invoiceId) qs.set("invoice_id", invoiceId);
    fetch(`/api/founders/finances/wise?${qs.toString()}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: Record<string, unknown>) => {
        if (!live || j?.ok !== true) return;
        const w = (j.wise || {}) as { available?: boolean; reason?: string | null };
        const supported = j.method_supported === true;
        setWise({ methodSupported: supported, available: w.available === true, reason: w.reason ?? null });
        // Before migration 184 every invoice is a card invoice; afterwards an edited draft shows what it stored.
        if (!supported) setMethod("stripe");
        else setMethod((m) => m ?? parsePaymentMethod(j.invoice_payment_method) ?? DEFAULT_NEW_INVOICE_METHOD);
      })
      .catch(() => {
        if (live) setWise({ methodSupported: false, available: false, reason: "Could not reach the server to check Wise." });
      });
    return () => {
      live = false;
    };
  }, [currency, invoiceId]);

  const preview = useMemo(() => {
    try {
      return { ok: true as const, t: computeInvoiceTotals(lines.map((l) => ({ description: l.description || "—", quantity: l.quantity || "0", unitPrice: l.unit_price || "0", taxable: l.taxable })), { registered }) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "invalid" };
    }
  }, [lines, registered]);

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function save() {
    setBusy(true);
    setErr(null);
    const body: Record<string, unknown> = {
      action: initial ? "invoice.update" : "invoice.create",
      entity,
      issue_date: issueDate,
      due_date: dueDate,
      currency,
      notes,
      lines,
    };
    if (initial) body.invoice_id = initial.invoiceId;
    if (method && wise?.methodSupported) body.payment_method = method;
    if (contactId === "__new") body.new_contact = { name: newName, email: newEmail };
    else body.contact_id = contactId;
    const r = await postFinanceAction(body).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : "Network error." }));
    setBusy(false);
    if (!r.ok) {
      setErr(r.message || "Failed.");
      return;
    }
    const data = (r as { data?: Record<string, unknown> }).data;
    if (typeof data?.redirect === "string") router.push(data.redirect);
    else router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label className={labelClass}>Customer</label>
          <select className={inputClass} value={contactId} onChange={(e) => setContactId(e.target.value)}>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.email ? ` — ${c.email}` : ""}
              </option>
            ))}
            <option value="__new">+ New customer</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Issue date</label>
          <input type="date" className={inputClass} value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Due date</label>
          <input type="date" className={inputClass} value={dueDate} onChange={(e) => setDueDate(e.target.value)} placeholder="terms" />
        </div>
        {contactId === "__new" && (
          <>
            <div className="sm:col-span-2">
              <label className={labelClass}>New customer name</label>
              <input className={inputClass} value={newName} onChange={(e) => setNewName(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>Billing email</label>
              <input type="email" className={inputClass} value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
            </div>
          </>
        )}
        <div>
          <label className={labelClass}>Currency</label>
          <select className={inputClass} value={currency} onChange={(e) => setCurrency(e.target.value as "CAD" | "USD")}>
            <option value="CAD">CAD</option>
            <option value="USD">USD</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className={labelClass}>How the client pays</label>
          <select
            className={inputClass}
            value={method ?? ""}
            disabled={!wise || !wise.methodSupported}
            onChange={(e) => setMethod(parsePaymentMethod(e.target.value))}
          >
            {method === null && <option value="">Loading…</option>}
            {INVOICE_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </div>
        <div className="-mt-1 text-[11px] leading-snug text-fg-dim sm:col-span-4">
          {!wise ? (
            "Checking Wise…"
          ) : !wise.methodSupported ? (
            <span className="text-status-warm">{wise.reason || "Bank transfer isn't available right now."} The invoice goes out with the card link.</span>
          ) : method && offersBankTransfer(method) && !wise.available ? (
            <span className="text-status-warm">Wise unavailable: {wise.reason} It will be sent with the card link or your payment instructions instead.</span>
          ) : method && offersBankTransfer(method) ? (
            `The invoice prints the Wise ${currency} bank details with its number as the payment reference. Recurring billing stays on Stripe subscriptions.`
          ) : (
            "A Stripe card payment link is attached when the invoice is sent."
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">
              <th className="pb-1.5 pr-2">Description</th>
              <th className="w-20 pb-1.5 pr-2">Qty</th>
              <th className="w-28 pb-1.5 pr-2">Unit price</th>
              <th className="w-40 pb-1.5 pr-2">Revenue account</th>
              {registered && <th className="w-16 pb-1.5 pr-2">Tax</th>}
              <th className="w-24 pb-1.5 text-right">Amount</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="py-1 pr-2">
                  <input className={inputClass} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="What was delivered" />
                </td>
                <td className="py-1 pr-2">
                  <input className={inputClass} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                </td>
                <td className="py-1 pr-2">
                  <input className={inputClass} inputMode="decimal" value={l.unit_price} onChange={(e) => setLine(i, { unit_price: e.target.value })} placeholder="0.00" />
                </td>
                <td className="py-1 pr-2">
                  <select className={inputClass} value={l.revenue_account_id} onChange={(e) => setLine(i, { revenue_account_id: e.target.value })}>
                    {revenueAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </td>
                {registered && (
                  <td className="py-1 pr-2 text-center">
                    <input type="checkbox" checked={l.taxable} onChange={(e) => setLine(i, { taxable: e.target.checked })} className="h-4 w-4 accent-[#1FE3F0]" />
                  </td>
                )}
                <td className="py-1 text-right tabular-nums text-fg-muted">
                  {preview.ok && preview.t.lines[i] ? formatCents(preview.t.lines[i].amountCents, currency) : "—"}
                </td>
                <td className="py-1 pl-2">
                  {lines.length > 1 && (
                    <button type="button" className="text-xs text-fg-dim hover:text-status-hot" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove line">
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className={`${quietButton} mt-2`} onClick={() => setLines((ls) => [...ls, { description: "", quantity: "1", unit_price: "", taxable: true, revenue_account_id: defaultAccount }])}>
          Add line
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label className={labelClass}>Notes on the invoice</label>
          <textarea className={inputClass} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Project reference, PO number…" />
        </div>
        <dl className="space-y-1 self-end text-sm">
          {preview.ok ? (
            <>
              <div className="flex justify-between text-fg-muted">
                <dt>Subtotal</dt>
                <dd className="tabular-nums">{formatCents(preview.t.subtotalCents, currency)}</dd>
              </div>
              {registered ? (
                <>
                  <div className="flex justify-between text-fg-muted">
                    <dt>GST 5%</dt>
                    <dd className="tabular-nums">{formatCents(preview.t.gstCents, currency)}</dd>
                  </div>
                  <div className="flex justify-between text-fg-muted">
                    <dt>QST 9.975%</dt>
                    <dd className="tabular-nums">{formatCents(preview.t.qstCents, currency)}</dd>
                  </div>
                </>
              ) : (
                <div className="text-[11px] text-fg-dim">No GST/QST — not registered (small supplier).</div>
              )}
              <div className="flex justify-between border-t border-bg-border pt-1 font-semibold text-fg">
                <dt>Total</dt>
                <dd className="tabular-nums">{formatCents(preview.t.totalCents, currency)}</dd>
              </div>
            </>
          ) : (
            <div className="text-xs text-status-warm">{preview.error}</div>
          )}
        </dl>
      </div>

      <div className="flex items-center gap-3">
        <button type="button" className={primaryButton} disabled={busy} onClick={save}>
          {busy ? "Saving…" : initial ? "Save draft" : "Create draft"}
        </button>
        {err && <span className="text-xs text-status-hot">{err}</span>}
      </div>
    </div>
  );
}
