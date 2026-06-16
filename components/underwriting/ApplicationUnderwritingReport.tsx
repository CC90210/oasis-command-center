"use client";

/**
 * ApplicationUnderwritingReport — full-width SOP underwriting report for ONE
 * application. Mounted on the per-application detail page
 * (/t/[slug]/applications/[id]) so the operator gets a dedicated, roomy view
 * of the grade + verified positions + leverage + red flags + sales angle,
 * rather than the cramped readiness badge in the Bank drawer.
 *
 * Reuses the same SalesMetricCard the drawer + UnderwritingClient render, and
 * the same /api/applications/[id]/underwriting/{latest,run} endpoints, so
 * there is one source of truth for the underwriting output. Self-contained:
 * fetches on mount, polls while a run is in-flight, exposes a Re-run button.
 *
 * Added 2026-06-16 to close the "underwriting only shows two things / no link
 * to a full page" gap — the grader was producing a complete metric_card all
 * along; nothing surfaced it at full size.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/Card";
import { SalesMetricCard } from "@/components/underwriting/SalesMetricCard";
import {
  RefreshCw,
  AlertTriangle,
  XCircle,
  ArrowRight,
  Database,
  Loader2,
  FileSearch,
} from "lucide-react";

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
  risk_flags: string[] | null;
  readiness_score: number | null;
  sales_angle: string | null;
  parser_output: unknown;
  debt_analysis: unknown;
  error_message: string | null;
};

const POLL_INTERVAL_MS = 5_000;

export function ApplicationUnderwritingReport({
  applicationId,
  tenantSlug,
}: {
  applicationId: string;
  tenantSlug: string;
}) {
  // undefined = loading; null = no run yet; object = latest run.
  const [run, setRun] = useState<UnderwritingRun | null | undefined>(undefined);
  const [rerunPending, setRerunPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const fetchLatest = useCallback(async (): Promise<UnderwritingRun | null> => {
    try {
      const r = await fetch(
        `/api/applications/${applicationId}/underwriting/latest`,
        { credentials: "include", cache: "no-store" },
      );
      if (!r.ok) return null;
      const j = await r.json().catch(() => ({}));
      return (j.run as UnderwritingRun) ?? null;
    } catch {
      return null;
    }
  }, [applicationId]);

  // Initial load + start polling if in-flight.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await fetchLatest();
      if (cancelled) return;
      setRun(r);
      if (r?.status === "pending" || r?.status === "parsing") {
        pollTimer.current = setInterval(async () => {
          if (document.visibilityState !== "visible") return;
          const updated = await fetchLatest();
          setRun(updated);
          if (updated?.status !== "pending" && updated?.status !== "parsing") {
            stopPolling();
          }
        }, POLL_INTERVAL_MS);
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [fetchLatest, stopPolling]);

  const handleRerun = async () => {
    if (rerunPending) return;
    setRerunPending(true);
    setError(null);
    stopPolling();
    try {
      const r = await fetch(
        `/api/applications/${applicationId}/underwriting/run`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ triggered_by: "manual" }),
        },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error || `failed_${r.status}`);
        return;
      }
      const fresh = await fetchLatest();
      setRun(fresh ?? run);
      // Resume polling until the new run resolves.
      pollTimer.current = setInterval(async () => {
        if (document.visibilityState !== "visible") return;
        const updated = await fetchLatest();
        setRun(updated);
        if (updated?.status !== "pending" && updated?.status !== "parsing") {
          stopPolling();
        }
      }, POLL_INTERVAL_MS);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setRerunPending(false);
    }
  };

  const fmt = (n: number | null, prefix = "", suffix = "") =>
    n == null ? "—" : `${prefix}${n.toLocaleString()}${suffix}`;
  const fmtPct = (n: number | null) => (n == null ? "—" : `${n.toFixed(1)}%`);

  // ---- Render states ------------------------------------------------------

  if (run === undefined) {
    return (
      <Card title="Underwriting">
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-fg-dim italic">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading underwriting…
        </div>
      </Card>
    );
  }

  if (run === null) {
    return (
      <Card
        title="Underwriting"
        action={
          <button
            type="button"
            onClick={handleRerun}
            disabled={rerunPending}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-md bg-accent text-bg-deep disabled:opacity-40"
          >
            {rerunPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <FileSearch className="w-3.5 h-3.5" />
            )}
            Run underwriting
          </button>
        }
      >
        <div className="text-[12.5px] text-fg-dim italic py-2">
          No underwriting run yet. Make sure bank statements are uploaded, then
          run underwriting to generate the grade + sales metric card.
        </div>
        {error && <div className="mt-2 text-[12px] text-red-300">{error}</div>}
      </Card>
    );
  }

  if (run.status === "pending" || run.status === "parsing") {
    const startedMinsAgo = run.run_at
      ? Math.round((Date.now() - new Date(run.run_at).getTime()) / 60_000)
      : null;
    return (
      <Card title="Underwriting">
        <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
          <Loader2 className="w-8 h-8 animate-spin text-accent" />
          <div className="text-[14px] font-semibold text-fg">
            {run.status === "parsing"
              ? "Parsing bank statements…"
              : "Run queued…"}
          </div>
          <div className="text-[11.5px] text-fg-dim">
            {startedMinsAgo != null
              ? `Started ${startedMinsAgo} minute${startedMinsAgo === 1 ? "" : "s"} ago · `
              : ""}
            polling every 5 s. Vision parsing of multi-month statements
            typically takes 1–3 minutes.
          </div>
        </div>
      </Card>
    );
  }

  if (run.status === "error") {
    return (
      <Card
        title="Underwriting"
        action={
          <button
            type="button"
            onClick={handleRerun}
            disabled={rerunPending}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-md bg-red-500/80 text-white hover:bg-red-500 disabled:opacity-40"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Re-run
          </button>
        }
      >
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-red-300">
            <XCircle className="w-4 h-4" />
            <span className="font-semibold text-[13px]">Underwriting failed</span>
          </div>
          {run.error_message && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200 font-mono break-all">
              {run.error_message}
            </div>
          )}
          {error && <div className="text-[12px] text-red-300">{error}</div>}
        </div>
      </Card>
    );
  }

  // status === "complete"
  const riskFlags = Array.isArray(run.risk_flags) ? run.risk_flags : [];
  return (
    <Card
      title="Underwriting"
      action={
        <button
          type="button"
          onClick={handleRerun}
          disabled={rerunPending}
          className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-md border border-bg-border text-fg-muted hover:text-fg hover:bg-bg-elev disabled:opacity-40"
        >
          {rerunPending ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          Re-run
        </button>
      }
    >
      <div className="space-y-4">
        {/* SOP §7 grade + verified positions + leverage + red flags. */}
        <SalesMetricCard debtAnalysis={run.debt_analysis} />

        {/* Banking signals the SOP card doesn't surface. */}
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold">
            Banking signals
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Signal label="Avg daily balance" value={fmt(run.avg_daily_balance, "$")} />
            <Signal label="Deposit consistency" value={fmtPct(run.deposit_consistency_pct)} />
            <Signal
              label="Readiness"
              value={
                run.readiness_score != null ? `${run.readiness_score}/100` : "—"
              }
            />
            <Signal label="NSF count" value={fmt(run.nsf_count)} />
          </div>
        </div>

        {run.sales_angle && (
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold">
              Sales angle
            </div>
            <blockquote className="border-l-2 border-accent pl-3 text-[13px] text-fg-muted italic leading-relaxed">
              {run.sales_angle}
            </blockquote>
          </div>
        )}

        {riskFlags.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold">
              Risk flags
            </div>
            <div className="flex flex-wrap gap-1.5">
              {riskFlags.map((f) => (
                <span
                  key={f}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-red-500/15 text-red-300 border border-red-500/30"
                >
                  <AlertTriangle className="w-3 h-3" />
                  {f.replace(/_/g, " ")}
                </span>
              ))}
            </div>
          </div>
        )}

        <details className="group">
          <summary className="cursor-pointer text-[11px] text-fg-dim hover:text-fg select-none flex items-center gap-1">
            <Database className="w-3 h-3" />
            Raw audit data
            <span className="ml-1 text-fg-muted">(parser + debt analysis JSON)</span>
          </summary>
          <div className="mt-2 rounded-md bg-bg-panel border border-bg-border p-3 max-h-80 overflow-y-auto">
            <pre className="text-[10.5px] font-mono text-fg-muted whitespace-pre-wrap break-all">
              {JSON.stringify(
                { parser_output: run.parser_output, debt_analysis: run.debt_analysis },
                null,
                2,
              )}
            </pre>
          </div>
        </details>

        <div className="pt-1 border-t border-bg-border flex flex-wrap items-center justify-between gap-3">
          <div className="text-[10.5px] text-fg-muted">
            Run at{" "}
            {new Date(run.run_at).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
            {run.triggered_by ? ` · by ${run.triggered_by}` : ""}
          </div>
          <Link
            href={`/t/${tenantSlug}/shopping-out?app=${applicationId}`}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold px-4 py-2 rounded-md bg-accent text-bg-deep"
          >
            Push to Lender Recommender
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </Card>
  );
}

function Signal({ label, value }: { label: string; value: string }) {
  // bg-bg-panel/60 mirrors SalesMetricCard's Metric tiles (same view) — keeps
  // these banking-signal tiles visually identical to the SOP card's tiles.
  // (bg-bg-deep would be transparent — there's no `deep` key in the bg scale.)
  return (
    <div className="rounded-lg border border-bg-border bg-bg-panel/60 p-3">
      <div className="text-[10px] uppercase tracking-wider text-fg-muted font-semibold mb-1">
        {label}
      </div>
      <div className="text-[15px] font-bold text-fg tabular-nums">{value}</div>
    </div>
  );
}
