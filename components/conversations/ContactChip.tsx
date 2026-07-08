"use client";

/**
 * ContactChip — plan §4. One component for both phone + email contact
 * affordances in ContactHeaderBar. Whole chip is clickable-to-copy; native
 * text selection ("highlight to copy") is never intercepted. Displays a
 * human-formatted value but copies the canonical form (E.164 for phone,
 * verbatim for email). An adjacent quick-action icon (tel:/mailto:, or
 * "Compose here" for email) sits OUTSIDE the chip so copy vs act never
 * collide on the same click target.
 */

import { useEffect, useRef, useState } from "react";
import { Phone, Mail, Copy, Check, PhoneCall, PenLine } from "lucide-react";
import { normalizePhoneE164 } from "@/lib/conversation-threading";
import { formatPhoneDisplay } from "./format";

export function ContactChip({
  kind,
  value,
  editHref,
  onComposeEmail,
}: {
  kind: "phone" | "email";
  value: string | null;
  /** Where the "add contact info" affordance links when value is missing. */
  editHref?: string;
  /** Email only — flips the Composer to email mode with this address prefilled. */
  onComposeEmail?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [announce, setAnnounce] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!value) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-bg-border/70 bg-bg-elev/30 px-3 py-1.5 text-[11px] text-fg-dim">
        {kind === "phone" ? <Phone className="h-3 w-3 opacity-60" /> : <Mail className="h-3 w-3 opacity-60" />}
        <span>No {kind} on file</span>
        {editHref && (
          <a href={editHref} className="text-accent hover:underline ml-0.5">
            Add
          </a>
        )}
      </span>
    );
  }

  const display = kind === "phone" ? formatPhoneDisplay(value) : value;
  const copyValue = kind === "phone" ? normalizePhoneE164(value) || value : value;

  const onCopy = () => {
    if (typeof window !== "undefined" && window.getSelection()?.toString()) {
      // A drag-selection is in progress / just completed inside the chip —
      // never intercept it. This is what makes highlight-to-copy work
      // "for free" without a separate code path.
      return;
    }
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(copyValue).catch(() => {});
    }
    setCopied(true);
    setAnnounce(`Copied ${copyValue}`);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={onCopy}
        title={copied ? "Copied" : "Copy"}
        className="group inline-flex items-center gap-1.5 rounded-lg border border-bg-border bg-bg-elev px-3 py-1.5 text-[11px] text-fg hover:border-accent/50 transition-colors"
      >
        {kind === "phone" ? (
          <Phone className="h-3 w-3 text-fg-dim group-hover:text-accent transition-colors" />
        ) : (
          <Mail className="h-3 w-3 text-fg-dim group-hover:text-accent transition-colors" />
        )}
        <span className="select-text">{display}</span>
        {copied ? (
          <Check className="h-3 w-3 text-status-engaged" />
        ) : (
          <Copy className="h-3 w-3 text-fg-faint group-hover:text-fg-dim transition-colors" />
        )}
      </button>
      {kind === "phone" ? (
        <a
          href={`tel:${copyValue}`}
          title="Call"
          aria-label="Call"
          className="p-1.5 rounded-md text-fg-dim hover:text-accent hover:bg-accent/10 transition-colors"
        >
          <PhoneCall className="h-3.5 w-3.5" />
        </a>
      ) : (
        <>
          <a
            href={`mailto:${copyValue}`}
            title="Open in mail client"
            aria-label="Open in mail client"
            className="p-1.5 rounded-md text-fg-dim hover:text-accent hover:bg-accent/10 transition-colors"
          >
            <Mail className="h-3.5 w-3.5" />
          </a>
          {onComposeEmail && (
            <button
              type="button"
              onClick={onComposeEmail}
              title="Compose here"
              aria-label="Compose email here"
              className="p-1.5 rounded-md text-fg-dim hover:text-accent hover:bg-accent/10 transition-colors"
            >
              <PenLine className="h-3.5 w-3.5" />
            </button>
          )}
        </>
      )}
      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
    </div>
  );
}
