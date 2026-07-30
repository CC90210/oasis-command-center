/**
 * lib/drips/immediate.ts — IO shell for the instant "Send Application" email
 * (2026-07-30).
 *
 * Why this exists: clicking Save used to write the lead and send NOTHING. The
 * email came from the drip engine through four composing delays — the 15-min
 * enroll cron, up to 90 min of enroll jitter, the 08:00-20:00 ET email window,
 * and the 5-min dispatch cron — so a midnight save landed at 08:00. See
 * docs/superpowers/specs/2026-07-30-sunbiz-drip-send-application-design.md.
 *
 * This is NOT a second send path. It calls the same guards the batch enroller
 * calls (now shared in drip-rules-core) and hands the row to the same executor.
 * Volume-PACING controls are bypassed for one operator-initiated transactional
 * message; consent, safety and emergency-stop controls are absolute.
 *
 * Every DECISION lives in lib/drips/immediate-core.ts, which is server-only
 * free and unit-tested. What remains here is DB plumbing.
 */
import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { wasShoppedRecently } from "@/lib/drips/enroller";
import { dispatchRuns } from "@/lib/drips/executor";
import { circuitOpen } from "@/lib/drips/governor";
import { isReEntryEligible, isTruthyFlag, staticSkipReason } from "@/lib/drips/drip-rules-core";
import { computeStep0DelayMinutes, enrollmentBufferForStage } from "@/lib/drips/stage-buffer";
import { ACCELERATED_FLAG, acceleratedSystemLive, hasActiveAcceleratedRun } from "@/lib/drips/accelerated";
import {
  instantEnabled, skipToStatus, statusFromRow,
  type EnrollNowSkip, type InstantEmailOutcome,
} from "@/lib/drips/immediate-core";
import type { DripStep } from "./types";

type Db = ReturnType<typeof getServiceSupabase>;

export type EnrollNowResult =
  | { ok: true; runId: string; sequenceId: string; emailClass: string }
  | { ok: false; reason: EnrollNowSkip };

const REDRIP_COOLDOWN_DEFAULT_DAYS = 7;

/**
 * Enroll ONE lead into the transactional stage sequence, scheduled NOW.
 *
 * collectCandidates() pages through a whole stage; bending it to one lead would
 * contort it for no gain. This loads the single lead and calls the SAME pure
 * guards instead — policy is called twice, never written twice.
 */
