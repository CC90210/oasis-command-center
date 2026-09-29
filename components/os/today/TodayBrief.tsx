/**
 * TodayBrief — the owner's morning brief, laid out (design doc §(c) Today).
 *
 *   Good morning, CC                          (PageFrame title)
 *   [ What should the team work on today? ]   (Ask → Chief of Staff)
 *   ┌ Needs you ───────────────┐ ┌ Today's schedule ┐
 *   │ …                        │ │ Goal pace        │
 *   ├ Departments ─────────────┤ │ Cash             │
 *   │ [card] [card]            │ └──────────────────┘
 *   └ Revenue goal (full card) ┘
 *
 * Presentational only: every value arrives already read and already shaped by
 * components/os/today/model.ts, and a block this viewer may not see arrives as
 * null and is simply not drawn. Nothing here fetches, so nothing here can leak.
 *
 * The right column stacks under the main one below `xl`: at `lg` the rail
 * leaves the canvas ~750px wide, too narrow for two columns plus the goal card's
 * four tiles.
 */
import type { ReactNode } from "react";
import { PageFrame } from "@/components/os/PageFrame";
import { AskComposer } from "@/components/os/today/AskComposer";
import { NeedsYouList } from "@/components/os/today/NeedsYouList";
import { DepartmentCard } from "@/components/os/today/DepartmentCard";
import { ScheduleGlance, type ScheduleGlanceProps } from "@/components/os/today/ScheduleGlance";
import { GoalPaceGlance } from "@/components/os/today/GoalPaceGlance";
import { CashGlance } from "@/components/os/today/CashGlance";
import type { CashView, DeptCardModel, GoalPaceView, NeedsYou } from "@/components/os/today/model";

/** Anchor of the full revenue-goal card, for the Goal pace glance's "Details". */
export const REVENUE_GOAL_ANCHOR = "revenue-goal";

export type TodayBriefProps = {
  greeting: string;
  subtitle: ReactNode;
  /** Chief of Staff, when this viewer's rail has it. Null hides the composer. */
  askHref: string | null;
  needsYou: NeedsYou;
  departments: DeptCardModel[];
  schedule: ScheduleGlanceProps;
  /** Null = company money is not this viewer's (never fetched). */
  goal: GoalPaceView | null;
  /** Null = not a finance owner (never fetched). */
  cash: CashView | null;
  /** Why company money is missing when it should be there (a degraded workspace read). */
  financialsNote: string | null;
  /** The full revenue-goal card (components/GoalCountdownCard.tsx), owners only. */
  goalCard: ReactNode | null;
};

export function TodayBrief(props: TodayBriefProps) {
  return (
    <PageFrame title={props.greeting} subtitle={props.subtitle}>
      <div className="space-y-6">
        {props.askHref && <AskComposer href={props.askHref} />}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-6">
            <NeedsYouList needsYou={props.needsYou} />

            {props.departments.length > 0 && (
              <section aria-labelledby="departments-heading">
                <h2 id="departments-heading" className="mb-3 text-sm font-semibold text-fg">
                  Departments
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                  {props.departments.map((card) => (
                    <DepartmentCard key={card.key} card={card} />
                  ))}
                </div>
              </section>
            )}

            {props.goalCard && <div id={REVENUE_GOAL_ANCHOR}>{props.goalCard}</div>}
          </div>

          <aside aria-label="Today at a glance" className="min-w-0 space-y-6">
            <ScheduleGlance {...props.schedule} />
            {props.goal && <GoalPaceGlance view={props.goal} detailHref={`#${REVENUE_GOAL_ANCHOR}`} />}
            {props.cash && <CashGlance view={props.cash} />}
            {props.financialsNote && (
              <p className="rounded-xl border border-hairline bg-bg-panel px-4 py-3 text-xs text-status-warm">
                {props.financialsNote}
              </p>
            )}
          </aside>
        </div>
      </div>
    </PageFrame>
  );
}
