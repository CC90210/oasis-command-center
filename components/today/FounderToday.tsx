/**
 * FounderToday — the owner's Today: the OASIS OS morning brief (2026-09-28).
 *
 * WHAT IT IS NOW. Greeting and the Ask composer, then Needs you (follow-ups
 * past due, tickets past SLA, hot replies, overdue invoices), one card per
 * department, and a right column with today's schedule, goal pace and cash.
 * The layout and the pieces live in components/os/today; this file does the
 * reading. It keeps its name and its place in app/page.tsx because
 * tests/role-surfaces.test.ts and tests/oasis-money-readers.test.ts pin the
 * dispatcher's persona order and the money gate HERE.
 *
 * THE MONEY RULE IS UNCHANGED, AND IT IS THE FETCH, NOT THE RENDER.
 * Company money — the revenue goal, collected, Stripe MRR, cash — is read only
 * when `showFinancials` says so, and then only through lib/goals/oasis-money
 * (the one reader Today and Analytics share) and the Finances Overview reader
 * behind its own finance-owner gate. When the capability is off the queries
 * never run; a dashboard silently missing its revenue reads as "the business
 * made nothing", so a degraded workspace read says why in a sentence instead.
 *
 * WHAT EACH BLOCK MAY READ is decided once, up front, by todayBriefPlan
 * (components/os/today/model.ts) from the viewer's capabilities and the
 * departments their rail shows (mayOpenOsHref — the rail's own answer). A
 * block the plan refuses is never loaded, and every loader returns "could not
 * find out" rather than a zero when it fails.
 *
 * The collected-vs-pace CHART no longer renders here: its area fill is a
 * gradient, which the OS visual rules do not allow. The pace is the bar in the
 * Goal pace glance, drawn from the same series, and the chart itself stays on
 * /analytics until it is flattened.
 */

import { GoalCountdownCard } from "@/components/GoalCountdownCard";
import type { GoalPacePoint } from "@/components/charts/GoalPaceChart";
import { LiveClock } from "@/components/LiveClock";
import { TodayBrief } from "@/components/os/today/TodayBrief";
import {
  buildDepartmentCards,
  buildNeedsYou,
  cashView,
  firstName,
  goalPaceView,
  greetingFor,
  todayBriefPlan,
  usd,
} from "@/components/os/today/model";
import {
  loadCalendarStatus,
  loadCash,
  loadContentWeek,
  loadDelivery,
  loadHotReplies,
  loadSales,
  type OperatorDay,
} from "@/components/os/today/loaders";
import { operatorDateKey, operatorDayStartIso, operatorParts } from "@/lib/dates";
import { loadOasisMoney } from "@/lib/goals/oasis-money";
import { isWebsiteSalesTenantSlug } from "@/lib/leads/canonical-lead-fields";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { resolveOsModules } from "@/lib/os/modules";
import { ASK_HREF, mayOpenOsHref, type BuildOsNavInput } from "@/lib/os/nav";
import { isOasisSurfaceTenant, type Persona, type SurfaceCapabilities } from "@/lib/role-surfaces";
import type { UserProfile } from "@/lib/supabase";

/** Where a viewer connects their own Google Calendar today (Settings › Personal). */
const CALENDAR_CONNECT_HREF = "/settings";

