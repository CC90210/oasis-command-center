"use client";

/**
 * Small inputs for the offer builder, on the OS tokens (globals.css .input,
 * .textarea, .label). A character count sits under every capped field, so the
 * parser's caps are visible before a save is refused.
 */
import type { ReactNode } from "react";

export function TextField({
  label,
  value,
  onChange,
  cap,
  placeholder,
  hint,
  multiline = false,
  rows = 3,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  cap: number;
  /** An input hint only. Never saved, never shown on the page. */
  placeholder?: string;
  hint?: ReactNode;
  multiline?: boolean;
  rows?: number;
}) {
  const v = value ?? "";
  const over = v.length > cap;
  return (
    <label className="block space-y-1">
      <span className="label">{label}</span>
      {multiline ? (
        <textarea className="textarea w-full" rows={rows} value={v} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="input w-full" value={v} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
      <span className="flex justify-between gap-3 text-[11px]">
        <span className="text-fg-dim">{hint}</span>
        <span className={over ? "text-rose-400" : "text-fg-dim"}>
          {v.length}/{cap}
        </span>
      </span>
    </label>
  );
}

export function Tick({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-[13px] text-fg">
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[rgb(var(--c-accent))]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function SmallButton({
  onClick,
  children,
  disabled,
  tone = "neutral",
  title,
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  tone?: "neutral" | "danger" | "primary";
  title?: string;
}) {
  const cls =
    tone === "danger"
      ? "text-rose-400 hover:text-rose-300"
      : tone === "primary"
        ? "text-accent hover:text-accent-bright"
        : "text-fg-muted hover:text-fg";
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={`text-xs ${cls} disabled:cursor-not-allowed disabled:opacity-40`}>
      {children}
    </button>
  );
}

/** A confirmation the server will stamp with the saving owner and the time. */
export function pendingConfirmation(): { by: string; at: string } {
  return { by: "pending", at: new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z") };
}
