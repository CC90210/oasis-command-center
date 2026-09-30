/**
 * components/os/today/brief-load.ts — the reads behind "what needs me", planned
 * and made in ONE place.
 *
 * Today (components/today/FounderToday.tsx) and the Chief of Staff tab
 * (/team/chief-of-staff, components/os/department/numbers.ts) both answer
 * "what needs me". They used to answer it from different reads and different
 * rules: on 2026-09-29 Today's Chief of Staff card said "1 item needs you"
 * (one row standing for 15 follow-ups) while the tab said nothing was waiting
 * (it counted only SLA breaches and failed routines). Both now call
 * loadNeedsYouReads with the viewer's own plan and build the list with
 * model.ts buildNeedsYou; the count is model.ts needsYouTotal.
 *
 * WHAT EACH BLOCK MAY READ is still decided by todayBriefPlan (model.ts) from
 * the viewer's capabilities and the departments their rail shows. A block the
 * plan refuses is never loaded, and company money (cash, invoices, bank lines)
 * is read only when the caller's `showFinancials` — the capability, narrowed
 * by plan.money — says so AND the plan allows cash; loadCash then applies the
 * finance-owner gate on top.
 *
 * Every loader resolves to a value, a failure marker or null (refused); none
 * rejects, so one failing source cannot take the rest down with it.
 */
import "server-only";

import { operatorDateKey, operatorDayStartIso } from "@/lib/dates";
import { OS_DEPARTMENTS, type OsDepartment } from "@/lib/os/departments";
import { mayOpenOsHref, type BuildOsNavInput } from "@/lib/os/nav";
import { isWebsiteSalesTenantSlug } from "@/lib/leads/canonical-lead-fields";
import { isOasisSurfaceTenant, type Persona, type SurfaceCapabilities } from "@/lib/role-surfaces";
import { loadPendingApprovals } from "@/components/os/approvals/load";
import { approvalScopeFromViewer } from "@/lib/os/approvals/scope";
import type { ApprovalsBlock } from "@/lib/os/approvals/rules";
import type { EmpireLane, RoutineHealth } from "@/components/os/department/routine-rules";
import type { PlatformOperatorCheck } from "@/lib/platform-operator";
import {
  buildNeedsYou,
  todayBriefPlan,
  type CashSnapshot,
  type ConnectionAttention,
  type DeliverySnapshot,
  type HotReply,
  type NeedsYou,
  type Read,
  type SalesSnapshot,
  type TodayBriefPlan,
} from "@/components/os/today/model";
import {
  loadCash,
  loadConnectionAlerts,
  loadDelivery,
  loadHotReplies,
  loadRoutineHealth,
  loadSales,
  type OperatorDay,
} from "@/components/os/today/loaders";

export type BriefViewer = {
  persona: Persona;
  capabilities: SurfaceCapabilities;
  tenantId: string;
  userId: string;
  tenantSlug: string | null;
};

/** The operator's day around `now`: its start and end, and its date key. */
export function operatorDayAt(now: Date): OperatorDay {
  return {
    nowMs: now.getTime(),
    startMs: Date.parse(operatorDayStartIso(now)),
    endMs: Date.parse(operatorDayStartIso(now, 1)),
    todayKey: operatorDateKey(now),
  };
}

/** The departments this viewer's rail shows, and what the brief may read for them. */
export function briefPlanFor(viewer: BriefViewer, navInput: BuildOsNavInput): { departments: OsDepartment[]; plan: TodayBriefPlan } {
  const departments = OS_DEPARTMENTS.filter((d) => mayOpenOsHref(navInput, d.href));
  const plan = todayBriefPlan({
    persona: viewer.persona,
    capabilities: viewer.capabilities,
    websiteSalesBoard: isWebsiteSalesTenantSlug(viewer.tenantSlug),
    departments: new Set(departments.map((d) => d.key)),
  });
  return { departments, plan };
}

