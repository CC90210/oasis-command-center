import { OASIS_LEAD_STAGES, type StageMeta } from "@/lib/oasis-stage-meta";
import { normalizeCollaborators } from "@/lib/lead-scope";

export const OASIS_WEBSITE_SALES_PROGRAM = "website_sales_v1";

export const AGENT_PIPELINE_STAGE_KEYS = [
  "assigned",
  "attempting_contact",
  "connected",
  "qualified",
  "founder_meeting_booked",
  "demo_completed",
  "proposal_sent",
  "won",
  "onboarding",
] as const;

export const OPENER_PIPELINE_STAGE_KEYS = [
  "assigned",
  "attempting_contact",
  "connected",
  "qualified",
  "founder_meeting_booked",
] as const;

export const CLOSER_PIPELINE_STAGE_KEYS = [
  "founder_meeting_booked",
  "demo_completed",
  "proposal_sent",
  "won",
  "onboarding",
] as const;

export const BUILDER_DELIVERY_STAGE_KEYS = [
  "onboarding",
  "in_build",
  "client_review",
] as const;
export const BUILDER_VISIBLE_STAGE_KEYS = [
  ...BUILDER_DELIVERY_STAGE_KEYS,
  "launched",
] as const;

const AGENT_STAGE_SET = new Set<string>(AGENT_PIPELINE_STAGE_KEYS);
const OPENER_STAGE_SET = new Set<string>(OPENER_PIPELINE_STAGE_KEYS);
const CLOSER_STAGE_SET = new Set<string>(CLOSER_PIPELINE_STAGE_KEYS);
const BUILDER_DELIVERY_STAGE_SET = new Set<string>(BUILDER_DELIVERY_STAGE_KEYS);
// CC, 2026-08-25: the builder/marketing hire sells too, so his board carries
// BOTH jobs — the nine sales stages his claimed deals travel, plus the four
// delivery stages his build work sits in. Union, not replacement: dropping the
// delivery stages here would empty the pipeline half of his Today.
const BUILDER_SALES_AND_DELIVERY_STAGE_SET = new Set<string>([
  ...AGENT_PIPELINE_STAGE_KEYS,
  ...BUILDER_VISIBLE_STAGE_KEYS,
]);
const EMPTY_STAGE_SET = new Set<string>();

function stageSetForOasisRole(role: string): ReadonlySet<string> {
  const normalized = role.trim().toLowerCase();
  if (normalized === "opener") return OPENER_STAGE_SET;
  if (normalized === "closer") return CLOSER_STAGE_SET;
  if (normalized === "builder") return BUILDER_SALES_AND_DELIVERY_STAGE_SET;
  if (normalized === "agent" || normalized === "manager") return AGENT_STAGE_SET;
  return EMPTY_STAGE_SET;
}

/**
 * ALLOWLIST. The OASIS sales titles added 2026-08-21 — manager, closer, opener,
 * builder — are deliberately ABSENT, and each absence is a decision:
 *
 *   closer / opener  see their own book at the stages their job can act on.
 *                    Keeping separate stage sets prevents a closer's deal
 *                    disappearing immediately after the demo.
 *
 *   manager          deliberately UNDER-permissive for now. A manager should see
 *                    their TEAM's book, which is a third scope this function
 *                    cannot express — `true` here would hand them the entire
 *                    tenant including CC's own leads, which is worse than
 *                    showing them too little. They see their own until the
 *                    team-scope read lands with the manager pages.
 *
 *   builder          was delivery-only; CC, 2026-08-25 widened him to his OWN
 *                    book at the full sales stage set (plus his delivery
 *                    stages) because the builder/marketing hire now sells as
 *                    well. Tenant-wide visibility stays false — the widening
 *                    is ownership-scoped rows only.
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
    : OASIS_LEAD_STAGES.filter((stage) => stageSetForOasisRole(role).has(stage.key));
}

type PipelineRow = { id: string; data: Record<string, unknown> };

type OasisViewer = { role: string; userId: string | null; isOwner?: boolean; adminAccess?: boolean };

export type OasisDeliveryQueueScope =
  | { mode: "all" }
  | { mode: "owned"; userId: string }
  | { mode: "none" };

/**
 * Builders are outside delivery contractors, so their Today queue is their
 * allocation rather than the tenant's client roster. Every other persona that
 * reaches DeliveryToday keeps its existing tenant-wide view. A builder whose
 * auth id did not resolve fails closed instead of widening to every client.
 */
export function resolveOasisDeliveryQueueScope(
  teamRole: string | null | undefined,
  userId: string | null | undefined,
): OasisDeliveryQueueScope {
  if ((teamRole || "").trim().toLowerCase() !== "builder") return { mode: "all" };
  const normalizedUserId = (userId || "").trim().toLowerCase();
  return normalizedUserId ? { mode: "owned", userId: normalizedUserId } : { mode: "none" };
}

/**
 * Roles that may operate the OASIS sales file after ownership is proven.
 *
 * This is intentionally narrower than SELF_EDIT_LEAD_ROLES below. That older
 * allowlist serves shared CRM surfaces where loan officers/processors/builders
 * legitimately edit their own records. The OASIS pipeline is a sales surface:
 * an attached delivery, marketing, default-member, or read-only account may
 * review a deal, but it must not send, pause nurture, add notes, or edit facts.
 *
 * `builder` joined on 2026-08-25 (CC): the builder/marketing hire sells, and
 * the per-lead tools — notes, AI score, lifecycle actions on HIS claimed
 * leads — are that job now. Ownership is still proven by every caller; this
 * set only answers "does this role do sales work at all".
 */
export const OASIS_SALES_LEAD_OPERATOR_ROLES = new Set<string>([
  "manager",
  "closer",
  "opener",
  "builder",
  "marketing",
  "agent",
  "member",
]);

