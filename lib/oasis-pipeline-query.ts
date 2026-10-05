import "server-only";

import {
  listRecords,
  listRecordsForViewer,
  type ListRecordsResult,
  type TenantRecord,
} from "@/lib/manifest/data";
import { isReleasedOasisPipelineRow } from "@/lib/oasis-sales-pipeline-policy";
import { isInPipelineCycle, type PipelineCycleBoundary } from "@/lib/pipeline-cycle";

export const OASIS_PIPELINE_OVERVIEW_LIMIT = 40;
export const OASIS_PIPELINE_STAGE_PAGE_SIZE = 100;

export const OASIS_PIPELINE_SEARCH_FIELDS = [
  "name",
  "company",
  "email",
  "phone",
  "notes",
  "industry",
  "business_city",
  "website",
] as const;

type EqualityValue = string | number | boolean | null;

export type OasisPipelineWindow = {
  rows: TenantRecord[];
  stageCounts: Record<string, number>;
  total: number;
  activeStage: string | null;
  page: number;
  pageSize: number;
  shownFrom: number;
  shownTo: number;
  hasPrevious: boolean;
  hasNext: boolean;
  truncatedStages: string[];
};

export type OasisPipelineAssigneeScope =
  | { allowed: false }
  | {
      allowed: true;
      assignedTo: string | null | undefined;
      /** Manager-only union of known, tenant-scoped sales-rep auth ids. */
      assignedToAny?: readonly string[];
    };

/**
 * Resolve the assignee clause before any data query runs.
 *
 * Admins can view everyone, one rep, or the unassigned pool. A non-admin's
 * optional rep parameter can only narrow their already-private book; typing a
 * colleague's id fails closed instead of widening visibility.
 */
export function resolveOasisPipelineAssigneeScope(input: {
  isAdmin: boolean;
  userId: string | null;
  repFilter: string | null;
  canReadTeam?: boolean;
  teamRepUserIds?: readonly string[];
}): OasisPipelineAssigneeScope {
  const rep = input.repFilter?.trim().toLowerCase() || null;
  if (input.isAdmin) {
    if (!rep) return { allowed: true, assignedTo: undefined };
    return { allowed: true, assignedTo: rep === "unassigned" ? null : rep };
  }

  if (input.canReadTeam) {
    const teamRepUserIds = [...new Set(
      (input.teamRepUserIds || [])
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean),
    )];
    if (teamRepUserIds.length === 0) return { allowed: false };
    // Manager scope contains assigned rep books only. A forged unassigned,
    // founder/admin id, foreign tenant id, or random UUID fails before a query.
    if (rep) {
      if (rep === "unassigned" || !teamRepUserIds.includes(rep)) {
        return { allowed: false };
      }
      return { allowed: true, assignedTo: rep };
    }
    return {
      allowed: true,
      assignedTo: undefined,
      assignedToAny: teamRepUserIds,
    };
  }

  const userId = input.userId?.trim().toLowerCase() || null;
  if (!userId) return { allowed: false };
  if (rep && rep !== userId) return { allowed: false };
  return { allowed: true, assignedTo: userId };
}

export function normalizeOasisPipelinePage(raw: string | number | null | undefined): number {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw || "1"), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function resolveOasisPipelineActiveStage(
  requested: string | null | undefined,
  stageKeys: readonly string[],
): string | null {
  const normalized = requested?.trim() || "";
  return normalized && stageKeys.includes(normalized) ? normalized : null;
}

type RecordLister = (input: {
  tenant_id: string;
  entity: string;
  sort?: string;
  limit?: number;
  offset?: number;
  where?: Record<string, EqualityValue>;
  whereIn?: Record<string, readonly string[]>;
  whereEmpty?: readonly string[];
  whereNotEmpty?: readonly string[];
  search?: { fields: readonly string[]; query: string };
}) => Promise<ListRecordsResult>;