/**
 * Does this viewer's routine health include the Empire lane (`cron_jobs` rows
 * carrying the OASIS workspace id)? Only for the platform operator standing in
 * OASIS: the verified check GET /api/cron-jobs lists those rows behind, so
 * every Empire failure counted for a viewer can be looked up in Automations.
 * The co-owner is not the operator and has no page that lists them, so for
 * them the count stays the workspace's own lane.
 *
 * `isOperator` is asked only for an owner in OASIS (it costs a profile read).
 * A check that could not be made is "unknown", never "no" (routine-rules.ts
 * EmpireLane): the operator must not read "no failures" over the workspace
 * lane alone because their profile read blipped. A throw is logged and
 * answered "unknown", never rejected.
 */
export async function empireRoutinesFor(
  viewer: Pick<BriefViewer, "persona" | "tenantSlug">,
  isOperator: () => Promise<EmpireLane>,
): Promise<EmpireLane> {
  if (!isOasisSurfaceTenant(viewer.tenantSlug) || viewer.persona !== "founder") return false;
  try {
    return await isOperator();
  } catch (err) {
    console.error("[today.routines.operator]", err);
    return "unknown";
  }
}

/**
 * The verified check's verdict (lib/platform-operator.ts) as an Empire lane:
 * a failed lookup is "unknown", and every other "no" (not an operator alias,
 * not an owner of OASIS, no session) is a true no.
 */
export function empireLaneFromCheck(check: PlatformOperatorCheck): EmpireLane {
  if (check.operator) return true;
  return check.reason === "lookup_failed" ? "unknown" : false;
}

export type NeedsYouReads = {
  sales: Read<SalesSnapshot> | null;
  delivery: Read<DeliverySnapshot> | null;
  inbound: Read<HotReply[]> | null;
  cash: Read<CashSnapshot> | null;
  approvals: Read<ApprovalsBlock>;
  connections: Read<ConnectionAttention[]> | null;
  routines: Read<RoutineHealth> | null;
};

export async function loadNeedsYouReads(input: {
  viewer: BriefViewer;
  navInput: BuildOsNavInput;
  plan: TodayBriefPlan;
  /** The company-money capability, already narrowed by plan.money. False → no cash read at all. */
  showFinancials: boolean;
  day: OperatorDay;
  /** Approval cards to fetch (the total is an exact count either way). */
  approvalsLimit: number;
  /** The verified platform-operator check for this session, as an Empire lane (see empireRoutinesFor). */
  isPlatformOperator: () => Promise<EmpireLane>;
}): Promise<NeedsYouReads> {
  const { viewer, plan, day } = input;
  const tenantId = viewer.tenantId;
  // Every block starts at once. None of these promises rejects.
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
  const cashP = input.showFinancials && plan.cash ? loadCash() : Promise.resolve(null);
  // Approvals waiting on THIS viewer: the session's workspace, cut to the
  // departments the rail opens for them (lib/os/approvals/scope.ts).
  const approvalsP = loadPendingApprovals({
    scope: approvalScopeFromViewer({ surface: viewer, navInput: input.navInput }),
    tenantSlug: viewer.tenantSlug,
    limit: input.approvalsLimit,
  });
  const connectionsP = plan.connections ? loadConnectionAlerts(tenantId) : Promise.resolve(null);
  // The Empire scheduler's OASIS rows are OASIS's own routines; only the
  // platform operator standing in OASIS counts them (empireRoutinesFor).
  const routinesP = plan.routines
    ? empireRoutinesFor(viewer, input.isPlatformOperator).then((empire) => loadRoutineHealth(tenantId, empire, day.nowMs))
    : Promise.resolve(null);

  const [sales, delivery, inbound, cash, approvals, connections, routines] = await Promise.all([
    salesP,
    deliveryP,
    inboundP,
    cashP,
    approvalsP,
    connectionsP,
    routinesP,
  ]);
  return { sales, delivery, inbound, cash, approvals, connections, routines };
}

/** The one Needs-you list, from the reads above. */
export function needsYouFrom(reads: NeedsYouReads, nowMs: number): NeedsYou {
  return buildNeedsYou({ ...reads, nowMs });
}
