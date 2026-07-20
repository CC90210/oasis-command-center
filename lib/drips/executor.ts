/**
 * lib/drips/executor.ts — dispatch due `drip_runs` rows. Called by
 * /api/cron/dispatch-drips on a ~5 min tick. Clones the proven
 * dispatch-scheduled-sends pattern (app/api/cron/dispatch-scheduled-sends/
 * route.ts): cron-secret auth lives in the route, this file owns claim +
 * render + guard + send + advance.
 *
 * Never-double-send: a row is claimed by a single conditional UPDATE
 * (`WHERE status='scheduled'` in the same statement that sets it to
 * 'sending') — the PostgREST-reachable equivalent of `FOR UPDATE SKIP
 * LOCKED`. Combined with the `uq_drip_runs_active_per_lead_sequence` unique
 * index (migration 115), a lead can never have two live sends in flight for
 * the same sequence.
 *
 * Stale-'sending' recovery: mirrors dispatch-scheduled-sends — any row still
 * 'sending' STALE_SENDING_MINUTES after its scheduled_for is reclaimed back
 * to 'scheduled' at the top of every run, before claiming new work.
 *
 * DRIPS_LIVE — THE drip-specific master go-live gate (see dripSendEnabled()).
 * With DRIPS_LIVE unset (default), `shouldSend` below is FALSE for every row,
 * so neither sendDripSms nor sendDripEmail is ever called — the row is still
 * rendered, guarded, logged (dry_run:true), and advanced to the next step,
 * exactly as if it sent, but zero bytes reach TextTorrent or Gmail. DRIPS_LIVE
 * is deliberately DECOUPLED from the global LIVE_SEND_TEXTTORRENT /
 * LIVE_SEND_EMAIL / DASHBOARD_LIVE_SEND flags (mirrors Constant Contact's own
 * LIVE_SEND_CONSTANT_CONTACT flag) so that turning drips on can't un-gate the
 * dashboard's other SMS/email paths, and drip email can go live without
 * un-gating cold outreach. The global hard kill BRAVO_FORCE_DRY_RUN still
 * clamps everything. WHO enters the funnel is a separate gate — see
 * enroller.ts DRIPS_ENROLL_STAGES + DRIPS_ENROLL_LIMIT.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { checkPhoneOptOut, checkEmailSuppressed } from "@/lib/lead-interactions-queries";
import { sanitizeBlastMessage } from "@/lib/integrations/blast-safety";
import { checkTcpaWindow, nextTcpaWindowStart } from "@/lib/tcpa-window";
import { renderTemplate } from "@/lib/drips/templates";
import { parseDripSteps, type DripStep } from "@/lib/drips/types";
import { sendDripSms, sendDripEmail } from "@/lib/drips/send";
import { buildDripHtml, listUnsubscribeHeader } from "@/lib/drips/html-email";
import { resolveDripSmsIdentity } from "@/lib/drips/rep-sms-identity";
import { nudgeConversations } from "@/lib/realtime/conversations-nudge";

export const BATCH_LIMIT = 12;
// Global drip send ceiling per ROLLING HOUR — the hard "it's a drip, not a
// blast" throttle (2026-07-20). Dispatch will not claim more than
// (HOURLY_CAP - realSendsLastHour) rows, so total real output can never exceed
// ~HOURLY_CAP/hour no matter how many rows are due — a mass-enrolled backlog
// bleeds out as a paced drip instead of detonating. Only enforced in live mode
// (dry runs move zero bytes, so pacing is moot). Tunable; 0 disables the cap.
const HOURLY_CAP = Number(process.env.DRIPS_HOURLY_CAP ?? 30);
// Scheduling jitter (minutes) — spread a cohort's scheduled_for across a window
// so a batch enrolled/advanced together doesn't all come due at the same instant
// (the clustering half of the blast). Same env the enroller uses for step 0.
const STEP_SPREAD_MS = Math.max(0, Number(process.env.DRIPS_ENROLL_SPREAD_MIN ?? 90)) * 60_000;
function spreadJitterMs(): number {
  return STEP_SPREAD_MS > 0 ? Math.floor(Math.random() * STEP_SPREAD_MS) : 0;
}
const MAX_ATTEMPTS = 3;
const STALE_SENDING_MINUTES = 15;
// Soft time budget — mirrors dispatch-scheduled-sends: stop claiming further
// rows once we're this deep into the 60s maxDuration so the function returns
// cleanly. Anything left 'sending' past this point is caught by the
// stale-reclaim on a later run.
const SOFT_BUDGET_MS = 50_000;

/**
 * The drip-specific master send gate. DRIPS_LIVE=1 is the deliberate go-live
 * act for the drip engine; BRAVO_FORCE_DRY_RUN=1 is the global hard kill that
 * always wins. Intentionally NOT coupled to the global LIVE_SEND_* /
 * DASHBOARD_LIVE_SEND flags — see the file header.
 */
