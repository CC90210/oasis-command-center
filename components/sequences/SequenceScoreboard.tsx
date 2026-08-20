"use client";

/**
 * SequenceScoreboard — one card per sequence, answering "is this working".
 *
 * Adon, 2026-08-20: "I don't even see the eleven ones that you texted... we
 * need to fix up the drips tab to make it more visual so that I can see
 * everything a lot easier." The eleven were on the tab, at rows 18-52 of a
 * ~600-row table behind a dropdown. This is the layer above that table: every
 * sequence, always visible, with the number that matters largest.
 *
 * WHAT THE BIG NUMBER IS. For texts it is the CARRIER'S verdict, not ours.
 * TextTorrent returns 201 for a message the carrier then refuses; on the day
 * this was built, Live Subs read as 11 sent and the carrier said 8 delivered
 * and 3 failed. "Sent" is shown as the smaller denominator underneath, where it
 * belongs. Email has no carrier receipt, so it shows Sent and says so rather
 * than borrowing a delivery number it cannot observe.
 *
 * Clicking a card filters the table below it, so "show me those eleven" is one
 * click instead of a dropdown hunt.
 */

import { AlertTriangle, CheckCircle2, HelpCircle, Mail, MessageSquare, Moon, PauseCircle } from "lucide-react";
import type { SequenceScore, ScoreVerdict } from "@/lib/drips/scoreboard-core";
import { verdictFor } from "@/lib/drips/scoreboard-core";
import { OPERATOR_TIME_ZONE } from "@/lib/dates";

const VERDICT: Record<ScoreVerdict, { label: string; dot: string; ring: string; Icon: typeof CheckCircle2 }> = {
  ok: { label: "Delivering", dot: "bg-emerald-400", ring: "border-emerald-500/30", Icon: CheckCircle2 },
  degraded: { label: "Some failures", dot: "bg-amber-400", ring: "border-amber-500/40", Icon: AlertTriangle },
  failing: { label: "Failing", dot: "bg-rose-400", ring: "border-rose-500/50", Icon: AlertTriangle },
  // Not a success state. This is the two-day blind spot, named on screen.
  unconfirmed: { label: "Unconfirmed", dot: "bg-sky-400", ring: "border-sky-500/40", Icon: HelpCircle },
  idle: { label: "Nothing sent", dot: "bg-fg-dim", ring: "border-bg-border", Icon: Moon },
};

function ago(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "never";
  const diff = t - Date.now();
  const mins = Math.round(Math.abs(diff) / 60_000);
  const label =
    mins < 60 ? `${mins}m` : mins < 60 * 48 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  // A scheduled row can be in the FUTURE. Saying "3h ago" about something that
  // has not happened yet is the kind of small lie that makes an operator stop
  // trusting the whole screen.
  return diff > 0 ? `in ${label}` : `${label} ago`;
}

function exact(iso: string | null): string {
  if (!iso) return "no activity in this window";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "no activity in this window";
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: OPERATOR_TIME_ZONE,
  });
}

/** A count that is zero is rendered dim, not hidden. A missing row and a zero
 *  row read identically once one of them disappears. */
