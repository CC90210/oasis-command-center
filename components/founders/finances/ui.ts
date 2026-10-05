/**
 * Shared class strings for the Finances pages. Server- and client-safe (no
 * React, no hooks). Kept here so every form on every tab looks the same.
 */

export const inputClass =
  "w-full rounded-md border border-bg-border bg-bg-deep px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-dim focus:border-[rgba(31,227,240,0.5)] focus:outline-none";

export const labelClass = "mb-1 block text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted";

export const buttonClass =
  "inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

export const primaryButton = `${buttonClass} border-[rgba(31,227,240,0.45)] bg-[rgba(31,227,240,0.1)] text-fg hover:bg-[rgba(31,227,240,0.18)]`;
export const quietButton = `${buttonClass} border-bg-border bg-bg-elev text-fg-muted hover:text-fg`;
export const dangerButton = `${buttonClass} border-status-hot/40 bg-status-hot/10 text-status-hot hover:bg-status-hot/20`;

export const tableClass = "w-full text-left text-sm";
export const thClass = "border-b border-bg-border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted";
export const tdClass = "border-b border-bg-border/60 px-3 py-2 align-top";
export const numClass = "text-right tabular-nums";

export const INVOICE_STATUS_TONE = { draft: "neutral", sent: "info", overdue: "hot", paid: "engaged", void: "neutral" } as const;

export function amountTone(cents: number): string {
  return cents < 0 ? "text-status-hot" : cents > 0 ? "text-status-engaged" : "text-fg-muted";
}
