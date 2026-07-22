"use client";

/**
 * AcceleratedToggle — the lightning chip on a lead row that turns the SMS
 * "Accelerated statement chase" on/off for that lead (2026-07-21). Amber + solid
 * when ON, dim outline when OFF. Optimistic; reverts + alerts on failure (the API
 * is role-gated + fail-closed). stopPropagation so clicking it never navigates
 * into the lead. Mirrors InlineStageControl's interaction pattern.
 */

import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useRouter } from "next/navigation";
import { Zap } from "lucide-react";

export function AcceleratedToggle({ recordId, on: onProp }: { recordId: string; on: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(onProp);
  const [pending, setPending] = useState(false);

  useEffect(() => setOn(onProp), [onProp]);

  async function toggle(e: ReactMouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (pending) return;
    const next = !on;
    setPending(true);
    setOn(next); // optimistic
    try {
      const res = await fetch(`/api/leads/${recordId}/accelerated`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on: next }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setOn(!next);
        alert(`Couldn't update accelerated chase: ${json?.error || res.status}`);
      } else {
        router.refresh();
      }
    } catch {
      setOn(!next);
      alert("Couldn't update accelerated chase — network error.");
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      disabled={pending}
      onClick={toggle}
      title={on ? "Accelerated chase ON — click to stop" : "Turn on accelerated chase"}
      aria-pressed={on}
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-colors disabled:opacity-50 ${
        on
          ? "bg-amber-400/20 text-amber-300 ring-1 ring-amber-400/50 hover:bg-amber-400/30"
          : "text-fg-dim ring-1 ring-bg-border hover:text-amber-300 hover:ring-amber-400/40"
      }`}
    >
      <Zap className="h-3 w-3" fill={on ? "currentColor" : "none"} />
      {on ? "Accel" : ""}
    </button>
  );
}
