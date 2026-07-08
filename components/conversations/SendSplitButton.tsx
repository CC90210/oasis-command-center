"use client";

/**
 * SendSplitButton — plan §3. Primary Send action, recolored to the active
 * channel. The "split" half (schedule presets + 8am-9pm recipient-local
 * TCPA warning) is Phase 3 per the plan (needs a recipient timezone source
 * that doesn't exist until the spine lands) — the chevron opens a disabled
 * "Coming soon" affordance so the control shape is final now and P3 only
 * has to enable it.
 */
import { useState, useRef, useEffect } from "react";
import { Send, ChevronDown, Clock } from "lucide-react";

export function SendSplitButton({
  onSend,
  sending,
  disabled,
  channel,
}: {
  onSend: () => void;
  sending: boolean;
  disabled?: boolean;
  channel: "sms" | "email";
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  const accent = channel === "sms" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-blue-600 hover:bg-blue-500";

  return (
    <div ref={ref} className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={onSend}
        disabled={disabled || sending}
        className={`inline-flex items-center gap-1.5 rounded-l-md px-3 py-2 text-xs font-bold text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${accent}`}
      >
        <Send className="h-3.5 w-3.5" />
        {sending ? "Sending…" : "Send"}
      </button>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        disabled={disabled || sending}
        aria-label="Send options"
        className={`rounded-r-md px-1.5 border-l border-white/20 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${accent}`}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {menuOpen && (
        <div className="absolute bottom-full right-0 mb-1.5 w-56 rounded-lg border border-bg-border bg-bg-elev shadow-elev z-20 p-1">
          <div className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-fg-dim italic cursor-not-allowed">
            <Clock className="h-3.5 w-3.5" />
            Schedule send — coming soon
          </div>
        </div>
      )}
    </div>
  );
}
