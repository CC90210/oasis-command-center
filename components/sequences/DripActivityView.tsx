"use client";

/**
 * DripActivityView — what the drip engine ACTUALLY sent.
 *
 * The templates tab answers "what would we send". This answers "what did we",
 * which until now had no surface at all: the only way to know whether a
 * sequence had reached anybody was to query drip_runs by hand.
 *
 * THE ONE RULE THIS SCREEN ENFORCES. It never renders `drip_runs.status`
 * verbatim. Measured 2026-08-10, 864 of 1,348 rows marked 'sent' had a NULL
 * from_identity and had merely ADVANCED without contacting a provider. Showing
 * that column raw would tell an operator 1,348 messages went out when 484 did.
 * Every status here comes from classifyRunStatus, and the failure rate is
 * computed over real sends only.
 *
 * Holds are shown apart from failures on purpose. "No lawful basis to text" and
 * "Bluerise has no numbers yet" are policy working correctly; counting them as
 * errors would make a healthy compliance gate look like an outage and train
 * whoever reads this to ignore the number.
 */

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Clock,
  Mail,
  MessageSquare,
  PauseCircle,
  ShieldCheck,
} from "lucide-react";
import type { ActivityStatus } from "@/lib/drips/activity-core";
import { OPERATOR_TIME_ZONE } from "@/lib/dates";

export type ActivityRow = {
  id: string;
  leadId: string;
  leadName: string | null;
  sequenceName: string | null;
  stepIndex: number | null;
  channel: string | null;
  brand: string;
  status: ActivityStatus;
  fromIdentity: string | null;
  error: string | null;
  heldForPolicy: boolean;
  sentAt: string | null;
  scheduledFor: string | null;
};

export type ActivitySummary = {
  realSends: number;
  failed: number;
  skipped: number;
  dryRun: number;
  failureRatePct: number | null;
  heldForPolicy: number;
  /** The summary read hit its row cap, so these counts are over a PARTIAL
   *  sample. A partial count rendered as fact is the same false denominator
   *  this screen exists to prevent. */
  truncated?: boolean;
};

const STATUS_STYLE: Record<ActivityStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  sent: { label: "Sent", cls: "bg-emerald-500/15 text-emerald-400", Icon: CheckCircle2 },
  failed: { label: "Failed", cls: "bg-rose-500/15 text-rose-400", Icon: AlertTriangle },
  skipped: { label: "Skipped", cls: "bg-amber-500/15 text-amber-400", Icon: CircleSlash },
  dry_run: { label: "Dry run", cls: "bg-sky-500/15 text-sky-400", Icon: ShieldCheck },
  scheduled: { label: "Scheduled", cls: "bg-bg-elev text-fg-muted", Icon: Clock },
  sending: { label: "Sending", cls: "bg-sky-500/15 text-sky-400", Icon: Clock },
  cancelled: { label: "Cancelled", cls: "bg-bg-elev text-fg-dim", Icon: PauseCircle },
  unknown: { label: "Unknown", cls: "bg-bg-elev text-fg-dim", Icon: CircleSlash },
};

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // Locale and zone are PINNED. This is a client component that Next
  // pre-renders, and `undefined` resolves to the server's locale during SSR and
  // the browser's on hydration -- different text for the same row. The zone is
  // the operator's, not the viewer's, so a timestamp means the same thing to
  // everyone reading the same board.
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: OPERATOR_TIME_ZONE,
  });
}

