/**
 * components/os/today/loaders.ts — the owner brief's reads, one per block.
 *
 * Each loader is called by components/today/FounderToday.tsx ONLY when
 * todayBriefPlan (model.ts) allows its block, and each returns a Read<T>: the
 * value, or `{ ok: false }` with the cause logged. None of them turns a failed
 * read into a zero — that decision belongs to the builders, which render it as
 * "Couldn't load".
 *
 * Reuse, not re-implementation: the pipeline counts are the /pipeline board's
 * own query (lib/oasis-pipeline-query + the board's stage list and cycle, the
 * same inputs lib/oasis-board-summary.ts passes), the SLA clock is
 * lib/delivery/rules, and cash is the Finances Overview reader
 * (lib/founders-finances/reports-io `overview`, behind its own owner gate).
 */
import "server-only";

import { listRecords } from "@/lib/manifest/data";
import { listOasisPipelineWindow } from "@/lib/oasis-pipeline-query";
import { oasisBoardProgramFilter, oasisBoardStages } from "@/lib/oasis-lead-create";
import { CURRENT_OASIS_PIPELINE_CYCLE } from "@/lib/pipeline-cycle";
import { summarizeBoardCounts } from "@/lib/oasis-board-summary-rules";
import { resolveDeliveryViewer } from "@/lib/delivery/access";
import { getDeliveryDb } from "@/lib/delivery/session";
import { listProjects, listTickets } from "@/lib/delivery/store";
import { momentumMetrics, priorityInbound } from "@/lib/queries";
import { getServiceSupabase } from "@/lib/supabase-server";
import { operatorCalendarStatus, systemCalendarConfig } from "@/lib/integrations/google-calendar";
import { getUserIntegrationBundleForStatus } from "@/lib/user-integration-store";
import { loadEmpireRoutines, loadTenantRoutines } from "@/components/os/department/routines";
import { empireReadFor, mergeRoutineReads, routineHealth, type EmpireLane, type RoutineHealth } from "@/components/os/department/routine-rules";
import { requireBusinessEntity, resolveFinanceViewer } from "@/lib/founders-finances/access-io";
import { overview } from "@/lib/founders-finances/reports-io";
import { formatCents } from "@/lib/founders-finances/money";
import { getTursoClient } from "@/lib/turso";
import { listActiveConnections } from "@/lib/connections/store";
import { providerById } from "@/lib/connections/registry";
import { toDateKey } from "@/lib/calendar/dates";
import { expandOccurrences } from "@/lib/calendar/recurrence";
import { listCalendars, listEvents } from "@/lib/calendar/store";
import type { CalendarRecord, EventRecord } from "@/lib/calendar/types";
import type { CalendarDay } from "@/components/os/today/ScheduleGlance";
import type { Persona } from "@/lib/role-surfaces";
import {
  pickHotReplies,
  summarizeBoard,
  summarizeDelivery,
  summarizeRecords,
  type CalendarStatus,
  type CashSnapshot,
  type ConnectionAttention,
  type ContentWeek,
  type DeliverySnapshot,
  type HotReply,
  type Read,
  type SalesSnapshot,
} from "@/components/os/today/model";

/** Run `fn`; log and answer `{ ok: false }` if it throws. Never a fallback value. */
async function read<T>(label: string, fn: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    console.error(`[today.${label}]`, err);
    return { ok: false };
  }
}

export type OperatorDay = { nowMs: number; startMs: number; endMs: number; todayKey: string };

/**
 * The pipeline block. On the OASIS sales workspace this is the /pipeline
 * board's "Everyone" query for the current revenue cycle, so Today and the
 * board cannot disagree about a count. Anywhere else it is the workspace's own
 * lead records.
 */
export function loadSales(input: {
  source: "board" | "records";
  tenantId: string;
  tenantSlug: string | null;
  day: OperatorDay;
}): Promise<Read<SalesSnapshot>> {
  const day = { startMs: input.day.startMs, endMs: input.day.endMs };
  if (input.source === "board") {
    return read("sales.board", async () => {
      const stages = oasisBoardStages({ teamRole: "owner", isOwner: true });
      const filter = oasisBoardProgramFilter(input.tenantSlug);
      const window = await listOasisPipelineWindow({
        tenantId: input.tenantId,
        stageKeys: stages.map((stage) => stage.key),
        salesProgram: filter.salesProgram,
        salesMotion: filter.salesMotion,
        cycle: CURRENT_OASIS_PIPELINE_CYCLE,
      });
      return summarizeBoard({
        rows: window.rows,
        summary: summarizeBoardCounts(window.stageCounts, CURRENT_OASIS_PIPELINE_CYCLE.startedAt),
        truncatedStages: window.truncatedStages,
        nowMs: input.day.nowMs,
        day,
      });
    });
  }
  return read("sales.records", async () => {
    const result = await listRecords({
      tenant_id: input.tenantId,
      entity: "lead",
      sort: "-updated_at",
      limit: 500,
    });
    return summarizeRecords(result.rows, result.total, input.day.nowMs, day);
  });
}

