"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postFinanceAction } from "./ActionForm";
import { dangerButton, inputClass, labelClass, primaryButton, quietButton } from "./ui";

export type CustomerManagerRow = {
  id: string;
  name: string;
  email: string;
  company: string;
  address: string;
  notes: string;
};

type Draft = Omit<CustomerManagerRow, "id">;

export function CustomerManager({ entity, customers }: { entity: string; customers: CustomerManagerRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function begin(row: CustomerManagerRow) {
    setEditing(row.id);
    setDraft({ name: row.name, email: row.email, company: row.company, address: row.address, notes: row.notes });
    setMessage(null);
  }

  async function save(id: string) {
    if (!draft) return;
    setBusy(id);
    setMessage(null);
    const result = await postFinanceAction({
      action: "contact.update",
      entity,
      contact_id: id,
      kind: "customer",
      ...draft,
    }).catch((error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : "Network error." }));
    setBusy(null);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message || "Customer update failed." });
      return;
    }
    setEditing(null);
    setDraft(null);
    setMessage({ ok: true, text: "Customer updated." });
    router.refresh();
  }

  async function archive(row: CustomerManagerRow) {
    if (!window.confirm(`Archive ${row.name}? Existing invoices and payments stay intact, but this customer will leave new-invoice pickers.`)) return;
    setBusy(row.id);
    setMessage(null);
    const result = await postFinanceAction({ action: "contact.archive", entity, contact_id: row.id }).catch((error: unknown) => ({
      ok: false,
      message: error instanceof Error ? error.message : "Network error.",
    }));
    setBusy(null);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message || "Customer archive failed." });
      return;
    }
    setMessage({ ok: true, text: "Customer archived. Historical records were kept." });
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {customers.length === 0 && <p className="text-sm text-fg-muted">No customers yet. Add your first one with the form.</p>}
      {customers.map((row) => {
        const open = editing === row.id && draft;
        return (
          <section key={row.id} className="rounded-lg border border-bg-border bg-bg-deep/35 p-3">
            {open ? (
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className={labelClass}>
                    Name
                    <input className={`${inputClass} mt-1`} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  </label>
                  <label className={labelClass}>
                    Billing email
                    <input type="email" className={`${inputClass} mt-1`} value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
                  </label>
                  <label className={labelClass}>
                    Company
                    <input className={`${inputClass} mt-1`} value={draft.company} onChange={(e) => setDraft({ ...draft, company: e.target.value })} />
                  </label>
                  <label className={labelClass}>
                    Address
                    <input className={`${inputClass} mt-1`} value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
                  </label>
                  <label className={`${labelClass} sm:col-span-2`}>
                    Notes
                    <textarea className={`${inputClass} mt-1`} rows={2} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={primaryButton} disabled={busy === row.id || !draft.name.trim()} onClick={() => void save(row.id)}>
                    {busy === row.id ? "Saving…" : "Save customer"}
                  </button>
                  <button type="button" className={quietButton} disabled={busy === row.id} onClick={() => { setEditing(null); setDraft(null); }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-semibold text-fg">{row.name}</p>
                  <p className="truncate text-xs text-fg-muted">{[row.company, row.email].filter(Boolean).join(" · ") || "No company or billing email"}</p>
                  {row.address && <p className="mt-1 text-xs text-fg-dim">{row.address}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" className={quietButton} disabled={busy === row.id} onClick={() => begin(row)}>Edit</button>
                  <button type="button" className={dangerButton} disabled={busy === row.id} onClick={() => void archive(row)}>
                    {busy === row.id ? "Working…" : "Archive"}
                  </button>
                </div>
              </div>
            )}
          </section>
        );
      })}
      {message && <p role="status" className={`text-xs ${message.ok ? "text-status-engaged" : "text-status-hot"}`}>{message.text}</p>}
    </div>
  );
}
