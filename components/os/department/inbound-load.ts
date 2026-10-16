/**
 * components/os/department/inbound-load.ts - the ONE read behind every count of
 * the warm-inbound queue: the Sales desk's "Inbound leads" tile, its Needs-you
 * lines, its "New inbound leads (14 days)" list, and the badge on /pipeline's
 * Warm inbound link (CC 2026-10-16: the badge uses the same count as the list).
 *
 * Moved here out of numbers.ts, unchanged, so /pipeline can call it without
 * importing every department's readers. The same call /pipeline?motion=inbound
 * makes for a pipeline admin: listOasisPipelineWindow, this workspace only,
 * sales_motion inbound_warm, unassigned rows included, no assignment cycle
 * (warm form leads carry no cycle stamp, app/pipeline/page.tsx).
 *
 * WHO MAY CALL IT is the caller's gate, and both gates are "sees the whole
 * queue": numbers.ts asks founder or isOasisPipelineAdmin; /pipeline asks
 * pipelineAdmin. Anyone else gets no number rather than one from a narrower
 * scope. Throws on a failed read: the callers decide what "could not load"
 * looks like, never a 0.
 */
import "server-only";
import { listOasisPipelineWindow } from "@/lib/oasis-pipeline-query";
import { oasisBoardProgramFilter } from "@/lib/oasis-lead-create";
import { stagesForOasisWarmInboundRole } from "@/lib/oasis-sales-pipeline-policy";
import { OASIS_INBOUND_WARM_MOTION } from "@/lib/leads/canonical-lead-fields";
import { formatBookedTime } from "@/lib/forms/public-booking-alert";
import { inboundRecent, inboundWaiting, type InboundFigures, type InboundRecent } from "./inbound-rules";

/** The queue's figures, with both lists always read. */
export type OasisInboundQueue = InboundFigures & { recent: InboundRecent };

export async function readOasisInboundQueue(scope: {
  tenantId: string;
  tenantSlug: string | null;
  teamRole: string;
  isOwner: boolean;
  adminAccess?: boolean;
}): Promise<OasisInboundQueue> {
  const filter = oasisBoardProgramFilter(scope.tenantSlug);
  const window = await listOasisPipelineWindow({
    tenantId: scope.tenantId,
    stageKeys: stagesForOasisWarmInboundRole(scope.teamRole, scope.isOwner, scope.adminAccess).map((s) => s.key),
    salesProgram: filter.salesProgram,
    salesMotion: OASIS_INBOUND_WARM_MOTION,
    includeUnassigned: true,
    // Warm form leads carry no assignment-cycle stamp (app/pipeline/page.tsx).
    cycle: undefined,
  });
  const now = Date.now();
  return {
    total: window.total,
    untouched: window.stageCounts.researched ?? 0,
    booked: window.stageCounts.founder_meeting_booked ?? 0,
    waiting: inboundWaiting(window.rows, now, window.stageCounts.researched ?? 0),
    recent: inboundRecent(window.rows, now, window.truncatedStages, formatBookedTime),
  };
}
