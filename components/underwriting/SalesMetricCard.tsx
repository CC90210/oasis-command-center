"use client";

/**
 * SalesMetricCard — Adon MCA SOP §7 sales-focused metric card.
 *
 * Renders the grading + recommendation + leverage + positions that the
 * grader.py module produced on the SunBiz-Agent side and persisted into
 * application_underwriting.debt_analysis.metric_card.
 *
 * SOP §7 shape:
 *   GRADE: [A/B/C/D/JUNK]    RECOMMEND: [Fresh capital / Consolidation / ...]
 *   True Monthly Revenue · Active MCA Positions · MCA Monthly Burden
 *   MCA Leverage · Est. Total MCA Balance · NSFs (90d) · Neg-balance Days
 *   Collections flag · Verified positions list · Red flags · Target tier
 *
 * Empty-state: when debt_analysis doesn't carry a metric_card (legacy
 * pre-2026-06-11 runs that predate the grader), renders a one-liner
 * inviting the operator to re-run rather than misleading them with
 * stale or absent data.
 */

import { AlertOctagon, AlertTriangle, ChevronRight, ShieldAlert } from "lucide-react";

// Shape matches SunBiz-Agent/scripts/underwriting/grader.py:build_metric_card.
type MetricCard = {
  grade: "A" | "B" | "C" | "D" | "JUNK" | null;
  recommendation: string | null;
  true_monthly_revenue: number;
  excluded_credits_monthly: number;
  revenue_note: string;
  active_mca_positions: number;
  mca_monthly_burden: number;
  mca_leverage_pct: number | null;
  estimated_total_mca_balance: number;
  estimate_quality: string;
  nsfs_90d: number;
  negative_balance_days: number;
  collections_flag: boolean;
  positions: Array<{
    lender_hint: string;
    estimated_monthly_payment: number;
    observed_in_statements: number;
    frequencies_observed: string[];
  }>;
  red_flags: string[];
  target_lender_tier: string | null;
};

const GRADE_TONE: Record<string, string> = {
  A: "from-emerald-500/30 to-emerald-700/10 border-emerald-500/40 text-emerald-200",
  B: "from-sky-500/30 to-sky-700/10 border-sky-500/40 text-sky-200",
  C: "from-amber-500/30 to-amber-700/10 border-amber-500/40 text-amber-200",
  D: "from-orange-500/30 to-orange-700/10 border-orange-500/40 text-orange-200",
  JUNK: "from-red-500/40 to-red-800/15 border-red-500/60 text-red-200",
};

