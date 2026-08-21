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

/**
 * ALLOWLIST. The OASIS sales titles added 2026-08-21 — manager, closer, opener,
 * builder — are deliberately ABSENT, and each absence is a decision:
 *
 *   closer / opener  correct and final. A rep sees their own book at the rep
 *                    stages. That is the whole design.
 *
 *   manager          deliberately UNDER-permissive for now. A manager should see
 *                    their TEAM's book, which is a third scope this function
 *                    cannot express — `true` here would hand them the entire
 *                    tenant including CC's own leads, which is worse than
 *                    showing them too little. They see their own until the
 *                    team-scope read lands with the manager pages.
 *
 *   builder          not a sales role at all. They are scoped to their own rows
 *                    here, and because AGENT_STAGE_SET holds only the five REP
 *                    stages, a builder's board is EMPTY today — their work sits
 *                    at onboarding / in_build / client_review / launched. Empty
 *                    is not a leak, but it is not their tool either; the
 *                    delivery board is what fixes it.
 *
 * Do not "fix" a role into this list to make a screen populate. Widening here
 * widens `filterWebsiteSalesRows` to every program row in the tenant.
 */
export function isOasisPipelineAdmin(role: string, isOwner = false, adminAccess = false): boolean {
  return isOwner || role === "owner" || role === "admin" || role === "member" || adminAccess;
}

export function stagesForOasisRole(role: string, isOwner = false, adminAccess = false): StageMeta[] {
  return isOasisPipelineAdmin(role, isOwner, adminAccess)
    ? OASIS_LEAD_STAGES
    : OASIS_LEAD_STAGES.filter((stage) => AGENT_STAGE_SET.has(stage.key));
}

type PipelineRow = { id: string; data: Record<string, unknown> };

type OasisViewer = { role: string; userId: string | null; isOwner?: boolean; adminAccess?: boolean };

/**
 * May this viewer OPEN this one record? Ownership only.
 *
 * WHY THIS EXISTS (CC, 2026-08-21: every lead returned "Lead not found")
 * app/pipeline/[id] used to answer this by running the single record through
 * `filterWebsiteSalesRows` and treating an empty array as "no access". That
 * conflates two different questions, and the list-shaping answer is wrong for
 * both of the constraints it drags along:
 *
 *   PROGRAM. filterWebsiteSalesRows drops rows not stamped
 *   sales_program=website_sales_v1. Measured in production the day this was
 *   found: oasis-ai-cc holds 31,031 leads, ZERO stamped. So every lead on the
 *   agency tenant was unopenable — by a rep, by an admin, by CC himself. A
 *   record's PROGRAM has nothing to do with whether its owner may read it.
 *
 *   STAGE. It also drops rows outside the five rep stages. That is deliberate
 *   and correct for the BOARD — a rep wants a clean queue of workable leads —
 *   and nonsense for a record read: it meant a rep could not open the deal they
 *   personally closed the moment the founder advanced it to onboarding, which
 *   is precisely the deal they most want to look at, because it is the one they
 *   are being paid for.
 *
 * So: list-shaping and access-control are separate functions with separate
 * rules, which is the split lib/lead-scope.ts already makes between
 * `filterRowsByScope` and `canViewLead`. This is that same split for the
 * website-sales surface.
 *
 * The tenant boundary is NOT checked here and must not be: callers reach this
 * record through a tenant-scoped `getRecord({ tenant_id })`, so a foreign
 * record never arrives in the first place. Re-checking it here would imply this
 * function is the tenant guard, and it is not.
 *
 * Fail-closed: an unresolved identity, or a record nobody owns, opens nothing.
 */
export function canOpenOasisSalesRecord(row: PipelineRow, viewer: OasisViewer): boolean {
  if (isOasisPipelineAdmin(viewer.role, viewer.isOwner, viewer.adminAccess)) return true;
  if (!viewer.userId) return false;
  const assignedTo =
    typeof row.data.assigned_to === "string" ? row.data.assigned_to.trim().toLowerCase() : "";
  // An unassigned lead belongs to nobody, so it is not "yours" by default —
  // without this, an empty assigned_to would match an empty userId and hand
  // every unowned record to any signed-in rep.
  if (!assignedTo) return false;
  return assignedTo === viewer.userId.trim().toLowerCase();
}

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
