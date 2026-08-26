"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MessageSquarePlus, CalendarClock } from "lucide-react";

/**
 * Local wall-clock value for <input type="datetime-local">.
 *
 * `toISOString()` cannot be used here: it converts to UTC, so a rep in Toronto
 * picking 2:00 p.m. would be shown 6:00 p.m. The input speaks local time with
 * no zone, which is also why the reverse (`new Date(value)`) is correct on the
 * way out: JS parses a zone-less datetime-local string AS local time, giving
 * the right absolute instant.
 */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Presets are what a rep actually says on a call, not arbitrary offsets. */
function preset(kind: "tomorrow" | "twoDays" | "nextWeek"): string {
  const d = new Date();
  if (kind === "tomorrow") d.setDate(d.getDate() + 1);
  if (kind === "twoDays") d.setDate(d.getDate() + 2);
  if (kind === "nextWeek") d.setDate(d.getDate() + 7);
  d.setHours(9, 0, 0, 0);
  return toLocalInputValue(d);
}

export function LeadNoteComposer({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [refreshPending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [calendarNote, setCalendarNote] = useState<string | null>(null);

  async function save() {
    const value = note.trim();
    if (!value) return;

    // Only send `followUpAt` when the rep actually scheduled something. Sending
    // null on every plain note would silently cancel a callback they promised
    // on an earlier call: the route reads an absent key as "leave it alone".
    let followUpAt: string | undefined;
    if (scheduling) {
      if (!followUp) {
        setMessage("Pick a date and time for the follow-up, or turn scheduling off.");
        return;
      }
      const when = new Date(followUp);
      if (!Number.isFinite(when.getTime())) {
        setMessage("That follow-up time is not a valid date.");
        return;
      }
      if (when.getTime() <= Date.now()) {
        setMessage("Pick a follow-up time in the future.");
        return;
      }
      followUpAt = when.toISOString();
    }

    setSaving(true);
    setMessage(null);
    setCalendarNote(null);
    try {
      const response = await fetch(`/api/leads/${leadId}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          note: value,
          ...(followUpAt
            ? {
                followUpAt,
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              }
            : {}),
        }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
        noteSaved?: boolean;
        calendar?: { state?: string; message?: string | null };
      };
      if (!response.ok || !json.ok) {
        if (json.noteSaved) {
          setNote("");
          setMessage("Note saved, but Last Touch needs an admin check.");
          window.dispatchEvent(new CustomEvent("oasis:lead-touch", { detail: { leadId } }));
          startTransition(() => router.refresh());
          return;
        }
        throw new Error(json.message || json.error || `note_${response.status}`);
      }
      setNote("");
      setFollowUp("");
      setScheduling(false);
      setMessage(
        followUpAt
          ? "Activity note added and the follow-up is on the lead."
          : "Activity note added. Last Touch and the timeline are up to date.",
      );
      // Surfaced separately and verbatim from the server. The rep must be able
      // to tell "it is on your phone" from "it is only in the app", and the
      // server is the only thing that knows which.
      setCalendarNote(json.calendar?.message || null);
      window.dispatchEvent(new CustomEvent("oasis:lead-touch", { detail: { leadId } }));
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Note failed to save.");
    } finally {
      setSaving(false);
    }
  }

  const disabled = saving || refreshPending;
  return (
    <section className="rounded-2xl border border-bg-border bg-bg-deep/50 p-5">
      <div className="flex items-center gap-2">
        <MessageSquarePlus className="h-4 w-4 text-accent" aria-hidden />
        <h2 className="text-sm font-semibold text-fg">Add activity note</h2>
      </div>
      <p className="mt-1 text-xs text-fg-muted">
        A note is a tracked touch. It appears chronologically and refreshes Last Touch.
      </p>
      <textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={4}
        maxLength={4000}
        placeholder='What happened, what was promised, and what happens next? Example: "Gatekeeper blocks before 10am, ask for Dana."'
        className="mt-3 w-full rounded-lg border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-accent/70 focus:ring-1 focus:ring-accent/30"
      />

      <div className="mt-3 rounded-lg border border-bg-border bg-bg-elev/25 p-3">
        <label className="flex items-center gap-2 text-xs font-medium text-fg">
          <input
            type="checkbox"
            checked={scheduling}
            onChange={(event) => {
              const on = event.target.checked;
              setScheduling(on);
              if (on && !followUp) setFollowUp(preset("tomorrow"));
            }}
            className="h-3.5 w-3.5 accent-[var(--accent,#6366f1)]"
          />
          <CalendarClock className="h-3.5 w-3.5 text-accent" aria-hidden />
          Schedule a follow-up
        </label>
        {scheduling && (
          <div className="mt-3 space-y-2">
            <input
              type="datetime-local"
              value={followUp}
              min={toLocalInputValue(new Date())}
              onChange={(event) => setFollowUp(event.target.value)}
              className="w-full rounded-lg border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg outline-none focus:border-accent/70 focus:ring-1 focus:ring-accent/30"
            />
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["Tomorrow 9am", "tomorrow"],
                  ["In 2 days", "twoDays"],
                  ["Next week", "nextWeek"],
                ] as const
              ).map(([label, kind]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setFollowUp(preset(kind))}
                  className="btn-secondary !px-2.5 !py-1 text-[10px]"
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-fg-dim">
              Saved on the lead either way. If your Google Calendar is connected, it also lands on
              your phone with a 10 minute warning. The reminder is private to you.
            </p>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[10px] text-fg-dim">{note.length}/4000</span>
        <button
          type="button"
          disabled={disabled || !note.trim()}
          onClick={save}
          className="btn-primary !px-4 !py-2 text-xs"
        >
          {saving ? "Adding…" : scheduling ? "Add note and schedule" : "Add note and touch"}
        </button>
      </div>
      {message && (
        <div role="status" className="mt-3 rounded-lg border border-bg-border bg-bg-elev/35 px-3 py-2 text-xs text-fg-muted">
          {message}
        </div>
      )}
      {calendarNote && (
        <div
          role="status"
          className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
        >
          {calendarNote}
        </div>
      )}
    </section>
  );
}
