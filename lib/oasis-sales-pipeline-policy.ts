import { OASIS_LEAD_STAGES, type StageMeta } from "@/lib/oasis-stage-meta";
import { normalizeCollaborators } from "@/lib/lead-scope";

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
 * COLLABORATORS COUNT. `data.collaborators` is first-class here, not a
 * curiosity: lib/manifest/data.ts runs indexed "owns OR collaborates" reads,
 * lib/lead-scope.ts honours it in recordMatchesViewer, and the applications
 * editor treats it as a writable field. Omitting it would make this predicate
 * stricter than every other access path in the codebase — and would break the
 * two-party sale outright, where an opener hands a lead to a closer, stops
 * being `assigned_to`, and is still owed 20% on it. They must be able to open
 * the deal they are being paid for.
 *
 * Fail-closed: an unresolved identity, or a record nobody owns, opens nothing.
 */
export function canOpenOasisSalesRecord(row: PipelineRow, viewer: OasisViewer): boolean {
  if (isOasisPipelineAdmin(viewer.role, viewer.isOwner, viewer.adminAccess)) return true;
  return ownsOasisSalesRecord(row, viewer.userId);
}

/**
 * Is this record literally THIS person's — assigned to them, or shared with
 * them as a collaborator? No role shortcut, by design.
 *
 * Split out of canOpenOasisSalesRecord because the two questions are not the
 * same question, and answering a WRITE with the READ predicate quietly grants
 * more than intended: canOpenOasisSalesRecord treats `member` as an admin (it
 * is the wide "who may look at the board" role), and `member` is the team_role
 * COLUMN DEFAULT — so gating an edit on it would have let any default-role
 * account edit every lead in the tenant, not just their own. Ownership is the
 * write question; keep them separate.
 */
export function ownsOasisSalesRecord(row: PipelineRow, userId: string | null): boolean {
  if (!userId) return false;
  const me = userId.trim().toLowerCase();
  const assignedTo =
    typeof row.data.assigned_to === "string" ? row.data.assigned_to.trim().toLowerCase() : "";
  // An unassigned lead belongs to nobody, so it is not "yours" by default —
  // without this, an empty assigned_to would match an empty userId and hand
  // every unowned record to any signed-in rep.
  if (assignedTo && assignedTo === me) return true;
  // Reused, not reimplemented: normalizeCollaborators already tolerates the
  // field being absent / not-an-array / full of junk, and fails closed to [].
  return normalizeCollaborators(row.data).includes(me);
}

/**
 * What a non-admin rep may change on a lead they own (CC directive,
 * 2026-08-24). The split is between the lead's FACTS and the pipeline's
 * SHAPE: a rep on a call learns the real phone number, the real contact,
 * what the website actually looks like — and should record it while it is
 * in front of them rather than queue an admin request. What they must not
 * do is move the deal or move themselves: stage, assignment, collaborators
 * and sales_program decide whose board a lead sits on and who is paid for
 * it, so they stay admin-only and keep their audited routes
 * (/api/leads/[id]/set-stage, /api/leads/[id]/assign).
 *
 * Allowlist, not denylist: a field added to the seed later is non-editable
 * by reps until someone decides it should be. The reverse default would
 * silently hand every new field to every rep.
 */
export const REP_EDITABLE_LEAD_FIELDS = new Set<string>([
  // contact facts a rep corrects mid-call
  "name",
  "company",
  "email",
  "phone",
  // the website-sales research a rep gathers or fixes
  "website",
  "website_condition",
  "audit_findings",
  "industry",
  "business_city",
  "state",
  // call notes + the AI columns the rep's own tools write back
  "notes",
  "last_contacted_at",
  "ai_score",
  "ai_reasoning",
  "ai_scored_at",
  "ai_next_action",
  "ai_next_action_rationale",
  "ai_next_action_at",
]);

/**
 * The keys in `patch` a rep is not allowed to set. Empty array = the patch
 * is safe. Callers reject the whole patch when this is non-empty rather
 * than silently dropping keys — a save that quietly discards half its
 * fields is worse than one that explains itself.
 */
export function rejectedRepPatchKeys(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((key) => !REP_EDITABLE_LEAD_FIELDS.has(key));
}

/**
 * Roles that may edit a lead of their OWN, given ownership is already proven.
 *
 * Ownership alone is not authority: a `read_only` account can legitimately be
 * named in `assigned_to` or `collaborators` (that is how a read-only observer
 * is attached to a deal), and gating the edit on ownership alone would have
 * handed them write access they were explicitly denied before — the role name
 * says exactly what it is. So the check is ownership AND a role floor.
 *
 * Allowlist, and `owner`/`admin` are absent because they never reach this
 * branch — they are already admins upstream. Marketing is absent too: it is
 * declared "never the sales pipeline" in lib/team-roles.ts.
 */
export const SELF_EDIT_LEAD_ROLES = new Set<string>([
  "manager",
  "closer",
  "opener",
  "builder",
  "agent",
  "member",
  "loan_officer",
  "processor",
]);

/** May this role edit a lead it owns? Fails closed on an unknown role. */
export function roleMaySelfEditLead(teamRole: string | null | undefined): boolean {
  return !!teamRole && SELF_EDIT_LEAD_ROLES.has(teamRole);
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
