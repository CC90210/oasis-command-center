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
import { operatorCalendarStatus } from "@/lib/integrations/google-calendar";
import { requireBusinessEntity, resolveFinanceViewer } from "@/lib/founders-finances/access-io";
import { overview } from "@/lib/founders-finances/reports-io";
import { formatCents } from "@/lib/founders-finances/money";
import type { Persona } from "@/lib/role-surfaces";
import {
  pickHotReplies,
  summarizeBoard,
  summarizeDelivery,
  summarizeRecords,
  type CashSnapshot,
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
    const access = resolveDeliveryViewer({
      ok: true,
      persona: input.persona,
      tenantId: input.tenantId,
      userId: input.userId,
      canAct: input.canAct,
    });
    if (!access.ok) throw new Error(`delivery access refused: ${access.error}`);
    const db = getDeliveryDb();
    if (!db) throw new Error("delivery database not configured");
    const [tickets, projects] = await Promise.all([
      listTickets(db, access.viewer, { status: "open" }),
      listProjects(db, access.viewer),
    ]);
    return summarizeDelivery({
      tickets: tickets.rows,
      projects: projects.rows,
      truncated: tickets.truncated || projects.truncated,
      now: new Date(input.day.nowMs),
      todayKey: input.day.todayKey,
    });
  });
}

/** Hot inbound from the last day. priorityInbound is tenant-scoped. */
export function loadHotReplies(tenantId: string, nowMs: number): Promise<Read<HotReply[]>> {
  return read("inbound", async () => pickHotReplies(await priorityInbound(tenantId, 10), nowMs));
}

/** Distinct content pieces published in 7 days (post_analytics, tenant-scoped). Null = the reader failed. */
export function loadContentWeek(tenantId: string): Promise<Read<number | null>> {
  return read("content", async () => (await momentumMetrics(tenantId)).contentPublished7d);
}

/** The viewer's own Google Calendar connection (Settings › Personal). */
export function loadCalendarStatus(
  tenantId: string,
  userId: string,
): Promise<Read<{ connected: boolean; address: string | null }>> {
  return read("calendar", async () => {
    const status = await operatorCalendarStatus(tenantId, userId);
    return { connected: status.connected, address: status.address ?? null };
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
    };
  });
}
