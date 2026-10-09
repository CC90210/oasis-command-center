/**
 * lib/os/desk/reads.ts - the workspace reads a department teammate answers
 * from: the DEPARTMENT STATE block (./state.ts) and the palette's tools
 * (./tools.ts) call these, so the summary and a lookup can never disagree.
 *
 * THE VIEWER IS THE SCOPE. Every read takes the session's OsViewer
 * (components/os/department/viewer.ts) and reads its `surface.tenantId`; no
 * read takes a tenant from anywhere else, and nothing the model writes is a
 * tenant. Each read applies the same rule the page behind it applies:
 *   pipeline    numbers.ts loadPipeline's split (an admin reads the board, a
 *               member their own book; a client workspace its lead records,
 *               own-book members by assigned_to in the query);
 *   delivery    lib/delivery/access.ts (own desk, then vendor);
 *   approvals   lib/os/approvals/scope.ts approvalScopeFromViewer;
 *   money       the Finance gate (OASIS + company financials);
 *   calendar    the person's own calendar (tenant AND user).
 *
 * UNKNOWN IS NOT ZERO. A read that fails is `{ ok: false }` and is said as
 * "could not be read", never as none.
 */

import "server-only";
import { listRecords, getRecord, type TenantRecord } from "@/lib/manifest/data";
import { listOasisPipelineWindow } from "@/lib/oasis-pipeline-query";
import { oasisBoardProgramFilter, oasisBoardStages } from "@/lib/oasis-lead-create";
import { isOasisPipelineAdmin } from "@/lib/oasis-sales-pipeline-policy";
import { CURRENT_OASIS_PIPELINE_CYCLE } from "@/lib/pipeline-cycle";
import { recordMatchesViewer } from "@/lib/lead-scope";
import { salesBuckets, meetingsBetween, type LeadLite, type LeadRow } from "@/components/os/today/model";
import { operatorDayAt } from "@/components/os/today/brief-load";
import type { OsViewer } from "@/components/os/department/viewer";

export type DeskRead<T> = { ok: true; value: T } | { ok: false; error?: string };

export async function deskRead<T>(label: string, fn: () => Promise<T>): Promise<DeskRead<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    console.error(`[os.desk.${label}]`, err instanceof Error ? err.message : err);
    return { ok: false };
  }
}

// -- Pipeline ---------------------------------------------------------------

export type PipelineStage = { key: string; label: string; count: number };

export type PipelineRead = {
  /** board: OASIS's revenue board; records: the workspace's own lead records. */
  source: "board" | "records";
  /** The viewer reads only their own book. */
  own: boolean;
  stages: PipelineStage[];
  total: number;
  /** The rows behind the follow-up buckets (a window: `partial` says when it is not every lead). */
  rows: LeadRow[];
  partial: boolean;
  /** OASIS's revenue cycle start (follow-ups promised before it are carried over), or null. */
  cycleStartMs: number | null;
};

/** How the viewer may read leads here, or null: no pipeline scope at all. */
export function pipelineScope(viewer: OsViewer): { source: "board" | "records"; own: boolean } | null {
  const s = viewer.surface;
  if (viewer.oasis) {
    const admin = s.persona === "founder" || isOasisPipelineAdmin(s.teamRole);
    return { source: "board", own: !admin };
  }
  const own = !s.capabilities.canSeeAllPipeline;
  if (own && !s.capabilities.canSeeOwnPipelineOnly) return null;
  return { source: "records", own };
}

const RECORDS_WINDOW = 500;

function str(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  return typeof v === "string" ? v.trim() : "";
}