function dripSendEnabled(): boolean {
  if ((process.env.BRAVO_FORCE_DRY_RUN || "").trim() === "1") return false;
  return process.env.DRIPS_LIVE === "1";
}

type Db = ReturnType<typeof getServiceSupabase>;

type ClaimedRow = {
  id: string;
  tenant_id: string;
  lead_id: string;
  sequence_id: string;
  sequence_name: string;
  step_index: number;
  channel: "sms" | "email";
  attempts: number;
};

type LeadData = Record<string, unknown>;
type SequenceRow = { id: string; name: string; enabled: boolean; steps: unknown; emailClass: string; triggerStage: string | null };

export type DispatchDripsResult = {
  ok: true;
  reclaimed: number;
  claimed: number;
  processed: number;
  sent: number;
  dryRun: number;
  rescheduled: number;
  retryPending: number;
  failed: number;
  cancelled: number;
};

/** Per-row outcome, tallied in-process by the main loop (no post-hoc DB
 *  query needed — every code path below returns exactly one of these). */
type StepOutcome = "sent" | "dry_run" | "rescheduled" | "retry_pending" | "failed" | "cancelled";

/** Best-effort lead_interactions log — never throws; a logging failure must
 *  never fail an actual send. agent_source is 'sequence:<name>' per the
 *  drip-engine attribution convention (mirrors 'scheduled_send' /
 *  'dashboard_conversations'). actor_user_id is always null — a drip has no
 *  human actor. */
async function logInteraction(
  db: Db,
  args: {
    tenantId: string;
    leadId: string;
    sequenceName: string;
    channel: "sms" | "email";
    toPhone: string | null;
    toEmail: string | null;
    subject: string | null;
    body: string;
    metadata: Record<string, unknown>;
    /** Pin the row id (email drips: = the send_id used in the open/click pixel
     *  URLs, so /api/track/open|click/[id] resolves tenant+lead from this row).
     *  Omit for SMS — the DB generates a random id. */
    interactionId?: string;
  },
) {
  try {
    await db.from("lead_interactions").insert({
      ...(args.interactionId ? { id: args.interactionId } : {}),
      tenant_id: args.tenantId,
      lead_id: args.leadId,
      type: args.channel === "sms" ? "sms_sent" : "email_sent",
      channel: args.channel,
      direction: "outbound",
      agent_source: `sequence:${args.sequenceName}`,
      to_phone: args.toPhone,
      to_email: args.toEmail,
      subject: args.subject,
      content: args.channel === "email" ? args.body : null,
      content_preview: args.body.slice(0, 1024),
      actor_user_id: null,
      metadata: args.metadata,
    });
  } catch (err) {
    console.error("[dispatch-drips] interaction insert failed", err);
  }
}

/** Insert the next step's row. Returns { hasNext, ok }:
 *  - hasNext=false → this was the last step, nothing to enqueue (ok=true).
 *  - hasNext=true, ok=true → the next row was created, OR a concurrent
 *    invocation already created it (a duplicate-key is benign HERE because the
 *    current row is already terminal by the time this is called — the collision
 *    can only be another invocation, never our own still-'sending' row).
 *  - hasNext=true, ok=false → a real (non-duplicate) insert error; the chain
 *    could not advance (audit M8).
 *  MUST be called only AFTER the current row has been moved out of active
 *  status — otherwise the insert collides with our own 'sending' row on the
 *  active-only unique index and every sequence silently stalls at step 0
 *  (audit C1). */
async function enqueueNextStep(
  db: Db,
  row: ClaimedRow,
  steps: DripStep[],
): Promise<{ hasNext: boolean; ok: boolean }> {
  const next = row.step_index + 1;
  if (next >= steps.length) return { hasNext: false, ok: true };
  const nextStep = steps[next];
  const scheduledFor = new Date(
    Date.now() + Math.max(0, nextStep.delay_minutes) * 60_000 + spreadJitterMs(),
  ).toISOString();
  const ins = await db.from("drip_runs").insert({
    tenant_id: row.tenant_id,
    lead_id: row.lead_id,
    sequence_id: row.sequence_id,
    sequence_name: row.sequence_name,
    step_index: next,
    channel: nextStep.channel,
    scheduled_for: scheduledFor,
    status: "scheduled",
  });
  if (ins.error) {
    if (/duplicate key|unique constraint/i.test(ins.error.message)) return { hasNext: true, ok: true };
    console.error("[dispatch-drips] enqueue next step failed", { rowId: row.id, err: ins.error.message });
    return { hasNext: true, ok: false };
  }
  return { hasNext: true, ok: true };
}

/** Advance a completed/skipped row out of active status and, if more steps
 *  follow, enqueue the next one. ORDER IS LOAD-BEARING (audit C1): mark the
 *  current row terminal FIRST, THEN insert the next step, so the insert can't
 *  collide with our own still-'sending' row on the active-only unique index.
 *  The update is guarded on status='sending' so a concurrent stale-reclaim that
 *  already moved the row can't cause a double-advance/double-send (audit H4),
 *  and the result is checked — we enqueue the next step only when the current
 *  row was actually ours to advance (audit M8). Returns true if we advanced it. */
