"use client";

/**
 * FeatureHealthGrid — the score-explaining part of the global health dashboard.
 *
 * The design rule here: never show a bare score. A number with no attribution
 * is an unactionable number. Every card expands to the per-component
 * breakdown the scorer persisted, so "why is this 42%" is answered on the page
 * rather than by re-running anything.
 *
 * Excluded components are shown as excluded, not as zeros. That distinction is
 * the whole reason the breakdown is stored.
 */

import { useState } from "react";
import { Card, Tag } from "@/components/Card";
import { ChevronDown, ChevronRight } from "lucide-react";

type ComponentDetail = {
  raw: number | null;
  normalized: number;
  weight: number;
  effectiveWeight: number;
};

export type HealthCheckRow = {
  check_key: string;
  feature: string;
  surface: string;
  severity: string;
  notes?: string | null;
  status: {
    score: number;
    status: "healthy" | "degraded" | "down" | "unknown";
    breakdown: {
      components?: Record<string, ComponentDetail>;
      excluded?: string[];
      dominantFailure?: string;
    };
    error: string | null;
    consecutive_bad: number;
    last_ok_at: string | null;
    last_bad_at: string | null;
    observed_at: string;
  } | null;
};

const STATUS_TONE: Record<string, "neutral" | "accent" | "hot" | "warm" | "info"> = {
  healthy: "accent",
  degraded: "warm",
  down: "hot",
  unknown: "neutral",
};

const COMPONENT_LABEL: Record<string, string> = {
  uptime: "Uptime",
  error_rate: "Error rate",
  latency: "Latency",
  outcome: "Outcome",
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function ScoreBar({ score, status }: { score: number; status: string }) {
  const color =
    status === "healthy"
      ? "bg-emerald-500"
      : status === "degraded"
        ? "bg-amber-500"
        : status === "down"
          ? "bg-rose-500"
          : "bg-neutral-400";
  return (
    <div
      className="h-1.5 w-full rounded-full bg-neutral-200/60 dark:bg-neutral-700/60 overflow-hidden"
      role="img"
      aria-label={`Health score ${pct(score)}, ${status}`}
    >
      <div className={`h-full ${color}`} style={{ width: `${Math.max(2, score * 100)}%` }} />
    </div>
  );
}

function CheckCard({ row }: { row: HealthCheckRow }) {
  const [open, setOpen] = useState(false);
  const s = row.status;
  const status = s?.status ?? "unknown";
  const score = s?.score ?? 0;
  const components = s?.breakdown?.components ?? {};
  const excluded = s?.breakdown?.excluded ?? [];

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full text-left"
      >
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            {open ? (
              <ChevronDown className="w-3.5 h-3.5 shrink-0 text-fg-muted" aria-hidden />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 shrink-0 text-fg-muted" aria-hidden />
            )}
            <span className="font-medium text-sm truncate">{row.feature}</span>
            <span className="text-[10px] text-fg-muted font-mono truncate">{row.check_key}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-sm font-semibold tabular-nums">{pct(score)}</span>
            <Tag tone={STATUS_TONE[status]}>{status}</Tag>
          </div>
        </div>
        <ScoreBar score={score} status={status} />
      </button>

      {open && (
        <div className="mt-3 space-y-2 text-xs">
          {/* Explains the otherwise confusing "60% but DOWN" case: the average
              survived, but the component carrying most of the weight is at
              zero, so the average was hiding a dead feature. */}
          {s?.breakdown?.dominantFailure && (
            <p className="text-rose-600 dark:text-rose-400">
              <strong>{COMPONENT_LABEL[s.breakdown.dominantFailure] ?? s.breakdown.dominantFailure}</strong>{" "}
              is at zero and carries most of the weight, so this is DOWN regardless of the{" "}
              {pct(score)} average. The other components staying green is what a silent failure
              looks like.
            </p>
          )}
          {s?.error && (
            <p className="text-amber-600 dark:text-amber-400">
              Observer error: {s.error}. Status is <strong>unknown</strong>, not down — the monitor
              could not look, which says nothing about the feature.
            </p>
          )}
          {Object.entries(components).map(([key, c]) => (
            <div key={key} className="flex items-center justify-between gap-2">
              <span className="text-fg-muted">{COMPONENT_LABEL[key] ?? key}</span>
              <span className="tabular-nums">
                {pct(c.normalized)}
                <span className="text-fg-muted"> × {pct(c.effectiveWeight)} weight</span>
              </span>
            </div>
          ))}
          {excluded.length > 0 && (
            <p className="text-fg-muted">
              Excluded (not reported by this check, so its weight was redistributed):{" "}
              {excluded.map((e) => COMPONENT_LABEL[e] ?? e).join(", ")}
            </p>
          )}
          {s && s.consecutive_bad > 0 && (
            <p className="text-fg-muted">{s.consecutive_bad} consecutive bad ticks.</p>
          )}
          {row.notes && <p className="text-fg-muted italic">{row.notes}</p>}
        </div>
      )}
    </div>
  );
}

export function FeatureHealthGrid({ rows }: { rows: HealthCheckRow[] }) {
  const bySurface = rows.reduce<Record<string, HealthCheckRow[]>>((acc, r) => {
    (acc[r.surface] ||= []).push(r);
    return acc;
  }, {});

  // Worst first. An admin opening this page needs the fire, not the alphabet.
  const rank: Record<string, number> = { down: 0, degraded: 1, unknown: 2, healthy: 3 };

  return (
    <div className="space-y-4">
      {Object.entries(bySurface).map(([surface, items]) => (
        <Card key={surface} title={surface}>
          <div className="space-y-2">
            {[...items]
              .sort(
                (a, b) =>
                  (rank[a.status?.status ?? "unknown"] ?? 9) -
                    (rank[b.status?.status ?? "unknown"] ?? 9) ||
                  (a.status?.score ?? 0) - (b.status?.score ?? 0),
              )
              .map((r) => (
                <CheckCard key={r.check_key} row={r} />
              ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
