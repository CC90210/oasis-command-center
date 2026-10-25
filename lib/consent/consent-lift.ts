/**
 * lib/consent/consent-lift.ts — the one decision every writer asks before it
 * writes: would this change take back a "stop", and if it would, may it?
 *
 * The rule (which keys count, and how each gate reads them) is pure and lives in
 * lib/consent/lead-consent-flags.ts. This adds the two things around it, in one
 * place so no writer can order them differently:
 *
 *   1. Nobody lifts by default. A change that would lift a marker is refused
 *      unless the caller passes a `lifter`: the workspace owner or admin (by
 *      BASE role, session.isTrueAdmin; the admin_access grant is not enough)
 *      who is making it. AI actions, the bridge, bulk edits, imports, quick-add
 *      and automations pass none.
 *   2. A lift leaves a record, written FIRST. A `lead_interactions` row of type
 *      `consent_flag_lifted` names the keys (never their values) and who did it.
 *      If it cannot be written the lift is not made, so there is never a lift
 *      without a record. If the write that follows then fails, the row remains
 *      and says the lift was attempted; the safe direction to be wrong in.
 *
 * Callers turn the answer into their own refusal: updateRecord throws a
 * RecordsError, set-field answers 409 or 500, the workflow step returns failed.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { isConsentBearingEntity, liftedConsentKeysByPatch } from "./lead-consent-flags";

/** Who is making a lift, and through which route (stored as the row's agent_source). */
export type ConsentLifter = { actorUserId: string; via: string };

export type ConsentGuardResult =
  /** Nothing is lifted, or `lifted` is non-empty and the lift is allowed and already recorded. */
  | { ok: true; lifted: string[] }
  /** "locked": nobody who may lift asked. "not_recorded": the record could not be written. */
  | { ok: false; reason: "locked" | "not_recorded"; lifted: string[] };

export async function guardConsentLift(input: {
  tenantId: string;
  /** tenant_records.entity_type; only leads and applications carry these markers. */
  entity: string;
  recordId: string;
  /** The record's data as it is stored now. */
  before: unknown;
  /** The shallow-merge patch about to be written. */
  patch: unknown;
  /** The owner or admin making the lift, or null when no one who may is asking. */
  lifter: ConsentLifter | null;
}): Promise<ConsentGuardResult> {
  if (!isConsentBearingEntity(input.entity)) return { ok: true, lifted: [] };
  const lifted = liftedConsentKeysByPatch(input.before, input.patch);
  if (lifted.length === 0) return { ok: true, lifted };
  if (!input.lifter) return { ok: false, reason: "locked", lifted };

  const recorded = await recordLift(input.tenantId, input.recordId, lifted, input.lifter);
  if (!recorded.ok) {
    console.error("[consent.guardConsentLift] lift not recorded; nothing was changed", {
      tenantId: input.tenantId,
      recordId: input.recordId,
      keys: lifted,
      via: input.lifter.via,
      error: recorded.error,
    });
    return { ok: false, reason: "not_recorded", lifted };
  }
  return { ok: true, lifted };
}

async function recordLift(
  tenantId: string,
  recordId: string,
  keys: readonly string[],
  lifter: ConsentLifter,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Written BEFORE the record write, which can still fail: the row records the authorisation,
  // not a completed lift (review, #728). The type stays consent_flag_lifted for its readers.
  const content = `Consent flag lift authorised by a workspace owner or admin: ${keys.join(", ")}.`;
  try {
    const res = await getServiceSupabase()
      .from("lead_interactions")
      .insert({
        tenant_id: tenantId,
        lead_id: recordId,
        type: "consent_flag_lifted",
        channel: "system",
        direction: "internal",
        agent_source: lifter.via,
        actor_user_id: lifter.actorUserId,
        subject: "Consent flag lift authorised",
        content,
        content_preview: content,
        metadata: { keys: [...keys], lifted_by: lifter.actorUserId, via: lifter.via, stage: "authorised" },
      });
    if (res.error) return { ok: false, error: res.error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
