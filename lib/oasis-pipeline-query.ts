import "server-only";

import { listRecords, type ListRecordsResult, type TenantRecord } from "@/lib/manifest/data";

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
  | { allowed: true; assignedTo: string | null | undefined };

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
}): OasisPipelineAssigneeScope {
  const rep = input.repFilter?.trim().toLowerCase() || null;
  if (input.isAdmin) {
    if (!rep) return { allowed: true, assignedTo: undefined };
    return { allowed: true, assignedTo: rep === "unassigned" ? null : rep };
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
  whereEmpty?: readonly string[];
  search?: { fields: readonly string[]; query: string };
}) => Promise<ListRecordsResult>;

/**
 * Query the OASIS board in bounded stage windows.
 *
 * Overview mode fetches at most 40 newest matches per stage while retaining an
 * exact DB count. Selecting a stage switches to a conventional 100-row page.
 * Every filter (program, assignee, stage, and search) is applied by listRecords
 * before range(), so older rows and search hits remain reachable through the
 * stage pager rather than disappearing behind an arbitrary global cap.
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
    query?: string | null;
  },
  deps: { list: RecordLister } = { list: listRecords },
): Promise<OasisPipelineWindow> {
  const stageKeys = [...new Set(input.stageKeys.filter(Boolean))];
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

  const whereFor = (stage: string): Record<string, EqualityValue> => {
    const where: Record<string, EqualityValue> = { stage };
    if (input.salesProgram) where.sales_program = input.salesProgram;
    if (input.salesMotion) where.sales_motion = input.salesMotion;
    // `undefined` means everyone; null is the explicit unassigned bucket and
    // is expressed separately so legacy empty-string assignees are included.
    if (input.assignedTo !== undefined && input.assignedTo !== null) {
      where.assigned_to = input.assignedTo;
    }
    return where;
  };

  const readStage = async (stage: string, page: number): Promise<ListRecordsResult> => {
    const includeRows = activeStage === null || activeStage === stage;
    const limit = includeRows
      ? activeStage
        ? OASIS_PIPELINE_STAGE_PAGE_SIZE
        : OASIS_PIPELINE_OVERVIEW_LIMIT
      : 1;
    const offset = activeStage && includeRows ? (page - 1) * OASIS_PIPELINE_STAGE_PAGE_SIZE : 0;
    return deps.list({
      tenant_id: input.tenantId,
      entity: "lead",
      sort: "-updated_at",
      limit,
      offset,
      where: whereFor(stage),
      ...(input.assignedTo === null ? { whereEmpty: ["assigned_to"] } : {}),
      ...(search ? { search } : {}),
    });
  };

  let page = activeStage ? requestedPage : 1;
  const stageResults = await Promise.all(stageKeys.map((stage) => readStage(stage, page)));
  const byStage = new Map(stageKeys.map((stage, index) => [stage, stageResults[index]]));

  // A stale/shared URL may point past the last page after rows move stages.
  // Clamp to the last real page and re-read it instead of rendering a false
  // empty state while the exact count says records exist.
  if (activeStage) {
    const activeResult = byStage.get(activeStage)!;
    const lastPage = Math.max(1, Math.ceil(activeResult.total / OASIS_PIPELINE_STAGE_PAGE_SIZE));
    if (page > lastPage) {
      page = lastPage;
      byStage.set(activeStage, await readStage(activeStage, page));
    }
  }

  const stageCounts = Object.fromEntries(
    stageKeys.map((stage) => [stage, byStage.get(stage)?.total ?? 0]),
  );
  const rows = stageKeys.flatMap((stage) => {
    if (activeStage && activeStage !== stage) return [];
    return byStage.get(stage)?.rows ?? [];
  });
  const total = Object.values(stageCounts).reduce((sum, count) => sum + count, 0);
  const activeTotal = activeStage ? stageCounts[activeStage] ?? 0 : total;
  const pageSize = activeStage ? OASIS_PIPELINE_STAGE_PAGE_SIZE : OASIS_PIPELINE_OVERVIEW_LIMIT;
  const shownFrom = rows.length === 0 ? 0 : activeStage ? (page - 1) * pageSize + 1 : 1;
  const shownTo = activeStage ? Math.min(activeTotal, (page - 1) * pageSize + rows.length) : rows.length;

  return {
    rows,
    stageCounts,
    total,
    activeStage,
    page,
    pageSize,
    shownFrom,
    shownTo,
    hasPrevious: Boolean(activeStage && page > 1),
    hasNext: Boolean(activeStage && page * pageSize < activeTotal),
    truncatedStages: stageKeys.filter(
      (stage) => !activeStage && (stageCounts[stage] ?? 0) > OASIS_PIPELINE_OVERVIEW_LIMIT,
    ),
  };
}
