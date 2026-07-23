"use client";

import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/lib/clipboard";

/**
 * Small copy-to-clipboard control for dense rows (phone/email). Stops event
 * propagation so it never triggers the parent row's onClick (open-drawer /
 * navigate). Falls back to window.prompt when the async clipboard API is
 * unavailable or permission-blocked (matches app/templates/page.tsx).
 */
export function CopyButton({
  value,
  title,
  className = "",
  size = 12,
}: {
  value: string | null | undefined;
  title?: string;
  className?: string;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const v = String(value ?? "").trim();
      if (!v) return;
      if (await copyText(v)) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    },
    [value],
  );

  if (!value || !String(value).trim()) return null;

  return (
    <button
      type="button"
      onClick={onCopy}
      title={title || `Copy ${value}`}
      aria-label={`Copy ${value}`}
      className={`inline-flex shrink-0 items-center justify-center rounded p-0.5 text-fg-dim transition-colors hover:bg-bg-elev/60 hover:text-accent ${className}`}
    >
      {copied ? <Check size={size} className="text-status-engaged" /> : <Copy size={size} />}
    </button>
  );
}
