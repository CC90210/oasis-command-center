/**
 * claim.ts — who owns a lead right now.
 *
 * THE PROBLEM THIS SOLVES: two reps dialling the same business. Adon's words --
 * "so that our reps are not calling the same people". A lead a rep holds
 * appears only in that rep's own book.
 *
 * ═══ NOTHING AGES OUT ANY MORE (2026-10-28) ══════════════════════════════════
 *
 * Until the Prospects surface (/web-leads) retired, ownership EXPIRED: a claim
 * never dialled for 7 days, or a lead marked lost 90 days ago, went back to the
 * shared Leads pool for another rep to claim. That pool and its claim flow are
 * gone, so an expiry would only make a lead vanish from the Pipeline with
 * nowhere to come back from (Codex review of the retirement, 2026-10-28). A
 * held lead now stays in its owner's book until someone reassigns it (an admin,
 * from the lead or the board), and a lost lead stays lost. Only an unowned lead
 * at a working stage is "available", which is what lets an admin assign it.
 *
 * ═══ INTERNAL DO-NOT-CALL OUTRANKS EVERYTHING ═══════════════════════════════
 *
 * `dnc: true` means a human said "never call me again". That never expires and
 * is never handed to a second rep. Canada requires an internal do-not-call list to be honoured
 * organisation-wide and permanently, and honouring it per-rep is the same as
 * not honouring it. It is checked FIRST in every function here, so no other
 * rule can route around it.
 */

/** Everything the ownership rules read. A subset of the lead's stored `data`,
 *  named so the rules can be tested without a database. */
import {
  OASIS_COLD_OUTBOUND_MOTION,
  OASIS_WEBSITE_SALES_PROGRAM,
} from "@/lib/leads/canonical-lead-fields";
import { OASIS_PRE_HANDOFF_STAGE_KEYS } from "@/lib/oasis-stage-meta";
import { pipelineCycleAssignmentFacts } from "@/lib/pipeline-cycle";

export type ClaimFacts = {
  /** Auth user id of the owning rep, or null when nobody holds it. */
  assignedTo: string | null;
  /** When the current owner took it. */
  claimedAt: string | null;
  /** The most recent logged call, whoever made it. */
  lastCallAt: string | null;
  /** Current lifecycle stage (CC's WEBSITE_SALES_STAGES value). */
  stage: string | null;
  /** When the lead was marked lost. */
  lostAt: string | null;
  /** Internal do-not-call. Permanent, organisation-wide, outranks everything. */
  dnc: boolean;
};


/**
 * Stages where ownership is still a prospect claim (an admin may hand it to
 * someone else, a release may return it). After the founder handoff, stage is
 * durable workflow state. A missing stage stays eligible for legacy rows.
 */
export const ACTIVE_PROSPECT_CLAIM_STAGES: ReadonlySet<string> = new Set([
  ...OASIS_PRE_HANDOFF_STAGE_KEYS,
]);

/**
 * Why a lead is claimable, or why it is not. Returned as a reason rather than a
 * boolean so the UI can say "Sarah has this one" instead of hiding the row with
 * no explanation, and so the tests name the rule they are exercising.
 */
export type Availability =
  | { available: true; reason: "unclaimed" }
  | { available: false; reason: "do_not_call" | "held" | "in_progress" };

/**
 * Whether anyone may take this lead on right now.
 *
 * ORDER MATTERS: the most restrictive answer is checked first, so no later rule
 * can override it by accident.
 */
export function availability(f: ClaimFacts, _now: number): Availability {
  // 1. Permanent, organisation-wide, never expires. Checked first so nothing
  //    below can hand a do-not-call business to a rep.
  if (f.dnc) return { available: false, reason: "do_not_call" };

  // 2. Marked lost: the conversation ended. It stays lost; nothing recycles it.
  if (f.stage === "lost") return { available: false, reason: "in_progress" };

  // 3. Handoff, paid, and delivery records are never prospect inventory. This
  //    check comes before ownership so even an accidentally orphaned Won row
  //    fails closed instead of reading as available.
  const stage = f.stage?.trim().toLowerCase() || "";
  if (stage && !ACTIVE_PROSPECT_CLAIM_STAGES.has(stage)) {
    return { available: false, reason: "in_progress" };
  }

  // 4. Nobody holds it, and it is neither lost nor active workflow.
  if (!f.assignedTo) return { available: true, reason: "unclaimed" };

  // 5. Held, until someone reassigns it. A logged call says it is being worked.
  return { available: false, reason: f.lastCallAt ? "in_progress" : "held" };
}

/**
 * Whether THIS viewer holds the lead: it is in their own book. A held lead is
 * unavailable to everyone else and stays in its owner's book until someone
 * reassigns it.
 */
export function isInBookOf(f: ClaimFacts, userId: string): boolean {
  if (!f.assignedTo) return false;
  return f.assignedTo.trim().toLowerCase() === userId.trim().toLowerCase();
}

/** The `data` patch that records a claim. Stamped fields are cleared as well as
 *  set: a reassigned lead carries the PREVIOUS owner's lost_at and call stamps,
 *  and leaving them in place would make the new owner's lead read as already
 *  lost, or already worked, whatever the new rep does with it.
 *
 * Source provenance is deliberately absent from this patch. A claim changes
 * who works the lead, not who originally sourced it. Durable
 * `sourced_by_user_id` lets payout logic distinguish the original rep from a
 * later closer; missing legacy identity fails closed in the payout engine. */
export function claimPatch(
  userId: string,
  nowIso: string,
): Record<string, unknown> {
  return {
    ...pipelineCycleAssignmentFacts(userId, nowIso),
    // Collaboration is scoped to the previous owner's active book. A recycled
    // lead must not carry those write grants into the next rep's claim.
    collaborators: [],
    claimed_at: nowIso,
    sales_program: OASIS_WEBSITE_SALES_PROGRAM,
    sales_motion: OASIS_COLD_OUTBOUND_MOTION,
    last_contacted_at: nowIso,
    last_call_at: null,
    lost_at: null,
    stage: "assigned",
    stage_entered_at: nowIso,
  };
}

/** The `data` patch that clears a lead's owner (lib/leads/release.ts). `dnc`
 *  is never touched here -- releasing a lead must not un-suppress a business
 *  that asked not to be called. */
export function releasePatch(): Record<string, unknown> {
  // Releasing ownership also releases every delegated write grant. Keeping
  // collaborators here would leave the former team able to mutate a lead that
  // has no owner, or has since been assigned to somebody else.
  return {
    assigned_to: null,
    assigned_at: null,
    claimed_at: null,
    pipeline_cycle: null,
    collaborators: [],
  };
}

/** Read the ownership facts off a raw stored `data` blob. Tolerant of missing
 *  fields (every lead predates this feature) and never invents a truthy dnc. */
export function factsFrom(data: Record<string, unknown>): ClaimFacts {
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    assignedTo: s(data.assigned_to),
    claimedAt: s(data.claimed_at),
    lastCallAt: s(data.last_call_at),
    stage: s(data.stage),
    lostAt: s(data.lost_at),
    // Strict: only a real boolean true, or the 1 libSQL returns for a boolean
    // column, counts. A stray string must never be read as consent to call
    // someone who opted out -- and must never be read as opt-out either, which
    // is why this is not `Boolean(data.dnc)`.
    dnc: data.dnc === true || data.dnc === 1,
  };
}
