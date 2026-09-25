/**
 * What deactivating a teammate does to their leads — the pure rules.
 *
 * CC retired the OASIS sales team on 2026-09-24 and chose, for the leads those
 * reps held: keep the warm ones on the board for the founders, send the cold
 * ones back to the prospect pool, and leave closed and delivery records with
 * the person who closed them. That choice is THE rule here, so the one-time
 * retirement and every later Active/Inactive toggle in Settings behave the same.
 *
 *   pool   — researched, assigned, attempting_contact (or no stage): nobody has
 *            a conversation going yet, so the lead goes back to Leads for anyone
 *            to claim (web-leads releaseLeads, the existing tested path).
 *   board  — connected, qualified, founder_meeting_booked, demo_completed,
 *            proposal_sent: a live conversation. It stays on the pipeline board,
 *            unassigned and stamped into the current cycle so the cycle
 *            boundary keeps showing it, for CC or Adon to pick up.
 *   keep   — won, lost, onboarding, in_build, client_review, launched: the
 *            owner is history (and commission attribution), not live work.
 *
 * No I/O here, so tests/team-activation.test.ts executes every branch.
 */

/** Far-future ban written to `_supabase_auth_users.banned_until`. Reactivation
 *  only clears a ban carrying exactly this value, so it never lifts a ban that
 *  somebody placed for a different reason. */
export const DEACTIVATION_BAN_UNTIL = "9999-12-31T23:59:59.000Z";

export const POOL_ON_DEACTIVATION: ReadonlySet<string> = new Set([
  "researched",
  "assigned",
  "attempting_contact",
]);

export const BOARD_ON_DEACTIVATION: ReadonlySet<string> = new Set([
  "connected",
  "qualified",
  "founder_meeting_booked",
  "demo_completed",
  "proposal_sent",
]);

export type LeadDisposition = "pool" | "board" | "keep";

export function dispositionForStage(stage: unknown): LeadDisposition {
  const key = typeof stage === "string" ? stage.trim().toLowerCase() : "";
  // A stageless lead predates the lifecycle; it is prospect inventory.
  if (!key || POOL_ON_DEACTIVATION.has(key)) return "pool";
  if (BOARD_ON_DEACTIVATION.has(key)) return "board";
  return "keep";
}

export type DispositionPlan = { pool: string[]; board: string[]; keep: string[] };

export function planLeadDisposition(
  rows: ReadonlyArray<{ id: string; data: Record<string, unknown> | null }>,
): DispositionPlan {
  const plan: DispositionPlan = { pool: [], board: [], keep: [] };
  for (const row of rows) plan[dispositionForStage(row.data?.stage)].push(row.id);
  return plan;
}

/**
 * The `data` patch for a warm lead that stays on the board without an owner.
 *
 * `pipeline_cycle` is set explicitly because the board shows only rows inside
 * the current cycle (lib/pipeline-cycle.ts): without it a lead assigned before
 * the boundary would vanish the moment its owner is cleared. Collaborators go
 * with the owner — their write grants were scoped to that rep's book.
 */
export function boardUnassignPatch(args: {
  previousOwner: string;
  nowIso: string;
  cycleId: string;
}): Record<string, unknown> {
  return {
    assigned_to: null,
    collaborators: [],
    pipeline_cycle: args.cycleId,
    unassigned_from: args.previousOwner,
    unassigned_at: args.nowIso,
    unassigned_reason: "rep_deactivated",
  };
}
