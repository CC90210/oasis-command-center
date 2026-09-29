/**
 * Goal pace, right column of the owner's brief: is the revenue goal on pace?
 *
 * The answer at a glance — collected against the target, a bar with a mark
 * where the straight line to the deadline says today should be, days left and
 * what each remaining day needs. Every figure is the GoalPaceView built from
 * lib/goals/oasis-money (the reader Today and Analytics share) and
 * computeGoalProgress, so it cannot disagree with the full revenue-goal card
 * (components/GoalCountdownCard.tsx) further down the page, which it
 * summarises.
 *
 * A failed collected-revenue read says so; it never draws an empty bar, which
 * would read as "$0 collected".
 *
 * Server component, no hooks. The bar is two flat fills: no gradient, no glow.
 */
import Link from "next/link";
import { usd, type GoalPaceView } from "@/components/os/today/model";

const STATUS_TEXT: Record<Extract<GoalPaceView, { kind: "live" }>["status"], string> = {
  met: "text-status-engaged",
  on_track: "text-fg",
  behind: "text-status-warm",
  missed: "text-status-hot",
  upcoming: "text-fg-muted",
};

export function GoalPaceGlance({ view, detailHref }: { view: GoalPaceView; detailHref: string }) {
  return (
    <section aria-labelledby="goal-pace-heading" className="rounded-xl border border-hairline bg-bg-panel">
      <header className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-3">
        <h2 id="goal-pace-heading" className="text-sm font-semibold text-fg">
          Goal pace
        </h2>
        {view.kind === "live" && (
          <a href={detailHref} className="text-xs font-medium text-accent hover:underline">
            Details
          </a>
        )}
      </header>
      <div className="px-4 py-3">
        {view.kind === "no_goal" ? (
          <p className="text-[13px] text-fg-muted">
            No revenue goal is set for this period.{" "}
            <Link href="/settings" prefetch={false} className="font-medium text-accent hover:underline">
              Set one in Settings
            </Link>
          </p>
        ) : view.kind === "error" ? (
          <p className="text-[13px] text-status-warm">
            Couldn&rsquo;t count revenue collected toward {view.label}. This is a failed read, not $0 collected.
          </p>
        ) : (
          <LivePace view={view} />
        )}
      </div>
    </section>
  );
}

function LivePace({ view }: { view: Extract<GoalPaceView, { kind: "live" }> }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[13px] text-fg-muted">{view.label}</span>
        <span className={`shrink-0 text-xs font-medium ${STATUS_TEXT[view.status]}`}>{view.statusLabel}</span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold leading-8 tracking-tight text-fg tabular-nums">{usd(view.collectedCents)}</span>
        <span className="text-[13px] text-fg-muted">of {usd(view.targetCents)} USD</span>
      </div>
      <div
        className="relative mt-3 h-1.5 rounded-full bg-bg-elev"
        role="img"
        aria-label={`${Math.round(view.pct)}% collected${
          view.pacePct !== null ? `; the straight line to the deadline is at ${Math.round(view.pacePct)}% today` : ""
        }`}
      >
        <div className="h-full rounded-full bg-fg-muted" style={{ width: `${view.pct}%` }} />
        {view.pacePct !== null && (
          <div
            aria-hidden
            className="absolute -top-1 h-3.5 w-0.5 rounded-full bg-fg"
            style={{ left: `calc(${view.pacePct}% - 1px)` }}
          />
        )}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-fg-dim">Days left</dt>
          <dd className="mt-0.5 text-sm font-medium text-fg tabular-nums">{view.daysLeft}</dd>
        </div>
        <div>
          <dt className="text-fg-dim">Needed per day</dt>
          <dd className="mt-0.5 text-sm font-medium text-fg tabular-nums">
            {view.dailyNeedCents > 0 ? usd(view.dailyNeedCents) : "—"}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-fg-dim">Deadline {view.periodEnd}. The mark on the bar is where pace says today should be.</p>
      {view.caveats.map((c) => (
        <p key={c} className="mt-2 text-xs text-status-warm">
          {c}
        </p>
      ))}
    </div>
  );
}
