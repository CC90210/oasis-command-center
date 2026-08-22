/**
 * lib/web-leads/pipeline.ts — pure grouping logic for the pipeline board
 * (`GET /api/web-leads/pipeline`, `app/web-leads/pipeline/page.tsx`).
 *
 * THE DECISION THIS FILE EXISTS TO RESPECT: the pipeline already exists.
 * lib/website-sales.ts's WEBSITE_SALES_STAGES is CC's fourteen-stage sales
 * lifecycle, with a commission model built on top of it. This is a VIEW over
 * that pipeline, filtered to this engine's leads -- never a second engine.
 * Stage order and labels are read from WEBSITE_SALES_STAGES so a rename there
 * breaks this build's typecheck rather than silently rendering an empty
 * column; nothing here hardcodes the stage strings independently of it.
 *
 * NO WRITES. This module only groups already-fetched leads in memory --
 * fetchPipelineLeads() (lib/web-leads/data.ts) does the one read this view
 * needs, and nothing here or in the route that calls it ever calls an
 * update/insert/RPC.
 */

import { WEBSITE_SALES_STAGES, type WebsiteSalesStage } from "@/lib/website-sales";
import type { PipelineLead } from "./data";

/**
 * A lead's `data.stage` is free text inside a JSON column -- there is no DB
 * CHECK constraint pinning it to WEBSITE_SALES_STAGES the way, say,
 * leadgen_call_outcomes.outcome is pinned to its own vocabulary. So a stage
 * value that doesn't match any of the fourteen known stages (a typo, a
 * legacy value, a future engine addition this build hasn't been taught, or a
 * lead that predates the promoter stamping `stage: 'researched'` and so
 * carries no stage at all) is a real possibility, not a theoretical one.
 * Dropping those leads from the board would make them invisible -- worse
 * than rendering them oddly, since nothing would even hint they exist. They
 * are bucketed here instead, always rendered, never silently discarded.
 */
export const UNRECOGNIZED_STAGE = "unrecognized" as const;

export type PipelineStageKey = WebsiteSalesStage | typeof UNRECOGNIZED_STAGE;

export type PipelineStageGroup = {
  stage: PipelineStageKey;
  label: string;
  /** The TRUE count for this stage -- never truncated, even when `leads` is. */
  count: number;
  leads: PipelineLead[];
  /** True when `leads.length < count` -- see PIPELINE_STAGE_LEAD_CAP below. */
  truncated: boolean;
};

const STAGE_LABELS: Record<WebsiteSalesStage, string> = {
  researched: "Researched",
  assigned: "Assigned",
  attempting_contact: "Attempting contact",
  connected: "Connected",
  qualified: "Qualified",
  founder_meeting_booked: "Founder meeting booked",
  demo_completed: "Demo completed",
  proposal_sent: "Proposal sent",
  won: "Won",
  lost: "Lost",
  onboarding: "Onboarding",
  in_build: "In build",
  client_review: "Client review",
  launched: "Launched",
};

function isKnownStage(stage: string | null): stage is WebsiteSalesStage {
  return stage !== null && (WEBSITE_SALES_STAGES as readonly string[]).includes(stage);
}

/**
 * Per-stage cap on the `leads` array returned to the client. Today almost
 * every lead in this tenant sits at `researched` (outcome logging, the thing
 * that moves leads past it, only just shipped) -- so an uncapped response
 * would ship all ~31,000 rows in one JSON body for that single column. The
 * cap keeps the payload sane while `count` stays the true, never-truncated
 * total (same honesty contract LEAD_READ_CAP already uses elsewhere in this
 * feature: a number the UI shows must never be quietly smaller than reality).
 */
export const PIPELINE_STAGE_LEAD_CAP = 500;

function toGroup(stage: PipelineStageKey, label: string, leads: PipelineLead[]): PipelineStageGroup {
  return {
    stage,
    label,
    count: leads.length,
    leads: leads.slice(0, PIPELINE_STAGE_LEAD_CAP),
    truncated: leads.length > PIPELINE_STAGE_LEAD_CAP,
  };
}

/**
 * Buckets `leads` into one group per WEBSITE_SALES_STAGES entry, in that
 * constant's own order, plus one trailing "unrecognized" group for anything
 * that doesn't match. Every one of the fourteen stages is ALWAYS present in
 * the result, even with zero leads -- an empty column is normal (most stages
 * are empty today) and must render plainly, not be hidden as if the stage
 * didn't exist.
 */
export function groupLeadsByStage(leads: PipelineLead[]): PipelineStageGroup[] {
  const buckets = new Map<PipelineStageKey, PipelineLead[]>();
  for (const stage of WEBSITE_SALES_STAGES) buckets.set(stage, []);
  buckets.set(UNRECOGNIZED_STAGE, []);

  for (const lead of leads) {
    const key: PipelineStageKey = isKnownStage(lead.stage) ? lead.stage : UNRECOGNIZED_STAGE;
    buckets.get(key)!.push(lead);
  }

  const groups = WEBSITE_SALES_STAGES.map((stage) => toGroup(stage, STAGE_LABELS[stage], buckets.get(stage) || []));
  groups.push(toGroup(UNRECOGNIZED_STAGE, "Unrecognized stage", buckets.get(UNRECOGNIZED_STAGE) || []));
  return groups;
}

/**
 * Admin-only rep filter (the route only calls this for an unscoped viewer --
 * an `agent`-role viewer is already locked to their own book by
 * fetchPipelineLeads' visibleToViewer call, so applying this on top of that
 * would be a no-op at best). Case-insensitive and whitespace-trimmed to
 * match visibleToViewer's own comparison convention.
 */
export function filterByRep(leads: PipelineLead[], repUserId: string | null): PipelineLead[] {
  if (!repUserId || !repUserId.trim()) return leads;
  const wanted = repUserId.trim().toLowerCase();
  return leads.filter((l) => (l.assignedTo || "").trim().toLowerCase() === wanted);
}