async function advanceRow(
  db: Db,
  row: ClaimedRow,
  steps: DripStep[],
  opts: { fromIdentity?: string; skippedReason?: string; providerMessageId?: string },
): Promise<boolean> {
  const isLast = row.step_index + 1 >= steps.length;
  const patch: Record<string, unknown> = {
    status: isLast ? "done" : "sent",
    sent_at: new Date().toISOString(),
  };
  if (opts.fromIdentity) patch.from_identity = opts.fromIdentity;
  if (opts.skippedReason) patch.last_error = `skipped: ${opts.skippedReason}`.slice(0, 500);
  // rfc822 Message-Id of the email send — the bounce reader's correlation key.
  if (opts.providerMessageId) patch.provider_message_id = opts.providerMessageId.slice(0, 998);
  const upd = await db
    .from("drip_runs")
    .update(patch)
    .eq("id", row.id)
    .eq("status", "sending")
    .select("id");
  if (upd.error || !(upd.data && upd.data.length)) {
    // Row already moved (reclaimed/advanced elsewhere) or the write failed. Do
    // NOT enqueue the next step (would risk a duplicate) and do not re-send —
    // the message, if any, already went out.
    console.error("[dispatch-drips] advanceRow status update did not apply", {
      rowId: row.id,
      err: upd.error?.message,
    });
    return false;
  }
  if (!isLast) {
    const { ok } = await enqueueNextStep(db, row, steps);
    if (!ok) {
      // Step completed but the next row couldn't be created (real insert
      // error). Leave a marker so the watchdog surfaces the stalled chain
      // rather than it dying silently (audit M8).
      await db
        .from("drip_runs")
        .update({ last_error: "advance_failed: next step not enqueued" })
        .eq("id", row.id);
    }
  }
  return true;
}

/** Step completed (sent for real or logged dry-run) — advance the chain. */
async function finishStep(
  db: Db,
  row: ClaimedRow,
  steps: DripStep[],
  fromIdentity: string,
  wasReal: boolean,
  providerMessageId?: string,
): Promise<StepOutcome> {
  await advanceRow(db, row, steps, { fromIdentity, providerMessageId });
  return wasReal ? "sent" : "dry_run";
}

/** The lead can't receive THIS step's channel (no phone for an sms step / no
 *  email for an email step). Skip it and advance — the sequence may have later
 *  steps on the other channel. Do NOT markPermanentFail (that would drop the
 *  lead from the whole sequence over a single unreachable step). audit H5. */
async function skipStep(db: Db, row: ClaimedRow, steps: DripStep[], reason: string): Promise<StepOutcome> {
  await advanceRow(db, row, steps, { skippedReason: reason });
  return "dry_run"; // nothing sent
}

/** Defense-in-depth backstop (the safety net the go-live incident lacked): has
 *  this exact lead already received a REAL send of THIS sequence at THIS
 *  step_index? Checks lead_interactions — the audit trail of what actually went
 *  out — so that even if enrollment or advance logic ever regresses, no lead is
 *  double-sent the same step. Best-effort: on a query error it returns false
 *  (does NOT block) — the CAS claim + the once-per-lead enroll + the reclaim fix
 *  are the primary guards; failing this backstop closed would stall the engine
 *  on a transient blip. */
async function alreadySentStep(db: Db, row: ClaimedRow): Promise<boolean> {
  try {
    const r = await db
      .from("lead_interactions")
      .select("id")
      .eq("tenant_id", row.tenant_id)
      .eq("lead_id", row.lead_id)
      .eq("agent_source", `sequence:${row.sequence_name}`)
      .eq("metadata->>step_index", String(row.step_index))
      .eq("metadata->>dry_run", "false")
      .limit(1);
    return !r.error && Array.isArray(r.data) && r.data.length > 0;
  } catch {
    return false;
  }
}

/** Retryable failure — increments attempts, requeues to 'scheduled' (picked
 *  up next tick, scheduled_for is already <= now) until MAX_ATTEMPTS, then a
 *  permanent 'failed'. */
async function markRetryOrFail(db: Db, row: ClaimedRow, reason: string): Promise<StepOutcome> {
  const attempts = (row.attempts || 0) + 1;
  const status = attempts >= MAX_ATTEMPTS ? "failed" : "scheduled";
  await db.from("drip_runs").update({ status, attempts, last_error: reason.slice(0, 500) }).eq("id", row.id);
  return status === "failed" ? "failed" : "retry_pending";
}

/** Non-retryable failure (confirmed opt-out/suppression/bad definition) —
 *  permanent fail immediately regardless of attempt count. */