function Tile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "good" | "bad" | "warn";
}) {
  const toneCls =
    tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-rose-400" : tone === "warn" ? "text-amber-400" : "text-fg";
  return (
    <div className="rounded-lg border border-bg-border bg-bg-elev/50 p-3">
      <div className="text-[10px] font-bold uppercase tracking-wide text-fg-dim">{label}</div>
      <div className={`mt-1 text-xl font-bold ${toneCls}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-fg-dim">{hint}</div>}
    </div>
  );
}

export function DripActivityView({
  rows,
  summary,
  readError = null,
}: {
  rows: ActivityRow[];
  summary: ActivitySummary;
  /** Set when the READ failed. Not the same as an empty window, and the two must
   *  never render alike: one says nothing was sent, the other says we do not
   *  know what was sent. */
  readError?: string | null;
}) {
  const [channel, setChannel] = useState<"all" | "email" | "sms">("all");
  const [status, setStatus] = useState<"all" | ActivityStatus>("all");

  const sequences = useMemo(
    () => [...new Set(rows.map((r) => r.sequenceName).filter(Boolean) as string[])].sort(),
    [rows],
  );
  const [sequence, setSequence] = useState<string>("all");

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (channel === "all" || r.channel === channel) &&
          (status === "all" || r.status === status) &&
          (sequence === "all" || r.sequenceName === sequence),
      ),
    [rows, channel, status, sequence],
  );

  return (
    <div className="space-y-4">
      {/* A FAILED READ IS NOT A QUIET DAY. Without this the page degrades to
          zeroed tiles and "no drip steps in this window" — telling the operator
          nothing was sent when the truth is that we could not find out. Zero
          failures is also the most reassuring number here, which makes a
          silently-zeroed summary the worst possible way to fail. */}
      {readError && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {readError}. The numbers and the table below are UNKNOWN, not zero — do not read this as a quiet window.
          </span>
        </div>
      )}

      {summary.truncated && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            More rows in this window than the summary reads at once. These counts are over a partial sample — treat them
            as a floor, not a total.
          </span>
        </div>
      )}

      {/* Basic numbers only. Opens, clicks and per-variant performance live in
          /metrics; a second copy here would just disagree with the first. */}
      <div className={`grid grid-cols-2 gap-3 md:grid-cols-5 ${readError ? "opacity-40" : ""}`}>
        <Tile label="Sent (24h)" value={String(summary.realSends)} hint="reached a provider" tone="good" />
        <Tile label="Failed (24h)" value={String(summary.failed)} tone={summary.failed > 0 ? "bad" : "neutral"} />
        <Tile
          label="Failure rate (24h)"
          // Null means nothing to judge. Rendering "0%" from an empty sample is
          // a false green, which is the exact thing this build exists to stop.
          value={summary.failureRatePct === null ? "—" : `${summary.failureRatePct}%`}
          hint="of real sends"
          tone={summary.failureRatePct === null ? "neutral" : summary.failureRatePct > 10 ? "bad" : "good"}
        />
        <Tile label="Held by policy (24h)" value={String(summary.heldForPolicy)} hint="consent / no channel" tone="warn" />
        {/* Every tile names its window. The table below is 7 days; an
            unlabelled tile next to it reads as the same period and quietly
            answers a different question. */}
        <Tile label="Skipped (24h)" value={String(summary.skipped)} hint="advanced, never sent" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Filter by channel"
          value={channel}
          onChange={(e) => setChannel(e.target.value as typeof channel)}
          className="rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg"
        >
          <option value="all">All channels</option>
          <option value="email">Email</option>
          <option value="sms">SMS</option>
        </select>
        <select
          aria-label="Filter by outcome"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          className="rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg"
        >
          <option value="all">All outcomes</option>
          {(Object.keys(STATUS_STYLE) as ActivityStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_STYLE[s].label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by sequence"
          value={sequence}
          onChange={(e) => setSequence(e.target.value)}
          className="rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg"
        >
          <option value="all">All sequences</option>
          {sequences.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-fg-dim">
          {filtered.length} of {rows.length} steps, last 7 days
        </span>
      </div>

      {filtered.length === 0 ? (
        // Honest empty state. "No activity" is a real and important answer —
        // the dispatcher went four days without claiming a row and every
        // surface looked fine.
        <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-8 text-center">
          {readError ? (
            <>
              <p className="text-sm font-semibold text-fg">Activity could not be read</p>
              <p className="mt-1 text-xs text-fg-muted">
                This is not an empty window. Nothing here should be read as evidence that nothing was sent.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-fg">No drip steps in this window</p>
              <p className="mt-1 text-xs text-fg-muted">
                That is a finding, not a blank. If sequences are live and enrolment is running, steps should appear here.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-bg-border">
          <table className="w-full min-w-[880px] text-left text-xs">
            <thead className="bg-bg-elev text-[10px] uppercase tracking-wide text-fg-dim">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Lead</th>
                <th className="px-3 py-2">Sequence</th>
                <th className="px-3 py-2">Ch</th>
                <th className="px-3 py-2">Brand</th>
                <th className="px-3 py-2">Outcome</th>
                <th className="px-3 py-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const s = STATUS_STYLE[r.status];
                return (
                  <tr key={r.id} className="border-t border-bg-border/60 align-top">
                    <td className="whitespace-nowrap px-3 py-2 text-fg-muted">{when(r.sentAt || r.scheduledFor)}</td>
                    <td className="px-3 py-2">
                      <a href={`/leads/${r.leadId}`} className="text-accent hover:underline">
                        {r.leadName || r.leadId.slice(0, 8)}
                      </a>
                    </td>
                    <td className="px-3 py-2 text-fg-muted">
                      {r.sequenceName || "—"}
                      {r.stepIndex !== null && <span className="text-fg-dim"> · step {r.stepIndex}</span>}
                    </td>
                    <td className="px-3 py-2">
                      {/* An unrecognised or missing channel must NOT fall
                          through to the Mail icon. Stating a delivery channel
                          the data does not support is presenting an unresolved
                          value as a resolved one, which is the failure this
                          screen exists to end. */}
                      {r.channel === "sms" ? (
                        <MessageSquare className="h-3.5 w-3.5 text-fg-muted" />
                      ) : r.channel === "email" ? (
                        <Mail className="h-3.5 w-3.5 text-fg-muted" />
                      ) : (
                        <span className="text-[10px] font-bold text-amber-400" title={`unknown channel: ${r.channel ?? "null"}`}>
                          ?
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-fg-muted">{r.brand === "bluerise" ? "Bluerise" : "SunBiz"}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-bold ${s.cls}`}>
                        <s.Icon className="h-3 w-3" />
                        {r.heldForPolicy ? "Held" : s.label}
                      </span>
                    </td>
                    {/* The provider's own words. A paraphrased error is an
                        undiagnosable one. */}
                    <td className="px-3 py-2 font-mono text-[10px] leading-relaxed text-fg-dim">
                      {r.error ? r.error.slice(0, 160) : r.fromIdentity || "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
