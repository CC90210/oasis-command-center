/**
 * The revenue-goal countdown on Today (rebuilt 2026-09-24).
 *
 * The goal is money COLLECTED in a period (a revenue_goals row), not an MRR
 * target — the old card read a hand-typed profile MRR against a hand-typed
 * target. Everything here is computed from the Finances ledger by the caller
 * and passed in; the card only presents it.
 *
 *   1. The hard numbers — collected, remaining, days left (deadline day
 *      included), and the daily amount still needed. No spin.
 *   2. A ring coloured by PACE, not by raw percentage: 30% on day 3 of 31 is
 *      ahead, 30% on day 25 is not, and a colour that ignores the calendar
 *      would call them the same.
 *
 * Renders an explicit "no goal set" state rather than nothing, so an empty
 * card never reads as "no target and nothing to do".
 */

import { Card } from "./Card";
import { CalendarClock, Flame, Target, TrendingUp } from "lucide-react";
import type { GoalProgress } from "@/lib/goals/goal-math";

const usd = (cents: number) =>
  `$${Math.round(cents / 100).toLocaleString("en-US")}`;

const STATUS_STYLE: Record<GoalProgress["status"], { ring: string; text: string; label: string }> = {
  met: { ring: "stroke-status-engaged", text: "text-status-engaged", label: "Goal met" },
  on_track: { ring: "stroke-accent", text: "text-accent", label: "On pace" },
  behind: { ring: "stroke-status-warm", text: "text-status-warm", label: "Behind pace" },
  missed: { ring: "stroke-status-hot", text: "text-status-hot", label: "Deadline passed" },
  upcoming: { ring: "stroke-bg-border", text: "text-fg-muted", label: "Not started" },
};

export function GoalCountdownCard({
  goal,
  progress,
  collectedCadCents,
  fxMissingDays,
  stripeConnected = true,
}: {
  goal: { label: string; target_cents: number; period_start: string; period_end: string } | null;
  progress: GoalProgress | null;
  /** The same collected money in CAD, as Stripe settled it. */
  collectedCadCents: number | null;
  /** Days whose payments had no FX rate on file — shown so a USD figure is never silently short. */
  fxMissingDays: string[];
  /** False: card payments are not synced yet, so "collected" is manual payments only. */
  stripeConnected?: boolean | null;
}) {
  if (!goal || !progress) {
    return (
      <Card title="Revenue goal" subtitle="No active goal">
        <p className="text-sm text-fg-muted">
          No revenue goal is set for this period. Set one in Settings → Revenue goal so Today can
          count down to it.
        </p>
      </Card>
    );
  }

  const style = STATUS_STYLE[progress.status];
  const pct = Math.max(0, Math.min(100, progress.pct));
  const radius = 52;
  const circ = 2 * Math.PI * radius;
  const dash = (pct / 100) * circ;

  return (
    <Card
      title={goal.label}
      subtitle={`${usd(goal.target_cents)} USD collected between ${goal.period_start} and ${goal.period_end} — money in the bank, net of refunds.`}
    >
      <div className="flex flex-col sm:flex-row items-center sm:items-stretch gap-6">
        <div className="relative flex-shrink-0" style={{ width: 140, height: 140 }}>
          <svg width="140" height="140" className="-rotate-90" aria-hidden>
            <circle cx="70" cy="70" r={radius} fill="none" className="stroke-bg-border" strokeWidth="8" />
            <circle
              cx="70"
              cy="70"
              r={radius}
              fill="none"
              className={`${style.ring} transition-all duration-700`}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${circ - dash}`}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={`text-2xl font-black ${style.text}`}>{progress.pct.toFixed(0)}%</span>
            <span className={`text-[10px] uppercase tracking-wider mt-0.5 ${style.text}`}>{style.label}</span>
          </div>
        </div>

        <div className="flex-1 grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile
            icon={<Target className="w-4 h-4" />}
            label="Collected"
            value={usd(progress.collected_cents)}
            hint={
              collectedCadCents === null
                ? "USD"
                : `≈ CA$${Math.round(collectedCadCents / 100).toLocaleString("en-US")} as settled`
            }
          />
          <Tile
            icon={<TrendingUp className="w-4 h-4" />}
            label="Still needed"
            value={usd(progress.remaining_cents)}
            hint={`of ${usd(goal.target_cents)} USD`}
          />
          <Tile
            icon={<Flame className="w-4 h-4" />}
            label="Days left"
            value={`${progress.days_left}`}
            hint={`deadline ${goal.period_end} (counts)`}
            urgent={progress.days_left > 0 && progress.days_left <= 7 && progress.status !== "met"}
          />
          <Tile
            icon={<CalendarClock className="w-4 h-4" />}
            label="Daily need"
            value={progress.daily_need_cents > 0 ? usd(progress.daily_need_cents) : "—"}
            hint={progress.status === "met" ? "target reached" : "per remaining day"}
          />
        </div>
      </div>
      {stripeConnected !== true && (
        <p className="mt-3 text-[11px] text-status-warm">
          {stripeConnected === false
            ? "Stripe is not connected to Finances yet, so card payments are not counted — only payments recorded by hand. Connect it in Founders → Finances → Settings → Stripe."
            : "Could not confirm the Stripe connection just now, so card payments may be missing from this figure."}
        </p>
      )}
      {fxMissingDays.length > 0 && (
        <p className="mt-3 text-[11px] text-status-warm">
          No Bank of Canada rate on file for {fxMissingDays.join(", ")} — those payments are not yet
          counted in USD. The Finances FX refresh fills this in.
        </p>
      )}
    </Card>
  );
}

function Tile({
  icon,
  label,
  value,
  hint,
  urgent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  urgent?: boolean;
}) {
  return (
    <div className={`rounded-lg border p-3 ${urgent ? "border-status-hot/40 bg-status-hot/5" : "border-bg-border bg-bg-elev"}`}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-muted">
        {icon}
        {label}
      </div>
      <div className={`text-xl font-black mt-1.5 ${urgent ? "text-status-hot" : "text-fg"}`}>{value}</div>
      {hint && <div className="text-[11px] text-fg-dim mt-0.5">{hint}</div>}
    </div>
  );
}
