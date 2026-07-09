"use client";

/**
 * CallsBoard — the Calls tab (built to the scheduling-UI research spec, 2026-07).
 * A tracking + dispatch surface over scheduled_calls (database/115):
 *   - Upcoming: pending bookings, time-bucketed (Due now -> Next up -> Later
 *     today -> Tomorrow -> This week -> Later), with exactly one live "Due now"
 *     hero row whose countdown recolors as it slips past due.
 *   - History: recently done / missed / cancelled, behind its own segment.
 * The monospace phone is the row's hero affordance (tap-to-dial + click-to-copy).
 * Mark done / missed / cancel are optimistic with a 5s Undo, and fail closed:
 * the server write is deferred to the end of the undo window, and a rejection
 * puts the row back and shows an error. Booking a new call opens the scheduler.
 *
 * All reads/writes are tenant-scoped server-side; this never dials a merchant.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarPlus, Phone, Check, XCircle, Ban, RefreshCw } from "lucide-react";
import { CallSchedulerModal } from "./CallSchedulerModal";
import { tzFromPhone } from "@/lib/phone-timezone";

const OP_TZ =
  typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "America/New_York";
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY_MS = 86_400_000;

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

const BUCKET_ORDER = ["Due now", "Next up", "Later today", "Tomorrow", "This week", "Later"] as const;
type Bucket = (typeof BUCKET_ORDER)[number];

function fmtTime(iso: string | number, tz = OP_TZ): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
}
function tzAbbr(iso: string | number, tz = OP_TZ): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZoneName: "short", timeZone: tz })
    .formatToParts(new Date(iso))
    .find((x) => x.type === "timeZoneName");
  return p ? p.value : "";
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function bucketOf(atMs: number): Bucket {
  const now = Date.now();
  if (atMs <= now + 2 * MIN) return "Due now";
  if (atMs <= now + 60 * MIN) return "Next up";
  const d = new Date(atMs);
  if (sameDay(d, new Date(now))) return "Later today";
  if (sameDay(d, new Date(now + DAY_MS))) return "Tomorrow";
  if (atMs <= now + 7 * DAY_MS) return "This week";
  return "Later";
}
function relLabel(atMs: number): { t: string; cls: string } {
  const diff = atMs - Date.now();
  const mins = Math.round(Math.abs(diff) / MIN);
  if (diff < 0) {
    if (mins < 60) return { t: `${mins} min overdue`, cls: "text-red-400 font-semibold" };
    return { t: `${Math.round(mins / 60)}h overdue`, cls: "text-red-400 font-semibold" };
  }
  if (mins < 1) return { t: "now", cls: "text-amber-300" };
  if (mins < 60) return { t: `in ${mins} min`, cls: mins <= 15 ? "text-amber-300" : "text-fg-muted" };
  const h = Math.floor(mins / 60);
  if (h < 24) return { t: `in ${h}h${mins % 60 ? ` ${mins % 60}m` : ""}`, cls: "text-fg-muted" };
  const days = Math.round(h / 24);
  return { t: `in ${days} day${days > 1 ? "s" : ""}`, cls: "text-fg-muted" };
}
function fmtHist(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const day = sameDay(d, now)
    ? "Today"
    : sameDay(d, new Date(Date.now() - DAY_MS))
      ? "Yesterday"
      : new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(d);
  return `${day} · ${fmtTime(iso)}`;
}
function prettyPhone(e164: string | null): string {
  if (!e164) return "";
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164;
}
function calendarUrl(c: CallRow): string {
  const start = new Date(c.scheduled_for);
  const end = new Date(start.getTime() + 30 * MIN);
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const details = [c.to_phone ? `Phone: ${c.to_phone}` : null, c.notes || null].filter(Boolean).join("\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `Call ${c.contact_label || "lead"}`,
    dates: `${stamp(start)}/${stamp(end)}`,
    ctz: OP_TZ,
  });
  if (details) params.set("details", details);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

type Toast = { id: number; msg: string; onUndo?: () => void };

export function CallsBoard() {
  const [state, setState] = useState<ListState>(IDLE);
  const [seg, setSeg] = useState<"up" | "hist">("up");
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  const [, setTick] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const toastId = useRef(0);

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

  // One list-level timer recomputes relative labels + buckets (no per-row timers).
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(iv);
  }, []);

  const pushToast = useCallback((msg: string, onUndo?: () => void) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts, { id, msg, onUndo }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 5000);
  }, []);

  // Optimistic resolve: move the row out of Upcoming immediately, defer the
  // server write to the end of the 5s undo window, and revert on rejection.
  const resolve = useCallback(
    (row: CallRow, action: "done" | "missed" | "cancelled") => {
      // optimistic local update
      setState((s) => ({
        ...s,
        upcoming: s.upcoming.filter((c) => c.id !== row.id),
        recent: [{ ...row, status: action }, ...s.recent],
      }));

      const revert = () => {
        const t = timers.current.get(row.id);
        if (t) clearTimeout(t);
        timers.current.delete(row.id);
        setState((s) => ({
          ...s,
          upcoming: [...s.upcoming, row].sort((a, b) => +new Date(a.scheduled_for) - +new Date(b.scheduled_for)),
          recent: s.recent.filter((c) => c.id !== row.id),
        }));
      };

      const commit = async () => {
        timers.current.delete(row.id);
        try {
          const r =
            action === "cancelled"
              ? await fetch(`/api/conversations/schedule-call?id=${row.id}`, { method: "DELETE", credentials: "include" })
              : await fetch(`/api/conversations/scheduled-calls?id=${row.id}&status=${action}`, {
                  method: "POST",
                  credentials: "include",
                });
          const j = await r.json().catch(() => null);
          if (!r.ok || !j?.ok) {
            revert();
            pushToast("Couldn't update that call. It may already be resolved.");
          }
        } catch {
          revert();
          pushToast("Network error updating that call.");
        }
      };

      const timer = setTimeout(commit, 5000);
      timers.current.set(row.id, timer);
      const verb = action === "cancelled" ? "cancelled" : action === "done" ? "marked done" : "marked missed";
      pushToast(`Call ${verb}`, revert);
    },
    [pushToast],
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => clearTimeout(t));
  }, []);

  const pending = useMemo(
    () => state.upcoming.slice().sort((a, b) => +new Date(a.scheduled_for) - +new Date(b.scheduled_for)),
    [state.upcoming],
  );
  const groups = useMemo(() => {
    const g: Record<string, CallRow[]> = {};
    pending.forEach((c) => {
      const b = bucketOf(+new Date(c.scheduled_for));
      (g[b] = g[b] || []).push(c);
    });
    return g;
  }, [pending]);
  const heroId = pending.length ? pending[0].id : null;

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {/* top bar */}
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex gap-0.5 rounded-lg border border-bg-border bg-bg-elev/40 p-0.5">
          <button
            type="button"
            aria-pressed={seg === "up"}
            onClick={() => setSeg("up")}
            className={`rounded-md px-3 py-1.5 text-[12px] font-semibold ${seg === "up" ? "bg-bg-elev text-fg" : "text-fg-dim"}`}
          >
            Upcoming <span className="ml-1 text-[11px] text-fg-dim tabular-nums">{pending.length}</span>
          </button>
          <button
            type="button"
            aria-pressed={seg === "hist"}
            onClick={() => setSeg("hist")}
            className={`rounded-md px-3 py-1.5 text-[12px] font-semibold ${seg === "hist" ? "bg-bg-elev text-fg" : "text-fg-dim"}`}
          >
            History <span className="ml-1 text-[11px] text-fg-dim tabular-nums">{state.recent.length}</span>
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-bg-border px-2.5 py-2 text-[11.5px] font-semibold text-fg-muted hover:bg-bg-elev"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${state.loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setSchedulerOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-violet-500"
          >
            <CalendarPlus className="h-3.5 w-3.5" />
            Schedule
          </button>
        </div>
      </div>

      {state.error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-3 text-[12px] text-red-200">{state.error}</div>
      ) : null}

      {/* upcoming */}
      {seg === "up" ? (
        pending.length === 0 && !state.loading ? (
          <div className="rounded-xl border border-bg-border py-10 text-center">
            <div className="text-[13px] text-fg-muted">No calls scheduled.</div>
            <button
              type="button"
              onClick={() => setSchedulerOpen(true)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-violet-500"
            >
              <CalendarPlus className="h-3.5 w-3.5" /> Book a call
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {BUCKET_ORDER.map((bk) => {
              const g = groups[bk];
              if (!g || !g.length) return null;
              return (
                <div key={bk}>
                  <div
                    className={`sticky top-14 z-[5] flex items-center gap-2 py-1.5 text-[10.5px] font-bold uppercase tracking-wider backdrop-blur ${
                      bk === "Due now" ? "text-amber-400" : "text-fg-dim"
                    }`}
                  >
                    {bk}
                    <span className="rounded-full bg-bg-elev px-1.5 py-0.5 text-[10px] text-fg-muted tabular-nums">{g.length}</span>
                  </div>
                  <div>
                    {g.map((c) => (
                      <CallRowView key={c.id} row={c} hero={c.id === heroId} onResolve={resolve} onCopy={pushToast} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : null}

      {/* history */}
      {seg === "hist" ? (
        state.recent.length === 0 ? (
          <div className="rounded-xl border border-bg-border py-10 text-center text-[13px] text-fg-muted">No resolved calls yet.</div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-bg-border">
            {state.recent.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 border-b border-bg-border px-3.5 py-2.5 opacity-80 last:border-b-0">
                <div className="min-w-0">
                  <span className="text-[12.5px] text-fg">{c.contact_label || "Lead"}</span>
                  <span className="ml-2 font-mono text-[11px] text-fg-dim">{fmtHist(c.scheduled_for)}</span>
                </div>
                <StatusPill status={c.status} />
              </div>
            ))}
          </div>
        )
      ) : null}

      {/* toasts */}
      <div className="fixed right-4 top-20 z-[60] flex flex-col items-end gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="flex items-center gap-3 rounded-xl border border-bg-border bg-bg-elev px-3.5 py-2.5 text-[12.5px] font-semibold text-fg shadow-2xl"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
            {t.msg}
            {t.onUndo ? (
              <button
                type="button"
                onClick={() => {
                  t.onUndo?.();
                  setToasts((ts) => ts.filter((x) => x.id !== t.id));
                }}
                className="font-bold text-violet-300"
              >
                Undo
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {schedulerOpen ? (
        <CallSchedulerModal editableContact onClose={() => setSchedulerOpen(false)} onBooked={() => void load()} />
      ) : null}
    </div>
  );
}

function CallRowView({
  row,
  hero,
  onResolve,
  onCopy,
}: {
  row: CallRow;
  hero: boolean;
  onResolve: (row: CallRow, action: "done" | "missed" | "cancelled") => void;
  onCopy: (msg: string) => void;
}) {
  const atMs = +new Date(row.scheduled_for);
  const due = atMs <= Date.now() + 2 * MIN;
  const rel = relLabel(atMs);
  const mtz = tzFromPhone(row.to_phone);
  const showDual = !!mtz && mtz !== OP_TZ;

  const copyPhone = () => {
    if (row.to_phone) {
      try {
        void navigator.clipboard?.writeText(prettyPhone(row.to_phone));
      } catch {
        /* clipboard unavailable */
      }
      onCopy(`Copied ${prettyPhone(row.to_phone)}`);
    }
  };

  return (
    <div
      tabIndex={0}
      className={`group relative flex items-start gap-3 rounded-lg border-b border-bg-border py-3 pl-4 pr-3 hover:bg-bg-elev/40 ${
        due ? "bg-violet-500/[0.06]" : ""
      }`}
    >
      <span
        className={`absolute inset-y-3 left-1 w-0.5 rounded-full ${due ? "bg-amber-400" : "bg-violet-500"} ${
          hero && due ? "motion-safe:animate-pulse" : ""
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-fg">{row.contact_label || "Lead"}</span>
        </div>
        <div className="mt-0.5 flex items-baseline gap-2">
          <span className={`text-[12.5px] ${rel.cls}`}>{rel.t}</span>
          <span className="font-mono text-[11px] text-fg-dim tabular-nums">
            {fmtTime(row.scheduled_for)} {tzAbbr(row.scheduled_for)}
          </span>
          {showDual && mtz ? (
            <span className="font-mono text-[11px] text-fg-dim tabular-nums">
              · {fmtTime(row.scheduled_for, mtz)} {tzAbbr(row.scheduled_for, mtz)} merchant
            </span>
          ) : null}
        </div>
        {row.to_phone ? (
          <a
            href={`tel:${row.to_phone}`}
            onClick={(e) => {
              e.preventDefault();
              copyPhone();
            }}
            className="mt-1.5 -ml-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12.5px] text-violet-300 hover:bg-violet-500/10"
          >
            <Phone className="h-3 w-3" />
            <span className="font-mono tabular-nums">{prettyPhone(row.to_phone)}</span>
            <span className="text-[11px] text-fg-dim opacity-0 transition-opacity group-hover:opacity-100">Call · click to copy</span>
          </a>
        ) : null}
        {row.notes ? <div className="mt-1.5 text-[11.5px] text-fg-dim">{row.notes}</div> : null}
      </div>

      <div className="flex w-[132px] shrink-0 items-center justify-end gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          title="Mark done"
          onClick={() => onResolve(row, "done")}
          className="inline-flex items-center gap-1 rounded-md border border-bg-border px-2 py-1 text-[10.5px] font-semibold text-fg-muted hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-300"
        >
          <Check className="h-3 w-3" /> Done
        </button>
        <button
          type="button"
          title="Missed"
          onClick={() => onResolve(row, "missed")}
          className="rounded-md border border-bg-border p-1 text-fg-muted hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-300"
        >
          <XCircle className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Cancel"
          onClick={() => onResolve(row, "cancelled")}
          className="rounded-md border border-bg-border p-1 text-fg-dim hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300"
        >
          <Ban className="h-3.5 w-3.5" />
        </button>
        <a
          href={calendarUrl(row)}
          target="_blank"
          rel="noopener noreferrer"
          title="Add to Google Calendar"
          className="grid h-7 w-7 place-items-center rounded-md border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20"
        >
          <CalendarPlus className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: CallRow["status"] }) {
  const map: Record<string, { cls: string; label: string; icon: ReactNode }> = {
    done: { cls: "bg-emerald-500/15 text-emerald-300", label: "Done", icon: <Check className="h-3 w-3" /> },
    missed: { cls: "bg-red-500/15 text-red-300", label: "Missed", icon: <XCircle className="h-3 w-3" /> },
    cancelled: { cls: "bg-slate-500/15 text-slate-300 line-through", label: "Cancelled", icon: <Ban className="h-3 w-3" /> },
    pending: { cls: "bg-violet-500/15 text-violet-300", label: "Pending", icon: null },
  };
  const s = map[status] || map.pending;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ${s.cls}`}>
      {s.icon}
      {s.label}
    </span>
  );
}
