"use client";

/**
 * CallSchedulerModal — the "Request a call" / "Schedule a call" flow (plan
 * Phase 3 UI). Opened from the AISuggestionRail's request-call chip (contact
 * prefilled + locked from the conversation) and from the Calls board's
 * "Schedule a call" button (contact editable, no lead attached). Books an
 * in-house call (POST /api/conversations/schedule-call → a pending row in
 * scheduled_calls), then offers a Google Calendar deep-link so the booking
 * also drops into the rep's calendar. The in-house record is the source of
 * truth; Calendar is a convenience mirror until 2-way sync lands.
 *
 * This never dials anyone. It only records the intent + reminds the rep (via
 * the dispatch cron) when the time comes.
 */
import { useMemo, useState } from "react";
import { X, CalendarPlus, Check, Loader2 } from "lucide-react";

/** `datetime-local` string ("YYYY-MM-DDTHH:mm", local time) for a Date. */
function localInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function inOneHour(): Date {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  return d;
}
function tomorrowAt(hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** Google Calendar event-create deep-link with the chosen 30-min window. */
function calendarUrl(args: {
  start: Date;
  contactLabel: string;
  company?: string;
  phone?: string | null;
  notes?: string;
  operatorEmail?: string | null;
}): string {
  const { start, contactLabel, company, phone, notes, operatorEmail } = args;
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const title = `Call ${contactLabel || "lead"}${company ? ` (${company})` : ""}`;
  const details = [phone ? `Phone: ${phone}` : null, notes ? notes : null].filter(Boolean).join("\n");
  const params = new URLSearchParams({ text: title, dates: `${stamp(start)}/${stamp(end)}` });
  if (details) params.set("details", details);
  if (operatorEmail) params.set("authuser", operatorEmail);
  return `https://calendar.google.com/calendar/r/eventedit?${params.toString()}`;
}

type Booked = { id: string; start: Date };

export function CallSchedulerModal({
  leadId = null,
  threadKey = null,
  defaultLabel = "",
  defaultPhone = null,
  company,
  editableContact = false,
  operatorEmail,
  onClose,
  onBooked,
}: {
  leadId?: string | null;
  threadKey?: string | null;
  defaultLabel?: string;
  defaultPhone?: string | null;
  company?: string;
  /** Board mode: show editable name/phone inputs (no lead attached). */
  editableContact?: boolean;
  operatorEmail?: string | null;
  onClose: () => void;
  onBooked?: () => void;
}) {
  const defaultVal = useMemo(() => localInputValue(inOneHour()), []);
  const [when, setWhen] = useState(defaultVal);
  const [label, setLabel] = useState(defaultLabel);
  const [phone, setPhone] = useState(defaultPhone ?? "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<Booked | null>(null);

  const setPreset = (d: Date) => setWhen(localInputValue(d));

  async function book() {
    setError(null);
    const start = new Date(when);
    if (Number.isNaN(start.getTime())) {
      setError("Pick a valid date and time.");
      return;
    }
    if (start.getTime() < Date.now() + 15_000) {
      setError("Pick a time in the future.");
      return;
    }
    if (editableContact && !label.trim() && !phone.trim()) {
      setError("Add a name or phone number for the call.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/conversations/schedule-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          lead_id: leadId,
          thread_key: threadKey,
          to_phone: phone.trim() || undefined,
          contact_label: label.trim() || undefined,
          scheduled_for: start.toISOString(),
          notes: notes.trim() || undefined,
        }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        setError(j?.message || "Couldn't book the call. Try again.");
        setBusy(false);
        return;
      }
      setBooked({ id: j.id, start });
      onBooked?.();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60 cursor-default" />
      <div className="relative w-full max-w-sm rounded-xl border border-bg-border bg-bg-panel shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-bg-border">
          <span className="text-[13px] font-bold text-fg">{editableContact ? "Schedule a call" : "Request a call"}</span>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-md text-fg-dim hover:text-fg hover:bg-bg-elev">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-3.5 space-y-3.5">
          {!editableContact ? (
            <div className="text-[12px] text-fg-muted">
              {label || "Lead"}
              {phone ? <span className="text-fg-dim"> · {phone}</span> : null}
            </div>
          ) : null}

          {booked ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-[12px] text-emerald-200">
                <Check className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  Call booked for{" "}
                  <strong>
                    {booked.start.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </strong>
                  . You&apos;ll get a reminder when it&apos;s due.
                </span>
              </div>
              <a
                href={calendarUrl({ start: booked.start, contactLabel: label, company, phone, notes: notes.trim() || undefined, operatorEmail })}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-1.5 w-full rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-[12px] font-semibold text-violet-200 hover:bg-violet-500/20"
              >
                <CalendarPlus className="h-3.5 w-3.5" />
                Add to Google Calendar
              </a>
              <button
                type="button"
                onClick={onClose}
                className="w-full rounded-lg border border-bg-border px-3 py-2 text-[12px] font-semibold text-fg-muted hover:bg-bg-elev"
              >
                Done
              </button>
            </div>
          ) : (
            <>
              {editableContact ? (
                <div className="flex gap-2">
                  <label className="block flex-1">
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-fg-dim">Name</span>
                    <input
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="Contact name"
                      className="mt-1 w-full rounded-lg border border-bg-border bg-bg-elev/40 px-2.5 py-2 text-[12px] text-fg placeholder:text-fg-dim focus:border-violet-500/50 focus:outline-none"
                    />
                  </label>
                  <label className="block flex-1">
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-fg-dim">Phone</span>
                    <input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="(555) 555-5555"
                      className="mt-1 w-full rounded-lg border border-bg-border bg-bg-elev/40 px-2.5 py-2 text-[12px] text-fg placeholder:text-fg-dim focus:border-violet-500/50 focus:outline-none"
                    />
                  </label>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-1.5">
                <PresetButton label="In 1 hour" onClick={() => setPreset(inOneHour())} />
                <PresetButton label="Tomorrow 10am" onClick={() => setPreset(tomorrowAt(10))} />
                <PresetButton label="Tomorrow 2pm" onClick={() => setPreset(tomorrowAt(14))} />
              </div>

              <label className="block">
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-fg-dim">When</span>
                <input
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-bg-border bg-bg-elev/40 px-2.5 py-2 text-[12px] text-fg focus:border-violet-500/50 focus:outline-none"
                />
              </label>

              <label className="block">
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-fg-dim">Notes (optional)</span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="What's this call about?"
                  className="mt-1 w-full resize-none rounded-lg border border-bg-border bg-bg-elev/40 px-2.5 py-2 text-[12px] text-fg placeholder:text-fg-dim focus:border-violet-500/50 focus:outline-none"
                />
              </label>

              {error ? <div className="text-[11.5px] text-red-300">{error}</div> : null}

              <div className="flex gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 rounded-lg border border-bg-border px-3 py-2 text-[12px] font-semibold text-fg-muted hover:bg-bg-elev"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void book()}
                  disabled={busy}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarPlus className="h-3.5 w-3.5" />}
                  Book call
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PresetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-bg-border bg-bg-elev/40 px-2 py-1 text-[10.5px] font-semibold text-fg-muted hover:border-violet-500/40 hover:text-violet-200"
    >
      {label}
    </button>
  );
}
