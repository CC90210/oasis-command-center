"use client";

/**
 * The "Write my page" fields (lib/offer-pages/write-page.ts), shared by every
 * place that asks for them: New offer (FormsListClient), Turn into an offer
 * (builder/TurnIntoOffer) and Write the empty parts (builder/WriteEmptyParts).
 * One component, so all three ask the same question with the same limits.
 */
import { WRITE_PAGE_INPUT } from "@/lib/offer-pages/write-page-client";

export function WritePageDescription({
  value,
  onChange,
  disabled = false,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  /** Locked while the page is being written from it, so the words match what was asked. */
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label className={`block text-xs text-fg-muted ${className}`}>
      What does this offer do, and who is it for?
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={3}
        maxLength={WRITE_PAGE_INPUT.maxDescription}
        className="input mt-1 w-full"
        placeholder="A sentence or two, in your own words. The page is written from this."
      />
    </label>
  );
}

export function WritePageToggle({
  checked,
  onChange,
  disabled = false,
  className = "",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Locked once creation starts: the choice it started with is the one it carries out. */
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label className={`flex items-center gap-2 text-xs text-fg ${className}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      Write the page for me (a draft: you review it, and set prices yourself, before it goes live)
    </label>
  );
}
