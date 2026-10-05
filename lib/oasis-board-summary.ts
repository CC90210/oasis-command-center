import "server-only";

/**
 * The founder's pipeline numbers for Today, read through the SAME query the
 * /pipeline board runs for "Everyone" (2026-09-24).
 *
 * Today's "Pipeline (all)" read every lead row ever written — 2,350, most of
 * them prospect inventory and pre-cycle history — while the board, correctly
 * bounded by the current revenue cycle (lib/pipeline-cycle.ts), showed 0. Two
 * numbers for one concept, a screen apart. This reuses listOasisPipelineWindow
 * with the board's own stage list, program/motion filter, and cycle, so the
 * two surfaces cannot disagree.
 */

import { listOasisPipelineWindow } from "@/lib/oasis-pipeline-query";
import { oasisBoardProgramFilter, oasisBoardStages } from "@/lib/oasis-lead-create";
import { CURRENT_OASIS_PIPELINE_CYCLE } from "@/lib/pipeline-cycle";
import { summarizeBoardCounts, type BoardSummary } from "@/lib/oasis-board-summary-rules";

export async function founderBoardSummary(tenantId: string, tenantSlug: string | null): Promise<BoardSummary> {
  const stages = oasisBoardStages({ teamRole: "owner", isOwner: true });
  const filter = oasisBoardProgramFilter(tenantSlug);
  const window = await listOasisPipelineWindow({
    tenantId,
    stageKeys: stages.map((stage) => stage.key),
    salesProgram: filter.salesProgram,
    salesMotion: filter.salesMotion,
    cycle: CURRENT_OASIS_PIPELINE_CYCLE,
  });
  return summarizeBoardCounts(window.stageCounts, CURRENT_OASIS_PIPELINE_CYCLE.startedAt);
}