async function markPermanentFail(db: Db, row: ClaimedRow, reason: string): Promise<StepOutcome> {
  await db
    .from("drip_runs")
    .update({ status: "failed", attempts: (row.attempts || 0) + 1, last_error: reason.slice(0, 500) })
    .eq("id", row.id);
  return "failed";
}

/** The lead has moved to a DIFFERENT stage than the one this sequence targets,
 *  so this sequence is stale for them — cancel it (don't send, don't advance).
 *  'cancelled' (not 'failed') so it reads as an intentional stage handoff, and
 *  because cancelled rows intentionally don't block re-enrollment the enroller
 *  is already starting the NEW stage's sequence. This is the "cancel old, start
 *  new" rule (2026-07-20): a lead only ever receives its current stage's drip. */
async function markCancelled(db: Db, row: ClaimedRow, reason: string): Promise<StepOutcome> {
  await db.from("drip_runs").update({ status: "cancelled", last_error: reason.slice(0, 500) }).eq("id", row.id);
  return "cancelled";
}

/** Not a failure — the recipient's local clock is outside the TCPA SMS
 *  window. Releases the claim back to 'scheduled' at the next in-window
 *  instant, WITHOUT bumping attempts (this isn't a retry budget spend). */
async function markRescheduled(
  db: Db,
  row: ClaimedRow,
  newScheduledForIso: string,
  reason: string,
): Promise<StepOutcome> {
  await db
    .from("drip_runs")
    .update({ status: "scheduled", scheduled_for: newScheduledForIso, last_error: reason.slice(0, 500) })
    .eq("id", row.id);
  return "rescheduled";
}