function humanStage(key: string): string {
  if (!key) return "No stage";
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** OASIS board rows for this viewer: the board for an admin, their own book otherwise. */
async function oasisWindow(viewer: OsViewer, own: boolean, opts: { query?: string | null; stage?: string | null } = {}) {
  const s = viewer.surface;
  const filter = oasisBoardProgramFilter(s.tenantSlug);
  const stages = own ? oasisBoardStages({ teamRole: s.teamRole }) : oasisBoardStages({ teamRole: "owner", isOwner: true });
  const me = s.userId.trim().toLowerCase();
  const window = await listOasisPipelineWindow({
    tenantId: s.tenantId,
    stageKeys: stages.map((st) => st.key),
    salesProgram: filter.salesProgram,
    salesMotion: filter.salesMotion,
    cycle: CURRENT_OASIS_PIPELINE_CYCLE,
    requestedStage: opts.stage ?? null,
    query: opts.query ?? null,
    ...(own ? { viewerUserId: me, assignedTo: me } : {}),
  });
  return { window, stages };
}

export async function readPipeline(viewer: OsViewer): Promise<DeskRead<PipelineRead> | null> {
  const scope = pipelineScope(viewer);
  if (!scope) return null;
  const tenantId = viewer.surface.tenantId;
  if (scope.source === "board") {
    return deskRead("pipeline.board", async () => {
      const { window, stages } = await oasisWindow(viewer, scope.own);
      return {
        source: "board" as const,
        own: scope.own,
        stages: stages.map((st) => ({ key: st.key, label: st.label, count: window.stageCounts[st.key] ?? 0 })),
        total: window.total,
        rows: window.rows.map((r) => ({ id: r.id, data: r.data || {} })),
        partial: window.truncatedStages.length > 0,
        cycleStartMs: Date.parse(CURRENT_OASIS_PIPELINE_CYCLE.startedAt),
      };
    });
  }
  return deskRead("pipeline.records", async () => {
    const where = scope.own ? { assigned_to: viewer.surface.userId.toLowerCase() } : undefined;
    const res = await listRecords({
      tenant_id: tenantId,
      entity: "lead",
      sort: "-updated_at",
      limit: RECORDS_WINDOW,
      ...(where ? { where } : {}),
    });
    const counts = new Map<string, number>();
    for (const r of res.rows) {
      const key = str(r.data || {}, "stage") || str(r.data || {}, "status");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return {
      source: "records" as const,
      own: scope.own,
      stages: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => ({ key, label: humanStage(key), count })),
      total: res.total,
      rows: res.rows.map((r) => ({ id: r.id, data: r.data || {} })),
      partial: res.total > res.rows.length,
      cycleStartMs: null,
    };
  });
}

export type FollowUps = {
  overdue: LeadLite[];
  outcomeMissing: LeadLite[];
  meetingsToday: LeadLite[];
  noNextStep: number;
};

export function followUpsFrom(p: PipelineRead, nowMs: number): FollowUps {
  const b = salesBuckets(p.rows, nowMs, p.cycleStartMs);
  const day = operatorDayAt(new Date(nowMs));
  return {
    overdue: b.overdue,
    outcomeMissing: b.outcomeMissing,
    meetingsToday: meetingsBetween(p.rows, day.startMs, day.endMs),
    noNextStep: b.noNextStep.length,
  };
}

// -- Leads ------------------------------------------------------------------

export type LeadLine = {
  id: string;
  name: string;
  company: string | null;
  stage: string;
  next_step_at: string | null;
  email: string | null;
  updated_at: string | null;
};

export function leadLine(r: Pick<TenantRecord, "id" | "data" | "updated_at">): LeadLine {
  const d = (r.data || {}) as Record<string, unknown>;
  return {
    id: r.id,
    name: str(d, "name") || str(d, "company") || str(d, "email") || "Unnamed lead",
    company: str(d, "company") || null,
    stage: str(d, "stage") || str(d, "status"),
    next_step_at: str(d, "next_action_at") || null,
    email: str(d, "email") || null,
    updated_at: r.updated_at ?? null,
  };
}

const LEAD_SEARCH_FIELDS = ["name", "company", "email", "phone"] as const;

export async function searchLeads(
  viewer: OsViewer,
  input: { query?: string | null; stage?: string | null; limit: number },
): Promise<{ leads: LeadLine[]; own: boolean } | null> {
  const scope = pipelineScope(viewer);
  if (!scope) return null;
  const query = (input.query || "").trim().slice(0, 120) || null;
  const stage = (input.stage || "").trim().slice(0, 60) || null;
  if (scope.source === "board") {
    const { window } = await oasisWindow(viewer, scope.own, { query, stage });
    return { leads: window.rows.slice(0, input.limit).map(leadLine), own: scope.own };
  }
  const where: Record<string, string> = {};
  if (scope.own) where.assigned_to = viewer.surface.userId.toLowerCase();
  if (stage) where.stage = stage;
  const res = await listRecords({
    tenant_id: viewer.surface.tenantId,
    entity: "lead",
    sort: "-updated_at",
    limit: input.limit,
    ...(Object.keys(where).length ? { where } : {}),
    ...(query ? { search: { fields: LEAD_SEARCH_FIELDS, query } } : {}),
  });
  return { leads: res.rows.map(leadLine), own: scope.own };
}

/**
 * One lead, if this viewer may open it: an admin any lead in the workspace, an
 * own-book member only theirs (or one they collaborate on). Null: not found or
 * not theirs, said the same way so the answer confirms nothing.
 */
export async function openLead(viewer: OsViewer, leadId: string): Promise<TenantRecord | null | "no_scope"> {
  const scope = pipelineScope(viewer);
  if (!scope) return "no_scope";
  const id = leadId.trim();
  if (!id) return null;
  const record = await getRecord({ tenant_id: viewer.surface.tenantId, entity: "lead", id });
  if (!record || record.tenant_id !== viewer.surface.tenantId) return null;
  if (scope.own && !recordMatchesViewer((record.data || {}) as Record<string, unknown>, { isAdmin: false, userId: viewer.surface.userId }, true, "isolate")) {
    return null;
  }
  return record;
}