/** Fails closed on null, unknown, or non-sales roles. */
export function roleMayOperateOasisSalesLead(teamRole: string | null | undefined): boolean {
  return OASIS_SALES_LEAD_OPERATOR_ROLES.has((teamRole || "").trim().toLowerCase());
}

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
  if (viewer.role.trim().toLowerCase() === "builder") {
    // Read must never sit BELOW write. Since 2026-08-25 a builder may mutate
    // rows he is a named collaborator on (ownsOasisSalesRecord), so the read
    // predicate honours the same field — otherwise such a row opens as "Lead
    // not found" while its owner edits it through tools that only ask
    // assertMayWorkLead. Delivery allocation stays an independent OR.
    return ownsOasisDeliveryRecord(row, viewer.userId) || ownsOasisSalesRecord(row, viewer.userId);
  }
  return ownsOasisSalesRecord(row, viewer.userId);
}

/** Builders can execute only the post-payment delivery edges they already see
 * on their Today queue. They never gain prospecting, pricing, payment, notes,
 * communication, or admin-correction powers from this predicate. */
export function mayOperateOasisDeliveryStage(
  teamRole: string | null | undefined,
  stage: unknown,
): boolean {
  return (
    (teamRole || "").trim().toLowerCase() === "builder" &&
    typeof stage === "string" &&
    BUILDER_DELIVERY_STAGE_SET.has(stage)
  );
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
 * Delivery allocation may be stored in either the canonical fulfilment field
 * or assigned_to on legacy/transitioning rows. This is the same OR used by the
 * builder's database query, keeping every rendered link openable by the shared
 * record-access predicate.
 */
export function ownsOasisDeliveryRecord(row: PipelineRow, userId: string | null): boolean {
  if (!userId) return false;
  const me = userId.trim().toLowerCase();
  const assignedTo =
    typeof row.data.assigned_to === "string" ? row.data.assigned_to.trim().toLowerCase() : "";
  const fulfillmentOwner =
    typeof row.data.fulfillment_owner_id === "string"
      ? row.data.fulfillment_owner_id.trim().toLowerCase()
      : "";
  return Boolean(me && (assignedTo === me || fulfillmentOwner === me));
}

/**
 * May this viewer MUTATE this OASIS lead?
 *
 * Read visibility is deliberately broader (canOpenOasisSalesRecord). Writes
 * require an admin capability, or BOTH an OASIS sales role and ownership. Keep
 * this pure predicate shared by the server-rendered detail page and API access
 * helper so hidden controls and HTTP authorization cannot drift apart.
 */
export function canMutateOasisSalesRecord(row: PipelineRow, viewer: OasisViewer): boolean {
  const role = viewer.role.trim().toLowerCase();
  if (viewer.isOwner || viewer.adminAccess || role === "owner" || role === "admin") return true;
  return roleMayOperateOasisSalesLead(role) && ownsOasisSalesRecord(row, viewer.userId);
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
  "next_action_at",
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
 * Fields that may only move through the audited OASIS lifecycle, assignment,
 * or communication routes. Even an admin must not write these through the
 * generic manifest editor: doing so would skip preconditions, attribution,
 * touch timestamps, hooks, and the interaction ledger.
 */
export const OASIS_STRUCTURED_LEAD_FIELDS = new Set<string>([
  "stage",
  "stage_entered_at",
  "assigned_to",
  "assigned_agent",
  "collaborators",
  "sales_program",
  "sales_motion",
  "attributed_rep_user_id",
  "attribution_frozen_at",
  "last_contact_at",
  "last_contacted_at",
  "last_call_at",
  "last_disposition",
  "last_handoff_note",
  "last_handoff_note_at",
  "qualification",
  "qualified_at",
  "booked_founder",
  "audit_host_user_id",
  "audit_host_role",
  "audit_host_email",
  "audit_duration_minutes",
  "calendar_event_status",
  "calendar_confirmed_at",
  "calendar_confirmed_by",
  "founder_meeting_at",
  "founder_meeting_status",
  "promised_demo",
  "audit_completed_at",
  "build_brief",
  "build_handoff_status",
  "recommended_tier",
  "automation_interests",
  "proposal_status",
  "quoted_setup_amount",
  "quoted_monthly_amount",
  "payment_due_amount",
  "proposal_payment_token",
  "stripe_checkout_session_id",
  "stripe_checkout_url",
  "stripe_checkout_created_at",
  "currency",
  "closed_by",
  "closed_at",
  "collected_setup_amount",
  "payment_provider",
  "verified_payment_id",
  "payment_verified_by",
  "payment_verified_at",
  "closed_by_user_id",
  "deal_outcome",
  "deal_outcome_at",
  "fulfillment_owner_id",
  "lost_at",
  "loss_reason",
  "drip_paused",
]);

export function rejectedOasisGenericPatchKeys(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((key) => OASIS_STRUCTURED_LEAD_FIELDS.has(key));
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
  return SELF_EDIT_LEAD_ROLES.has((teamRole || "").trim().toLowerCase());
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
  const allowedStages = stageSetForOasisRole(viewer.role);
  return programRows.filter((row) => {
    const assignedTo = typeof row.data.assigned_to === "string" ? row.data.assigned_to.toLowerCase() : "";
    // Same predicate pair as canOpenOasisSalesRecord's builder branch: board,
    // record read, and per-lead writes cannot disagree about whose row this is.
    const owned =
      viewer.role.trim().toLowerCase() === "builder"
        ? ownsOasisDeliveryRecord(row, userId) || ownsOasisSalesRecord(row, userId)
        : assignedTo === userId;
    return owned && allowedStages.has(String(row.data.stage || ""));
  });
}
