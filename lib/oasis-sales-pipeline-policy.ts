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

export function filterWebsiteSalesRows<T extends PipelineRow>(
  rows: T[],
  viewer: { role: string; userId: string | null; isOwner?: boolean; adminAccess?: boolean },
): T[] {
  const programRows = rows.filter((row) => row.data.sales_program === OASIS_WEBSITE_SALES_PROGRAM);
  if (isOasisPipelineAdmin(viewer.role, viewer.isOwner, viewer.adminAccess)) return programRows;
  if (!viewer.userId) return [];
  const userId = viewer.userId.toLowerCase();
  return programRows.filter((row) => {
    const assignedTo = typeof row.data.assigned_to === "string" ? row.data.assigned_to.toLowerCase() : "";
    return assignedTo === userId && AGENT_STAGE_SET.has(String(row.data.stage || ""));
  });
}