/**
 * Tickets and projects, through the same viewer rule and store every /tickets
 * and /projects read uses (lib/delivery/access.ts builds the WHERE). The viewer
 * is resolved from the surface the page already holds, rather than a second
 * session read. A viewer the rule refuses is a failed read here: the plan only
 * asks for this block when the Client Success department is on the rail, so a
 * refusal means the two disagree, and that must be loud.
 */
export function loadDelivery(input: {
  persona: Persona;
  tenantId: string;
  userId: string;
  canAct: boolean;
  day: OperatorDay;
}): Promise<Read<DeliverySnapshot>> {
  return read("delivery", async () => {
    // The workspace's own desk for its team; OASIS as vendor for anyone else
    // (lib/delivery/access.ts), the same order /tickets reads in.
    const who = {
      ok: true as const,
      persona: input.persona,
      tenantId: input.tenantId,
      userId: input.userId,
      canAct: input.canAct,
    };
    const desk = resolveDeliveryViewer(who, { relation: "desk" });
    const access = desk.ok ? desk : resolveDeliveryViewer(who);
    if (!access.ok) throw new Error(`delivery access refused: ${access.error}`);
    const db = getDeliveryDb();
    if (!db) throw new Error("delivery database not configured");
    const [tickets, projects] = await Promise.all([
      listTickets(db, access.viewer, { status: "open" }),
      listProjects(db, access.viewer),
    ]);
    // With nothing open, ask whether the desk has EVER held a ticket: a desk
    // nobody has used is "No tickets yet", not "Within SLA". Same viewer, same
    // scope as the open read.
    const closedTicketsExist =
      tickets.rows.length === 0 ? (await listTickets(db, access.viewer, { status: "closed" })).rows.length > 0 : false;
    return summarizeDelivery({
      viewerKind: access.viewer.kind,
      tickets: tickets.rows,
      projects: projects.rows,
      ticketsTruncated: tickets.truncated,
      projectsTruncated: projects.truncated,
      closedTicketsExist,
      now: new Date(input.day.nowMs),
      todayKey: input.day.todayKey,
    });
  });
}

/**
 * Hot inbound from the last day. priorityInbound is tenant-scoped, and it
 * THROWS when lead_interactions cannot be read (lib/queries.ts recentInbound),
 * so a failed read is "Couldn't check inbound replies", never "no hot replies".
 */
export function loadHotReplies(tenantId: string, nowMs: number): Promise<Read<HotReply[]>> {
  return read("inbound", async () => pickHotReplies(await priorityInbound(tenantId, 10), nowMs));
}

/**
 * What the Marketing card reads: distinct pieces published in 7 days
 * (post_analytics via momentumMetrics, tenant-scoped; null = that read failed)
 * and when this workspace's post analytics last synced from Zernio, so the
 * card names its source and its freshness instead of a fixed label.
 */
export function loadContentWeek(tenantId: string): Promise<Read<ContentWeek>> {
  return read("content", async () => {
    const [momentum, latest] = await Promise.all([
      momentumMetrics(tenantId),
      getServiceSupabase()
        .from("post_analytics")
        .select("last_synced_at")
        .eq("tenant_id", tenantId)
        .order("last_synced_at", { ascending: false })
        .limit(1),
    ]);
    if (latest.error) throw new Error(`post_analytics freshness read failed: ${latest.error.message}`);
    const row = ((latest.data || []) as Array<{ last_synced_at: string | null }>)[0];
    return { published: momentum.contentPublished7d, lastSyncedAt: row?.last_synced_at ?? null };
  });
}

/**
 * Routine health for the Operations card and a failed-routine row in Needs
 * you: the workspace's own routines, plus — for the platform operator in
 * OASIS — the Empire scheduler's rows that carry the OASIS workspace id
 * (routines.ts). The same readers and the same routineHealth the Operations
 * tab uses. `empire` "unknown" (the operator check failed) is a failed read:
 * "Couldn't check", never the workspace lane passed off as the whole.
 */
export function loadRoutineHealth(tenantId: string, empire: EmpireLane, nowMs: number): Promise<Read<RoutineHealth>> {
  return read("routines", async () => {
    const [workspace, empireRead] = await Promise.all([
      loadTenantRoutines(tenantId),
      empireReadFor(empire, () => loadEmpireRoutines(tenantId)),
    ]);
    const merged = mergeRoutineReads(workspace, empireRead);
    if (!merged.ok) {
      throw new Error(
        empire === "unknown"
          ? "the platform-operator check failed, so the Empire lane is unknown (logged by lib/platform-operator)"
          : "routine read failed (logged by the reader)",
      );
    }
    return routineHealth(merged.value, nowMs);
  });
}

/**
 * The workspace's live Connections-framework connections, for Needs you — the
 * same tenant-scoped reader the Connections hub uses. Read fresh on every
 * render, so a connection that recovers drops off without anything clearing it.
 */