export async function enrollNow(args: {
  db: Db; tenantId: string; leadId: string; stage: string;
}): Promise<EnrollNowResult> {
  const { db, tenantId, leadId, stage } = args;

  const leadRes = await db
    .from("tenant_records")
    .select("id, data")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "lead")
    .eq("id", leadId)
    .limit(1);
  const lead = (leadRes.data || [])[0] as { id: string; data: Record<string, unknown> } | undefined;
  if (!lead) return { ok: false, reason: "no_sequence" };
  const data = lead.data || {};

  // The enabled, stage-triggered, TRANSACTIONAL sequence for this stage.
  const seqRes = await db
    .from("drip_sequences")
    .select("id, tenant_id, name, enabled, trigger_filter, steps, email_class")
    .eq("tenant_id", tenantId)
    .eq("enabled", true);
  const seq = ((seqRes.data || []) as Array<Record<string, unknown>>).find((s) => {
    const tf = (s.trigger_filter || {}) as Record<string, unknown>;
    const entityOk = !tf.entity || tf.entity === "lead";
    const fieldOk = !tf.field || tf.field === "stage";
    return entityOk && fieldOk && tf.to === stage && s.email_class === "transactional";
  });
  if (!seq) return { ok: false, reason: "no_sequence" };

  const steps = Array.isArray(seq.steps) ? (seq.steps as DripStep[]) : null;
  if (!steps || steps.length === 0 || !steps[0]) return { ok: false, reason: "sequence_steps_invalid" };
  const first = steps[0];

  // IDENTICAL permanent-guard policy to the batch enroller (drip-rules-core).
  const staticSkip = staticSkipReason(data, stage, first.channel);
  if (staticSkip) return { ok: false, reason: staticSkip };

  // Re-drip cooldown against the most recent non-cancelled run. This is
  // duplicate-prevention layer 2: it covers the window after an inline run
  // settles to 'done', where the partial unique index stops blocking.
  const priorRes = await db
    .from("drip_runs")
    .select("created_at")
    .eq("tenant_id", tenantId)
    .eq("sequence_id", seq.id as string)
    .eq("lead_id", leadId)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(1);
  const prior = (priorRes.data || [])[0] as { created_at: string } | undefined;
  if (prior) {
    const raw = Number((process.env.DRIPS_REDRIP_COOLDOWN_DAYS || "").trim());
    const days = Number.isFinite(raw) && raw >= 0 ? raw : REDRIP_COOLDOWN_DEFAULT_DAYS;
    const eligible = isReEntryEligible({
      lastRunAtMs: new Date(prior.created_at).getTime(),
      stageEnteredAt: data.stage_entered_at,
      nowMs: Date.now(),
      cooldownMs: days * 24 * 3_600_000,
    });
    if (!eligible) return { ok: false, reason: "already_enrolled" };
  }

  // Transient guards — DB calls, so they run last.
  if (await wasShoppedRecently(db, tenantId, leadId, data)) {
    return { ok: false, reason: "shopped_recently" };
  }
  if (
    acceleratedSystemLive() &&
    isTruthyFlag(data[ACCELERATED_FLAG]) &&
    (await hasActiveAcceleratedRun(db, tenantId, leadId))
  ) {
    return { ok: false, reason: "accelerated_chase" };
  }

  // scheduled_for = NOW. No enroll jitter (de-clustering a cohort of one is
  // meaningless) and enrollmentBufferForStage('sent_application') is already 0.
  const delayMin = computeStep0DelayMinutes(first.delay_minutes, enrollmentBufferForStage(stage));
  const ins = await db
    .from("drip_runs")
    .insert({
      tenant_id: tenantId,
      lead_id: leadId,
      sequence_id: seq.id as string,
      sequence_name: seq.name as string,
      step_index: 0,
      channel: first.channel,
      scheduled_for: new Date(Date.now() + delayMin * 60_000).toISOString(),
      status: "scheduled",
    })
    .select("id")
    .single();

  // A unique violation here is duplicate-prevention layer 1 doing its job: an
  // ACTIVE run already exists for this lead+sequence, so a retry, a refresh or
  // a double-click already queued the send.
  if (ins.error || !ins.data) return { ok: false, reason: "already_enrolled" };

  return {
    ok: true,
    runId: (ins.data as { id: string }).id,
    sequenceId: seq.id as string,
    emailClass: String(seq.email_class || "commercial"),
  };
}

/** Enroll + dispatch inline, returning what ACTUALLY happened. */
export async function sendApplicationNow(args: {
  tenantId: string; leadId: string; stage: string;
}): Promise<InstantEmailOutcome> {
  // Emergency stop wins over everything, including an operator action.
  if (circuitOpen()) return { status: "held_circuit_open" };

  const db = getServiceSupabase();
  const enrolled = await enrollNow({ db, ...args });
  if (!enrolled.ok) return { status: skipToStatus(enrolled.reason), reason: enrolled.reason };

  // The row exists either way. With the switch off we simply don't dispatch it
  // inline; the dispatch cron picks it up on its usual cadence.
  if (!instantEnabled()) return { status: "disabled", runId: enrolled.runId };

  let tallies;
  try {
    tallies = await dispatchRuns(db, [enrolled.runId], { immediate: true });
  } catch (err) {
    console.error("[send-application] inline dispatch threw", err);
    return { status: "failed", runId: enrolled.runId, reason: "dispatch_threw" };
  }

  // THE TALLY IS THE ONLY AUTHORITY ON WHETHER BYTES MOVED.
  //
  // The row cannot answer this: executor's advanceRow() terminalizes a SKIPPED
  // or DEDUPED step to the very same 'sent'/'done' status a real send gets, and
  // a forced dry run does too. Only `tallies.sent` counts a genuine send
  // (finishStep with wasReal=true). So 'sent' is reported here and nowhere else,
  // and the row read-back below is used ONLY to explain why it did not send.
  if (tallies.sent > 0) return { status: "sent", runId: enrolled.runId };

  const back = await db.from("drip_runs").select("status, last_error").eq("id", enrolled.runId).single();
  if (back.error || !back.data) {
    // Cannot verify. Never claim 'sent' on an unverified send.
    return { status: "queued", runId: enrolled.runId, reason: "status_unreadable" };
  }
  const row = back.data as { status: string; last_error: string | null };
  const mapped = statusFromRow(row);
  return {
    // Clamp: no path through the row may upgrade a non-send to 'sent'. This is
    // belt-and-braces on top of statusFromRow's own skip handling.
    status: mapped === "sent" ? "queued" : mapped,
    runId: enrolled.runId,
    reason: row.last_error || undefined,
  };
}