function isTruthyFlag(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/** Next 18:00 UTC — the conservative send time for a lead whose area code we
 *  can't map to a timezone (audit H6). 18:00 UTC lands inside the 8am-9pm TCPA
 *  window for EVERY US zone including Hawaii/Alaska and regardless of DST:
 *  UTC-10 (HST) → 08:00 (the floor) up through UTC-4 (EDT) → 14:00. 17:00 UTC
 *  was WRONG — it's 07:00 HST, an hour before the floor (review HIGH-2). */
function safeFallbackSendTime(): Date {
  const t = new Date();
  t.setUTCHours(18, 0, 0, 0);
  if (t.getTime() <= Date.now()) t.setUTCDate(t.getUTCDate() + 1);
  return t;
}

/** Fail-closed-ADJACENT re-check at fire time (defense in depth on top of the
 *  enroller's own guardrails, which only run at enrollment time — a lead can
 *  opt out or go dead in the window between enroll and fire). The load-
 *  bearing fail-closed checks are checkPhoneOptOut/checkEmailSuppressed
 *  below, called per-channel; this is the cheap same-row flag check. */
function isOptedOutOrDead(data: LeadData): boolean {
  return (
    isTruthyFlag(data.opted_out) ||
    isTruthyFlag(data.sms_opt_out) ||
    isTruthyFlag(data.email_opt_out) ||
    data.stage === "opted_out" ||
    data.stage === "dead_file"
  );
}

/** Build the template context with fallbacks so a thin lead row never renders
 *  broken copy. Central to every sequence's quality:
 *   - contact_name / first_name → a neutral "there" (NOT the company name — a
 *     "Hi ACME LLC" greeting reads like a mailmerge miss); first_name is the
 *     first token so "Hi Richard" not "Hi Richard VanderTuig".
 *   - business_name / company → the real business, else "your business"
 *     (company is the alias several seeded templates use for business_name).
 *   - rep_name / assigned_agent_name → the lead's rep (the enroller backfills
 *     rep_name from assigned_to, so this is populated for all but the rare
 *     fully-unassigned lead), else a brand-safe "your funding specialist".
 *     Exposed under BOTH names the seeded sequences reference. */
function buildContext(data: LeadData): Record<string, unknown> {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const rawContact = str(data.contact_name);
  const contactName = rawContact || "there";
  const firstName = rawContact ? rawContact.split(/\s+/)[0] : "there";
  const business = str(data.business_name) || str(data.company) || "your business";
  const repName = str(data.rep_name) || str(data.assigned_agent_name) || "your funding specialist";
  // application_url: per-lead link when present (viewed/signed/declined have it),
  // else the generic SunBiz intake form (same URL pattern the live "Incomplete
  // Application" email uses) so a template never renders a blank link for a
  // hot_lead/follow_up lead. Env-overridable base for domain changes.
  const repSlug = repName.toLowerCase().split(/\s+/)[0].replace(/[^a-z]/g, "") || "team";
  const intakeBase = process.env.DRIP_INTAKE_URL || "https://oasisai.work/f/submissions/initial-lead-capture";
  const applyUrl = str(data.application_url) || `${intakeBase}?rep=${repSlug}`;
  return {
    lead: {
      ...data,
      contact_name: contactName,
      first_name: firstName,
      business_name: business,
      company: business,
      rep_name: repName,
      assigned_agent_name: repName,
      application_url: applyUrl,
    },
  };
}

/** Deterministic per-(lead, step) index into a variant set. STABLE across
 *  retries/reclaims — the reclaim + alreadySentStep dedup key on step_index, so
 *  a RANDOM pick could send a lead a *different* variation on a re-dispatch.
 *  FNV-1a over `${leadId}:${stepIndex}`. */
function stableIndex(seed: string, n: number): number {
  if (n <= 1) return 0;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % n;
}

/** Resolve the subject+body to actually send for this step. When the step
 *  defines body_variants (the "same message in nice variations" mechanism),
 *  pick ONE deterministically per (lead, step); otherwise use the single
 *  body/subject. The chosen string then flows through the unchanged renderer. */
function resolveStepCopy(
  step: DripStep,
  leadId: string,
  stepIndex: number,
): { subject: string; body: string; variantIndex: number } {
  const variants = step.body_variants;
  if (variants && variants.length > 0) {
    const i = stableIndex(`${leadId}:${stepIndex}`, variants.length);
    const subjectVariants = step.subject_variants;
    const subject =
      (subjectVariants && subjectVariants.length > 0 ? subjectVariants[i % subjectVariants.length] : step.subject) || "";
    return { subject, body: variants[i], variantIndex: i };
  }
  return { subject: step.subject || "", body: step.body, variantIndex: 0 };
}

async function processSmsStep(
  db: Db,
  row: ClaimedRow,
  data: LeadData,
  step: DripStep,
  steps: DripStep[],
): Promise<StepOutcome> {
  const phone = typeof data.phone === "string" ? data.phone.trim() : "";
  // No phone for an SMS step: SKIP + advance (the sequence may have email steps
  // this lead CAN receive) rather than fail the whole chain (audit H5).
  if (!phone) return skipStep(db, row, steps, "no_phone_for_sms_step");

  const supp = await checkPhoneOptOut(row.tenant_id, phone);
  if (supp.optedOut) return markPermanentFail(db, row, "opted_out (replied STOP)");
  if (supp.checkFailed) return markRetryOrFail(db, row, "suppression_check_failed");

  // TCPA quiet-hours: only send SMS within the recipient's local ~8am-9pm.
  const tcpa = checkTcpaWindow(phone);
  // FAIL CLOSED on an unresolved timezone (audit H6): if the area code isn't in
  // the NANP map, checkTcpaWindow falls back to the SERVER tz (UTC on Vercel),
  // which would happily "pass" the window at the recipient's pre-dawn local
  // time. We can't prove it's daytime for them, so we don't send — reschedule
  // to a conservative all-US-timezones-safe hour instead.
  if (tcpa.usedFallback) {
    return markRescheduled(db, row, safeFallbackSendTime().toISOString(), "tcpa_unresolved_tz (area code unmapped)");
  }
  if (!tcpa.withinWindow) {
    // Outside the window, RESCHEDULE (don't fail) to the next in-window instant.
    const next = nextTcpaWindowStart(phone);
    return markRescheduled(db, row, next.toISOString(), `quiet_hours (local ${tcpa.timeLabel} ${tcpa.timeZone})`);
  }

  const copy = resolveStepCopy(step, row.lead_id, row.step_index);
  const rendered = renderTemplate(copy.body, buildContext(data));
  const clean = await sanitizeBlastMessage(row.tenant_id, rendered, { checkPositioning: true });
  if (!clean.ok) {
    return clean.reason === "lender_name" || clean.reason === "positioning"
      ? markPermanentFail(db, row, `blast_safety: ${clean.message}`)
      : markRetryOrFail(db, row, "blast_safety_check_failed");
  }

  // Per-rep routing: this lead's SMS goes out AS its rep's TT sub-account
  // (Alex/Jordan) or the admin/parent account (Matt/owner/unattributed), from
  // that rep's own number. Resolved here (before the send gate) so the dry-run
  // log also records who WOULD have sent it.
  const identity = await resolveDripSmsIdentity(row.tenant_id, row.lead_id, data);
  if ("error" in identity) return markRetryOrFail(db, row, `sms_identity: ${identity.error}`);

  const dripsLive = process.env.DRIPS_LIVE === "1";
  const shouldSend = dripSendEnabled();

  // Backstop: never re-send this lead the same sequence step (audit safety net).
  if (shouldSend && (await alreadySentStep(db, row))) {
    return finishStep(db, row, steps, `dedup:${identity.repKey}:${identity.senderId}`, false);
  }

  let fromIdentity = `dry:${identity.repKey}:${identity.senderId}`;
  if (shouldSend) {
    const result = await sendDripSms(row.tenant_id, phone, clean.cleaned, identity);
    if (!result.ok) return markRetryOrFail(db, row, result.error);
    fromIdentity = `${identity.repKey}:${result.fromNumber}`;
  }

  await logInteraction(db, {
    tenantId: row.tenant_id,
    leadId: row.lead_id,
    sequenceName: row.sequence_name,
    channel: "sms",
    toPhone: phone,
    toEmail: null,
    subject: null,
    body: clean.cleaned,
    metadata: {
      provider: "texttorrent",
      account: "main",
      rep: identity.repKey,
      act_as: identity.actAsEmail,
      from_number: identity.senderId,
      sequence_id: row.sequence_id,
      step_index: row.step_index,
      variant_index: copy.variantIndex,
      drip_run_id: row.id,
      dry_run: !shouldSend,
      drips_live: dripsLive,
    },
  });
  const outcome = await finishStep(db, row, steps, fromIdentity, shouldSend);
  await nudgeConversations(row.tenant_id);
  return outcome;
}

async function processEmailStep(
  db: Db,
  row: ClaimedRow,
  data: LeadData,
  step: DripStep,
  steps: DripStep[],
  emailClass: string,
): Promise<StepOutcome> {
  const email = typeof data.email === "string" ? data.email.trim() : "";
  // No email for an email step: SKIP + advance (the sequence may have SMS steps
  // this lead CAN receive) rather than fail the whole chain (audit H5).
  if (!email) return skipStep(db, row, steps, "no_email_for_email_step");

  const supp = await checkEmailSuppressed(row.tenant_id, email);
  if (supp.suppressed) return markPermanentFail(db, row, "suppressed (unsubscribed)");
  if (supp.checkFailed) return markRetryOrFail(db, row, "suppression_check_failed");

  const ctx = buildContext(data);
  const copy = resolveStepCopy(step, row.lead_id, row.step_index);
  const subjectRaw = renderTemplate(copy.subject, ctx) || "Following up";
  const rendered = renderTemplate(copy.body, ctx);
  const clean = await sanitizeBlastMessage(row.tenant_id, rendered, { checkPositioning: true });
  if (!clean.ok) {
    return clean.reason === "lender_name" || clean.reason === "positioning"
      ? markPermanentFail(db, row, `blast_safety: ${clean.message}`)
      : markRetryOrFail(db, row, "blast_safety_check_failed");
  }
  // Guard the SUBJECT too. Only the body was gated here; the subject (and, via
  // resolveStepCopy, any subject_variants) reached the merchant unchecked — a
  // positioning/lender phrase in a subject line slipped through (2026-07-20).
  const subjectGuard = await sanitizeBlastMessage(row.tenant_id, subjectRaw, { checkPositioning: true });
  if (!subjectGuard.ok) {
    return subjectGuard.reason === "lender_name" || subjectGuard.reason === "positioning"
      ? markPermanentFail(db, row, `blast_safety(subject): ${subjectGuard.message}`)
      : markRetryOrFail(db, row, "blast_safety_check_failed");
  }
  const subject = subjectGuard.cleaned.slice(0, 200) || "Following up";

  const dripsLive = process.env.DRIPS_LIVE === "1";
  const shouldSend = dripSendEnabled();

  // Backstop: never re-send this lead the same sequence step (audit safety net).
  if (shouldSend && (await alreadySentStep(db, row))) {
    return finishStep(db, row, steps, "dedup:submissions@sunbizfunding.com", false);
  }

  // send_id pins the lead_interactions row id so /api/track/open|click/<send_id>
  // resolves this exact send (tenant + lead) without trusting the URL. Generated
  // up front so the open pixel + click-wrapped links in the HTML body and the
  // logged interaction row all share the one key.
  const sendId = randomUUID();
  let fromIdentity = "dry:submissions@sunbizfunding.com";
  let providerMessageId: string | undefined;
  if (shouldSend) {
    // Transactional/relationship email (application nudges, statements, etc.) is
    // CAN-SPAM opt-out-exempt → NO visible unsubscribe footer. The invisible
    // List-Unsubscribe header stays for BOTH classes (cuts spam complaints +
    // protects inbox placement). Commercial mail keeps the footer.
    const unsub = emailClass === "transactional" ? "none" : "footer";
    const html = buildDripHtml(clean.cleaned, { sendId, email, unsub });
    const result = await sendDripEmail(row.tenant_id, email, subject, clean.cleaned, {
      html,
      listUnsubscribe: listUnsubscribeHeader(email),
    });
    if (!result.ok) return markRetryOrFail(db, row, result.error);
    fromIdentity = result.fromAddress;
    providerMessageId = result.messageId;
  }

  await logInteraction(db, {
    tenantId: row.tenant_id,
    leadId: row.lead_id,
    sequenceName: row.sequence_name,
    channel: "email",
    toPhone: null,
    toEmail: email,
    subject,
    body: clean.cleaned,
    interactionId: sendId,
    metadata: {
      provider: "submissions_gmail",
      sequence_id: row.sequence_id,
      step_index: row.step_index,
      variant_index: copy.variantIndex,
      drip_run_id: row.id,
      rfc822_message_id: providerMessageId ?? null,
      dry_run: !shouldSend,
      drips_live: dripsLive,
    },
  });
  const outcome = await finishStep(db, row, steps, fromIdentity, shouldSend, providerMessageId);
  await nudgeConversations(row.tenant_id);
  return outcome;
}

async function processRow(
  db: Db,
  row: ClaimedRow,
  leadMap: Map<string, LeadData>,
  seqMap: Map<string, SequenceRow>,
): Promise<StepOutcome> {
  const data = leadMap.get(`${row.tenant_id}|${row.lead_id}`);
  const seq = seqMap.get(`${row.tenant_id}|${row.sequence_id}`);

  if (!data) return markPermanentFail(db, row, "lead_not_found");
  if (!seq) return markPermanentFail(db, row, "sequence_not_found");
  if (!seq.enabled) return markPermanentFail(db, row, "sequence_disabled");

  let steps: DripStep[];
  try {
    steps = parseDripSteps(seq.steps);
  } catch (err) {
    return markPermanentFail(db, row, `sequence_definition_invalid: ${err instanceof Error ? err.message : "unknown"}`);
  }
  const step = steps[row.step_index];
  if (!step) return markPermanentFail(db, row, "step_index_out_of_range");
  if (step.channel !== row.channel) {
    // The sequence definition changed after this row was enqueued — trust
    // the CURRENT definition (the operator's latest edit wins) and log the
    // drift rather than silently sending on a channel the operator changed.
    console.warn("[dispatch-drips] step channel changed since enrollment", {
      rowId: row.id,
      enqueuedChannel: row.channel,
      currentChannel: step.channel,
    });
  }

  if (isOptedOutOrDead(data)) return markPermanentFail(db, row, "lead_opted_out_or_dead");

  // Cancel-old-start-new (2026-07-20): if the lead has moved to a different
  // stage than the one this sequence targets, this sequence is stale for them —
  // cancel it (no send, no advance) instead of continuing to nag about an old
  // stage. The enroller (also stage-matched) is already starting the lead's
  // CURRENT-stage sequence, so this is a clean handoff and stops the "stacking"
  // where a fast-moving lead accumulates several stages' emails at once.
  if (seq.triggerStage && String(data.stage ?? "") !== seq.triggerStage) {
    return markCancelled(db, row, `stage_changed: lead now at ${String(data.stage ?? "unknown")}`);
  }

  if (step.channel === "sms") return processSmsStep(db, row, data, step, steps);
  return processEmailStep(db, row, data, step, steps, seq.emailClass || "commercial");
}

export async function runDispatchDrips(): Promise<DispatchDripsResult> {
  const startedAt = Date.now();
  const db = getServiceSupabase();
  const nowIso = new Date().toISOString();
  const staleBeforeIso = new Date(Date.now() - STALE_SENDING_MINUTES * 60_000).toISOString();

  // 1) Stale-'sending' recovery — keyed on CLAIM age (claimed_at), NOT
  // scheduled_for (audit H3). A row claimed seconds ago whose scheduled_for is
  // >15 min old (normal when dispatch is backed up / after a quiet-hours
  // reschedule) must NOT be reclaimed mid-send — that resurrects an in-flight
  // send and double-texts the merchant. Only a genuine crash-mid-send (row
  // stuck 'sending' with an aged claimed_at) is recovered.
  let reclaimed = 0;
  try {
    const reclaim = await db
      .from("drip_runs")
      .update({ status: "scheduled" })
      .eq("status", "sending")
      .lt("claimed_at", staleBeforeIso)
      .select("id");
    reclaimed = reclaim.data?.length || 0;
  } catch (err) {
    console.error("[dispatch-drips] stale reclaim failed", err);
  }

  const empty = (): DispatchDripsResult => ({
    ok: true, reclaimed, claimed: 0, processed: 0, sent: 0,
    dryRun: 0, rescheduled: 0, retryPending: 0, failed: 0, cancelled: 0,
  });

  // 2) Hourly send cap (live mode only) — the hard drip throttle. Count REAL
  // drip sends in the rolling last hour and claim at most (HOURLY_CAP - that),
  // so total output can never exceed ~HOURLY_CAP/hour no matter how many rows
  // are due. (Dry runs and channel-skips also advance to 'sent'/'done', so this
  // slightly over-counts and errs toward under-sending — the safe side of "no
  // blast". Only enforced in live mode; dry runs move zero bytes.)
  let claimBudget = BATCH_LIMIT;
  if (dripSendEnabled() && HOURLY_CAP > 0) {
    const oneHourAgoIso = new Date(Date.now() - 3_600_000).toISOString();
    try {
      const r = await db
        .from("drip_runs")
        .select("id", { count: "exact", head: true })
        .in("status", ["sent", "done"])
        .gte("sent_at", oneHourAgoIso);
      const sentLastHour = r.count || 0;
      claimBudget = Math.max(0, Math.min(BATCH_LIMIT, HOURLY_CAP - sentLastHour));
    } catch (err) {
      // Can't measure the rate → trickle a few rather than risk a burst.
      console.error("[dispatch-drips] hourly-cap count failed, trickling", err);
      claimBudget = Math.min(BATCH_LIMIT, 5);
    }
    if (claimBudget <= 0) return empty(); // at the hourly ceiling — wait for the next tick
  }

  // 3) Find due 'scheduled' work (bounded by the hourly cap).
  const dueRes = await db
    .from("drip_runs")
    .select("id")
    .eq("status", "scheduled")
    .lte("scheduled_for", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(claimBudget);
  if (dueRes.error) return empty();
  const dueIds = (dueRes.data || []).map((r) => (r as { id: string }).id);
  if (dueIds.length === 0) return empty();

  // 3) Claim: conditional UPDATE (status still 'scheduled' at write time).
  // Stamp claimed_at so the stale-reclaim above can tell a fresh claim from a
  // genuinely stuck one (audit H3).
  const claimRes = await db
    .from("drip_runs")
    .update({ status: "sending", claimed_at: new Date().toISOString() })
    .in("id", dueIds)
    .eq("status", "scheduled")
    .select("id, tenant_id, lead_id, sequence_id, sequence_name, step_index, channel, attempts");
  if (claimRes.error) return empty();
  const claimed = (claimRes.data || []) as ClaimedRow[];
  if (claimed.length === 0) return empty();

  // 4) Batch-prefetch every distinct lead + sequence this batch touches.
  // Maps below are keyed by "tenant_id|id" so a (theoretical) cross-tenant
  // UUID collision can never mix up rows between tenants.
  const leadIds = Array.from(new Set(claimed.map((r) => r.lead_id)));
  const sequenceIds = Array.from(new Set(claimed.map((r) => r.sequence_id)));

  const leadMap = new Map<string, LeadData>();
  try {
    const leadsRes = await db.from("tenant_records").select("id, tenant_id, data").eq("entity_type", "lead").in("id", leadIds);
    for (const r of (leadsRes.data || []) as Array<{ id: string; tenant_id: string; data: LeadData }>) {
      leadMap.set(`${r.tenant_id}|${r.id}`, r.data || {});
    }
  } catch (err) {
    console.error("[dispatch-drips] lead prefetch failed", err);
  }

  const seqMap = new Map<string, SequenceRow>();
  try {
    const seqRes = await db
      .from("drip_sequences")
      .select("id, tenant_id, name, enabled, steps, email_class, trigger_filter")
      .in("id", sequenceIds);
    for (const r of (seqRes.data || []) as Array<{ id: string; tenant_id: string; name: string; enabled: boolean; steps: unknown; email_class: string | null; trigger_filter: unknown }>) {
      const tf = r.trigger_filter as { to?: unknown } | null;
      const triggerStage = tf && typeof tf.to === "string" && tf.to.trim() ? tf.to.trim() : null;
      seqMap.set(`${r.tenant_id}|${r.id}`, { id: r.id, name: r.name, enabled: r.enabled, steps: r.steps, emailClass: r.email_class || "commercial", triggerStage });
    }
  } catch (err) {
    console.error("[dispatch-drips] sequence prefetch failed", err);
  }

  // 5) Process serially, each fully isolated by try/catch so one bad row
  // never blocks the rest of the batch. Stop early if we're eating into the
  // platform timeout — remainder stays 'sending' and is caught by the
  // stale-reclaim above on a later run. Outcomes are tallied in-process
  // (every code path in processRow/markX returns a StepOutcome) rather than
  // via a post-hoc DB re-query — cheaper and unambiguous (a 'sent' status on
  // the row alone can't distinguish a real send from a logged dry-run).
  let processed = 0;
  let sent = 0;
  let dryRun = 0;
  let rescheduled = 0;
  let retryPending = 0;
  let failed = 0;
  let cancelled = 0;
  for (const row of claimed) {
    if (Date.now() - startedAt > SOFT_BUDGET_MS) break;
    let outcome: StepOutcome;
    try {
      outcome = await processRow(db, row, leadMap, seqMap);
    } catch (err) {
      console.error("[dispatch-drips] unhandled row error", row.id, err);
      outcome = await markRetryOrFail(db, row, err instanceof Error ? err.message : "unhandled_error").catch(
        () => "failed" as const,
      );
    }
    processed++;
    if (outcome === "sent") sent++;
    else if (outcome === "dry_run") dryRun++;
    else if (outcome === "rescheduled") rescheduled++;
    else if (outcome === "retry_pending") retryPending++;
    else if (outcome === "cancelled") cancelled++;
    else failed++;
  }

  return { ok: true, reclaimed, claimed: claimed.length, processed, sent, dryRun, rescheduled, retryPending, failed, cancelled };
}
