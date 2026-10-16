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
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <label className={`block text-xs text-fg-muted ${className}`}>
      What does this offer do, and who is it for?
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
  className = "",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}) {
  return (
    <label className={`flex items-center gap-2 text-xs text-fg ${className}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Write the page for me (a draft: you review it, and set prices yourself, before it goes live)
    </label>
  );
}