type ViewerRecordLister = (input: {
  tenant_id: string;
  entity: string;
  userId: string;
  sort?: string;
  limit?: number;
  offset?: number;
}) => Promise<ListRecordsResult>;

function activeCycleRows(
  rows: TenantRecord[],
  now: number,
  cycle?: PipelineCycleBoundary,
): TenantRecord[] {
  return rows.filter(
    (row) =>
      !isReleasedOasisPipelineRow(row, now) &&
      (!cycle || isInPipelineCycle(row, cycle)),
  );
}

function normalizedSearchTerms(rawQuery: string | null | undefined): string[] {
  return (rawQuery || "")
    .normalize("NFKC")
    .trim()
    .slice(0, 160)
    .toLowerCase()
    .split(/[(),"'\\\s%*_]+/g)
    .filter(Boolean);
}

function containsTermsInOrder(value: unknown, terms: readonly string[]): boolean {
  const haystack = String(value ?? "").normalize("NFKC").toLowerCase();
  let cursor = 0;
  for (const term of terms) {
    const index = haystack.indexOf(term, cursor);
    if (index < 0) return false;
    cursor = index + term.length;
  }
  return true;
}

function scopedWindowFromRows(input: {
  rows: TenantRecord[];
  stageKeys: readonly string[];
  activeStage: string | null;
  requestedPage: number;
  salesProgram?: string | null;
  salesMotion?: string | null;
  query?: string | null;
}): OasisPipelineWindow {
  const queryTerms = normalizedSearchTerms(input.query);
  const allowedStages = new Set(input.stageKeys);
  const rows = input.rows.filter((row) => {
    const data = row.data || {};
    const stage = String(data.stage || "");
    if (!allowedStages.has(stage)) return false;
    if (input.salesProgram && data.sales_program !== input.salesProgram) return false;
    if (input.salesMotion && data.sales_motion !== input.salesMotion) return false;
    if (queryTerms.length === 0) return true;
    return OASIS_PIPELINE_SEARCH_FIELDS.some((field) =>
      containsTermsInOrder(data[field], queryTerms),
    );
  });

  const byStage = new Map<string, TenantRecord[]>();
  for (const stage of input.stageKeys) byStage.set(stage, []);
  for (const row of rows) byStage.get(String(row.data.stage))?.push(row);
  const stageCounts = Object.fromEntries(
    input.stageKeys.map((stage) => [stage, byStage.get(stage)?.length ?? 0]),
  );
  const total = rows.length;
  const activeTotal = input.activeStage ? stageCounts[input.activeStage] ?? 0 : total;
  const pageSize = input.activeStage
    ? OASIS_PIPELINE_STAGE_PAGE_SIZE
    : OASIS_PIPELINE_OVERVIEW_LIMIT;
  const lastPage = input.activeStage
    ? Math.max(1, Math.ceil(activeTotal / pageSize))
    : 1;
  const page = Math.min(input.requestedPage, lastPage);
  const visibleRows = input.activeStage
    ? (byStage.get(input.activeStage) || []).slice((page - 1) * pageSize, page * pageSize)
    : input.stageKeys.flatMap((stage) =>
        (byStage.get(stage) || []).slice(0, OASIS_PIPELINE_OVERVIEW_LIMIT),
      );
  const shownFrom = visibleRows.length === 0 ? 0 : input.activeStage ? (page - 1) * pageSize + 1 : 1;
  const shownTo = input.activeStage
    ? Math.min(activeTotal, (page - 1) * pageSize + visibleRows.length)
    : visibleRows.length;

  return {
    rows: visibleRows,
    stageCounts,
    total,
    activeStage: input.activeStage,
    page,
    pageSize,
    shownFrom,
    shownTo,
    hasPrevious: Boolean(input.activeStage && page > 1),
    hasNext: Boolean(input.activeStage && page * pageSize < activeTotal),
    truncatedStages: input.stageKeys.filter(
      (stage) =>
        !input.activeStage &&
        (stageCounts[stage] ?? 0) > OASIS_PIPELINE_OVERVIEW_LIMIT,
    ),
  };
}

/**
 * Query the OASIS board from one bounded, server-filtered working set.
 *
 * The complete active set is read before released claims are removed, counts
 * are computed, and the selected stage is paged. If a scope reaches the safe
 * read ceiling we fail loudly instead of displaying partial counts.
 */
export async function listOasisPipelineWindow(
  input: {
    tenantId: string;
    stageKeys: readonly string[];
    requestedStage?: string | null;
    requestedPage?: string | number | null;
    salesProgram?: string | null;
    salesMotion?: string | null;
    assignedTo?: string | null;
    /** Assigned sales-rep union for a manager's read-only team view. */
    assignedToAny?: readonly string[];
    /** Self-scoped rep read: assigned rows OR collaborator rows. */
    viewerUserId?: string | null;
    /** Builder delivery allocation stored outside assigned_to. */
    fulfillmentOwnerId?: string | null;
    /** Optional reversible board boundary. Historical rows remain stored. */
    cycle?: PipelineCycleBoundary;
    query?: string | null;
  },
  deps: { list: RecordLister; listForViewer?: ViewerRecordLister } = {
    list: listRecords,
    listForViewer: listRecordsForViewer,
  },
): Promise<OasisPipelineWindow> {
  const teamAssignees = input.assignedToAny
    ? [...new Set(input.assignedToAny.map((id) => id.trim().toLowerCase()).filter(Boolean))]
    : null;
  // Passing both is a caller bug with authorization implications. Fail closed
  // instead of guessing which scope should win.
  const hasConflictingAssigneeScopes =
    teamAssignees !== null && input.assignedTo !== undefined;
  const hasEmptyTeamScope = teamAssignees !== null && teamAssignees.length === 0;
  const stageKeys = hasConflictingAssigneeScopes || hasEmptyTeamScope
    ? []
    : [...new Set(input.stageKeys.filter(Boolean))];
  const activeStage = resolveOasisPipelineActiveStage(input.requestedStage, stageKeys);
  const requestedPage = normalizeOasisPipelinePage(input.requestedPage);
  const search = input.query?.trim()
    ? { fields: OASIS_PIPELINE_SEARCH_FIELDS, query: input.query.trim() }
    : undefined;

  if (stageKeys.length === 0) {
    return {
      rows: [],
      stageCounts: {},
      total: 0,
      activeStage,
      page: 1,
      pageSize: activeStage ? OASIS_PIPELINE_STAGE_PAGE_SIZE : OASIS_PIPELINE_OVERVIEW_LIMIT,
      shownFrom: 0,
      shownTo: 0,
      hasPrevious: false,
      hasNext: false,
      truncatedStages: [],
    };
  }

  const viewerUserId = input.viewerUserId?.trim().toLowerCase() || null;
  const assignedTo = input.assignedTo?.trim().toLowerCase() || null;
  if (teamAssignees) {
    const where: Record<string, EqualityValue> = {};
    if (input.salesProgram) where.sales_program = input.salesProgram;
    if (input.salesMotion) where.sales_motion = input.salesMotion;
    const scoped = await deps.list({
      tenant_id: input.tenantId,
      entity: "lead",
      whereIn: { assigned_to: teamAssignees, stage: stageKeys },
      ...(Object.keys(where).length ? { where } : {}),
      ...(search ? { search } : {}),
      sort: "-updated_at",
      limit: 2_000,
    });
    // A clipped roster read would understate a manager's team and stage totals.
    // The live OASIS roster is far below this guard; fail loudly if it grows
    // beyond the generic record-read ceiling rather than rendering partial data.
    if (scoped.total >= 2_000) {
      throw new Error("oasis_pipeline_team_scope_exceeds_safe_window");
    }
    const now = Date.now();
    return scopedWindowFromRows({
      rows: activeCycleRows(scoped.rows, now, input.cycle),
      stageKeys,
      activeStage,
      requestedPage,
      salesProgram: input.salesProgram,
      salesMotion: input.salesMotion,
      query: input.query,
    });
  }
  if (viewerUserId && assignedTo !== viewerUserId) {
    throw new Error("oasis_pipeline_viewer_scope_mismatch");
  }
  if (viewerUserId && !deps.listForViewer) {
    throw new Error("oasis_pipeline_viewer_reader_unavailable");
  }
  if (viewerUserId && deps.listForViewer) {
    const fulfillmentOwnerId = input.fulfillmentOwnerId?.trim().toLowerCase() || null;
    const [scoped, fulfillment] = await Promise.all([
      deps.listForViewer({
        tenant_id: input.tenantId,
        entity: "lead",
        userId: viewerUserId,
        sort: "-updated_at",
        limit: 2_000,
      }),
      fulfillmentOwnerId === viewerUserId
        ? deps.list({
            tenant_id: input.tenantId,
            entity: "lead",
            where: { fulfillment_owner_id: fulfillmentOwnerId },
            sort: "-updated_at",
            limit: 2_000,
          })
        : Promise.resolve({ rows: [], total: 0 }),
    ]);
    // A clipped scoped book would make the counts look exact while hiding old
    // deals. The normal claim cap is 250; fail loudly if manual assignments ever
    // push a seat to the generic record-read ceiling.
    if (scoped.total >= 2_000 || fulfillment.total >= 2_000) {
      throw new Error("oasis_pipeline_rep_scope_exceeds_safe_window");
    }
    const now = Date.now();
    const activeScopedRows = activeCycleRows(scoped.rows, now, input.cycle);
    const byId = new Map(activeScopedRows.map((row) => [row.id, row]));
    for (const row of activeCycleRows(fulfillment.rows, now, input.cycle)) byId.set(row.id, row);
    return scopedWindowFromRows({
      rows: [...byId.values()].sort((left, right) =>
        String(right.updated_at || "").localeCompare(String(left.updated_at || "")),
      ),
      stageKeys,
      activeStage,
      requestedPage,
      salesProgram: input.salesProgram,
      salesMotion: input.salesMotion,
      query: input.query,
    });
  }

  // Admin/owner and explicit-assignee boards use the same exact active-set
  // calculation. Server predicates keep the transfer bounded; expiry is then
  // applied before counts and pagination so every role sees the same truth.
  {
    const where: Record<string, EqualityValue> = {};
    if (input.salesProgram) where.sales_program = input.salesProgram;
    if (input.salesMotion) where.sales_motion = input.salesMotion;
    if (input.assignedTo !== undefined && input.assignedTo !== null) {
      where.assigned_to = assignedTo;
    }
    const scoped = await deps.list({
      tenant_id: input.tenantId,
      entity: "lead",
      sort: "-updated_at",
      limit: 2_000,
      // stageKeys is non-empty here — the empty case returns above — and
      // whereIn rejects an empty list rather than silently dropping the
      // filter, so a future refactor cannot quietly restore the full scan.
      whereIn: { stage: stageKeys },
      ...(input.assignedTo === null
        ? { whereEmpty: ["assigned_to"] }
        : input.assignedTo === undefined
          ? { whereNotEmpty: ["assigned_to"] }
          : {}),
      ...(Object.keys(where).length ? { where } : {}),
      ...(search ? { search } : {}),
    });
    if (scoped.total >= 2_000) {
      throw new Error("oasis_pipeline_scope_exceeds_safe_window");
    }
    const now = Date.now();
    return scopedWindowFromRows({
      rows: activeCycleRows(scoped.rows, now, input.cycle),
      stageKeys,
      activeStage,
      requestedPage,
      salesProgram: input.salesProgram,
      salesMotion: input.salesMotion,
      query: input.query,
    });
  }

}
