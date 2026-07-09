"use client";

/**
 * CallsClient — the Calls tab. Left: the current user's scheduled calls,
 * grouped Overdue / Today / Upcoming with status chips. Right: the CALL
 * SHEET for whichever appointment is selected — the lead's notes + MCA/
 * underwriting summary, plus Call now / Add note / Log outcome / Reschedule
 * / Cancel.
 *
 * Data comes from /api/call-appointments (GET), which is already scoped to
 * the signed-in user (assigned_to = me OR created_by = me) and enriched with
 * each lead's basic info so this list renders in one round trip. Selecting a
 * row hands the appointment to CallSheet, which does its own detail/notes
 * fetches against the existing /api/leads/[id]/* routes.
 *
 * Layout pattern follows the app's list+detail conventions (2/3-pane
 * fetch-and-select, e.g. the Conversations inbox): local state owns the
 * list + selection, no routing/URL state needed since this isn't deep-linked
 * from anywhere yet.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, RefreshCw, Phone } from "lucide-react";
import { CallSheet, type AppointmentRow } from "./CallSheet";

type Bucket = "Overdue" | "Today" | "Upcoming";
const BUCKET_ORDER: Bucket[] = ["Overdue", "Today", "Upcoming"];

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function bucketOf(row: AppointmentRow): Bucket {
  const at = new Date(row.scheduled_for);
  const now = new Date();
  if (at.getTime() < now.getTime()) return "Overdue";
  if (sameDay(at, now)) return "Today";
  return "Upcoming";
}

function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
function fmtDay(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return "Today";
  if (sameDay(d, new Date(now.getTime() + 86_400_000))) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(d);
}

const STATUS_CHIP: Record<AppointmentRow["status"], { label: string; cls: string }> = {
  scheduled: { label: "Scheduled", cls: "bg-violet-500/15 text-violet-300" },
  rescheduled: { label: "Rescheduled", cls: "bg-amber-500/15 text-amber-300" },
  completed: { label: "Completed", cls: "bg-emerald-500/15 text-emerald-300" },
  no_answer: { label: "No answer", cls: "bg-orange-500/15 text-orange-300" },
  cancelled: { label: "Cancelled", cls: "bg-slate-500/15 text-slate-300 line-through" },
};

function StatusChip({ status }: { status: AppointmentRow["status"] }) {
  const s = STATUS_CHIP[status] || STATUS_CHIP.scheduled;
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${s.cls}`}>
      {s.label}
    </span>
  );
}

export function CallsClient({ tenantSlug }: { tenantSlug: string }) {
  const [appointments, setAppointments] = useState<AppointmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/call-appointments", { credentials: "include", cache: "no-store" });
      const j = await r.json();
      if (!j.ok) {
        setError(j.message || j.error || "load_failed");
        setAppointments([]);
        return;
      }
      const rows = (j.appointments || []) as AppointmentRow[];
      setAppointments(rows);
      setSelectedId((cur) => cur && rows.some((a) => a.id === cur) ? cur : rows[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network_error");
      setAppointments([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(
    () => (appointments || []).slice().sort((a, b) => +new Date(a.scheduled_for) - +new Date(b.scheduled_for)),
    [appointments],
  );
  const groups = useMemo(() => {
    const g: Record<Bucket, AppointmentRow[]> = { Overdue: [], Today: [], Upcoming: [] };
    for (const row of sorted) g[bucketOf(row)].push(row);
    return g;
  }, [sorted]);
  const selected = sorted.find((a) => a.id === selectedId) || null;

  return (
    <div className="flex h-[calc(100vh-140px)] min-h-[520px] gap-4">
      {/* list pane */}
      <div className="flex w-[340px] shrink-0 flex-col rounded-xl border border-bg-border bg-bg-panel">
        <div className="flex items-center justify-between gap-2 border-b border-bg-border px-3.5 py-3">
          <div className="text-[12.5px] font-bold text-fg">
            Your calls <span className="text-fg-dim tabular-nums">({sorted.length})</span>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            title="Refresh"
            className="rounded-md p-1.5 text-fg-muted hover:bg-bg-elev hover:text-fg"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {error ? (
          <div className="m-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11.5px] text-red-200">
            {error}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {sorted.length === 0 && !loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
              <CalendarClock className="h-6 w-6 text-fg-dim" />
              <div className="text-[12.5px] text-fg-muted">No calls scheduled.</div>
              <div className="text-[11px] text-fg-dim">
                Schedule one from a lead&apos;s detail drawer.
              </div>
            </div>
          ) : (
            BUCKET_ORDER.map((bk) => {
              const rows = groups[bk];
              if (!rows.length) return null;
              return (
                <div key={bk}>
                  <div
                    className={`sticky top-0 z-[1] bg-bg-panel/95 px-3.5 py-1.5 text-[10.5px] font-bold uppercase tracking-wider backdrop-blur ${
                      bk === "Overdue" ? "text-red-400" : "text-fg-dim"
                    }`}
                  >
                    {bk} <span className="text-fg-dim">({rows.length})</span>
                  </div>
                  {rows.map((row) => (
                    <AppointmentRowView
                      key={row.id}
                      row={row}
                      active={row.id === selectedId}
                      overdue={bk === "Overdue"}
                      onClick={() => setSelectedId(row.id)}
                    />
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* call sheet */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-bg-border bg-bg-panel">
        {selected ? (
          <CallSheet key={selected.id} appointment={selected} tenantSlug={tenantSlug} onChanged={load} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Phone className="h-6 w-6 text-fg-dim" />
            <div className="text-[13px] text-fg-muted">Select a call to open its call sheet.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function AppointmentRowView({
  row,
  active,
  overdue,
  onClick,
}: {
  row: AppointmentRow;
  active: boolean;
  overdue: boolean;
  onClick: () => void;
}) {
  const label = row.lead?.business_name || row.lead?.contact_name || "Lead";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full flex-col gap-1 border-b border-bg-border/70 px-3.5 py-2.5 text-left transition-colors ${
        active ? "bg-violet-500/10" : "hover:bg-bg-elev/40"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[13px] font-semibold text-fg">{label}</span>
        <StatusChip status={row.status} />
      </div>
      <div className="flex items-center gap-2 text-[11.5px]">
        <span className={overdue ? "font-semibold text-red-400" : "text-fg-muted"}>{fmtDay(row.scheduled_for)}</span>
        <span className="font-mono text-fg-dim tabular-nums">{fmtTime(row.scheduled_for)}</span>
      </div>
      {row.pre_call_note ? (
        <div className="truncate text-[11px] text-fg-dim">{row.pre_call_note}</div>
      ) : null}
    </button>
  );
}
