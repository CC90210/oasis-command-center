import { OASIS_LEAD_STAGES, type StageMeta } from "@/lib/oasis-stage-meta";

export const OASIS_WEBSITE_SALES_PROGRAM = "website_sales_v1";

export const AGENT_PIPELINE_STAGE_KEYS = [
  "assigned",
  "attempting_contact",
  "connected",
  "qualified",
  "founder_meeting_booked",
] as const;

const AGENT_STAGE_SET = new Set<string>(AGENT_PIPELINE_STAGE_KEYS);

export function isOasisPipelineAdmin(role: string, isOwner = false, adminAccess = false): boolean {
  return isOwner || role === "owner" || role === "admin" || role === "member" || adminAccess;
}

export function stagesForOasisRole(role: string, isOwner = false, adminAccess = false): StageMeta[] {
  return isOasisPipelineAdmin(role, isOwner, adminAccess)
    ? OASIS_LEAD_STAGES
    : OASIS_LEAD_STAGES.filter((stage) => AGENT_STAGE_SET.has(stage.key));
}

type PipelineRow = { id: string; data: Record<string, unknown> };

/**
 * Scope pipeline rows to what this viewer may see.
 *
 * `programScoped` (default true) drops anything not stamped
 * sales_program=website_sales_v1. That is correct ONLY on the website-sales
 * tenant. Applying it everywhere hid all 8 of CC's own oasis-ai-cc CRM leads
 * behind an empty board — those rows predate the program and will never carry
 * the flag. Callers that already constrained the program in the DB query pass
 * `false` so the cap-then-filter bug can't strand rows either: on oasis-webdev
 * the 53 real sales leads sit in a table with 31k raw prospects, so a 500-row
 * fetch filtered afterwards in JS is one import away from returning nothing.
 * Rep scoping (own leads, agent stages) applies regardless.
 */
export function filterWebsiteSalesRows<T extends PipelineRow>(
  rows: T[],
  viewer: { role: string; userId: string | null; isOwner?: boolean; adminAccess?: boolean },
  options: { programScoped?: boolean } = {},
): T[] {
  const programRows = (options.programScoped ?? true)
    ? rows.filter((row) => row.data.sales_program === OASIS_WEBSITE_SALES_PROGRAM)
    : rows;
  if (isOasisPipelineAdmin(viewer.role, viewer.isOwner, viewer.adminAccess)) return programRows;
  if (!viewer.userId) return [];
  const userId = viewer.userId.toLowerCase();
  return programRows.filter((row) => {
    const assignedTo = typeof row.data.assigned_to === "string" ? row.data.assigned_to.toLowerCase() : "";
    return assignedTo === userId && AGENT_STAGE_SET.has(String(row.data.stage || ""));
  });
}
