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
import { getServiceSupabase } from "@/lib/supabase-server";
import { checkPhoneOptOut, checkEmailSuppressed } from "@/lib/lead-interactions-queries";
import { sanitizeBlastMessage } from "@/lib/integrations/blast-safety";
import { checkTcpaWindow, nextTcpaWindowStart } from "@/lib/tcpa-window";
import { renderTemplate } from "@/lib/drips/templates";
import { parseDripSteps, type DripStep } from "@/lib/drips/types";
import { sendDripSms, sendDripEmail } from "@/lib/drips/send";
import { resolveDripSmsIdentity } from "@/lib/drips/rep-sms-identity";
import { nudgeConversations } from "@/lib/realtime/conversations-nudge";

export const BATCH_LIMIT = 50;
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
type SequenceRow = { id: string; name: string; enabled: boolean; steps: unknown };

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
};

/** Per-row outcome, tallied in-process by the main loop (no post-hoc DB
 *  query needed — every code path below returns exactly one of these). */
type StepOutcome = "sent" | "dry_run" | "rescheduled" | "retry_pending" | "failed";

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
  },
) {
  try {
    await db.from("lead_interactions").insert({
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

/** Insert the next step's row (or leave none — caller marks 'done'). */
async function enqueueNextStep(db: Db, row: ClaimedRow, steps: DripStep[]): Promise<boolean> {
  const next = row.step_index + 1;
  if (next >= steps.length) return false;
  const nextStep = steps[next];
  const scheduledFor = new Date(Date.now() + Math.max(0, nextStep.delay_minutes) * 60_000).toISOString();
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
  if (ins.error && !/duplicate key|unique constraint/i.test(ins.error.message)) {
    console.error("[dispatch-drips] enqueue next step failed", { rowId: row.id, err: ins.error.message });
  }
  return true;
}

/** Step completed (sent for real or logged dry-run). Marks this row 'sent'
 *  (more steps follow) or 'done' (was the last step), and — only when more
 *  steps follow — enqueues the next one. */
async function finishStep(
  db: Db,
  row: ClaimedRow,
  steps: DripStep[],
  fromIdentity: string,
  wasReal: boolean,
): Promise<StepOutcome> {
  const hasNext = await enqueueNextStep(db, row, steps);
  await db
    .from("drip_runs")
    .update({ status: hasNext ? "sent" : "done", sent_at: new Date().toISOString(), from_identity: fromIdentity })
    .eq("id", row.id);
  return wasReal ? "sent" : "dry_run";
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

/** Build the template context with a greeting fallback so a missing
 *  contact_name never renders "Hi ,": falls back to business_name, then a
 *  generic "there". */
function buildContext(data: LeadData): Record<string, unknown> {
  const contactName =
    (typeof data.contact_name === "string" && data.contact_name.trim()) ||
    (typeof data.business_name === "string" && data.business_name.trim()) ||
    "there";
  return { lead: { ...data, contact_name: contactName, first_name: contactName } };
}

async function processSmsStep(
  db: Db,
  row: ClaimedRow,
  data: LeadData,
  step: DripStep,
  steps: DripStep[],
): Promise<StepOutcome> {
  const phone = typeof data.phone === "string" ? data.phone.trim() : "";
  if (!phone) return markPermanentFail(db, row, "missing_phone");

  const supp = await checkPhoneOptOut(row.tenant_id, phone);
  if (supp.optedOut) return markPermanentFail(db, row, "opted_out (replied STOP)");
  if (supp.checkFailed) return markRetryOrFail(db, row, "suppression_check_failed");

  // TCPA quiet-hours: only send SMS within the recipient's local ~8am-9pm.
  // Outside the window, RESCHEDULE (don't fail) to the next in-window
  // instant — the drip analogue of the VPS send-window.
  const tcpa = checkTcpaWindow(phone);
  if (!tcpa.withinWindow) {
    const next = nextTcpaWindowStart(phone);
    return markRescheduled(db, row, next.toISOString(), `quiet_hours (local ${tcpa.timeLabel} ${tcpa.timeZone})`);
  }

  const rendered = renderTemplate(step.body, buildContext(data));
  const clean = await sanitizeBlastMessage(row.tenant_id, rendered);
  if (!clean.ok) {
    return clean.reason === "lender_name"
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
): Promise<StepOutcome> {
  const email = typeof data.email === "string" ? data.email.trim() : "";
  if (!email) return markPermanentFail(db, row, "missing_email");

  const supp = await checkEmailSuppressed(row.tenant_id, email);
  if (supp.suppressed) return markPermanentFail(db, row, "suppressed (unsubscribed)");
  if (supp.checkFailed) return markRetryOrFail(db, row, "suppression_check_failed");

  const ctx = buildContext(data);
  const subject = renderTemplate(step.subject || "", ctx) || "Following up";
  const rendered = renderTemplate(step.body, ctx);
  const clean = await sanitizeBlastMessage(row.tenant_id, rendered);
  if (!clean.ok) {
    return clean.reason === "lender_name"
      ? markPermanentFail(db, row, `blast_safety: ${clean.message}`)
      : markRetryOrFail(db, row, "blast_safety_check_failed");
  }

  const dripsLive = process.env.DRIPS_LIVE === "1";
  const shouldSend = dripSendEnabled();

  let fromIdentity = "dry:submissions@sunbizfunding.com";
  if (shouldSend) {
    const result = await sendDripEmail(row.tenant_id, email, subject, clean.cleaned);
    if (!result.ok) return markRetryOrFail(db, row, result.error);
    fromIdentity = result.fromAddress;
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
    metadata: {
      provider: "submissions_gmail",
      sequence_id: row.sequence_id,
      step_index: row.step_index,
      drip_run_id: row.id,
      dry_run: !shouldSend,
      drips_live: dripsLive,
    },
  });
  const outcome = await finishStep(db, row, steps, fromIdentity, shouldSend);
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

  if (step.channel === "sms") return processSmsStep(db, row, data, step, steps);
  return processEmailStep(db, row, data, step, steps);
}

export async function runDispatchDrips(): Promise<DispatchDripsResult> {
  const startedAt = Date.now();
  const db = getServiceSupabase();
  const nowIso = new Date().toISOString();
  const staleBeforeIso = new Date(Date.now() - STALE_SENDING_MINUTES * 60_000).toISOString();

  // 1) Stale-'sending' recovery — see file header.
  let reclaimed = 0;
  try {
    const reclaim = await db
      .from("drip_runs")
      .update({ status: "scheduled" })
      .eq("status", "sending")
      .lt("scheduled_for", staleBeforeIso)
      .select("id");
    reclaimed = reclaim.data?.length || 0;
  } catch (err) {
    console.error("[dispatch-drips] stale reclaim failed", err);
  }

  // 2) Find due 'scheduled' work.
  const dueRes = await db
    .from("drip_runs")
    .select("id")
    .eq("status", "scheduled")
    .lte("scheduled_for", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(BATCH_LIMIT);
  if (dueRes.error) {
    return { ok: true, reclaimed, claimed: 0, processed: 0, sent: 0, dryRun: 0, rescheduled: 0, retryPending: 0, failed: 0 };
  }
  const dueIds = (dueRes.data || []).map((r) => (r as { id: string }).id);
  if (dueIds.length === 0) {
    return { ok: true, reclaimed, claimed: 0, processed: 0, sent: 0, dryRun: 0, rescheduled: 0, retryPending: 0, failed: 0 };
  }

  // 3) Claim: conditional UPDATE (status still 'scheduled' at write time).
  const claimRes = await db
    .from("drip_runs")
    .update({ status: "sending" })
    .in("id", dueIds)
    .eq("status", "scheduled")
    .select("id, tenant_id, lead_id, sequence_id, sequence_name, step_index, channel, attempts");
  if (claimRes.error) {
    return { ok: true, reclaimed, claimed: 0, processed: 0, sent: 0, dryRun: 0, rescheduled: 0, retryPending: 0, failed: 0 };
  }
  const claimed = (claimRes.data || []) as ClaimedRow[];
  if (claimed.length === 0) {
    return { ok: true, reclaimed, claimed: 0, processed: 0, sent: 0, dryRun: 0, rescheduled: 0, retryPending: 0, failed: 0 };
  }

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
      .select("id, tenant_id, name, enabled, steps")
      .in("id", sequenceIds);
    for (const r of (seqRes.data || []) as Array<{ id: string; tenant_id: string; name: string; enabled: boolean; steps: unknown }>) {
      seqMap.set(`${r.tenant_id}|${r.id}`, { id: r.id, name: r.name, enabled: r.enabled, steps: r.steps });
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
    else failed++;
  }

  return { ok: true, reclaimed, claimed: claimed.length, processed, sent, dryRun, rescheduled, retryPending, failed };
}