export function loadConnectionAlerts(tenantId: string): Promise<Read<ConnectionAttention[]>> {
  return read("connections", async () =>
    (await listActiveConnections(getTursoClient(), tenantId)).map((c) => ({
      provider: c.provider,
      label: providerById(c.provider)?.label ?? c.provider,
      status: c.status,
      detail: c.last_health_detail,
    })),
  );
}

/**
 * The calendars behind today's schedule (model.ts CalendarStatus). The
 * personal login is read through the FAIL-LOUD status reader: the send-path
 * reader (getUserIntegrationBundle) answers {} on a database error, which
 * printed "Not connected" for a check that never ran. The workspace calendar
 * is OASIS's own identity, so it is reported only in an OASIS workspace.
 */
export function loadCalendarStatus(tenantId: string, userId: string, oasisWorkspace: boolean): Promise<Read<CalendarStatus>> {
  return read("calendar", async () => {
    const status = await operatorCalendarStatus(tenantId, userId, { getBundle: getUserIntegrationBundleForStatus });
    const system = oasisWorkspace ? systemCalendarConfig() : null;
    return {
      personal: { connected: status.connected, address: status.address ?? null },
      workspace: oasisWorkspace ? { configured: system !== null, address: system?.organizerEmail || null } : null,
    };
  });
}

const DAY_MS = 86_400_000;

/**
 * Today's entries in the viewer's own Schedule calendar, in time order: the
 * rows /schedule shows, expanded by the same recurrence code, from visible
 * calendars only. Timed events count when they overlap the operator day;
 * all-day events when their dates cover today's date key (their dates are
 * wall dates, so comparing instants on a UTC server would pull in tomorrow's).
 */
export function calendarBlocksForDay(
  events: EventRecord[],
  calendars: CalendarRecord[],
  day: Pick<OperatorDay, "startMs" | "endMs" | "todayKey">,
): CalendarDay["blocks"] {
  const visible = new Set(calendars.filter((c) => c.visible).map((c) => c.id));
  return expandOccurrences(events, new Date(day.startMs - DAY_MS), new Date(day.endMs + DAY_MS))
    .filter((o) => visible.has(o.event.calendarId))
    .filter((o) =>
      o.allDay
        ? toDateKey(o.start) <= day.todayKey && day.todayKey < toDateKey(o.end)
        : o.start.getTime() < day.endMs && o.end.getTime() > day.startMs,
    )
    .map((o) => ({
      key: o.key,
      title: o.event.title.trim() || "(No title)",
      startMs: o.start.getTime(),
      endMs: o.end.getTime(),
      allDay: o.allDay,
    }))
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs || a.endMs - b.endMs);
}

/**
 * The viewer's own calendar for today (lib/calendar/store, private to the
 * viewer: every read filters on the session's tenant AND user). Read-only: a
 * viewer who has never opened /schedule has no calendar yet, and looking at
 * Today must not create one. A failed read is `{ ok: false }`, never "nothing
 * today".
 */
export function loadTodayCalendar(owner: { tenantId: string; userId: string }, day: OperatorDay): Promise<Read<CalendarDay>> {
  return read("calendar.events", async () => {
    const [calendars, { events, truncated }] = await Promise.all([listCalendars(owner, { create: false }), listEvents(owner)]);
    return { blocks: calendarBlocksForDay(events, calendars, day), partial: truncated };
  });
}

/**
 * The Finances Overview reader, for the two finance owners only.
 *
 * Returns null — not a failure — when this viewer is not a finance owner
 * (resolveFinanceViewer: CC and Adon, by auth user). The plan asks for this
 * block only when company financials are already allowed, so null is the
 * narrower owner gate saying no, and the block is simply absent.
 *
 * `sweep: "deferred"`: Today never writes. Overdue is recomputed from the due
 * date inside the reader, so the figure is right without the sweep.
 */
export async function loadCash(): Promise<Read<CashSnapshot> | null> {
  let viewer: Awaited<ReturnType<typeof resolveFinanceViewer>>;
  try {
    viewer = await resolveFinanceViewer();
  } catch (err) {
    console.error("[today.cash.viewer]", err);
    return { ok: false };
  }
  if (!viewer) return null;
  const finance = viewer;
  return read("cash", async () => {
    const entity = await requireBusinessEntity(finance);
    const ov = await overview(finance, entity.id, { sweep: "deferred" });
    const overdue = Object.entries(ov.overdueAr).filter(([, cents]) => cents !== 0);
    return {
      cashCadCents: ov.cashTotal,
      hasCashActivity:
        ov.cashTotal !== 0 ||
        ov.cashAccounts.some((a) => a.balanceCents !== 0) ||
        ov.series.some((m) => m.inCents !== 0 || m.outCents !== 0),
      overdueCount: ov.overdueCount,
      overdueLabel: overdue.length > 0 ? overdue.map(([currency, cents]) => formatCents(cents, currency)).join(" + ") : null,
      unreviewed: ov.unreviewed,
      coverage: ov.coverage,
    };
  });
}
