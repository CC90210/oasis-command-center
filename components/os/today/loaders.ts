/**
 * components/os/today/loaders.ts — the owner brief's reads, one per block.
 *
 * Each loader is called by components/today/FounderToday.tsx ONLY when
 * todayBriefPlan (model.ts) allows its block, and each returns a Read<T>: the
 * value, or `{ ok: false }` with the cause logged. None of them turns a failed
 * read into a zero — that decision belongs to the builders, which render it as
 * "Couldn't load".
 *
 * A read that does not ANSWER is different from one that fails. Every read
 * here runs under TODAY_READ_DEADLINE_MS (lib/os/deadline.ts): past it, the
 * loader rejects with a ReadDeadlineError instead of answering, so the page
 * fails closed to app/error.tsx ("a workspace read timed out", reload) rather
 * than leaving the root skeleton up forever. A failed read is still a failed
 * block; a hung read is a hung page, and the page says so inside the budget.
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
import { systemCalendarConfig } from "@/lib/integrations/google-calendar";
import { readPersonalGoogleFact } from "@/lib/integrations/personal-google";
import { personalGoogleStatus } from "@/lib/os/connectors";
import { loadEmpireRoutines, loadTenantRoutines } from "@/components/os/department/routines";
import { empireReadFor, mergeRoutineReads, routineHealth, type EmpireLane, type RoutineHealth } from "@/components/os/department/routine-rules";
import { requireBusinessEntity, resolveFinanceViewer } from "@/lib/founders-finances/access-io";
import { overview } from "@/lib/founders-finances/reports-io";
import { formatCents } from "@/lib/founders-finances/money";
import { getTursoClient } from "@/lib/turso";
import { listActiveConnections } from "@/lib/connections/store";
import { providerById } from "@/lib/connections/registry";
import { getTenantIntegrationPresenceForStatus } from "@/lib/tenant-integration-store";
import { toDateKey } from "@/lib/calendar/dates";
import { expandOccurrences } from "@/lib/calendar/recurrence";
import { listCalendars, listEvents } from "@/lib/calendar/store";
import type { CalendarRecord, EventRecord } from "@/lib/calendar/types";
import { isTimeZone } from "@/lib/calendar/zone";
import { OPERATOR_TIME_ZONE, operatorDateKey, operatorDayStartIso } from "@/lib/dates";
import type { CalendarDay } from "@/components/os/today/ScheduleGlance";
import type { Persona } from "@/lib/role-surfaces";
import { isReadDeadlineError, withDeadline } from "@/lib/os/deadline";
import {
  pickHotReplies,
  REPLY_ANSWER_TYPES,
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

/**
 * How long one Today read may take before the page gives up on it. Long
 * enough for a cold Turso read; short enough that the founder sees an answer,
 * not a skeleton, when something hangs.
 */
export const TODAY_READ_DEADLINE_MS = 12_000;

/**
 * Run `fn` under the deadline; log and answer `{ ok: false }` if it throws.
 * Never a fallback value. A deadline is the one error that is NOT swallowed:
 * it is rethrown (logged first) so the page fails closed to the error boundary
 * instead of rendering a block as "Couldn't load" twelve seconds late while a
 * sibling read may still hang.
 */
