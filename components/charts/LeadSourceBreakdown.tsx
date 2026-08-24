"use client";

/**
 * LeadSourceBreakdown — origination attribution for the Metrics surface.
 *
 * Renders GET /api/metrics/lead-sources as a segmented donut (share of leads by
 * channel) plus a stacked daily bar chart (volume over time). Client-fetched
 * because the range selector is interactive; the endpoint is `no-store` so
 * every range switch reads live.
 *
 * FOUR STATES, ALL DISTINCT ON PURPOSE:
 *   loading   — skeleton
 *   error     — LOUD and red. Never a zero chart: an all-zero donut is
 *               indistinguishable from a real quiet day and would hide an
 *               outage behind a plausible dashboard.
 *   empty     — explicit "no leads in this window" copy
 *   truncated — data rendered, but with a visible warning that the scan cap
 *               was hit and older days are under-counted. No silent caps.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import {
  LEAD_SOURCE_ORDER,
  LEAD_SOURCE_LABELS,
  type LeadSource,
} from "@/lib/forms/lead-source";

// ---------------------------------------------------------------------------
// Palette — semantic, not decorative. Text and Dial are the two real channels
// and get the two accent hues; Unknown is deliberately drab so an untagged
// slice reads as a gap in instrumentation rather than a third channel.
// ---------------------------------------------------------------------------

const COLORS: Record<LeadSource, string> = {
  text: "#3b82f6", // accent (OASIS blue)
  dial: "#10b981", // status-engaged
  unknown: "#4b5563", // status-dormant
};

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

// ---------------------------------------------------------------------------
// Response shape (mirrors app/api/metrics/lead-sources/route.ts)
// ---------------------------------------------------------------------------

type Totals = Record<LeadSource, number>;
type DailyRow = { date: string } & Totals & { total: number };

type MetricsResponse = {
  ok: true;
  range: { days: number; since: string; timezone: string; dates: string[] };
  totals: Totals & { total: number };
  percentages: Totals;
  daily: DailyRow[];
  meta: {
    scanned: number;
    counted: number;
    undated: number;
    scan_cap: number;
    truncated: boolean;
    generated_at: string;
    duration_ms: number;
  };
};

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: MetricsResponse };

// ---------------------------------------------------------------------------
// Segmented donut
// ---------------------------------------------------------------------------

function SegmentedDonut({
  segments,
  total,
  size = 168,
  stroke = 18,
}: {
  segments: Array<{ key: LeadSource; pct: number }>;
  total: number;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const GAP = 3; // arc-length gap between adjacent segments

  const drawn = segments.filter((s) => s.pct > 0);
  let cursor = 0;

  return (
    <div
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} role="img" aria-label="Lead share by origination channel">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#22262e"
          strokeWidth={stroke}
        />
        {drawn.map((s) => {
          const len = (s.pct / 100) * circ;
          // Only carve a gap when the segment can spare it — a 1% sliver must
          // stay visible rather than being eaten by the separator.
          const visible = len > GAP * 2 ? len - GAP : len;
          const el = (
            <circle
              key={s.key}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={COLORS[s.key]}
              strokeWidth={stroke}
              strokeDasharray={`${visible} ${circ - visible}`}
              strokeDashoffset={-cursor}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              style={{ transition: "stroke-dasharray .6s ease, stroke-dashoffset .6s ease" }}
            >
              <title>{`${LEAD_SOURCE_LABELS[s.key]} — ${s.pct.toFixed(1)}%`}</title>
            </circle>
          );
          cursor += len;
          return el;
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="text-2xl font-bold text-fg tabular-nums">{total.toLocaleString()}</span>
        <span className="mt-1 text-[9px] font-bold uppercase tracking-[0.14em] text-fg-dim">
          {total === 1 ? "Lead" : "Leads"}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stacked daily bars
// ---------------------------------------------------------------------------

function shortDate(iso: string): string {
  // iso is already YYYY-MM-DD in the API's bucket timezone. Parse the parts
  // directly — `new Date("2026-08-24")` would re-interpret it as UTC midnight
  // and shift the label back a day for anyone west of Greenwich.
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function DailyStack({ daily }: { daily: DailyRow[] }) {
  const max = Math.max(1, ...daily.map((d) => d.total));
  // Keep the axis readable at 90 days without dropping bars.
  const labelEvery = daily.length > 45 ? 10 : daily.length > 14 ? 5 : 2;

  return (
    <div className="space-y-2">
      <div className="flex h-40 items-end gap-[3px]">
        {daily.map((d, i) => {
          const heightPct = (d.total / max) * 100;
          const tip = `${d.date} · ${d.total} lead${d.total === 1 ? "" : "s"} — ${LEAD_SOURCE_ORDER.map(
            (k) => `${LEAD_SOURCE_LABELS[k]} ${d[k]}`,
          ).join(", ")}`;
          return (
            <div
              key={d.date}
              className="group relative flex h-full flex-1 flex-col justify-end"
              title={tip}
            >
              {d.total === 0 ? (
                <div className="h-[2px] w-full rounded-full bg-bg-border" />
              ) : (
                <div
                  className="flex w-full flex-col-reverse overflow-hidden rounded-t-[3px] ring-0 ring-accent/50 transition-all group-hover:ring-2"
                  style={{ height: `${heightPct}%`, minHeight: 3 }}
                >
                  {LEAD_SOURCE_ORDER.map((k) =>
                    d[k] > 0 ? (
                      <div
                        key={k}
                        style={{
                          height: `${(d[k] / d.total) * 100}%`,
                          backgroundColor: COLORS[k],
                        }}
                      />
                    ) : null,
                  )}
                </div>
              )}
              {i % labelEvery === 0 && (
                <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[9px] tabular-nums text-fg-dim">
                  {shortDate(d.date)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="h-4" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function LeadSourceBreakdown() {
  const [range, setRange] = useState<Range>(30);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const ac = new AbortController();
    setLoad({ status: "loading" });
    (async () => {
      try {
        const res = await fetch(`/api/metrics/lead-sources?days=${range}`, {
          signal: ac.signal,
          cache: "no-store",
        });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.ok) {
          setLoad({
            status: "error",
            message:
              body?.error === "unauthorized"
                ? "Your session expired. Reload the page to sign back in."
                : `${body?.error || `HTTP ${res.status}`}${body?.detail ? ` — ${body.detail}` : ""}`,
          });
          return;
        }
        setLoad({ status: "ready", data: body as MetricsResponse });
      } catch (err) {
        if (ac.signal.aborted) return;
        setLoad({
          status: "error",
          message: err instanceof Error ? err.message : "Network request failed",
        });
      }
    })();
    return () => ac.abort();
  }, [range, nonce]);

  return (
    <div className="space-y-5">
      {/* Range selector ---------------------------------------------------- */}
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-bg-border text-[11px]">
          {RANGES.map((r, i) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 font-bold transition-colors ${
                i > 0 ? "border-l border-bg-border" : ""
              } ${range === r ? "bg-bg-elev text-fg" : "text-fg-muted hover:text-fg"}`}
            >
              {r}d
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex items-center gap-1.5 rounded-md border border-bg-border px-2.5 py-1.5 text-[11px] font-bold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg"
        >
          <RefreshCw className={`h-3 w-3 ${load.status === "loading" ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {load.status === "loading" && <Skeleton />}

      {load.status === "error" && (
        <div className="flex items-start gap-3 rounded-lg border border-status-hot/40 bg-status-hot/10 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-hot" />
          <div className="space-y-1">
            <div className="text-xs font-bold text-status-hot">
              Could not load lead source metrics
            </div>
            <div className="text-xs leading-relaxed text-fg-muted">
              {load.message}. Nothing is charted on purpose: an empty chart here would look
              like a quiet day instead of a broken read.
            </div>
          </div>
        </div>
      )}

      {load.status === "ready" && <Ready data={load.data} range={range} />}
    </div>
  );
}

function Ready({ data, range }: { data: MetricsResponse; range: Range }) {
  const { totals, percentages, daily, meta } = data;

  if (totals.total === 0) {
    return (
      <div className="rounded-lg border border-dashed border-bg-border px-4 py-10 text-center">
        <div className="text-xs font-bold text-fg-muted">No leads in the last {range} days</div>
        <div className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-fg-dim">
          Once a merchant submits through a tagged link, their channel shows up here. Grab the
          Text and Dial links from the Forms page.
        </div>
      </div>
    );
  }

  const segments = LEAD_SOURCE_ORDER.map((k) => ({ key: k, pct: percentages[k] }));
  const tagged = totals.text + totals.dial;
  const coverage = totals.total > 0 ? (tagged / totals.total) * 100 : 0;

  return (
    <div className="space-y-5">
      {meta.truncated && (
        <div className="flex items-start gap-2.5 rounded-lg border border-status-warm/40 bg-status-warm/10 p-3">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warm" />
          <div className="text-[11px] leading-relaxed text-fg-muted">
            Hit the {meta.scan_cap.toLocaleString()}-row scan cap. The most recent days are
            accurate; older days in this window are <strong className="text-fg">under-counted</strong>.
            Narrow the range, or move this metric to a nightly pre-aggregate.
          </div>
        </div>
      )}

      {/* Donut + legend ---------------------------------------------------- */}
      <div className="flex flex-col items-center gap-7 sm:flex-row sm:items-center">
        <SegmentedDonut segments={segments} total={totals.total} />

        <div className="w-full flex-1 space-y-2.5">
          {LEAD_SOURCE_ORDER.map((k) => (
            <div key={k} className="flex items-center gap-3">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: COLORS[k] }}
              />
              <span className="w-16 shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
                {LEAD_SOURCE_LABELS[k]}
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-elev">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${percentages[k]}%`,
                    backgroundColor: COLORS[k],
                    transition: "width .6s ease",
                  }}
                />
              </div>
              <span className="w-12 shrink-0 text-right text-xs font-bold tabular-nums text-fg">
                {percentages[k].toFixed(1)}%
              </span>
              <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-fg-dim">
                {totals[k].toLocaleString()}
              </span>
            </div>
          ))}

          <div className="border-t border-bg-border pt-2.5 text-[10px] leading-relaxed text-fg-dim">
            {coverage.toFixed(0)}% of leads carried a channel tag.
            {totals.unknown > 0 && (
              <>
                {" "}
                The {totals.unknown.toLocaleString()} untagged came in through a link with no{" "}
                <code className="font-mono text-fg-muted">?source=</code> on it.
              </>
            )}
          </div>
        </div>
      </div>

      {/* Daily volume ------------------------------------------------------ */}
      <div className="space-y-2.5 border-t border-bg-border pt-5">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
          Daily volume
        </div>
        <DailyStack daily={daily} />
      </div>

      <div className="text-[10px] text-fg-faint">
        {meta.counted.toLocaleString()} leads · {data.range.timezone} days · generated in{" "}
        {meta.duration_ms}ms
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-5">
      <div className="flex flex-col items-center gap-7 sm:flex-row">
        <div className="h-[168px] w-[168px] shrink-0 rounded-full border-[18px] border-bg-elev" />
        <div className="w-full flex-1 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-3 rounded bg-bg-elev" />
          ))}
        </div>
      </div>
      <div className="h-40 rounded bg-bg-elev/60" />
    </div>
  );
}
