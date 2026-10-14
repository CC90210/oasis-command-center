"use client";

/**
 * One form component for every Finances write. Posts JSON
 * { action, ...hidden, ...fields } to /api/founders/finances/actions, shows
 * the server's message on failure (written for a founder to read), and
 * refreshes the server-rendered page on success. Callers may project
 * reversible non-financial intent while the server remains the source of
 * truth for money, lifecycle, ledger and report state.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition, type FormEvent } from "react";
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

type FinanceActionData = Record<string, unknown>;
type OptimisticRollback = (() => void) | void;

export async function postFinanceAction(body: Record<string, unknown>): Promise<{ ok: boolean; message?: string; data?: FinanceActionData }> {
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
  disabled = false,
  onPendingChange,
  onOptimistic,
}: {
  action: string;
  hidden?: Record<string, string | number | boolean>;
  fields: FieldSpec[];
  submitLabel: string;
  successMessage?: string;
  confirm?: string;
  columns?: 1 | 2 | 3 | 4;
  resetOnSuccess?: boolean;
  disabled?: boolean;
  onPendingChange?: (pending: boolean) => void;
  onOptimistic?: (values: Record<string, unknown>) => OptimisticRollback;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [transitionPending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const inFlight = useRef(false);
  const pendingCallback = useRef(onPendingChange);
  const reportedPending = useRef(false);
  const pending = submitting || transitionPending;
  const locked = disabled || pending;

  const reportPending = useCallback((next: boolean) => {
    if (reportedPending.current === next) return;
    reportedPending.current = next;
    pendingCallback.current?.(next);
  }, []);

  useEffect(() => {
    pendingCallback.current = onPendingChange;
  }, [onPendingChange]);

  useEffect(() => {
    reportPending(pending);
    return () => {
      if (pending) reportPending(false);
    };
  }, [pending, reportPending]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked || inFlight.current) return;
    if (confirm && !window.confirm(confirm)) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const values: Record<string, unknown> = { action, ...hidden };
    for (const f of fields) {
      if (f.type === "checkbox") values[f.name] = fd.get(f.name) === "on";
      else values[f.name] = String(fd.get(f.name) ?? "");
    }
    inFlight.current = true;
    reportPending(true);
    let rollback: (() => void) | undefined;
    try {
      const maybeRollback = onOptimistic?.(values);
      rollback = typeof maybeRollback === "function" ? maybeRollback : undefined;
    } catch (err) {
      inFlight.current = false;
      reportPending(false);
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Could not prepare this change." });
      return;
    }
    setSubmitting(true);
    setMsg(null);
    try {
      const r = await postFinanceAction(values);
      if (!r.ok) {
        const message = r.message || "Failed.";
        rollback?.();
        setMsg({ ok: false, text: message });
        return;
      }
      const data = r.data ?? {};
      setMsg({ ok: true, text: typeof data.message === "string" ? data.message : successMessage });
      if (resetOnSuccess) form.reset();
      startTransition(() => {
        if (typeof data.redirect === "string") router.push(data.redirect);
        else router.refresh();
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error.";
      rollback?.();
      setMsg({ ok: false, text: message });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const grid = { 1: "sm:grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" }[columns];
  const span = (n?: number) => (n === 3 ? "sm:col-span-3" : n === 2 ? "sm:col-span-2" : "");

  return (
    <form onSubmit={onSubmit} className="space-y-3" aria-busy={pending}>
      <fieldset disabled={locked} className="space-y-3 border-0 p-0">
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
          <button type="submit" disabled={locked} aria-disabled={locked} className={primaryButton}>
            {pending ? "Working…" : submitLabel}
          </button>
          {msg && (
            <span role="status" aria-live="polite" className={`text-xs ${msg.ok ? "text-status-engaged" : "text-status-hot"}`}>
              {msg.text}
            </span>
          )}
        </div>
      </fieldset>
    </form>
  );
}
