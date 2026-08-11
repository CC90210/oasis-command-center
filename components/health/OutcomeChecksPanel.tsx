/**
 * OutcomeChecksPanel — the outcome health checks, and what is currently paging.
 *
 * These checks have run every 15 minutes since 2026-08-07 and written to
 * `health_check_runs`, and until now nothing read that table. The checks built
 * to catch silent failure were themselves invisible.
 *
 * PURE PRESENTER. The reads live in lib/health/outcome-panel-data.ts because
 * the PAGE has to count the same signals into its header verdict — otherwise
 * "All clear" renders directly above a card reporting a failing check. One read
 * feeds both, so the two halves of the page cannot disagree about the same
 * moment.
 */

import { AlertTriangle, CheckCircle2, CircleHelp, Clock, ShieldAlert } from "lucide-react";
import { failingForHours, ladderLabel, type OpenAlert, type PanelRow, type Tone } from "@/lib/health/panel-core";

const TONE_CLS: Record<Tone, string> = {
  good: "bg-emerald-500/15 text-emerald-400",
  warn: "bg-amber-500/15 text-amber-400",
  bad: "bg-rose-500/15 text-rose-400",
  unknown: "bg-bg-elev text-fg-dim",
};

function ToneIcon({ tone }: { tone: Tone }) {
  if (tone === "good") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (tone === "bad") return <AlertTriangle className="h-3.5 w-3.5" />;
  if (tone === "warn") return <ShieldAlert className="h-3.5 w-3.5" />;
  return <CircleHelp className="h-3.5 w-3.5" />;
}

export function OutcomeChecksPanel({
  rows,
  openAlerts,
  readFailed,
  readError,
  now,
}: {
  rows: PanelRow[];
  openAlerts: OpenAlert[];
  readFailed: boolean;
  readError: string | null;
  now: number;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-fg">Outcome checks</h2>
        <span className="text-[11px] text-fg-dim">
          Do merchants actually receive things, measured in the data. Runs every 15 minutes.
        </span>
      </div>

      {/* A read failure is NOT an empty state. Rendering "all clear" because the
          query broke is the precise failure this panel exists to surface. */}
      {readFailed && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Could not read health results ({readError}). This panel is blind right now — treat it as unknown, not
            healthy.
          </span>
        </div>
      )}

      {openAlerts.length > 0 && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-3">
          <div className="text-[11px] font-bold uppercase tracking-wide text-rose-400">
            Open alerts ({openAlerts.length})
          </div>
          <ul className="mt-2 space-y-1.5">
            {openAlerts.map((a) => {
              const hrs = failingForHours(a, now);
              return (
                <li key={a.alertKey} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono text-fg">{a.alertKey}</span>
                  <span className="text-fg-muted">
                    failing {hrs === null ? "for an unknown time" : `${hrs}h`}
                  </span>
                  {/* Showing the ladder stops an operator reading throttled
                      silence as "it got fixed". */}
                  <span className="rounded bg-bg-elev px-1.5 py-0.5 text-[10px] text-fg-dim">
                    repeating {ladderLabel(a, now)} · sent {a.repeatN}x
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!readFailed && rows.length === 0 ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-xs text-amber-400">
          No check has ever recorded a result. The checks run on the every-15-minute cron; if this stays empty the
          scheduler is not firing, which is a finding rather than a clean bill of health.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-bg-border">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="bg-bg-elev text-[10px] uppercase tracking-wide text-fg-dim">
              <tr>
                <th className="px-3 py-2">Check</th>
                <th className="px-3 py-2">Verdict</th>
                <th className="px-3 py-2">Observed</th>
                <th className="px-3 py-2">Normal</th>
                <th className="px-3 py-2">Last run</th>
                <th className="px-3 py-2">Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.checkId} className="border-t border-bg-border/60 align-top">
                  <td className="px-3 py-2 font-mono text-[11px] text-fg">{r.checkId}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-bold ${TONE_CLS[r.tone]}`}>
                      <ToneIcon tone={r.tone} />
                      {r.verdict === "check_broken" ? "could not run" : r.verdict}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-fg-muted">{r.observed ?? "—"}</td>
                  <td className="px-3 py-2 text-fg-dim">{r.baseline ?? "—"}</td>
                  <td className="px-3 py-2">
                    {r.freshness === "never_run" ? (
                      <span className="inline-flex items-center gap-1 text-amber-400">
                        <Clock className="h-3 w-3" /> never
                      </span>
                    ) : r.freshness === "stale" ? (
                      <span className="inline-flex items-center gap-1 text-amber-400">
                        <Clock className="h-3 w-3" /> stale
                      </span>
                    ) : (
                      <span className="text-fg-dim">
                        {r.ranAt ? new Date(r.ranAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "—"}
                      </span>
                    )}
                  </td>
                  {/* The check's own words. A rewritten reason is one an
                      operator cannot act on. */}
                  <td className="px-3 py-2 text-[11px] leading-relaxed text-fg-muted">{r.reason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
