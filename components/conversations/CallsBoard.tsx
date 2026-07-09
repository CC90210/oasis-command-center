"use client";

/**
 * CallsBoard — the Calls tab (plan Phase 4). A tracking + scheduling surface
 * over scheduled_calls (database/115_scheduled_calls.sql):
 *   - Upcoming: pending bookings, soonest first; ones already due are flagged.
 *   - History: recently done / missed / cancelled calls.
 * The rep can mark a call done or missed, cancel a pending one, click the phone
 * to dial (tel:), add it to Google Calendar, and book a new call from scratch
 * (the scheduler in editable-contact mode — no lead needed).
 *
 * All reads/writes are tenant-scoped server-side (the API resolves the session
 * tenant); this component never sees another tenant's calls. Nothing here dials
 * a merchant automatically — booking only records intent + reminds the rep.
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarPlus, Phone, Check, XCircle, Ban, RefreshCw, CalendarClock } from "lucide-react";
import { CallSchedulerModal } from "./CallSchedulerModal";

type CallRow = {
  id: string;
  lead_id: string | null;
  thread_key: string | null;
  to_phone: string | null;
  contact_label: string | null;
  actor_user_id: string | null;
  scheduled_for: string;
  notes: string | null;
  status: "pending" | "done" | "cancelled" | "missed";
  reminded_at: string | null;
  created_at: string;
};

type ListState = { upcoming: CallRow[]; recent: CallRow[]; loading: boolean; error: string | null };
const IDLE: ListState = { upcoming: [], recent: [], loading: true, error: null };

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function calendarUrl(row: CallRow): string {
  const start = new Date(row.scheduled_for);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const title = `Call ${row.contact_label || "lead"}`;
  const details = [row.to_phone ? `Phone: ${row.to_phone}` : null, row.notes || null].filter(Boolean).join("\n");
  const params = new URLSearchParams({ text: title, dates: `${stamp(start)}/${stamp(end)}` });
  if (details) params.set("details", details);
  return `https://calendar.google.com/calendar/r/eventedit?${params.toString()}`;
}

export function CallsBoard() {
  const [state, setState] = useState<ListState>(IDLE);
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const r = await fetch("/api/conversations/scheduled-calls", { credentials: "include", cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        setState({ upcoming: [], recent: [], loading: false, error: "Couldn't load calls." });
        return;
      }
      setState({ upcoming: j.upcoming ?? [], recent: j.recent ?? [], loading: false, error: null });
    } catch {
      setState({ upcoming: [], recent: [], loading: false, error: "Network error." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = useCallback(
    async (id: string, action: "done" | "missed" | "cancel") => {
      setBusyId(id);
      setActionError(null);
      try {
        const r =
          action === "cancel"
            ? await fetch(`/api/conversations/schedule-call?id=${id}`, { method: "DELETE", credentials: "include" })
            : await fetch(`/api/conversations/scheduled-calls?id=${id}&status=${action}`, { method: "POST", credentials: "include" });
        const j = await r.json().catch(() => null);
        await load();
        if (!r.ok || !j?.ok) {
          setActionError(
            action === "cancel"
              ? "Couldn't cancel that call. It may already be resolved. The list has been refreshed."
              : "Couldn't update that call. The list has been refreshed.",
          );
        }
      } catch {
        setActionError("Network error. Please try again.");
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const nowMs = Date.now();

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setSchedulerOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-violet-500"
        >
          <CalendarPlus className="h-3.5 w-3.5" />
          Schedule a call
        </button>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-bg-border px-2.5 py-2 text-[11.5px] font-semibold text-fg-muted hover:bg-bg-elev"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${state.loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {state.error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-3 text-[12px] text-red-200">{state.error}</div>
      ) : null}
      {actionError ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-3 text-[12px] text-amber-200">{actionError}</div>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">Upcoming</h2>
        {!state.loading && state.upcoming.length === 0 ? (
          <p className="text-[12px] text-fg-dim italic">No calls scheduled. Book one from a conversation or with the button above.</p>
        ) : (
          <div className="space-y-2">
            {state.upcoming.map((row) => {
              const due = new Date(row.scheduled_for).getTime() <= nowMs;
              return (
                <div
                  key={row.id}
                  className={`rounded-lg border px-3.5 py-3 ${due ? "border-amber-500/40 bg-amber-500/[0.07]" : "border-bg-border bg-bg-elev/20"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold text-fg truncate">{row.contact_label || "Lead"}</span>
                        {due ? (
                          <span className="shrink-0 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-amber-200">
                            Due now
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-fg-muted">
                        <CalendarClock className="h-3 w-3 shrink-0" />
                        {fmtWhen(row.scheduled_for)}
                      </div>
                      {row.to_phone ? (
                        <a href={`tel:${row.to_phone}`} className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] text-violet-300 hover:underline">
                          <Phone className="h-3 w-3" />
                          {row.to_phone}
                        </a>
                      ) : null}
                      {row.notes ? <p className="mt-1 text-[11.5px] text-fg-dim">{row.notes}</p> : null}
                    </div>
                    <a
                      href={calendarUrl(row)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 rounded-md border border-violet-500/30 bg-violet-500/10 p-1.5 text-violet-300 hover:bg-violet-500/20"
                      title="Add to Google Calendar"
                    >
                      <CalendarPlus className="h-3.5 w-3.5" />
                    </a>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    <RowAction icon={Check} label="Mark done" tone="ok" disabled={busyId === row.id} onClick={() => void resolve(row.id, "done")} />
                    <RowAction icon={XCircle} label="Missed" tone="warn" disabled={busyId === row.id} onClick={() => void resolve(row.id, "missed")} />
                    <RowAction icon={Ban} label="Cancel" tone="muted" disabled={busyId === row.id} onClick={() => void resolve(row.id, "cancel")} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {state.recent.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">History</h2>
          <div className="rounded-lg border border-bg-border divide-y divide-bg-border">
            {state.recent.map((row) => (
              <div key={row.id} className="flex items-center justify-between gap-3 px-3.5 py-2">
                <div className="min-w-0">
                  <span className="text-[12px] text-fg truncate">{row.contact_label || "Lead"}</span>
                  <span className="ml-2 text-[11px] text-fg-dim">{fmtWhen(row.scheduled_for)}</span>
                </div>
                <StatusBadge status={row.status} />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {schedulerOpen ? (
        <CallSchedulerModal
          editableContact
          onClose={() => setSchedulerOpen(false)}
          onBooked={() => void load()}
        />
      ) : null}
    </div>
  );
}

function RowAction({
  icon: Icon,
  label,
  tone,
  disabled,
  onClick,
}: {
  icon: typeof Check;
  label: string;
  tone: "ok" | "warn" | "muted";
  disabled?: boolean;
  onClick: () => void;
}) {
  const toneCls =
    tone === "ok"
      ? "border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/15"
      : tone === "warn"
        ? "border-amber-500/30 text-amber-300 hover:bg-amber-500/15"
        : "border-bg-border text-fg-muted hover:bg-bg-elev";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10.5px] font-semibold disabled:opacity-40 ${toneCls}`}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}

function StatusBadge({ status }: { status: CallRow["status"] }) {
  const map = {
    done: "bg-emerald-500/15 text-emerald-300",
    missed: "bg-amber-500/15 text-amber-300",
    cancelled: "bg-bg-elev text-fg-dim",
    pending: "bg-violet-500/15 text-violet-300",
  };
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wider ${map[status]}`}>{status}</span>
  );
}
