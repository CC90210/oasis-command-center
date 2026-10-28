/**
 * lib/ai-audit/pipeline-deals.ts — the Pipeline's own deals, read for the AI
 * audits board (CC, 2026-10-28: "they should have the same numbers and when a
 * new lead comes in it updates both").
 *
 * The board used to count only engagements, so a founder meeting nobody had
 * pressed Start AI audit on was on the Pipeline and nowhere on the board. It now
 * reads both Pipeline queues through the SAME query the Pipeline page runs for
 * its owner (lib/oasis-pipeline-query.ts listOasisPipelineWindow, with the
 * owner's arguments from app/pipeline/page.tsx): the same stages, programme,
 * queue, unassigned rule, cycle and released-claim rule. The counts are that
 * query's exact stage totals, so the two screens cannot disagree, and a new
 * lead counts on both the moment it lands.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { getTenant } from "@/lib/queries";
import { listOasisPipelineWindow } from "@/lib/oasis-pipeline-query";
import { oasisBoardProgramFilter, oasisBoardStages } from "@/lib/oasis-lead-create";
import { stagesForOasisWarmInboundRole } from "@/lib/oasis-sales-pipeline-policy";
import { CURRENT_OASIS_PIPELINE_CYCLE } from "@/lib/pipeline-cycle";
import { OASIS_INBOUND_WARM_MOTION } from "@/lib/leads/canonical-lead-fields";
import { openAuditsForLeads, type OpenAudit } from "@/lib/ai-audit/pipeline-link";
import type { PipelineQueue } from "@/lib/ai-audit/pipeline-view";

export type PipelineDeal = {
  id: string;
  queue: PipelineQueue;
  stage: string;
  name: string | null;
  company: string | null;
  email: string | null;
  audit: OpenAudit | null;
};

export type PipelineSnapshot = {
  /** Exact deals per stage in each queue, as the Pipeline counts them for its owner. */
  counts: Record<PipelineQueue, Record<string, number>>;
  /** Stages with more deals than the read returns rows for (the Pipeline's own overview limit). */
  truncated: Record<PipelineQueue, string[]>;
  /** The deals the read returned, each with its open audit if it has one. */
  deals: PipelineDeal[];
};

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Both queues of the Pipeline, as the workspace owner sees them on /pipeline and /pipeline?motion=inbound. */
export async function ownerPipelineSnapshot(db: Client, tenantId: string): Promise<PipelineSnapshot> {
  const tenant = await getTenant(tenantId);
  if (!tenant?.slug) throw new Error("ai-audit.pipeline-deals: the workspace's slug could not be read");
  const filter = oasisBoardProgramFilter(tenant.slug);
  const owner = { teamRole: "owner", isOwner: true, adminAccess: false };
  const [cold, warm] = await Promise.all([
    listOasisPipelineWindow({
      tenantId,
      stageKeys: oasisBoardStages(owner).map((s) => s.key),
      requestedStage: null,
      requestedPage: null,
      salesProgram: filter.salesProgram,
      salesMotion: filter.salesMotion,
      includeUnassigned: false,
      cycle: CURRENT_OASIS_PIPELINE_CYCLE,
      query: null,
    }),
    listOasisPipelineWindow({
      tenantId,
      stageKeys: stagesForOasisWarmInboundRole(owner.teamRole, owner.isOwner, owner.adminAccess).map((s) => s.key),
      requestedStage: null,
      requestedPage: null,
      salesProgram: filter.salesProgram,
      salesMotion: OASIS_INBOUND_WARM_MOTION,
      includeUnassigned: true,
      query: null,
    }),
  ]);
  const rows = [
    ...cold.rows.map((r) => ({ r, queue: "cold" as const })),
    ...warm.rows.map((r) => ({ r, queue: "warm" as const })),
  ];
  const audits = await openAuditsForLeads(db, tenantId, rows.map(({ r }) => r.id));
  const truncatedOf = (w: typeof cold) => Object.entries(w.stageCounts).filter(([stage, n]) => n > w.rows.filter((r) => r.data.stage === stage).length).map(([stage]) => stage);
  return {
    counts: { cold: cold.stageCounts, warm: warm.stageCounts },
    truncated: { cold: truncatedOf(cold), warm: truncatedOf(warm) },
    deals: rows.map(({ r, queue }) => ({
      id: r.id,
      queue,
      stage: String(r.data.stage ?? ""),
      name: text(r.data.name) ?? text(r.data.contact_name),
      company: text(r.data.company) ?? text(r.data.business_name),
      email: text(r.data.email),
      audit: audits.get(r.id) ?? null,
    })),
  };
}
