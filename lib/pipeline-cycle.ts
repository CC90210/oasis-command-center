/**
 * Reversible boundary for the OASIS revenue pipeline.
 *
 * Historical deals stay in tenant_records. The current board selects only
 * assignments made in this cycle (or rows explicitly stamped with this id),
 * so "start from zero" is a view boundary, never a destructive reset.
 */

export type PipelineCycleBoundary = {
  id: string;
  startedAt: string;
  focus: readonly string[];
};

export const CURRENT_OASIS_PIPELINE_CYCLE: PipelineCycleBoundary = {
  id: "revenue-2026-09-23",
  startedAt: "2026-09-23T06:00:00.000Z",
  focus: ["outreach", "marketing", "sales"],
};

export type PipelineCycleAssignmentFacts = {
  assigned_to: string;
  assigned_at: string;
  pipeline_cycle: string;
};

/**
 * Stamp one canonical owner and the active-cycle clock as a single unit.
 *
 * Importers previously wrote `assigned_to` alone. The active board deliberately
 * ignores rows without an assignment clock or explicit cycle id, so those
 * imports succeeded in storage and then disappeared from the working pipeline.
 * Keeping the three fields together makes that invalid state unrepresentable at
 * the import boundary.
 */
export function pipelineCycleAssignmentFacts(
  assignedTo: string,
  assignedAt: string,
  cycle: PipelineCycleBoundary = CURRENT_OASIS_PIPELINE_CYCLE,
): PipelineCycleAssignmentFacts {
  const owner = assignedTo.trim();
  if (!owner) throw new Error("pipeline_assignment_owner_required");

  const assignmentMs = Date.parse(assignedAt);
  const boundaryMs = Date.parse(cycle.startedAt);
  if (!Number.isFinite(assignmentMs)) throw new Error("pipeline_assignment_time_invalid");
  if (!cycle.id.trim() || !Number.isFinite(boundaryMs)) {
    throw new Error("pipeline_cycle_invalid");
  }
  if (assignmentMs < boundaryMs) throw new Error("pipeline_assignment_before_cycle");

  return {
    assigned_to: owner,
    assigned_at: new Date(assignmentMs).toISOString(),
    pipeline_cycle: cycle.id,
  };
}

export type PipelineCycleRow = {
  id?: string;
  data: Record<string, unknown>;
  updated_at?: string | null;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Explicit cycle ids outrank timestamps. Untagged rows remain compatible when
 * their canonical assignment clock falls on/after the boundary.
 */
export function isInPipelineCycle(
  row: PipelineCycleRow,
  cycle: PipelineCycleBoundary = CURRENT_OASIS_PIPELINE_CYCLE,
): boolean {
  const explicit = text(row.data.pipeline_cycle);
  if (explicit) return explicit === cycle.id;

  const assignedAt = text(row.data.assigned_at) || text(row.data.claimed_at);
  const assignedMs = Date.parse(assignedAt);
  const boundaryMs = Date.parse(cycle.startedAt);
  return Number.isFinite(assignedMs) && Number.isFinite(boundaryMs) && assignedMs >= boundaryMs;
}

export type PipelineArchiveEntry = {
  id: string;
  priorStage: string | null;
  priorAssignedTo: string | null;
  priorAssignedAt: string | null;
  priorUpdatedAt: string | null;
};

export type PipelineCyclePlan = {
  cycle: PipelineCycleBoundary;
  archive: PipelineArchiveEntry[];
  current: PipelineArchiveEntry[];
  outsideAssignmentRoster: string[];
};

function archiveEntry(row: PipelineCycleRow): PipelineArchiveEntry {
  return {
    id: text(row.id),
    priorStage: text(row.data.stage) || null,
    priorAssignedTo: text(row.data.assigned_to) || null,
    priorAssignedAt: text(row.data.assigned_at) || text(row.data.claimed_at) || null,
    priorUpdatedAt: text(row.updated_at) || null,
  };
}

function isPipelineWork(row: PipelineCycleRow): boolean {
  const stage = text(row.data.stage).toLowerCase();
  const owner = text(row.data.assigned_to);
  return Boolean(owner || (stage && stage !== "researched" && stage !== "unassigned"));
}

/**
 * Build a restoration-grade archive manifest without changing a row. The ids
 * outside the founder roster are called out separately; the planner never
 * guesses whether CC or Adon should own them.
 */
export function planPipelineCycleArchive(
  rows: readonly PipelineCycleRow[],
  cycle: PipelineCycleBoundary,
  assignmentRosterUserIds: readonly string[],
): PipelineCyclePlan {
  const allowed = new Set(
    assignmentRosterUserIds.map((id) => id.trim().toLowerCase()).filter(Boolean),
  );
  const pipelineRows = rows.filter((row) => text(row.id) && isPipelineWork(row));
  const currentRows = pipelineRows.filter((row) => isInPipelineCycle(row, cycle));
  const archiveRows = pipelineRows.filter((row) => !isInPipelineCycle(row, cycle));

  return {
    cycle,
    archive: archiveRows.map(archiveEntry).sort((a, b) => a.id.localeCompare(b.id)),
    current: currentRows.map(archiveEntry).sort((a, b) => a.id.localeCompare(b.id)),
    outsideAssignmentRoster: currentRows
      .filter((row) => {
        const owner = text(row.data.assigned_to).toLowerCase();
        return Boolean(owner && !allowed.has(owner));
      })
      .map((row) => text(row.id))
      .sort(),
  };
}
