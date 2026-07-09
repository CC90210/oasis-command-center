"use client";

/**
 * ScheduleCallControl — "Schedule call" footer action on the lead drawer.
 * Opens a small dialog (datetime-local + optional pre-call note), POSTs
 * /api/call-appointments, and confirms. The appointment then shows up on
 * the Calls tab's call sheet (components/calls/CallsClient.tsx), which pulls
 * this same lead's notes + MCA summary when the rep opens it for the call.
 *
 * Kept deliberately simpler than CallSchedulerModal (Conversations' call-
 * reminder scheduler, components/conversations/CallSchedulerModal.tsx) — a
 * plain datetime-local input rather than a slot-picker/timezone-dual-display,
 * per spec. The datetime-local value has no offset, so `new Date(value)` is
 * parsed in the browser's local timezone (matches what the rep typed) and
 * `.toISOString()` converts to UTC for storage — no explicit tz picker needed
 * for a single-operator-timezone dashboard.
 */

import { useState } from "react";
import { CalendarPlus, X, Loader2, Check } from "lucide-react";

function defaultLocalDateTime(): string {
  // Next :00/:30 strictly after now, formatted for <input type="datetime-local">
  // (local time, no offset) — mirrors CallSchedulerModal's smartDefault().
  const d = new Date();
  d.setSeconds(0, 0);
  if (d.getMinutes() < 30) d.setMinutes(30);
  else {
    d.setMinutes(0);
    d.setHours(d.getHours() + 1);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleCallControl({
  leadId,
  entity,
  label,
}: {
  leadId: string;
  entity: "lead" | "application";
  label?: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex-1 min-w-[120px] inline-flex items-center justify-center gap-1.5 text-[12px] font-semibold px-3 py-2 rounded-md bg-bg-elev border border-bg-border text-fg hover:bg-bg-elev/80"
      >
        <CalendarPlus className="w-3 h-3" />
        Schedule call
      </button>
      {open ? (
        <ScheduleCallDialog leadId={leadId} entity={entity} label={label} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function ScheduleCallDialog({
  leadId,
  entity,
  label,
  onClose,
}: {
  leadId: string;
  entity: "lead" | "application";
  label?: string | null;
  onClose: () => void;
}) {
  const [when, setWhen] = useState(defaultLocalDateTime);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    if (!when) {
      setError("Pick a date and time.");
      return;
    }
    const d = new Date(when);
    if (Number.isNaN(d.getTime())) {
      setError("Pick a valid date and time.");
      return;
    }
    if (d.getTime() < Date.now() - 5 * 60_000) {
      setError("Pick a time in the future.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/call-appointments", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId,
          entity,
          scheduledFor: d.toISOString(),
          preCallNote: note.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.message || j.error || "Couldn't schedule the call.");
        return;
      }
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Schedule a call"
        className="relative w-full max-w-sm rounded-2xl border border-bg-border bg-bg-panel shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
          <span className="text-[14px] font-bold text-fg">Schedule a call{label ? ` · ${label}` : ""}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-fg-dim hover:bg-bg-elev hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {done ? (
          <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
            <div className="grid h-12 w-12 place-items-center rounded-full bg-emerald-500/15">
              <Check className="h-6 w-6 text-emerald-400" />
            </div>
            <div className="text-[13px] text-fg">Call scheduled — find it on the Calls tab.</div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-bg-border px-3 py-2 text-[12.5px] font-semibold text-fg-muted hover:bg-bg-elev"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="space-y-3 px-4 py-3.5">
            <div>
              <label className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-fg-dim">
                Date &amp; time
              </label>
              <input
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                className="w-full rounded-lg border border-bg-border bg-bg-deep px-2.5 py-1.5 text-[12.5px] text-fg"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-fg-dim">
                Pre-call note (optional)
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={4000}
                placeholder="What's this call about?"
                className="w-full resize-none rounded-lg border border-bg-border bg-bg-deep px-2.5 py-2 text-[12.5px] text-fg"
              />
            </div>
            {error ? <div className="text-[11.5px] text-red-300">{error}</div> : null}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 py-2.5 text-[12.5px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarPlus className="h-4 w-4" />}
              Schedule call
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
