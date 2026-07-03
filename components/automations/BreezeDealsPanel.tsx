"use client";

/**
 * BreezeDealsPanel — read-only feed of the Breeze BD deal queue
 * (scrub_candidates) on the SunBiz Automations tab.
 *
 * Shows what the backend agents are actually producing: the mca-lead-scrubber
 * daemon pulls UW Entry Sheets off the shared Breeze Drive, verifies + scores
 * each deal, and stages the qualified ones here as pending_review. Approval
 * happens in Ezra's Telegram (ezra-telegram-bridge) — approving there creates
 * the lead + fires enrichment. This panel is the dashboard window onto that
 * flow, NOT a second approval surface (one approval path, no drift).
 *
 * Data: GET /api/automations/breeze-deals (auth-gated, tenant-scoped,
 * PII-whitelisted server-side). Refreshes every 60s.
 */

import { useCallback, useEffect, useState } from "react";
import { Banknote, AlertCircle, CheckCircle2, XCircle, Hourglass, RefreshCw } from "lucide-react";

type Deal = {
  id: string;
  status: string;
  tier: string;
  score: number;
  reasons: string[];
  previously_submitted: boolean;
  leverage_pct: number | null;
  monthly_revenue: number | null;
  business_name: string;
  iso_broker: string | null;
  source_file: string | null;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_lead_id: string | null;
};

type ApiResponse = {
  ok: boolean;
  counts: { pending_review: number; approved: number; declined: number; total: number };
  status: string;
  deals: Deal[];
  error?: string;
};

const FILTERS = [
  { key: "pending_review", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "declined", label: "Declined" },
  { key: "all", label: "All" },
] as const;

export function BreezeDealsPanel() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("pending_review");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (status: string) => {
    try {
      setRefreshing(true);
      const res = await fetch(`/api/automations/breeze-deals?status=${status}&limit=25`);
      const j = (await res.json()) as ApiResponse;
      if (!j.ok) {
        setError(j.error || `http_${res.status}`);
        return;
      }
      setData(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load_failed");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh(filter);
    const t = setInterval(() => void refresh(filter), 60_000);
    return () => clearInterval(t);
  }, [filter, refresh]);

  if (error) {
    return (
      <div className="rounded-xl border border-status-warm/40 bg-status-warm/10 p-3 text-sm text-status-warm flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>Couldn&apos;t load Breeze BD deals: {error}</span>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-xl border border-bg-border bg-bg-elev/30 p-4 text-xs text-fg-muted">
        Loading Breeze BD deals…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Banknote className="w-4 h-4 text-fg-muted" />
          <div className="text-sm font-bold text-fg">Breeze BD deals</div>
          <span className="text-[10px] uppercase tracking-wider text-fg-dim border border-bg-border rounded-full px-1.5 py-0.5">
            {data.counts.pending_review} pending · {data.counts.total} total
          </span>
          {refreshing && <RefreshCw className="w-3 h-3 text-fg-dim animate-spin" />}
        </div>
        <div className="flex items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                filter === f.key
                  ? "border-accent/60 bg-accent/10 text-fg"
                  : "border-bg-border bg-bg-elev/50 text-fg-muted hover:bg-bg-elev hover:text-fg"
              }`}
            >
              {f.label}
              {f.key !== "all" && (
                <span className="ml-1 text-fg-dim font-mono">
                  {data.counts[f.key as keyof typeof data.counts]}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="text-[11px] text-fg-muted leading-relaxed">
        UW Entry Sheets pulled off the shared Breeze Drive, verified and scored by the scrubber
        daemon. Qualified deals wait here as <span className="text-fg">Pending</span> until Ezra
        approves or declines them in Telegram — approval creates the lead and fires enrichment.
      </div>

      {data.deals.length === 0 ? (
        <div className="rounded-xl border border-bg-border bg-bg-elev/30 p-6 text-center text-xs text-fg-muted">
          No {filter === "all" ? "" : `${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} `}
          deals yet. New UW sheets land here within ~2 minutes of the scrubber&apos;s next pass.
        </div>
      ) : (
        <div className="space-y-2">
          {data.deals.map((d) => (
            <DealRow key={d.id} deal={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function DealRow({ deal }: { deal: Deal }) {
  const StatusIcon =
    deal.status === "approved" ? CheckCircle2 : deal.status === "declined" ? XCircle : Hourglass;
  const statusClass =
    deal.status === "approved"
      ? "text-status-engaged"
      : deal.status === "declined"
        ? "text-status-warm"
        : "text-accent";
  const statusLabel =
    deal.status === "approved"
      ? `Approved${deal.reviewed_by ? ` · ${deal.reviewed_by}` : ""}`
      : deal.status === "declined"
        ? `Declined${deal.reviewed_by ? ` · ${deal.reviewed_by}` : ""}`
        : "Pending Ezra";

  // The scrubber's score reasons ("leverage 12% (+20)") in the tooltip —
  // same detail-on-hover convention as the workers panel.
  const tooltip = deal.reasons.length
    ? deal.reasons.join("\n")
    : deal.source_file || deal.id;

  return (
    <div
      className={`rounded-lg border p-3 ${
        deal.status === "pending_review"
          ? "border-bg-border bg-bg-elev/30"
          : "border-bg-border bg-bg-deep/40 opacity-90"
      }`}
      title={tooltip}
    >
      <div className="flex items-start gap-2">
        <StatusIcon className={`w-4 h-4 shrink-0 mt-0.5 ${statusClass}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-bold text-sm text-fg truncate">{deal.business_name}</div>
            <span
              className={`text-[10px] uppercase tracking-wider rounded-full border px-1.5 py-0.5 ${
                deal.tier === "good"
                  ? "border-status-engaged/40 text-status-engaged"
                  : "border-accent/40 text-accent"
              }`}
            >
              {deal.tier} · {deal.score}
            </span>
            {deal.previously_submitted && (
              <span className="text-[10px] uppercase tracking-wider rounded-full border border-status-warm/40 text-status-warm px-1.5 py-0.5">
                Prev. submitted
              </span>
            )}
          </div>
          <div className="text-[11px] text-fg-muted mt-1 flex items-center gap-3 flex-wrap">
            {deal.monthly_revenue != null && (
              <span>{formatMoney(deal.monthly_revenue)}/mo revenue</span>
            )}
            {deal.leverage_pct != null && <span>{Number(deal.leverage_pct)}% leverage</span>}
            {deal.iso_broker && <span className="truncate">ISO: {deal.iso_broker}</span>}
          </div>
          <div className="text-[11px] text-fg-dim mt-1 flex items-center gap-3 flex-wrap">
            <span className={statusClass}>{statusLabel}</span>
            <span>{relativeTime(deal.created_at)}</span>
            {deal.source_file && (
              <span className="font-mono truncate max-w-[280px]">{deal.source_file}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatMoney(n: number): string {
  return `$${Math.round(Number(n)).toLocaleString("en-US")}`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleDateString();
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  if (ms < 30 * 86_400_000) return `${Math.round(ms / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}