async function read<T>(label: string, fn: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await withDeadline(fn(), TODAY_READ_DEADLINE_MS, label) };
  } catch (err) {
    console.error(`[today.${label}]`, err);
    if (isReadDeadlineError(err)) throw err;
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
 * Hot inbound from the last day, less what has been answered. priorityInbound
 * is tenant-scoped, and it THROWS when lead_interactions cannot be read
 * (lib/queries.ts recentInbound), so a failed read is "Couldn't check inbound
 * replies", never "no hot replies". The answers are the sends, DMs, texts and
 * calls logged on the same leads since the oldest of those replies, read the
 * same tenant-scoped way; that read failing fails the block too, because a
 * reply that may already be answered is not known to be waiting.
 */
export function loadHotReplies(tenantId: string, nowMs: number): Promise<Read<HotReply[]>> {
  return read("inbound", async () => {
    const inbound = await priorityInbound(tenantId, 10);
    const leads = [...new Set(inbound.map((r) => (r.lead_id || "").trim()).filter(Boolean))];
    const oldest = inbound.reduce((min, r) => Math.min(min, Date.parse(r.created_at)), Infinity);
    let outbound: Array<{ lead_id: string | null; type: string; created_at: string }> = [];
    if (leads.length > 0 && Number.isFinite(oldest)) {
      const res = await getServiceSupabase()
        .from("lead_interactions")
        .select("lead_id, type, created_at")
        .eq("tenant_id", tenantId)
        .in("lead_id", leads)
        .in("type", [...REPLY_ANSWER_TYPES])
        .gte("created_at", new Date(oldest).toISOString());
      if (res.error) throw new Error(`reply answers read failed: ${res.error.message}`);
      outbound = (res.data || []) as typeof outbound;
    }
    return pickHotReplies(inbound, nowMs, outbound);
  });
}

/** The provider ids Zernio has gone by (it was Late until 2026). */
const ZERNIO_PROVIDERS: readonly string[] = ["zernio", "late"];

/**
 * Has this workspace connected its own Zernio account? A live
 * Connections-framework row for it, or a Zernio/Late API key in the
 * workspace's key store, read for those services alone (the strict status
 * reader: presence only, never a value). Any of these reads failing, or a
 * Zernio/Late key that will not decrypt, is a throw: "not connected" would be
 * a guess. Another app's unreadable key is not this question's answer, so it
 * never turns the Marketing card into "Couldn't load".
 */
async function zernioConnected(tenantId: string): Promise<boolean> {
  const [connections, keys] = await Promise.all([
    listActiveConnections(getTursoClient(), tenantId),
    Promise.all(ZERNIO_PROVIDERS.map((service) => getTenantIntegrationPresenceForStatus(tenantId, service, ["api_key"]))),
  ]);
  return connections.some((c) => ZERNIO_PROVIDERS.includes(c.provider)) || keys.some((k) => k.api_key === true);
}

/**
 * What the Marketing card reads: distinct pieces published in 7 days
 * (post_analytics via momentumMetrics, tenant-scoped; null = that read failed)
 * and when this workspace's post analytics last synced from Zernio, so the
 * card names its source and its freshness instead of a fixed label. Only when
 * nothing has ever synced does it ask whether Zernio is connected at all: a
 * workspace that never connected it is told to connect a social account, not
 * shown Zernio as a sync that is not happening.
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
    const lastSyncedAt = row?.last_synced_at ?? null;
    return {
      published: momentum.contentPublished7d,
      lastSyncedAt,
      zernioConnected: lastSyncedAt ? null : await zernioConnected(tenantId),
    };
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
    // Your own Google account through the one reader and resolver Settings and
    // the Connections card use (lib/integrations/personal-google.ts), so a
    // wrong account reads "Wrong Google account" here too, never "Connected".
    const fact = await readPersonalGoogleFact(tenantId, userId);
    const status = personalGoogleStatus(fact);
    const system = oasisWorkspace ? systemCalendarConfig() : null;
    return {
      personal: { connected: status.state === "ready", label: status.label, address: fact.address },
      workspace: oasisWorkspace ? { configured: system !== null, address: system?.organizerEmail || null } : null,
    };
  });
}

const DAY_MS = 86_400_000;

/**
 * Today's entries in the viewer's own Schedule calendar, in time order: the
 * rows /schedule shows, expanded by the same recurrence code, from visible
 * calendars only. Timed events count when they overlap the day given;
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
 * The zone a viewer's calendar is kept in: the zone most of their timed
 * events carry (each is saved in the zone of the browser that made it, or
 * America/Toronto for the restored routine). With no timed event, or a tie
 * the operator's zone is part of, the operator's zone. The Today page runs on
 * the server, which never sees the viewer's browser, so the calendar's own
 * rows are the only honest source for it.
 */
export function calendarZone(events: EventRecord[]): string {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.allDay || !isTimeZone(e.timeZone)) continue;
    counts.set(e.timeZone, (counts.get(e.timeZone) ?? 0) + 1);
  }
  let best = OPERATOR_TIME_ZONE;
  let bestCount = counts.get(OPERATOR_TIME_ZONE) ?? 0;
  for (const [zone, n] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    if (n > bestCount) [best, bestCount] = [zone, n];
  }
  return best;
}

/** Today in `timeZone`: its midnight-to-midnight and date key, at the same instant. */
export function dayInZone(nowMs: number, timeZone: string): Pick<OperatorDay, "startMs" | "endMs" | "todayKey"> {
  const now = new Date(nowMs);
  return {
    startMs: Date.parse(operatorDayStartIso(now, 0, timeZone)),
    endMs: Date.parse(operatorDayStartIso(now, 1, timeZone)),
    todayKey: operatorDateKey(now, 0, timeZone),
  };
}

/**
 * The viewer's own calendar for today (lib/calendar/store, private to the
 * viewer: every read filters on the session's tenant AND user). Read-only: a
 * viewer who has never opened /schedule has no calendar yet, and looking at
 * Today must not create one. A failed read is `{ ok: false }`, never "nothing
 * today".
 *
 * "Today" is the day in the calendar's own zone (calendarZone), the way
 * /schedule shows it in that viewer's browser: a Vancouver client's 10pm
 * block is still Wednesday's, though Toronto is already on Thursday.
 */
export function loadTodayCalendar(owner: { tenantId: string; userId: string }, day: OperatorDay): Promise<Read<CalendarDay>> {
  return read("calendar.events", async () => {
    const [calendars, { events, truncated }] = await Promise.all([listCalendars(owner, { create: false }), listEvents(owner)]);
    const timeZone = calendarZone(events);
    const zoneDay = timeZone === OPERATOR_TIME_ZONE ? day : dayInZone(day.nowMs, timeZone);
    return { blocks: calendarBlocksForDay(events, calendars, zoneDay), partial: truncated, asOfMs: day.nowMs, timeZone };
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
    viewer = await withDeadline(resolveFinanceViewer(), TODAY_READ_DEADLINE_MS, "cash.viewer");
  } catch (err) {
    console.error("[today.cash.viewer]", err);
    if (isReadDeadlineError(err)) throw err;
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