function Stat({ label, value, tone = "muted" }: { label: string; value: number; tone?: "good" | "bad" | "warn" | "muted" }) {
  const cls =
    value === 0
      ? "text-fg-dim"
      : tone === "good" ? "text-emerald-400"
      : tone === "bad" ? "text-rose-400"
      : tone === "warn" ? "text-amber-400"
      : "text-fg-muted";
  return (
    <div className="flex flex-col">
      <span className={`text-sm font-bold tabular-nums ${cls}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-fg-dim">{label}</span>
    </div>
  );
}

export function SequenceScoreboard({
  scores,
  days,
  truncated = false,
  error = null,
  selected = null,
  onSelect,
}: {
  scores: SequenceScore[];
  days: number;
  truncated?: boolean;
  error?: string | null;
  selected?: string | null;
  onSelect?: (sequenceName: string | null) => void;
}) {
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-400">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Per-sequence outcomes could not be read: {error}. These are UNKNOWN, not zero. Do not read the absence of
          cards below as evidence that nothing sent.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-bold uppercase tracking-wide text-fg-muted">
          Per sequence · last {days} days
        </h3>
        {selected && (
          <button
            type="button"
            onClick={() => onSelect?.(null)}
            className="text-[11px] font-bold text-accent hover:underline"
          >
            Clear filter
          </button>
        )}
      </div>

      {truncated && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>More rows in this window than we read at once. Every number below is a floor, not a total.</span>
        </div>
      )}

      {scores.length === 0 ? (
        <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-6 text-center">
          <p className="text-sm font-semibold text-fg">No sequence activity in this window</p>
          <p className="mt-1 text-xs text-fg-muted">
            That is a finding, not a blank. If sequences are live and enrolment is running, they should appear here.
          </p>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {scores.map((s) => {
            const v = verdictFor(s);
            const style = VERDICT[v];
            const isSel = selected === s.sequenceName;
            // Whether there is a carrier verdict to show at all — driven by
            // `delivered !== null` rather than by the channel label, because a
            // `mixed` sequence (email steps AND text steps, which several live
            // ones have) still sends texts that a carrier ruled on.
            const hasReceipts = s.delivered !== null;
            // The headline: what the CARRIER confirmed for a pure text
            // sequence, what we handed to the provider otherwise. Never the
            // same number twice under two different words.
            const pureSms = s.channel === "sms";
            const headline = pureSms ? (s.delivered ?? 0) : s.sent;
            const headlineLabel = pureSms ? "delivered" : "sent";

            return (
              <button
                key={s.sequenceName}
                type="button"
                onClick={() => onSelect?.(isSel ? null : s.sequenceName)}
                aria-pressed={isSel}
                className={`rounded-lg border bg-bg-elev/50 p-3 text-left transition-colors hover:bg-bg-elev ${
                  isSel ? "border-accent ring-1 ring-accent/40" : style.ring
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {s.channel === "sms" ? (
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                      ) : s.channel === "email" ? (
                        <Mail className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                      ) : (
                        <span className="text-[10px] font-bold text-amber-400" title={`channel: ${s.channel}`}>?</span>
                      )}
                      <span className="truncate text-xs font-bold text-fg" title={s.sequenceName}>
                        {s.sequenceName}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />
                      <span className="text-[10px] text-fg-muted">{style.label}</span>
                      {/* enabled is tristate. Unknown must not render as "off". */}
                      {s.enabled === false && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-bg-border px-1 text-[9px] font-bold uppercase text-fg-dim">
                          <PauseCircle className="h-2.5 w-2.5" /> off
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-2xl font-bold leading-none tabular-nums text-fg">{headline}</div>
                    <div className="text-[9px] uppercase tracking-wide text-fg-dim">{headlineLabel}</div>
                  </div>
                </div>

                <div className="mt-3 flex items-end justify-between gap-2 border-t border-bg-border/60 pt-2">
                  {hasReceipts ? (
                    <>
                      {!pureSms && <Stat label="delivered" value={s.delivered ?? 0} tone="good" />}
                      {pureSms && <Stat label="sent" value={s.sent} />}
                      <Stat label="failed" value={s.failed} tone="bad" />
                      {/* Named on screen on purpose. This is the state that hid
                          three carrier failures for two days. */}
                      <Stat label="unconfirmed" value={s.unconfirmed} tone="warn" />
                      <Stat label="queued" value={s.queued} />
                    </>
                  ) : (
                    <>
                      <Stat label="failed" value={s.failed} tone="bad" />
                      <Stat label="held" value={s.held} tone="warn" />
                      <Stat label="queued" value={s.queued} />
                    </>
                  )}
                </div>

                <div className="mt-2 text-[10px] text-fg-dim" title={exact(s.lastActivityAt)}>
                  last activity {ago(s.lastActivityAt)}
                  {/* Confirmed-rate is over TEXT sends only, so the denominator
                      is delivered+failed+unconfirmed rather than `sent` — on a
                      mixed sequence `sent` includes emails and would silently
                      deflate the percentage. */}
                  {(() => {
                    if (s.delivered === null) return null;
                    const smsSent = s.delivered + s.unconfirmed + s.failed;
                    if (smsSent === 0) return null;
                    return <span className="ml-1">· {Math.round((s.delivered / smsSent) * 100)}% of texts confirmed</span>;
                  })()}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
