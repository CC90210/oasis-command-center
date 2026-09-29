/**
 * FounderToday — the owner's Today: the OASIS OS morning brief (2026-09-28).
 *
 * WHAT IT IS NOW. Greeting and the Ask composer, then Needs you (approval
 * cards first — lib/os/approvals, scoped to this viewer's workspace and
 * departments — then follow-ups past due, tickets past SLA, hot replies,
 * overdue invoices, connections that need attention), one card per
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
 * departments their rail shows (mayOpenOsHref — the rail's own answer), via
 * briefPlanFor. A block the plan refuses is never loaded, and every loader
 * returns "could not find out" rather than a zero when it fails. The Needs-you
 * reads live in components/os/today/brief-load.ts, shared with the Chief of
 * Staff tab; cash is read there only behind the `showFinancials` passed from
 * here.
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
  cashView,
  firstName,
  goalPaceView,
  greetingFor,
  usd,
} from "@/components/os/today/model";
import { loadCalendarStatus, loadContentWeek } from "@/components/os/today/loaders";
import { briefPlanFor, loadNeedsYouReads, needsYouFrom, operatorDayAt } from "@/components/os/today/brief-load";
import { operatorParts } from "@/lib/dates";
import { loadOasisMoney } from "@/lib/goals/oasis-money";
import { resolveOsModules } from "@/lib/os/modules";
import { ASK_HREF, mayOpenOsHref, type BuildOsNavInput } from "@/lib/os/nav";
import { isOasisSurfaceTenant, type Persona, type SurfaceCapabilities } from "@/lib/role-surfaces";
import type { UserProfile } from "@/lib/supabase";

/** Where a viewer connects their own Google Calendar today (Settings › Personal). */
const CALENDAR_CONNECT_HREF = "/settings";
/** Approval cards drawn inline on Today (design doc §(c) Today, 2); the rest are in the Feed. */
const TODAY_APPROVALS_SHOWN = 5;
const FEED_HREF = "/feed";

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
  const { departments, plan } = briefPlanFor(viewer, navInput);
  const showFinancials = financialsAllowed && plan.money;

  const now = new Date();
  const day = operatorDayAt(now);

  // Every block starts at once. None of these promises rejects: each loader
  // resolves to a value, a failure marker, or null when its block is refused.
  // The Needs-you reads (pipeline, support, inbound, cash, approvals,
  // connections, routines) are the SAME call the Chief of Staff tab makes
  // (components/os/today/brief-load.ts), so the two cannot count differently.
  const needsP = loadNeedsYouReads({ viewer, navInput, plan, showFinancials, day, approvalsLimit: TODAY_APPROVALS_SHOWN });
  const contentP = plan.content ? loadContentWeek(tenantId) : Promise.resolve(null);
  const calendarP = loadCalendarStatus(tenantId, viewer.userId, isOasisSurfaceTenant(viewer.tenantSlug));

  // The money block. Entered only when the capability says so — the point of
  // the branch is that these reads never happen otherwise, not that their
  // results get dropped afterwards. lib/goals/oasis-money is the same loader
  // /analytics uses; its figures are the Finances ledger and live Stripe.
  const money = showFinancials ? await loadOasisMoney(tenantId, "today") : null;
  const [reads, content, calendar] = await Promise.all([needsP, contentP, calendarP]);
  const { sales, delivery, cash, routines } = reads;

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
  const needsYou = needsYouFrom(reads, day.nowMs);
  const cards = buildDepartmentCards({
    departments,
    needsYou,
    sales,
    delivery,
    content,
    goal,
    stripeConnected: money?.stripeConnected ?? null,
    routines,
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
      feedHref={mayOpenOsHref(navInput, FEED_HREF) ? `${FEED_HREF}?tab=needs` : null}
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
