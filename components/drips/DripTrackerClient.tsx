"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, Stat } from "@/components/Card";
import { ChevronDown, ChevronUp, Eye, Maximize2, RefreshCcw, X } from "lucide-react";

type DripEvent = {
  id: string;
  merchant_id: string;
  merchant_name: string;
  sequence_id: string;
  sequence_name: string;
  drip_run_id: string;
  step_index: number;
  recipient_email: string;
  subject_line: string;
  payload_text: string;
  payload_html: string;
  provider_message_id: string | null;
  sent_at: string;
};

type Metrics = {
  total_sent_today: number;
  active_loops: number;
  visible_events: number;
};

export function DripTrackerClient({ compact = false }: { compact?: boolean }) {
  const [events, setEvents] = useState<DripEvent[]>([]);
  const [metrics, setMetrics] = useState<Metrics>({
    total_sent_today: 0,
    active_loops: 0,
    visible_events: 0,
  });
  const [selected, setSelected] = useState<DripEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<"sent_at" | "subject_line" | "recipient_email" | "step_index">(
    "sent_at",
  );
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [collapsed, setCollapsed] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/drip-tracker?sort=${sort}&order=${order}&limit=${compact ? 50 : 200}`,
        { credentials: "include", cache: "no-store" },
      );
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.error || "tracker_load_failed");
      setEvents(Array.isArray(json.events) ? json.events : []);
      setMetrics(json.metrics || {});
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "tracker_load_failed");
    } finally {
      setLoading(false);
    }
  }, [compact, order, sort]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const sortedLabel = useMemo(
    () => `${sort.replaceAll("_", " ")} ${order === "desc" ? "↓" : "↑"}`,
    [order, sort],
  );

  function changeSort(next: typeof sort) {
    if (sort === next) setOrder((value) => (value === "desc" ? "asc" : "desc"));
    else {
      setSort(next);
      setOrder("desc");
    }
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Total sent today" value={metrics.total_sent_today} accent />
        <Stat label="Active loops" value={metrics.active_loops} />
        <Stat label="Events loaded" value={metrics.visible_events} hint="Refreshes every 5 seconds" />
      </div>

      <Card
        title="Outbound sequence activity"
        subtitle={`Live exact-payload telemetry · sorted by ${sortedLabel}`}
        noPadding
        action={
          <div className="flex items-center gap-2">
            {compact && (
              <>
                <button
                  type="button"
                  onClick={() => setCollapsed((value) => !value)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-bg-border px-2.5 py-1.5 text-xs text-fg-muted hover:text-fg"
                >
                  {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
                  {collapsed ? "Show" : "Collapse"}
                </button>
                <Link
                  href="/drip-tracker"
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-semibold text-bg hover:opacity-90"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                  View all
                </Link>
              </>
            )}
            <button
              type="button"
              onClick={() => void load()}
              aria-label="Refresh drip activity"
              className="inline-flex items-center gap-1.5 rounded-md border border-bg-border px-2.5 py-1.5 text-xs text-fg-muted hover:text-fg"
            >
              <RefreshCcw className="h-3.5 w-3.5" />
              {!compact && "Refresh"}
            </button>
          </div>
        }
      >
        {!collapsed && error && <div className="border-b border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">{error}</div>}
        {!collapsed && <div className={compact ? "max-h-[246px] overflow-auto" : "overflow-x-auto"}>
          <table className="w-full text-left text-xs">
            <thead className={`border-b border-bg-border bg-bg-deep text-[10px] uppercase tracking-wider text-fg-dim ${compact ? "sticky top-0 z-10" : ""}`}>
              <tr>
                <th className="px-4 py-3"><button onClick={() => changeSort("sent_at")}>Sent</button></th>
                <th className="px-4 py-3">Merchant</th>
                <th className="px-4 py-3">Sequence</th>
                <th className="px-4 py-3"><button onClick={() => changeSort("step_index")}>Step</button></th>
                <th className="px-4 py-3"><button onClick={() => changeSort("recipient_email")}>Recipient</button></th>
                <th className="px-4 py-3"><button onClick={() => changeSort("subject_line")}>Subject</button></th>
                <th className="px-4 py-3 text-right">Payload</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bg-border">
              {events.map((event) => (
                <tr
                  key={event.id}
                  className="cursor-pointer hover:bg-accent/5"
                  onClick={() => setSelected(event)}
                >
                  <td className="whitespace-nowrap px-4 py-3 tabular-nums text-fg-muted">{new Date(event.sent_at).toLocaleString()}</td>
                  <td className="max-w-48 truncate px-4 py-3 font-medium text-fg">{event.merchant_name}</td>
                  <td className="max-w-44 truncate px-4 py-3 text-fg-muted">{event.sequence_name}</td>
                  <td className="px-4 py-3 tabular-nums">{event.step_index + 1}</td>
                  <td className="px-4 py-3 text-fg-muted">{event.recipient_email}</td>
                  <td className="max-w-72 truncate px-4 py-3">{event.subject_line}</td>
                  <td className="px-4 py-3 text-right"><Eye className="ml-auto h-4 w-4 text-accent" /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && events.length === 0 && (
            <div className="px-4 py-14 text-center text-sm text-fg-muted">No loop emails have been dispatched yet.</div>
          )}
          {loading && <div className="px-4 py-14 text-center text-sm text-fg-muted">Loading telemetry…</div>}
        </div>}
      </Card>

      {selected && (
        <div className="fixed inset-0 z-[100] flex justify-end bg-black/60" onClick={() => setSelected(null)}>
          <aside
            className="h-full w-full max-w-3xl overflow-y-auto border-l border-bg-border bg-bg-panel p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-accent">Exact dispatched payload</div>
                <h2 className="mt-2 text-xl font-bold text-fg">{selected.subject_line}</h2>
              </div>
              <button type="button" onClick={() => setSelected(null)} className="rounded-md border border-bg-border p-2 text-fg-muted hover:text-fg">
                <X className="h-4 w-4" />
              </button>
            </div>
            <dl className="mt-6 grid gap-3 rounded-lg border border-bg-border bg-bg-deep/50 p-4 text-xs sm:grid-cols-2">
              <div><dt className="text-fg-dim">Timestamp</dt><dd className="mt-1 text-fg">{new Date(selected.sent_at).toLocaleString()}</dd></div>
              <div><dt className="text-fg-dim">Recipient</dt><dd className="mt-1 text-fg">{selected.recipient_email}</dd></div>
              <div><dt className="text-fg-dim">Merchant</dt><dd className="mt-1 text-fg">{selected.merchant_name}</dd></div>
              <div><dt className="text-fg-dim">Sequence</dt><dd className="mt-1 text-fg">{selected.sequence_name} · step {selected.step_index + 1}</dd></div>
              <div className="sm:col-span-2"><dt className="text-fg-dim">Provider message ID</dt><dd className="mt-1 break-all font-mono text-fg">{selected.provider_message_id || "Not returned"}</dd></div>
            </dl>
            <section className="mt-6">
              <h3 className="text-xs font-bold uppercase tracking-wider text-fg-muted">Rendered HTML</h3>
              <div className="mt-2 overflow-hidden rounded-lg border border-bg-border bg-white">
                <iframe title="Dispatched email HTML" sandbox="" srcDoc={selected.payload_html} className="h-[420px] w-full" />
              </div>
            </section>
            <section className="mt-6">
              <h3 className="text-xs font-bold uppercase tracking-wider text-fg-muted">Plain text</h3>
              <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-bg-border bg-bg-deep p-4 text-xs leading-relaxed text-fg">{selected.payload_text}</pre>
            </section>
          </aside>
        </div>
      )}
    </>
  );
}
