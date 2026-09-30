"use client";

/**
 * SelectAction — a choice and a button in one row, for a Finances write that
 * needs one answer from the founder (which account paid this bill; which
 * account pays this recurring cost). Posts { action, ...payload, [name]: value }
 * to /api/founders/finances/actions like ActionForm, shows the server's
 * message on failure, and refreshes the page on success. With `required`, the
 * button stays disabled until something is chosen: there is no default
 * answer to click through. With `date`, a date field sits beside the choice
 * and is sent under its name ("Paid on" for a bill: the day the money left,
 * which is often not the day the founder clicks).
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postFinanceAction } from "./ActionForm";
import { inputClass, quietButton } from "./ui";

export function SelectAction({
  action,
  payload,
  name,
  options,
  label,
  placeholder,
  defaultValue = "",
  required = true,
  confirm,
  date,
}: {
  action: string;
  payload: Record<string, unknown>;
  /** The field the chosen value is sent as. */
  name: string;
  options: Array<{ value: string; label: string }>;
  /** The button's text. */
  label: string;
  /** The first, empty option. */
  placeholder: string;
  defaultValue?: string;
  required?: boolean;
  confirm?: string;
  /** A date sent with the choice (a bill's payment day). Required when given: the button waits for it. */
  date?: { name: string; label: string; defaultValue: string; max?: string };
}) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue);
  const [day, setDay] = useState(date?.defaultValue ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <select
        aria-label={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={`${inputClass} w-auto min-w-[11rem] py-1 text-xs`}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {date && (
        <input
          type="date"
          name={date.name}
          aria-label={date.label}
          title={date.label}
          value={day}
          max={date.max}
          onChange={(e) => setDay(e.target.value)}
          className={`${inputClass} w-auto py-1 text-xs`}
        />
      )}
      <button
        type="button"
        disabled={busy || (required && !value) || (!!date && !day)}
        className={quietButton}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setErr(null);
          const body = { action, ...payload, [name]: value, ...(date ? { [date.name]: day } : {}) };
          const r = await postFinanceAction(body).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : "Network error." }));
          setBusy(false);
          if (!r.ok) {
            setErr(r.message || "Failed.");
            return;
          }
          router.refresh();
        }}
      >
        {busy ? "Saving…" : label}
      </button>
      {err && <span className="text-xs text-status-hot">{err}</span>}
    </span>
  );
}