function formatUsd(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/**
 * Extract the metric_card from the orchestrator's debt_analysis JSON.
 * Returns null when the field is absent (legacy runs) — caller renders
 * an empty-state instead of a broken card.
 */
export function extractMetricCard(debtAnalysis: unknown): MetricCard | null {
  if (!debtAnalysis || typeof debtAnalysis !== "object") return null;
  const mc = (debtAnalysis as { metric_card?: unknown }).metric_card;
  if (!mc || typeof mc !== "object") return null;
  const card = mc as Record<string, unknown>;
  if (card.grade !== "A" && card.grade !== "B" && card.grade !== "C" && card.grade !== "D" && card.grade !== "JUNK" && card.grade !== null) {
    return null;
  }
  return mc as MetricCard;
}

export function SalesMetricCard({ debtAnalysis }: { debtAnalysis: unknown }) {
  const card = extractMetricCard(debtAnalysis);

  if (!card || card.grade === null) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-[12px] text-amber-200/80">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span className="font-semibold">No SOP grade on this run.</span>
        </div>
        <div className="mt-1 text-[11px] text-fg-dim leading-relaxed">
          This row predates the Adon MCA SOP grader (2026-06-11) or the grader
          failed on this run. Re-run underwriting to generate the A/B/C/D/JUNK
          grade + sales metric card.
        </div>
      </div>
    );
  }

  const tone = GRADE_TONE[card.grade] || GRADE_TONE.D;
  const isJunk = card.grade === "JUNK";

  return (
    <div className="space-y-3">
      {/* Header strip — Grade + Recommendation, big and unmissable. */}
      <div
        className={`rounded-xl border bg-gradient-to-br ${tone} px-4 py-4 flex items-center gap-4`}
      >
        <div className="flex flex-col items-center justify-center min-w-[64px]">
          <div className="text-[10px] uppercase tracking-wider opacity-70">Grade</div>
          <div className="text-4xl font-bold leading-none tabular-nums">{card.grade}</div>
        </div>
        <div className="h-12 w-px bg-white/15" />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider opacity-70">Recommend</div>
          <div className="text-[15px] font-semibold leading-tight truncate">
            {card.recommendation || "—"}
          </div>
          {card.target_lender_tier && !isJunk && (
            <div className="text-[11px] opacity-70 mt-0.5">
              Target tier: <span className="font-mono">{card.target_lender_tier}-paper</span>
            </div>
          )}
        </div>
        {isJunk && (
          <div className="flex items-center gap-1.5 text-red-200/90 font-semibold text-[12px] uppercase tracking-wider">
            <AlertOctagon className="w-4 h-4" />
            Do not shop
          </div>
        )}
      </div>

      {/* Two-column metric grid — the 6 numbers the agent reads in 3 seconds. */}
      <div className="grid grid-cols-2 gap-2.5">
        <Metric
          label="True monthly revenue"
          value={`$${formatUsd(card.true_monthly_revenue)}`}
          sub={card.revenue_note}
        />
        <Metric
          label="Active MCA positions"
          value={String(card.active_mca_positions)}
          sub={
            card.active_mca_positions === 0
              ? "Clean stack"
              : card.active_mca_positions === 1
                ? "Single position"
                : `${card.active_mca_positions}-deep stack`
          }
        />
        <Metric
          label="MCA monthly burden"
          value={`$${formatUsd(card.mca_monthly_burden)}`}
          sub="payments normalized to monthly"
        />
        <Metric
          label="MCA leverage"
          value={
            card.mca_leverage_pct !== null
              ? `${card.mca_leverage_pct.toFixed(1)}%`
              : "n/a"
          }
          sub="burden ÷ true revenue"
          tone={
            card.mca_leverage_pct !== null
              ? card.mca_leverage_pct < 25
                ? "ok"
                : card.mca_leverage_pct < 70
                  ? "warn"
                  : "bad"
              : undefined
          }
        />
        <Metric
          label="Est. total MCA balance"
          value={`~$${formatUsd(card.estimated_total_mca_balance)}`}
          sub={`${card.estimate_quality.replace(/_/g, " ")} — confirm with funder`}
        />
        <Metric
          label="NSFs (window) · neg days"
          value={`${card.nsfs_90d} · ${card.negative_balance_days}`}
          sub={
            card.nsfs_90d > 6
              ? "heavy cash-mgmt risk"
              : card.nsfs_90d > 3
                ? "moderate cash-mgmt risk"
                : "clean banking"
          }
          tone={card.nsfs_90d > 6 ? "bad" : card.nsfs_90d > 3 ? "warn" : "ok"}
        />
      </div>

      {/* DEATH-BLOW collections strip — only when flagged, full red. */}
      {card.collections_flag && (
        <div className="rounded-lg border border-red-500/50 bg-red-500/15 px-3 py-2 flex items-center gap-2 text-[12.5px] text-red-200 font-semibold">
          <ShieldAlert className="w-4 h-4 flex-shrink-0" />
          <span>
            Collections flag — defaulted MCA in active recovery. Adon SOP §6: JUNK
            paper, do not shop. Refer to restructure.
          </span>
        </div>
      )}

      {/* Verified positions table — only renders when there ARE positions. */}
      {card.positions.length > 0 && (
        <div className="rounded-lg border border-bg-border bg-bg-deep/40">
          <div className="px-3 py-1.5 border-b border-bg-border text-[10px] uppercase tracking-wider text-fg-dim font-semibold">
            Verified MCA positions ({card.positions.length})
          </div>
          <div className="divide-y divide-bg-border">
            {card.positions.map((p) => (
              <div
                key={p.lender_hint}
                className="px-3 py-2 flex items-center gap-3 text-[12px]"
              >
                <div className="flex-1 font-semibold text-fg truncate">{p.lender_hint}</div>
                <div className="font-mono tabular-nums text-fg-muted">
                  ${formatUsd(p.estimated_monthly_payment)}/mo
                </div>
                <div className="text-fg-dim text-[10.5px] font-mono">
                  {p.frequencies_observed.join(", ")} · {p.observed_in_statements}× obs.
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Red flags — including the SOP-required "unverified biller" callouts.
          Collapsed by default (the grader can emit 40+ rows) and deduped
          case-insensitively, since the parser frequently re-flags the same
          biller across statements. <details> = native collapse, no state. */}
      {card.red_flags.length > 0 && (() => {
        const seen = new Set<string>();
        const uniqueFlags: string[] = [];
        for (const f of card.red_flags) {
          const k = f.trim().toLowerCase();
          if (!k || seen.has(k)) continue;
          seen.add(k);
          uniqueFlags.push(f);
        }
        const dupCount = card.red_flags.length - uniqueFlags.length;
        return (
          <details className="group rounded-lg border border-amber-500/30 bg-amber-500/5">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-amber-300 font-semibold">
              <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
              Red flags ({uniqueFlags.length})
              <span className="ml-auto normal-case tracking-normal text-amber-200/55 font-normal">
                {dupCount > 0 ? `${dupCount} dup hidden · ` : ""}expand
              </span>
            </summary>
            <ul className="space-y-1 px-3 pb-2.5 pt-0.5 text-[12px] text-amber-100/85">
              {uniqueFlags.map((flag, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
                  <span>{flag}</span>
                </li>
              ))}
            </ul>
          </details>
        );
      })()}
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "ok" | "warn" | "bad";
}) {
  const valueColor =
    tone === "bad"
      ? "text-red-300"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "ok"
          ? "text-emerald-300"
          : "text-fg";
  return (
    <div className="rounded-lg border border-bg-border bg-bg-panel/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold">{label}</div>
      <div className={`text-[18px] font-bold tabular-nums leading-tight ${valueColor}`}>{value}</div>
      <div className="text-[10.5px] text-fg-dim mt-0.5">{sub}</div>
    </div>
  );
}