export async function FounderToday({
  profile,
  viewer,
  showFinancials: financialsAllowed,
  financialsNote,
}: {
  profile: UserProfile;
  /** The resolved session surface (lib/role-surfaces-session resolveViewerSurface). */
  viewer: {
    persona: Persona;
    capabilities: SurfaceCapabilities;
    tenantId: string;
    userId: string;
    tenantSlug: string | null;
  };
  /** False → the money queries are never issued. Not "issued and hidden". */
  showFinancials: boolean;
  /** Why the money is absent, in plain English. Shown only when set. */
  financialsNote?: string | null;
}) {
  const tenantId = viewer.tenantId;

  // The rail's inputs, so the brief shows exactly the departments the rail
  // does. Operator status and the founders-portal gates only decide Admin,
  // Content and Money rows, none of which is a department, so they stay closed.
  const navInput: BuildOsNavInput = {
    persona: viewer.persona,
    capabilities: viewer.capabilities,
    isOperator: false,
    tenantSlug: viewer.tenantSlug,
    isOasisTenant: isOasisSurfaceTenant(viewer.tenantSlug),
    modules: resolveOsModules({ tenantSlug: viewer.tenantSlug, provisioned: true }),
    provisioned: true,
    founders: null,
  };
  const departments = OS_DEPARTMENTS.filter((d) => mayOpenOsHref(navInput, d.href));
  const plan = todayBriefPlan({
    persona: viewer.persona,
    capabilities: viewer.capabilities,
    websiteSalesBoard: isWebsiteSalesTenantSlug(viewer.tenantSlug),
    departments: new Set(departments.map((d) => d.key)),
  });
  const showFinancials = financialsAllowed && plan.money;

  const now = new Date();
  const day: OperatorDay = {
    nowMs: now.getTime(),
    startMs: Date.parse(operatorDayStartIso(now)),
    endMs: Date.parse(operatorDayStartIso(now, 1)),
    todayKey: operatorDateKey(now),
  };

  // Every block starts at once. None of these promises rejects: each loader
  // resolves to a value, a failure marker, or null when its block is refused.
  const salesP = plan.pipeline
    ? loadSales({ source: plan.pipeline, tenantId, tenantSlug: viewer.tenantSlug, day })
    : Promise.resolve(null);
  const deliveryP = plan.delivery
    ? loadDelivery({
        persona: viewer.persona,
        tenantId,
        userId: viewer.userId,
        canAct: viewer.capabilities.canAct,
        day,
      })
    : Promise.resolve(null);
  const inboundP = plan.inbound ? loadHotReplies(tenantId, day.nowMs) : Promise.resolve(null);
  const contentP = plan.content ? loadContentWeek(tenantId) : Promise.resolve(null);
  const calendarP = loadCalendarStatus(tenantId, viewer.userId);
  const cashP = showFinancials && plan.cash ? loadCash() : Promise.resolve(null);

  // The money block. Entered only when the capability says so — the point of
  // the branch is that these reads never happen otherwise, not that their
  // results get dropped afterwards. lib/goals/oasis-money is the same loader
  // /analytics uses; its figures are the Finances ledger and live Stripe.
  const money = showFinancials ? await loadOasisMoney(tenantId, "today") : null;
  const [sales, delivery, inbound, content, calendar, cash] = await Promise.all([
    salesP,
    deliveryP,
    inboundP,
    contentP,
    calendarP,
    cashP,
  ]);

  const paceSeries: GoalPacePoint[] = money?.paceSeries ?? [];
  const goal = money
    ? goalPaceView({
        goal: money.goal,
        progress: money.progress,
        paceSeries,
        stripeConnected: money.stripeConnected,
        collected: money.collected,
      })
    : null;
  const needsYou = buildNeedsYou({ sales, delivery, inbound, cash, nowMs: day.nowMs });
  const cards = buildDepartmentCards({
    departments,
    needsYou,
    sales,
    delivery,
    content,
    goal,
    stripeConnected: money?.stripeConnected ?? null,
  });

  const name = firstName(profile.display_name || profile.full_name);
  const greeting = `${greetingFor(operatorParts(now).hour)}${name ? `, ${name}` : ""}`;
  // Restates the goal from the same row the goal card reads, so the header can
  // never name a target the card below does not.
  const mission = money?.goal ? `${usd(money.goal.target_cents)} collected by ${money.goal.period_end}` : null;

  return (
    <TodayBrief
      greeting={greeting}
      subtitle={
        <>
          <LiveClock initialDateKey={day.todayKey} />
          {mission && <> · {mission}</>}
        </>
      }
      askHref={mayOpenOsHref(navInput, ASK_HREF) ? ASK_HREF : null}
      needsYou={needsYou}
      departments={cards}
      schedule={{
        meetings: sales ? (sales.ok ? { ok: true, value: sales.value.meetingsToday } : { ok: false }) : null,
        partial: !!sales && sales.ok && sales.value.partial,
        calendar,
        connectHref: CALENDAR_CONNECT_HREF,
      }}
      goal={goal}
      cash={cash ? cashView(cash) : null}
      financialsNote={!showFinancials && financialsNote ? financialsNote : null}
      goalCard={
        money ? (
          <GoalCountdownCard
            goal={money.goal}
            progress={money.progress}
            collectedCadCents={money.collected?.cad_cents ?? null}
            fxMissingDays={money.collected?.fx_missing_days ?? []}
            stripeConnected={money.stripeConnected}
          />
        ) : null
      }
    />
  );
}
