"use client";

/**
 * UnderwritingClient — SunBiz tenant / Underwriting tab.
 *
 * Added: 2026-05-25 (second SunBiz product meeting, three-tab rollout).
 *
 * What this surface does:
 *   Manual bank-statement upload → trigger underwriting agent → view results.
 *   Backend orchestrator: scripts/underwriting_orchestrator.py (built in
 *   parallel), which wraps statement_parser.py (Anthropic vision),
 *   debt_detector.py (cross-statement aggregation), and sales_angle.py
 *   (positioning blurb). Results persisted to application_underwriting table
 *   (migration 069).
 *
 * Preview-mode contract:
 *   When tenantId === null the component renders an empty 2-pane scaffold
 *   (no network requests fire). Same pattern as ShoppingOutClient lines 144-152.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/Card";
import {
  FileSearch,
  Upload,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Database,
  Loader2,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppSummary = {
  id: string;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
  monthly_revenue: number | null;
  assigned_rep: string | null;
  latest_run_status: string | null;
  readiness_score: number | null;
  risk_flags: string[];
};

type QueueGroups = {
  needs_underwriting: AppSummary[];
  in_progress: AppSummary[];
  ready_to_shop: AppSummary[];
  risk_flagged: AppSummary[];
};

type UnderwritingRun = {
  id: string;
  run_at: string;
  triggered_by: string | null;
  status: "pending" | "parsing" | "complete" | "error";
  avg_monthly_revenue: number | null;
  avg_daily_balance: number | null;
  nsf_count: number | null;
  deposit_consistency_pct: number | null;
  debt_service_monthly: number | null;
  debt_to_revenue_ratio: number | null;
  lender_count: number | null;
  risk_flags: string[];
  readiness_score: number | null;
  sales_angle: string | null;
  parser_output: unknown;
  debt_analysis: unknown;
  error_message: string | null;
};

type DocRow = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  doc_type: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUN_STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  parsing: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  complete: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  error: "bg-red-500/15 text-red-300 border-red-500/30",
};

const POLL_INTERVAL_MS = 8_000;

// ---------------------------------------------------------------------------
// Small sub-components (inlined per spec)
// ---------------------------------------------------------------------------

function RunStatusPill({ status }: { status: string }) {
  const tone =
    RUN_STATUS_TONE[status] ?? "bg-slate-500/15 text-slate-300 border-slate-500/30";
  const spinning = status === "pending" || status === "parsing";
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded border ${tone}`}
    >
      {spinning && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
      {status.replace(/_/g, " ")}
    </span>
  );
}

function MetricsGrid({ run }: { run: UnderwritingRun }) {
  const score = Math.min(100, Math.max(0, run.readiness_score ?? 0));
  const scoreColor =
    score >= 70
      ? "text-emerald-400"
      : score >= 40
        ? "text-amber-300"
        : "text-red-400";

  const fmt = (n: number | null, prefix = "", suffix = "") =>
    n == null ? "—" : `${prefix}${n.toLocaleString()}${suffix}`;
  const fmtPct = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);
  const fmtRatio = (n: number | null) => (n == null ? "—" : n.toFixed(2));

  const cells: { label: string; value: string; badge?: string }[] = [
    { label: "Avg Monthly Revenue", value: fmt(run.avg_monthly_revenue, "$") },
    { label: "Avg Daily Balance", value: fmt(run.avg_daily_balance, "$") },
    { label: "NSF Count", value: fmt(run.nsf_count) },
    { label: "Deposit Consistency", value: fmtPct(run.deposit_consistency_pct) },
    { label: "Debt Service / Mo", value: fmt(run.debt_service_monthly, "$") },
    { label: "Debt-to-Revenue", value: fmtRatio(run.debt_to_revenue_ratio) },
    {
      label: "Open MCA Positions",
      value: fmt(run.lender_count),
      badge:
        run.lender_count != null && run.lender_count > 0
          ? `${run.lender_count} detected`
          : undefined,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {cells.map((c) => (
          <div
            key={c.label}
            className="rounded-lg border border-bg-border bg-bg-deep p-3"
          >
            <div className="text-[10px] uppercase tracking-wider text-fg-muted font-semibold mb-1">
              {c.label}
            </div>
            <div className="text-[15px] font-bold text-fg tabular-nums">
              {c.value}
            </div>
            {c.badge && (
              <div className="mt-1 text-[10px] text-amber-300">{c.badge}</div>
            )}
          </div>
        ))}
        {/* Readiness Score — always last, spans full row on xs */}
        <div className="rounded-lg border border-bg-border bg-bg-deep p-3 sm:col-span-1 col-span-2">
          <div className="text-[10px] uppercase tracking-wider text-fg-muted font-semibold mb-1">
            Readiness Score
          </div>
          <div className={`text-[22px] font-black tabular-nums ${scoreColor}`}>
            {score}
            <span className="text-[12px] text-fg-muted font-normal"> / 100</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RiskFlags({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {flags.map((f) => (
        <span
          key={f}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-red-500/15 text-red-300 border border-red-500/30"
        >
          <AlertTriangle className="w-3 h-3" />
          {f.replace(/_/g, " ")}
        </span>
      ))}
    </div>
  );
}

