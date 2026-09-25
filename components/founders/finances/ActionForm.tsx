"use client";

/**
 * One form component for every Finances write. Posts JSON
 * { action, ...hidden, ...fields } to /api/founders/finances/actions, shows
 * the server's message on failure (written for a founder to read), and
 * refreshes the server-rendered page on success. No optimistic UI: money
 * forms show what the server actually stored.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { inputClass, labelClass, primaryButton } from "./ui";

export type FieldSpec = {
  name: string;
  label: string;
  type?: "text" | "date" | "money" | "number" | "select" | "textarea" | "checkbox" | "email";
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  defaultValue?: string | boolean;
  placeholder?: string;
  hint?: string;
  span?: 1 | 2 | 3;
};

export async function postFinanceAction(body: Record<string, unknown>): Promise<{ ok: boolean; message?: string; data?: Record<string, unknown> }> {
  const res = await fetch("/api/founders/finances/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json || json.ok !== true) {
    const message =
      (json && typeof json.message === "string" && json.message) ||
      (json && typeof json.error === "string" && json.error) ||
      `Request failed (${res.status})`;
    return { ok: false, message };
  }
  return { ok: true, data: json };
}

export function ActionForm({
  action,
  hidden = {},
  fields,
  submitLabel,
  successMessage = "Saved.",
  confirm,
  columns = 3,
  resetOnSuccess = true,
}: {
  action: string;
  hidden?: Record<string, string | number | boolean>;
  fields: FieldSpec[];
  submitLabel: string;
  successMessage?: string;
  confirm?: string;
  columns?: 1 | 2 | 3 | 4;
  resetOnSuccess?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (confirm && !window.confirm(confirm)) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const values: Record<string, unknown> = { action, ...hidden };
    for (const f of fields) {
      if (f.type === "checkbox") values[f.name] = fd.get(f.name) === "on";
      else values[f.name] = String(fd.get(f.name) ?? "");
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await postFinanceAction(values);
      if (!r.ok) {
        setMsg({ ok: false, text: r.message || "Failed." });
        return;
      }
      setMsg({ ok: true, text: typeof r.data?.message === "string" ? (r.data.message as string) : successMessage });
      if (resetOnSuccess) form.reset();
      if (typeof r.data?.redirect === "string") router.push(r.data.redirect as string);
      else router.refresh();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Network error." });
    } finally {
      setBusy(false);
    }
  }

  const grid = { 1: "sm:grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" }[columns];
  const span = (n?: number) => (n === 3 ? "sm:col-span-3" : n === 2 ? "sm:col-span-2" : "");

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className={`grid grid-cols-1 gap-3 ${grid}`}>
        {fields.map((f) => (
          <div key={f.name} className={span(f.span)}>
            {f.type === "checkbox" ? (
              <label className="flex items-center gap-2 pt-5 text-sm text-fg">
                <input type="checkbox" name={f.name} defaultChecked={f.defaultValue === true} className="h-4 w-4 accent-[#1FE3F0]" />
                {f.label}
              </label>
            ) : (
              <>
                <label className={labelClass} htmlFor={`${action}-${f.name}`}>
                  {f.label}
                  {f.required && <span className="text-status-hot"> *</span>}
                </label>
                {f.type === "select" ? (
                  <select id={`${action}-${f.name}`} name={f.name} required={f.required} defaultValue={String(f.defaultValue ?? "")} className={inputClass}>
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : f.type === "textarea" ? (
                  <textarea id={`${action}-${f.name}`} name={f.name} required={f.required} defaultValue={String(f.defaultValue ?? "")} placeholder={f.placeholder} rows={3} className={inputClass} />
                ) : (
                  <input
                    id={`${action}-${f.name}`}
                    name={f.name}
                    type={f.type === "money" ? "text" : f.type || "text"}
                    inputMode={f.type === "money" || f.type === "number" ? "decimal" : undefined}
                    required={f.required}
                    defaultValue={String(f.defaultValue ?? "")}
                    placeholder={f.placeholder ?? (f.type === "money" ? "0.00" : undefined)}
                    className={inputClass}
                  />
                )}
              </>
            )}
            {f.hint && <p className="mt-1 text-[11px] text-fg-dim">{f.hint}</p>}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? "Working…" : submitLabel}
        </button>
        {msg && (
          <span role="status" className={`text-xs ${msg.ok ? "text-status-engaged" : "text-status-hot"}`}>
            {msg.text}
          </span>
        )}
      </div>
    </form>
  );
}