function StatementRow({ doc }: { doc: DocRow }) {
  const sizeKb = Math.max(1, Math.round(doc.size_bytes / 1024));
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <Database className="w-4 h-4 text-fg-dim shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-fg truncate">
          {doc.filename}
        </div>
        <div className="text-[10.5px] text-fg-dim font-mono">
          {doc.doc_type.replace(/_/g, " ")} · {sizeKb} KB
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group section header for the left-column list
// ---------------------------------------------------------------------------

type GroupKey = keyof QueueGroups;

const GROUP_META: Record<GroupKey, { label: string; icon: ReactNode }> = {
  needs_underwriting: {
    label: "Needs Underwriting",
    icon: <FileSearch className="w-3 h-3" />,
  },
  in_progress: {
    label: "In Progress",
    icon: <Loader2 className="w-3 h-3 animate-spin" />,
  },
  ready_to_shop: {
    label: "Ready to Shop",
    icon: <CheckCircle2 className="w-3 h-3" />,
  },
  risk_flagged: {
    label: "Risk Flagged",
    icon: <AlertTriangle className="w-3 h-3" />,
  },
};

const GROUP_ORDER: GroupKey[] = [
  "needs_underwriting",
  "in_progress",
  "ready_to_shop",
  "risk_flagged",
];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function UnderwritingClient({
  tenantSlug,
  tenantId,
}: {
  tenantSlug: string;
  tenantId: string | null;
}) {
  const router = useRouter();

  // Left column state
  const [queue, setQueue] = useState<QueueGroups | null>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Right column state
  const [latestRun, setLatestRun] = useState<UnderwritingRun | null | undefined>(
    undefined, // undefined = not yet fetched; null = fetched, no run
  );
  const [statements, setStatements] = useState<DocRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const triggerDebounce = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Helpers
  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const fetchLatestRun = useCallback(
    async (appId: string): Promise<UnderwritingRun | null> => {
      if (!tenantId) return null;
      try {
        const res = await fetch(`/api/applications/${appId}/underwriting/latest`, {
          credentials: "include",
        });
        const json = await res.json();
        return (json.run as UnderwritingRun | null) ?? null;
      } catch {
        return null;
      }
    },
    [tenantId],
  );

  const fetchStatements = useCallback(
    async (appId: string): Promise<DocRow[]> => {
      if (!tenantId) return [];
      try {
        const res = await fetch(
          `/api/leads/${appId}/documents?entity=application&doc_type=bank_statements_3mo`,
          { credentials: "include" },
        );
        const json = await res.json();
        if (json.ok && Array.isArray(json.documents)) {
          return (json.documents as Record<string, unknown>[]).map((d) => ({
            id: String(d.id ?? ""),
            filename: String(d.filename ?? ""),
            mime_type: String(d.mime_type ?? "application/pdf"),
            size_bytes: typeof d.size_bytes === "number" ? d.size_bytes : 0,
            doc_type: String(d.doc_type ?? "bank_statements_3mo"),
          }));
        }
      } catch {
        // fall through
      }
      return [];
    },
    [tenantId],
  );

  // Load queue on mount
  useEffect(() => {
    if (!tenantId) {
      setQueue({ needs_underwriting: [], in_progress: [], ready_to_shop: [], risk_flagged: [] });
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/manifest/${tenantSlug}/underwriting/queue`, {
          credentials: "include",
        });
        const json = await res.json();
        setQueue(json.groups ?? { needs_underwriting: [], in_progress: [], ready_to_shop: [], risk_flagged: [] });
      } catch {
        setQueue({ needs_underwriting: [], in_progress: [], ready_to_shop: [], risk_flagged: [] });
      }
    })();
  }, [tenantSlug, tenantId]);

  // On app selection: fetch run + statements, start/stop polling
  useEffect(() => {
    stopPolling();
    setLatestRun(undefined);
    setStatements([]);
    setUploadError(null);

    if (!selectedId || !tenantId) return;

    const load = async () => {
      const [run, docs] = await Promise.all([
        fetchLatestRun(selectedId),
        fetchStatements(selectedId),
      ]);
      setLatestRun(run);
      setStatements(docs);

      // Start polling if run is in-flight
      if (run?.status === "pending" || run?.status === "parsing") {
        pollTimer.current = setInterval(async () => {
          const updated = await fetchLatestRun(selectedId);
          setLatestRun(updated);
          if (updated?.status !== "pending" && updated?.status !== "parsing") {
            stopPolling();
            // Refresh queue to update left-column pill
            if (tenantId) {
              try {
                const qRes = await fetch(`/api/manifest/${tenantSlug}/underwriting/queue`, {
                  credentials: "include",
                });
                const qJson = await qRes.json();
                setQueue(qJson.groups ?? null);
              } catch {
                // best-effort
              }
            }
          }
        }, POLL_INTERVAL_MS);
      }
    };

    load();

    return () => stopPolling();
  }, [selectedId, tenantId, tenantSlug, fetchLatestRun, fetchStatements, stopPolling]);

  // File upload
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset picker
    if (!file || !selectedId) return;

    if (file.type !== "application/pdf") {
      setUploadError("Only PDF bank statements are accepted.");
      return;
    }
    setUploadError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("doc_type", "bank_statements_3mo");
      form.append("entity", "application");
      const res = await fetch(`/api/leads/${selectedId}/documents/upload`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "Upload failed.");
      // Refresh statements
      const docs = await fetchStatements(selectedId);
      setStatements(docs);
    } catch (err) {
      setUploadError((err as Error).message || "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  // Trigger / re-run underwriting
  const triggerRun = async () => {
    if (!selectedId || triggerDebounce.current) return;
    triggerDebounce.current = true;
    setTriggering(true);
    stopPolling();
    try {
      const res = await fetch(`/api/applications/${selectedId}/underwriting/run`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!json.run_id) throw new Error(json.error ?? "Failed to start run.");
      // Immediately set to pending so UI reflects it
      const pending: UnderwritingRun = {
        id: String(json.run_id),
        run_at: new Date().toISOString(),
        triggered_by: null,
        status: "pending",
        avg_monthly_revenue: null,
        avg_daily_balance: null,
        nsf_count: null,
        deposit_consistency_pct: null,
        debt_service_monthly: null,
        debt_to_revenue_ratio: null,
        lender_count: null,
        risk_flags: [],
        readiness_score: null,
        sales_angle: null,
        parser_output: null,
        debt_analysis: null,
        error_message: null,
      };
      setLatestRun(pending);
      // Start polling
      pollTimer.current = setInterval(async () => {
        const updated = await fetchLatestRun(selectedId);
        setLatestRun(updated);
        if (updated?.status !== "pending" && updated?.status !== "parsing") {
          stopPolling();
        }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setUploadError((err as Error).message || "Could not start underwriting run.");
    } finally {
      setTriggering(false);
      setTimeout(() => { triggerDebounce.current = false; }, 2000);
    }
  };

  // Computed
  const isRunInFlight =
    latestRun?.status === "pending" || latestRun?.status === "parsing";
  const canRun = statements.length > 0 && !isRunInFlight && !triggering;

  const allApps: AppSummary[] = queue
    ? GROUP_ORDER.flatMap((g) => queue[g])
    : [];

  const filteredGroups: QueueGroups | null = queue
    ? (() => {
        const needle = search.trim().toLowerCase();
        if (!needle) return queue;
        const filter = (arr: AppSummary[]) =>
          arr.filter((a) =>
            [a.business_name, a.contact_name, a.phone]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(needle),
          );
        return {
          needs_underwriting: filter(queue.needs_underwriting),
          in_progress: filter(queue.in_progress),
          ready_to_shop: filter(queue.ready_to_shop),
          risk_flagged: filter(queue.risk_flagged),
        };
      })()
    : null;

  const selectedApp = allApps.find((a) => a.id === selectedId) ?? null;

  const startedMinsAgo = latestRun?.run_at
    ? Math.round((Date.now() - new Date(latestRun.run_at).getTime()) / 60_000)
    : null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex gap-4 h-full min-h-[520px]">
      {/* ------------------------------------------------------------------ */}
      {/* LEFT COLUMN — Application picker (~360px)                          */}
      {/* ------------------------------------------------------------------ */}
      <div className="w-[360px] shrink-0 flex flex-col gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find application by business name, contact…"
          className="w-full text-sm px-3 py-2 rounded-md bg-bg-deep border border-bg-border text-fg placeholder:text-fg-dim"
        />

        <div className="flex-1 overflow-y-auto rounded-xl border border-bg-border bg-bg-panel">
          {filteredGroups === null ? (
            <div className="flex items-center justify-center gap-2 py-10 text-xs text-fg-dim italic">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Loading queue…
            </div>
          ) : (
            GROUP_ORDER.map((key) => {
              const group = filteredGroups[key];
              if (group.length === 0) return null;
              const meta = GROUP_META[key];
              return (
                <div key={key}>
                  <div className="flex items-center gap-1.5 px-3 py-2 bg-bg-deep border-b border-bg-border text-[10px] uppercase tracking-wider text-fg-dim font-semibold sticky top-0">
                    {meta.icon}
                    {meta.label}
                    <span className="ml-auto text-fg-muted">{group.length}</span>
                  </div>
                  <div className="divide-y divide-bg-border">
                    {group.map((app) => {
                      const isSelected = app.id === selectedId;
                      const score =
                        app.readiness_score != null
                          ? Math.min(100, Math.max(0, app.readiness_score))
                          : null;
                      const scoreColor =
                        score == null
                          ? "text-fg-muted"
                          : score >= 70
                            ? "text-emerald-400"
                            : score >= 40
                              ? "text-amber-300"
                              : "text-red-400";
                      return (
                        <button
                          key={app.id}
                          type="button"
                          onClick={() => setSelectedId(app.id)}
                          className={`w-full text-left px-3 py-2.5 flex items-start justify-between gap-2 hover:bg-bg-elev/60 transition-colors ${
                            isSelected ? "bg-accent/10" : ""
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div
                              className={`text-[13px] font-semibold truncate ${
                                isSelected ? "text-accent" : "text-fg"
                              }`}
                            >
                              {app.business_name}
                            </div>
                            <div className="text-[11px] text-fg-dim truncate">
                              {[app.contact_name, app.monthly_revenue != null ? `$${Number(app.monthly_revenue).toLocaleString()}/mo` : null]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          </div>
                          <div className="shrink-0 flex flex-col items-end gap-1">
                            {app.latest_run_status && (
                              <RunStatusPill status={app.latest_run_status} />
                            )}
                            {score != null && (
                              <span className={`text-[11px] font-bold tabular-nums ${scoreColor}`}>
                                {score}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* RIGHT COLUMN — Selected application detail                          */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex-1 min-w-0 flex flex-col gap-4 overflow-y-auto">
        {!selectedId ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-fg-dim rounded-xl border border-bg-border bg-bg-panel">
            <FileSearch className="w-8 h-8 opacity-30" />
            <span className="text-sm">Select an application to begin underwriting.</span>
          </div>
        ) : (
          <>
            {/* Business header */}
            {selectedApp && (
              <Card>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-lg font-bold text-fg leading-tight">
                      {selectedApp.business_name}
                    </div>
                    <div className="text-[12px] text-fg-dim mt-0.5">
                      {[
                        selectedApp.contact_name,
                        selectedApp.phone,
                        selectedApp.monthly_revenue != null
                          ? `$${Number(selectedApp.monthly_revenue).toLocaleString()}/mo`
                          : null,
                        selectedApp.assigned_rep
                          ? `Rep: ${selectedApp.assigned_rep}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  {selectedApp.latest_run_status && (
                    <RunStatusPill status={selectedApp.latest_run_status} />
                  )}
                </div>
              </Card>
            )}

            {/* Bank statements section */}
            <Card title="Bank Statements">
              <div className="space-y-3">
                {statements.length === 0 ? (
                  <div className="text-[12px] text-fg-dim italic py-2">
                    No bank statements uploaded yet.
                  </div>
                ) : (
                  <div className="rounded-md border border-bg-border divide-y divide-bg-border">
                    {statements.map((doc) => (
                      <StatementRow key={doc.id} doc={doc} />
                    ))}
                  </div>
                )}

                {uploadError && (
                  <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
                    {uploadError}
                  </div>
                )}

                <div className="flex items-center gap-2 flex-wrap">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-md border border-bg-border text-fg-muted hover:text-fg hover:bg-bg-elev disabled:opacity-50"
                  >
                    {uploading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Upload className="w-3.5 h-3.5" />
                    )}
                    Upload statement
                  </button>
                  <span className="text-[10.5px] text-fg-muted">PDF only</span>

                  <button
                    type="button"
                    onClick={triggerRun}
                    disabled={!canRun}
                    className="ml-auto inline-flex items-center gap-1.5 text-[12.5px] font-semibold px-4 py-1.5 rounded-md bg-accent text-bg-deep disabled:opacity-40"
                  >
                    {triggering ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <FileSearch className="w-3.5 h-3.5" />
                    )}
                    Run underwriting
                  </button>
                </div>
              </div>
            </Card>

            {/* Latest run results */}
            {latestRun === undefined ? (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-fg-dim italic">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading latest run…
              </div>
            ) : latestRun === null ? (
              <div className="rounded-xl border border-bg-border bg-bg-panel p-5 text-[12px] text-fg-dim italic text-center">
                No underwriting runs yet. Upload statements and click &quot;Run underwriting&quot;.
              </div>
            ) : latestRun.status === "pending" || latestRun.status === "parsing" ? (
              /* In-flight pane */
              <Card>
                <div className="flex flex-col items-center justify-center gap-3 py-6 text-center">
                  <Loader2 className="w-8 h-8 animate-spin text-accent" />
                  <div className="text-[14px] font-semibold text-fg">
                    {latestRun.status === "parsing" ? "Parsing statements…" : "Run queued…"}
                  </div>
                  {startedMinsAgo != null && (
                    <div className="text-[11.5px] text-fg-dim">
                      Started {startedMinsAgo} minute{startedMinsAgo === 1 ? "" : "s"} ago
                      &nbsp;· polling every 8 s
                    </div>
                  )}
                  <RunStatusPill status={latestRun.status} />
                </div>
              </Card>
            ) : latestRun.status === "error" ? (
              /* Error pane */
              <Card>
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-red-300">
                    <XCircle className="w-4 h-4" />
                    <span className="font-semibold text-[13px]">Underwriting failed</span>
                  </div>
                  {latestRun.error_message && (
                    <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200 font-mono break-all">
                      {latestRun.error_message}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={triggerRun}
                    disabled={!canRun}
                    className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold px-4 py-2 rounded-md bg-red-500/80 text-white hover:bg-red-500 disabled:opacity-40"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Re-run underwriting
                  </button>
                </div>
              </Card>
            ) : (
              /* Complete — results pane */
              <div className="space-y-3">
                <Card
                  title="Results"
                  action={
                    <button
                      type="button"
                      onClick={triggerRun}
                      disabled={!canRun}
                      className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md border border-bg-border text-fg-muted hover:text-fg hover:bg-bg-elev disabled:opacity-40"
                    >
                      <RefreshCw className="w-3 h-3" />
                      Re-run
                    </button>
                  }
                >
                  <div className="space-y-4">
                    <MetricsGrid run={latestRun} />

                    {latestRun.risk_flags.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold">
                          Risk Flags
                        </div>
                        <RiskFlags flags={latestRun.risk_flags} />
                      </div>
                    )}

                    {latestRun.sales_angle && (
                      <div className="space-y-1.5">
                        <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold">
                          Sales Angle
                        </div>
                        <blockquote className="border-l-2 border-accent pl-3 text-[13px] text-fg-muted italic leading-relaxed">
                          {latestRun.sales_angle}
                        </blockquote>
                      </div>
                    )}

                    <details className="group">
                      <summary className="cursor-pointer text-[11px] text-fg-dim hover:text-fg select-none flex items-center gap-1">
                        <Database className="w-3 h-3" />
                        Raw audit data
                        <span className="ml-1 text-fg-muted">(parser + debt analysis JSON)</span>
                      </summary>
                      <div className="mt-2 rounded-md bg-bg-deep border border-bg-border p-3 max-h-64 overflow-y-auto">
                        <pre className="text-[10.5px] font-mono text-fg-muted whitespace-pre-wrap break-all">
                          {JSON.stringify(
                            { parser_output: latestRun.parser_output, debt_analysis: latestRun.debt_analysis },
                            null,
                            2,
                          )}
                        </pre>
                      </div>
                    </details>

                    <div className="pt-1 border-t border-bg-border flex items-center justify-between gap-3">
                      <div className="text-[10.5px] text-fg-muted">
                        Run at{" "}
                        {new Date(latestRun.run_at).toLocaleString(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                        {latestRun.triggered_by ? ` · by ${latestRun.triggered_by}` : ""}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          router.push(`/t/${tenantSlug}/shopping-out?app=${selectedId}`)
                        }
                        className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold px-4 py-2 rounded-md bg-accent text-bg-deep"
                      >
                        Push to Lender Recommender
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </Card>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
