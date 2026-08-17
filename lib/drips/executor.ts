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
import { sanitizeBlastMessage, stripDashes } from "@/lib/integrations/blast-safety";
import { writeAgentAlert } from "@/lib/notify/agent-alert";
import { maybeMintApplicationUrl, updateRecord } from "@/lib/manifest/data";
import { checkTcpaWindow, nextTcpaWindowStart } from "@/lib/tcpa-window";
import { renderTemplate } from "@/lib/drips/templates";
import { parseDripSteps, type DripStep } from "@/lib/drips/types";
import { sendDripSms, sendDripEmail } from "@/lib/drips/send";
import { brandIsSendable, type BrandKey } from "@/lib/email/brands";
import { brandFooter } from "@/lib/email/brand-shell";
import { isWithinSendWindow } from "@/lib/sms/compliance";
import { contactabilityOf, resolveChannel, onProviderGap } from "@/lib/drips/channel-fallback";
import { AI_WIRE_REP_KEY, aiWireNumbers, isSmsOnly } from "@/lib/drips/ai-wire-core";
import { smsPacingCaps, pacingDecision, windowStartFor, type PacingCounts } from "@/lib/drips/sms-pacing-core";
import { emailCooloff, cooloffDays } from "@/lib/drips/optout-cooloff-core";
import { mayTextFor } from "@/lib/sms/lawful-basis";
import { smsSendAllowed, resetBreakerCache, claimBreakerProbe } from "@/lib/sms/send-breaker";
import { routeOutbound, type ProviderAvailability } from "@/lib/routing/outbound-routing";
import { loadProviderAvailability } from "@/lib/routing/provider-availability";
import { openReceipt } from "@/lib/sms/delivery-receipts";
import { loadBrandsForLeads } from "@/lib/drips/brand-store";
import { loadDealGate } from "@/lib/drips/deal-state-store";
import { brandForStage, brandForSend } from "@/lib/drips/brand-routing";
import { isOnLeadsBoard } from "@/lib/leads/board-visibility";
import { poolFor, resolveCopy, type PoolTemplate } from "@/lib/drips/template-pool";
import { loadApprovedPool } from "@/lib/drips/template-pool-store";
import { wasShoppedRecently } from "@/lib/drips/enroller";
import { SUNBIZ_BRAND, dripTrackingBase, platformTrackingBase, buildDripHtml, listUnsubscribeHeader, pixelUrl, unsubscribeUrl } from "@/lib/drips/html-email";
import { resolveDripSmsIdentity, staticRegistryNumbers, type DripSmsIdentity } from "@/lib/drips/rep-sms-identity";
import { ACCELERATED_FLAG, acceleratedSystemLive, hasActiveAcceleratedRun } from "@/lib/drips/accelerated";
import {
  circuitOpen,
  consumeEmail,
  emailGateReason,
  holdUntilIso,
  isPaused,
  loadEmailBudget,
  type EmailBudget,
} from "@/lib/drips/governor";
import { nudgeConversations } from "@/lib/realtime/conversations-nudge";

export const BATCH_LIMIT = 12;
// Read a numeric env var, treating unset OR blank/whitespace as "use default"
// (a blank secret materializes as "" on some platforms → Number("")===0, which
// would SILENTLY disable the cap/jitter below — the exact silent failure to
// avoid). Non-numeric also falls back to the default.
function envNum(name: string, def: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}
// Global drip send ceiling per ROLLING HOUR — the hard "it's a drip, not a
// blast" throttle (2026-07-20). Dispatch will not claim more than
// (HOURLY_CAP - realSendsLastHour) rows, so total real output can never exceed
// ~HOURLY_CAP/hour no matter how many rows are due — a mass-enrolled backlog
// bleeds out as a paced drip instead of detonating. Only enforced in live mode
// (dry runs move zero bytes, so pacing is moot). Tunable; 0 disables the cap.
// NOTE: this is a GLOBAL (all-tenant) ceiling — correct while SunBiz is the only
// active drip tenant; make it per-tenant if a second tenant goes live.
const HOURLY_CAP = envNum("DRIPS_HOURLY_CAP", 30);
// How long a paused lead's row waits before being reconsidered. Long enough
// that a paused lead costs almost nothing per dispatch tick, short enough that
// un-pausing resumes the sequence the same day.
const PAUSE_HOLD_MS = 6 * 3_600_000;
// Scheduling jitter (minutes) — spread a cohort's scheduled_for across a window
// so a batch enrolled/advanced together doesn't all come due at the same instant
// (the clustering half of the blast). Same env the enroller uses for step 0.
const STEP_SPREAD_MS = Math.max(0, envNum("DRIPS_ENROLL_SPREAD_MIN", 90)) * 60_000;
function spreadJitterMs(): number {
  return STEP_SPREAD_MS > 0 ? Math.floor(Math.random() * STEP_SPREAD_MS) : 0;
}

// Email business-hours window (2026-07-21). Unlike SMS, email has no TCPA gate,
// so a step due at 3am would send at 3am. This reschedules an off-hours email
// step to the next window-start, so drip email lands in daytime ("every
// morning") for every lead + sequence. Fixed business TZ (email has no per-lead
// tz). Set START<=0 & END>=24 (or END<=START) to disable.
const EMAIL_WIN_START = envNum("DRIP_EMAIL_WINDOW_START", 8);
const EMAIL_WIN_END = envNum("DRIP_EMAIL_WINDOW_END", 20);
const EMAIL_WIN_TZ = (process.env.DRIP_EMAIL_WINDOW_TZ || "America/New_York").trim() || "America/New_York";

const E164_RE = /^\+[1-9][0-9]{9,14}$/;

/**
 * Runtime override for the accelerated two-number pool (JSON array of E.164
 * strings, e.g. '["+15614650503","+14707429516"]'). When set AND valid, it
 * replaces whatever numbers are baked into the sequence's steps — so a
 * carrier-burned accelerated number can be rotated WITHOUT a redeploy or a
 * sequence re-install (mirrors DRIP_REP_SMS_IDENTITIES). A malformed/empty
 * value falls back to the step's own from_number (fail-safe, never a throw). */
function acceleratedNumberPool(): string[] {
  const raw = (process.env.DRIP_ACCELERATED_NUMBERS || "").trim();
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string" && E164_RE.test(x.trim())).map((x) => x.trim());
  } catch {
    return [];
  }
}

/**
 * The pinned sending number for one SMS step, or null to use the per-rep
 * identity. A step opts in by declaring `from_number`; the env pool (if any)
 * overrides it, alternating by step_index so consecutive sends rotate across
 * the two numbers. Always E.164-validated before it can reach sender_id. */
function pinnedSenderId(step: DripStep, stepIndex: number): string | null {
  const baked = typeof step.from_number === "string" ? step.from_number.trim() : "";
  if (!baked) return null; // step didn't opt in — normal per-rep routing
  const pool = acceleratedNumberPool();
  const pick = pool.length ? pool[stepIndex % pool.length] : baked;
  if (E164_RE.test(pick)) return pick;
  return E164_RE.test(baked) ? baked : null;
}

/** ms the wall-clock in `tz` is ahead of UTC at `date` (negative for US zones). */
function tzOffsetMs(tz: string, date: Date): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

/** If `now` is OUTSIDE the email window, the next window-start Date; else null.
 *  Fails OPEN on a bad TZ / Intl error (returns null = no gate) — this is a
 *  cosmetic daytime nudge, not a legal window like TCPA, so a misconfig must not
 *  brick the email send path. */
function emailWindowNextStart(now: Date = new Date()): Date | null {
  try {
    if (!(EMAIL_WIN_END > EMAIL_WIN_START) || (EMAIL_WIN_START <= 0 && EMAIL_WIN_END >= 24)) return null; // disabled
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: EMAIL_WIN_TZ, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    }).formatToParts(now).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
    const hour = +parts.hour;
    if (hour >= EMAIL_WIN_START && hour < EMAIL_WIN_END) return null; // inside window
    let y = +parts.year, m = +parts.month, d = +parts.day;
    if (hour >= EMAIL_WIN_END) {
      // after close → advance to tomorrow's open (rolls month/year correctly).
      const t = new Date(Date.UTC(y, m - 1, d) + 86_400_000);
      y = t.getUTCFullYear(); m = t.getUTCMonth() + 1; d = t.getUTCDate();
    } // else (before open) → today's open
    const localOpenAsUTC = Date.UTC(y, m - 1, d, EMAIL_WIN_START, 0, 0);
    // Offset at the TARGET (not `now`), so a DST change between now and the
    // target open can't shift the result by an hour.
    return new Date(localOpenAsUTC - tzOffsetMs(EMAIL_WIN_TZ, new Date(localOpenAsUTC)));
  } catch {
    return null;
  }
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
 *
 * DRIPS_CIRCUIT_OPEN=1 (2026-07-29) is the third stop: a one-flag halt for a
 * human or a watchdog to trip when something is visibly wrong (a bounce spike, a
 * bad template that already went out) WITHOUT having to take DRIPS_LIVE down and
 * lose the distinction between "we never went live" and "we hit the brakes".
 * Rows keep rendering, logging and advancing as dry runs, so nothing is lost.
 */
function dripSendEnabled(): boolean {
  if ((process.env.BRAVO_FORCE_DRY_RUN || "").trim() === "1") return false;
  if (circuitOpen()) return false;
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
type SequenceRow = { id: string; name: string; enabled: boolean; steps: unknown; emailClass: string; triggerStage: string | null; triggerFlag: string | null };

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
  /** True when the run stopped early because TextTorrent credits ran out. */
  creditHalted: boolean;
};

/** Per-row outcome, tallied in-process by the main loop (no post-hoc DB
 *  query needed — every code path below returns exactly one of these). */
type StepOutcome = "sent" | "dry_run" | "rescheduled" | "retry_pending" | "failed" | "cancelled";

/** Mutable per-run state. `creditExhausted` latches the moment TextTorrent
 *  reports an account-wide credit outage. This matters because Step 1
 *  (`/inbox/chat/create`) is FREE and returns 201 even at a zero balance, while
 *  only the Step 2 send is billable — so continuing the batch mints one empty
 *  chat per remaining row while every send 422s. Parking rows individually (the
 *  existing +6h behaviour) fixes the retry burn but NOT the chat litter; the main
 *  loop must also stop claiming further work. 2026-07-23 incident: 1,232 chats,
 *  0 messages delivered. */
type RunState = {
  creditExhausted: boolean;
  /** Email volume budget for this dispatch run (governor.ts). Null when the run
   *  claimed no email rows, or in dry-run mode where no bytes move. */
  emailBudget: EmailBudget | null;
  /** Sending brand per lead_id, resolved once per run from the stamp the
   *  enroller wrote. Absent lead => sunbiz, which is the pre-existing
   *  behaviour and what every lead currently in the CRM knows. */
  brandByLead: Map<string, BrandKey>;
  /** APPROVED drip templates for this tenant, loaded once. Empty means copy
   *  falls back to each step's own variants, i.e. the pre-pool behaviour. */
  /** Keyed by tenant. A batch can span tenants and approved copy is tenant
   *  property: one flat pool would let tenant A's templates render for
   *  tenant B's merchants. */
  templatePoolByTenant: Map<string, PoolTemplate[]>;
  /** Provider availability per tenant, loaded once per run. Resolving it per
   *  ROW meant one service-role credential query per SMS in the batch, which
   *  on an SMS-heavy run is dozens of extra round trips against a soft time
   *  budget — and rows left 'sending' until stale recovery. */
  availabilityByTenant: Map<string, ProviderAvailability>;
  /** Sending lines per `${tenantId}::${wire}`, so the per-wire breaker scope is
   *  resolved once per run rather than once per SMS row. */
  linesByWire: Map<string, string[]>;
  /** SMS already sent today / this hour, counted ONCE per run and incremented
   *  locally as the batch sends. Re-reading per row would issue one counting
   *  query per text and, worse, would race itself into overshooting the cap —
   *  none of this batch's in-flight sends are visible to a fresh read yet. */
  smsCountsByTenant: Map<string, PacingCounts>;
};

/**
 * The lines belonging to ONE wire, for scoping the carrier breaker.
 *
 * An allow-list, deliberately, rather than "every line except the other wire's":
 * the scope is applied inside the query so a busy wire cannot push a quiet
 * wire's receipts out of the LIMIT — and an exclusion cannot be expressed there
 * without an operator the Turso adapter does not implement.
 *
 * The main wire's list therefore has to be enumerated. Cached per run because a
 * dispatch batch is up to 200 rows and this is one query.
 */
async function linesForWire(tenantId: string, wire: string, run: RunState): Promise<string[]> {
  const key = `${tenantId}::${wire}`;
  const hit = run.linesByWire.get(key);
  if (hit) return hit;

  const aiLines = aiWireNumbers();
  let lines: string[];
  if (wire === AI_WIRE_REP_KEY) {
    lines = aiLines;
  } else {
    const db = getServiceSupabase();
    const r = await db
      .from("sms_sender_numbers")
      .select("number, rep_key")
      .eq("tenant_id", tenantId)
      .eq("active", true);
    const rows = (r.data || []) as Array<{ number: string; rep_key: string }>;
    lines = rows.filter((x) => x.rep_key !== AI_WIRE_REP_KEY).map((x) => x.number);
    // A read failure or a cold table must NOT produce an empty allow-list: an
    // empty scope means "no sample", the breaker sees no failures, and it would
    // permit sending straight into the route it is meant to be guarding. The
    // static registry is the floor.
    if (lines.length === 0) {
      lines = staticRegistryNumbers().filter((n) => !aiLines.includes(n));
    }
  }
  run.linesByWire.set(key, lines);
  return lines;
}

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
    const { error } = await db.from("lead_interactions").insert({
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
    if (error) throw error;
  } catch (err) {
    console.error("[dispatch-drips] interaction insert failed", err);
  }
}

/** Exact payload telemetry for successfully dispatched email steps. Runs in
 * parallel with the existing interaction audit after SMTP accepts the message,
 * so it adds no latency to the delivery itself. */
async function logDripEmailEvent(
  db: Db,
  args: {
    tenantId: string;
    merchantId: string;
    sequenceId: string;
    dripRunId: string;
    stepIndex: number;
    recipientEmail: string;
    subject: string;
    payloadText: string;
    payloadHtml: string;
    providerMessageId?: string;
  },
) {
  try {
    const { error } = await db.from("drip_email_events").insert({
      tenant_id: args.tenantId,
      merchant_id: args.merchantId,
      sequence_id: args.sequenceId,
      drip_run_id: args.dripRunId,
      step_index: args.stepIndex,
      recipient_email: args.recipientEmail,
      subject_line: args.subject,
      payload_text: args.payloadText,
      payload_html: args.payloadHtml,
      provider_message_id: args.providerMessageId ?? null,
      sent_at: new Date().toISOString(),
    });
    if (error) throw error;
  } catch (err) {
    console.error("[dispatch-drips] exact email telemetry insert failed", err);
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
async function skipStep(
  db: Db,
  row: ClaimedRow,
  steps: DripStep[],
  reason: string,
  opts: { deliveryFailed?: boolean } = {},
): Promise<StepOutcome> {
  // A BENIGN skip (no phone for an sms step) and a DELIVERY FAILURE (the
  // provider rejected the message three times) are not the same event, and
  // until 2026-08-06 both were recorded identically: advanced, status 'sent',
  // last_error prefixed 'skipped:'. That is how 1,070 TextTorrent 422s over
  // three weeks stayed invisible — 865 of 1,348 rows read 'sent' while nothing
  // had been delivered, and every dashboard counted them as sends.
  //
  // The row still ADVANCES either way: a lead must not be stranded mid-sequence
  // because one provider call failed. What changes is that the failure is now
  // labelled as one and counted as one, so a health check can see it.
  await advanceRow(db, row, steps, {
    skippedReason: opts.deliveryFailed ? `delivery_failed: ${reason}` : reason,
  });
  return opts.deliveryFailed ? "failed" : "dry_run";
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

/** Handle a blast-safety guard BLOCK for a drip step (2026-07-20 hardening).
 *  The guard must stay fail-closed (no bad copy reaches a merchant) but must NOT
 *  silently PERMANENT-drop a lead's whole chain — that turned a template bug or a
 *  transient DB blip into invisible lead loss.
 *   - positioning / lender_name  → a TEMPLATE bug, not a per-lead problem. Alert
 *     operators (deduped to ONE card per sequence) to fix the copy, and
 *     skip-advance this step so the lead still gets later steps.
 *   - safety_check_failed        → the lender-name lookup couldn't run (transient
 *     DB error). RESCHEDULE (no attempt burn) so the channel recovers when the DB
 *     does, and raise a deduped alert so a persistent stall is never silent. */
async function handleGuardBlock(
  db: Db,
  row: ClaimedRow,
  steps: DripStep[],
  guard: { reason: string; message: string },
  where: string,
): Promise<StepOutcome> {
  if (guard.reason === "lender_name" || guard.reason === "positioning") {
    await writeAgentAlert({
      tenantId: row.tenant_id,
      alertType: "drip_blast_safety_block",
      lane: "sunbiz-ops",
      severity: "warn",
      title: `Drip copy blocked by compliance: ${row.sequence_name}`,
      body: `${where} step ${row.step_index}: ${guard.message} Fix the sequence template; leads are skipping this step until you do.`,
      subjectType: "drip_sequence",
      subjectId: row.sequence_id,
      payload: { step_index: row.step_index, reason: guard.reason, where },
    }).catch(() => {});
    return skipStep(db, row, steps, `blast_safety_skipped(${where}): ${guard.message}`);
  }
  // safety_check_failed — fail-closed, but recoverable, never a permanent drop.
  await writeAgentAlert({
    tenantId: row.tenant_id,
    alertType: "drip_safety_lookup_failed",
    lane: "sunbiz-ops",
    severity: "warn",
    title: "Drip compliance check can't run — sends rescheduling",
    body: "The lender-name safety lookup is failing; drip sends are rescheduling (fail-closed, not dropped) until it recovers.",
  }).catch(() => {});
  const retryAt = new Date(Date.now() + 15 * 60_000).toISOString();
  return markRescheduled(db, row, retryAt, `blast_safety_check_failed(${where}) - retrying`);
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

/** UTC hours during which an unmapped-area-code lead may be texted.
 *
 *  Derived the same way as the 18:00 anchor above. At UTC hour H a zone at
 *  UTC-N reads H-N locally, and the TCPA window is [8, 21):
 *    HST (UTC-10) needs H >= 18   →  18:00 UTC is 08:00, the floor
 *    EDT (UTC-4)  needs H  < 25   →  never binds
 *  So [18, 21) is inside the window for every US STATE, DST included: EDT sees
 *  14:00-17:00 and Hawaii sees 08:00-11:00.
 *
 *  ENDS AT 21, NOT 22. The unmapped path falls through to `tcpa.withinWindow`
 *  below, which on this fallback is evaluated against the SERVER timezone —
 *  UTC on Vercel — and [8, 21) excludes hour 21. So a declared 22 would have
 *  advertised four hours and delivered three, with the last hour silently
 *  rescheduling. Codex caught the mismatch; the honest boundary is the real
 *  one.
 *
 *  US TERRITORIES ARE NOT COVERED BY THIS REASONING and cannot be: Guam
 *  (UTC+10) and American Samoa (UTC-11) are 21 hours apart, so no single UTC
 *  hour is inside 8am-9pm for both. They are handled by being MAPPED in
 *  lib/tcpa-window.ts instead, which keeps them off this path entirely. */
const SAFE_FALLBACK_UTC_START = 18;
const SAFE_FALLBACK_UTC_END = 21;

function insideSafeFallbackWindow(at: Date = new Date()): boolean {
  const h = at.getUTCHours();
  return h >= SAFE_FALLBACK_UTC_START && h < SAFE_FALLBACK_UTC_END;
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

// The deterministic per-(lead, step) variant hash moved to
// lib/drips/template-pool.ts when copy resolution did (2026-08-06). It is
// FNV-1a over `${leadId}:${stepIndex}` and must stay STABLE across
// retries/reclaims: reclaim + alreadySentStep dedup on step_index, so a random
// pick would send a lead a DIFFERENT variation on re-dispatch, which reads to
// the merchant as a second, different message.
//
// Deliberately not re-declared here. Two copies of a hash that must agree is a
// drift waiting to happen, and the failure would be silent.

/** Resolve the subject+body to actually send for this step. When the step
 *  defines body_variants (the "same message in nice variations" mechanism),
 *  pick ONE deterministically per (lead, step); otherwise use the single
 *  body/subject. The chosen string then flows through the unchanged renderer. */
function resolveStepCopy(
  step: DripStep,
  leadId: string,
  stepIndex: number,
  opts?: { brand?: BrandKey; stage?: string; pool?: PoolTemplate[] },
): { subject: string; body: string; bodyHtml?: string; variantIndex: number; source: string; templateId: string | null } {
  // Narrow the run's pool to templates doing the SAME JOB for this brand and
  // stage, so an opener is never substituted by a last call. An unset role on
  // the step means "nudge", the neutral middle of the arc.
  const scoped =
    opts?.pool && opts.pool.length > 0 && opts.brand && opts.stage
      ? poolFor(opts.pool, opts.brand, opts.stage, String(step.role || "nudge"))
      : [];
  // Precedence lives in the pure module: approved pool, then the step's own
  // variants, then its plain copy. An empty pool reproduces the pre-pool engine
  // byte for byte, which is what makes this deployable before anything is
  // seeded.
  return resolveCopy(step, leadId, stepIndex, scoped);
}

/**
 * How many drip texts have already gone out today, and in the current hour.
 *
 * Counted from lead_interactions `sms_sent`, the same row the send path writes,
 * so the pacing gate and the record can never disagree about what a text is.
 *
 * FAILS CLOSED at the cap on a read error: an unreadable count returns the
 * ceiling, which holds the row rather than sending. A breaker that cannot see
 * must not wave traffic through, and a held text costs an hour while an
 * unbounded burst costs the number.
 */
async function loadSmsCounts(db: Db, tenantId: string): Promise<PacingCounts> {
  const caps = smsPacingCaps();
  const now = Date.now();
  // Counted from the current sending window, NOT a rolling 24 hours. A rolling
  // count disagrees with the fixed resume boundary: reach the cap at 20:00,
  // resume at 14:00 tomorrow, and the prior afternoon's sends are still inside
  // the last 24 hours, so the row re-holds for another full day. 40 a day
  // silently becomes 40 every two days.
  const dayAgo = windowStartFor(new Date(now), caps.windowStartUtcHour).toISOString();
  const hourAgo = new Date(now - 3_600_000).toISOString();
  try {
    const r = await db
      .from("lead_interactions")
      .select("created_at")
      .eq("tenant_id", tenantId)
      .eq("type", "sms_sent")
      .eq("direction", "outbound")
      .like("agent_source", "sequence:%")
      .gte("created_at", dayAgo)
      .limit(1000);
    if (r.error) return { sentToday: caps.daily, sentThisHour: caps.hourly };
    const rows = (r.data || []) as Array<{ created_at: string }>;
    return {
      sentToday: rows.length,
      sentThisHour: rows.filter((x) => x.created_at >= hourAgo).length,
    };
  } catch {
    return { sentToday: caps.daily, sentThisHour: caps.hourly };
  }
}

/**
 * SMS is blocked upstream. Email them instead of sitting on the row.
 *
 * WHY THIS EXISTS — measured in production 2026-08-14, and it is the whole
 * reason drip volume was ONE email in 24 hours while every check read green:
 *
 *   220 rows  Follow-up sequence        sms_channel_unavailable: Bluerise has no
 *                                       SMS numbers yet        → +6h, forever
 *    54 rows  Viewed application nudge  sms_carrier_halt: 19 consecutive
 *                                       carrier failures       → +2h, repeatedly
 *
 * Every one of those rescheduled cleanly. Nothing was overdue, nothing failed,
 * no attempt was burned — the engine was behaving exactly as written, and the
 * merchants heard nothing for days. Bluerise is a cold EMAIL brand and is never
 * getting SMS numbers, so "wait for the provider" there is silence with extra
 * steps.
 *
 * The hold is still correct where it is the only honest option, and
 * onProviderGap decides which case this is. When we do fall back, the row is
 * handed to processEmailStep and COMPLETES as an email step — it is not left
 * scheduled, so there is no second send later.
 */
async function holdOrEmailInstead(
  db: Db,
  row: ClaimedRow,
  data: LeadData,
  step: DripStep,
  steps: DripStep[],
  run: RunState,
  emailClass: string,
  holdHours: number,
  gap: string,
): Promise<StepOutcome> {
  const decision = onProviderGap({
    blocked: "sms",
    contact: contactabilityOf(data),
    // An SMS-only stage is locked for this purpose too. Falling back to email
    // because TextTorrent is having a bad hour is exactly the substitution
    // Live Subs was declared SMS-only to prevent, and it would be indefinite:
    // the AI wire's whole reason to exist is that the main wire is carrier-dead.
    channelLocked:
      isTruthyFlag((step as unknown as Record<string, unknown>).channel_locked) || isSmsOnly(data),
    gap,
  });

  if (decision.action === "hold") {
    return markRescheduled(
      db, row, new Date(Date.now() + holdHours * 3_600_000).toISOString(), decision.reason,
    );
  }

  console.warn("[dispatch-drips] sms blocked upstream, sending email instead", {
    leadId: row.lead_id,
    sequence: row.sequence_name,
    step: row.step_index,
    gap,
  });
  return processEmailStep(db, row, data, step, steps, emailClass, run);
}

async function processSmsStep(
  db: Db,
  row: ClaimedRow,
  data: LeadData,
  step: DripStep,
  steps: DripStep[],
  run: RunState,
  /** Sequence class. Transactional chases on a live deal are not solicitations
   *  and are exempt from the marketing consent bar — see mayTextFor. */
  emailClass: string,
): Promise<StepOutcome> {
  const phone = typeof data.phone === "string" ? data.phone.trim() : "";
  // No phone for an SMS step: SKIP + advance (the sequence may have email steps
  // this lead CAN receive) rather than fail the whole chain (audit H5).
  if (!phone) return skipStep(db, row, steps, "no_phone_for_sms_step");

  const supp = await checkPhoneOptOut(row.tenant_id, phone);
  if (supp.optedOut) return markPermanentFail(db, row, "opted_out (replied STOP)");
  if (supp.checkFailed) return markRetryOrFail(db, row, "suppression_check_failed");

  // LAWFUL BASIS TO TEXT. Email and SMS are not interchangeable in law: email
  // needs no prior permission, a marketing text does. $500 a message, $1,500 if
  // wilful, no cap, private right of action, and Florida has its own statute —
  // which matters because these are Florida merchants.
  //
  // This became load-bearing the moment the channel fallback landed. Without it,
  // "we have their number so text them" routes 240 purchased and 119 cold-called
  // leads — all phone-only, none with a consent record — straight into SMS.
  //
  // Transactional chases on a deal already in motion are exempt: asking for a
  // signature or a document is not a solicitation, and blocking those would
  // stall live deals for no compliance gain.
  {
    const purpose = emailClass === "transactional" ? "transactional" : "marketing";
    const basis = mayTextFor(data, purpose);
    if (!basis.mayText) {
      // NOT a failure and NOT a retry: nothing about this lead will change on
      // its own. Skip the step and advance so the sequence's email steps still
      // run, and record the basis so the decision is reconstructable.
      return skipStep(db, row, steps, `sms_no_lawful_basis: ${basis.reason}`);
    }
  }

  // TCPA quiet-hours: only send SMS within the recipient's local ~8am-9pm.
  const tcpa = checkTcpaWindow(phone);
  // FAIL CLOSED on an unresolved timezone (audit H6): if the area code isn't in
  // the NANP map, checkTcpaWindow falls back to the SERVER tz (UTC on Vercel),
  // which would happily "pass" the window at the recipient's pre-dawn local
  // time. We can't prove it's daytime for them, so we don't send — reschedule
  // to a conservative all-US-timezones-safe hour instead.
  if (tcpa.usedFallback && !insideSafeFallbackWindow()) {
    // Outside the safe hours — wait for them. Inside, fall through and SEND.
    //
    // THIS BRANCH USED TO RESCHEDULE UNCONDITIONALLY, and that made it a
    // permanent loop: the row came due at 18:00 UTC, the area code was still
    // unmapped, `usedFallback` was still true, and it was pushed to the next
    // 18:00 UTC. Forever. Measured 2026-08-14: 106 rows stuck, 98 of them
    // created on 2026-07-20 — twenty-five days, attempts still 0, not one
    // message ever sent. No error, no overdue row, nothing to see.
    //
    // The window below is exactly what the reschedule target was always for.
    // Refusing to send AT the safe hour makes computing a safe hour pointless.
    return markRescheduled(db, row, safeFallbackSendTime().toISOString(), "tcpa_unresolved_tz (area code unmapped)");
  }
  if (!tcpa.withinWindow) {
    // Outside the window, RESCHEDULE (don't fail) to the next in-window instant.
    const next = nextTcpaWindowStart(phone);
    return markRescheduled(db, row, next.toISOString(), `quiet_hours (local ${tcpa.timeLabel} ${tcpa.timeZone})`);
  }

  // STATE-SPECIFIC quiet hours, on top of the federal 8am-9pm check above.
  //
  // The federal window is not sufficient: FL, MD and OK close at 8pm, AL, LA
  // and MS additionally bar Sunday solicitation, Rhode Island closes at 6pm on
  // weekdays and 5pm Saturday, and Texas does not open until noon on Sunday.
  // Sending at 8:30pm to a Florida merchant is legal under the check above and
  // illegal under Florida law.
  //
  // Resolved from the lead's own address state. An absent state falls back to
  // the federal window rather than blocking, because the federal check has
  // already passed and refusing every address-less lead would stall the engine;
  // the tradeoff is recorded on the row so the basis is reconstructable.
  {
    const stateRaw =
      (typeof data.owner_address_state === "string" && data.owner_address_state) ||
      (typeof data.state === "string" && data.state) ||
      (typeof data.business_state === "string" && data.business_state) ||
      null;
    if (stateRaw) {
      // tcpa.timeZone is the recipient's resolved zone; build their local clock.
      const localNow = new Date(
        new Date().toLocaleString("en-US", { timeZone: tcpa.timeZone }),
      );
      // isWithinSendWindow reads UTC getters, so hand it a Date whose UTC
      // fields ARE the recipient's local wall-clock values.
      const asUtc = new Date(
        Date.UTC(
          localNow.getFullYear(),
          localNow.getMonth(),
          localNow.getDate(),
          localNow.getHours(),
          localNow.getMinutes(),
        ),
      );
      const stateWindow = isWithinSendWindow(stateRaw, asUtc);
      if (!stateWindow.ok) {
        const next = nextTcpaWindowStart(phone);
        return markRescheduled(db, row, next.toISOString(), `state_${stateWindow.reason} (${stateRaw})`);
      }
    }
  }

  // SMS copy comes from the same approved pool, scoped to this lead's brand and
  // stage. The brand map is email-keyed for the volume gate, so resolve it here
  // directly; absent means sunbiz, the pre-existing behaviour.
  // Stage decides the desk, and only falls back to the lead's stamped brand
  // when the stage has no rule (see brandForStage). Applied to SMS as well as
  // email so a merchant is never emailed by one company and texted by another —
  // 10DLC registration is per brand and the mismatch is what gets numbers
  // filtered.
  const smsBrand: BrandKey = brandForSend({
    stage: data.stage,
    stampedBrand: run.brandByLead.get(row.lead_id),
  });

  const copy = resolveStepCopy(step, row.lead_id, row.step_index, {
    brand: smsBrand,
    stage: typeof data.stage === "string" ? data.stage : undefined,
    pool: run.templatePoolByTenant.get(row.tenant_id) ?? [],
  });
  const rendered = renderTemplate(copy.body, buildContext(data));
  const clean = await sanitizeBlastMessage(row.tenant_id, rendered, { checkPositioning: true });
  if (!clean.ok) return handleGuardBlock(db, row, steps, clean, "sms");

  // ALLOCATION GATE — deliberately BEFORE sender-identity resolution.
  //
  // Resolving a TextTorrent identity first meant a Bluerise lead, which must
  // HOLD because it has no numbers, would instead fail sender resolution and
  // burn an attempt through markRetryOrFail. The policy promises a reschedule
  // and was delivering a consumed retry. Same for any tenant whose TextTorrent
  // provider is switched off.
  //
  // What it prevents: brand used to be an email-only concept, so a
  // Bluerise-branded merchant would be emailed as Bluerise and texted as SunBiz
  // from a rep's number — two company names in one conversation, the confusing
  // first impression the split exists to avoid, and a carrier problem too, since
  // 10DLC registration is per brand.
  //
  // Skipped on a dry run, which is contracted to render, log and ADVANCE every
  // row without consulting a provider.
  if (dripSendEnabled()) {
    const availability =
      run.availabilityByTenant.get(row.tenant_id) ?? (await loadProviderAvailability(row.tenant_id));
    const route = routeOutbound({ channel: "sms", purpose: "drip", brand: smsBrand, available: availability });
    if (!route.send) {
      return holdOrEmailInstead(
        db, row, data, step, steps, run, emailClass,
        6, `sms_channel_unavailable: ${route.reason}`,
      );
    }
    // Everything below is TextTorrent-specific: the breaker, the act-as
    // identity, sendDripSms. Any other provider HOLDS rather than quietly going
    // out through the wrong account — otherwise enabling Twilio for Bluerise
    // would push Bluerise copy from SunBiz's TextTorrent account, reintroducing
    // the exact mismatch this gate exists to prevent.
    if (route.provider !== "texttorrent") {
      return holdOrEmailInstead(
        db, row, data, step, steps, run, emailClass,
        6, `sms_provider_not_wired: ${route.provider} has no sender in the drip executor yet`,
      );
    }
  }

  // Sender routing. Default: this lead's SMS goes out AS its rep's TT
  // sub-account (Alex/Jordan) or the admin/parent account (Matt/owner/
  // unattributed), from that rep's own number. Resolved here (before the send
  // gate) so the dry-run log also records who WOULD have sent it.
  //   Override: a step with a pinned `from_number` (the accelerated 2-number
  //   chase) sends from THAT number on the parent/admin account (no act-as) —
  //   bypassing per-rep resolution so the two dedicated lines alternate.
  let identity: DripSmsIdentity;
  const pinned = pinnedSenderId(step, row.step_index);
  if (pinned) {
    identity = { actAsEmail: null, senderId: pinned, repKey: "accel" };
  } else {
    const resolved = await resolveDripSmsIdentity(row.tenant_id, row.lead_id, data);
    if ("error" in resolved) {
      // "This rep owns no usable number" is BLOCKED, not FAILED. Retrying
      // cannot buy a number, so burning the attempt budget only converts a
      // fixable operational gap into a dead row. Hold it, name the rep, and let
      // the health check page someone to buy a line.
      // See [[feedback_blocking_not_error]].
      if (resolved.error.startsWith("rep_has_no_line")) {
        return markRescheduled(
          db,
          row,
          new Date(Date.now() + 4 * 3_600_000).toISOString(),
          `sms_no_sender_line (${resolved.error}) — buy a number for this rep in TextTorrent`,
        );
      }
      return markRetryOrFail(db, row, `sms_identity: ${resolved.error}`);
    }
    identity = resolved;
  }

  const dripsLive = process.env.DRIPS_LIVE === "1";
  const shouldSend = dripSendEnabled();

  // Backstop: never re-send this lead the same sequence step (audit safety net).
  if (shouldSend && (await alreadySentStep(db, row))) {
    return finishStep(db, row, steps, `dedup:${identity.repKey}:${identity.senderId}`, false);
  }

  let fromIdentity = `dry:${identity.repKey}:${identity.senderId}`;
  if (shouldSend) {

    // DELIVERY BREAKER. TextTorrent's send endpoint returns 201 for messages the
    // carrier then refuses; between 2026-07-27 and 2026-08-07 it returned 201 to
    // 51 consecutive sends that all failed, and we were billed for every one.
    // The breaker reads the carrier's own verdicts and stops the bleed.
    //
    // RESCHEDULE rather than fail: the route being dead is not this lead's
    // fault, and burning an attempt (or advancing the sequence past a step the
    // merchant never received) would turn a vendor outage into permanent damage
    // to the sequence.
    // Judged PER WIRE, not per tenant. The two TextTorrent accounts are
    // independent routes with separate carrier registrations, and the main
    // SunBiz SID's failures must not halt the Legacy/AI numbers that have never
    // sent — that would hold back the very wire stood up to escape the outage.
    const wire = identity.repKey === AI_WIRE_REP_KEY ? AI_WIRE_REP_KEY : "main";
    // Each wire is judged ONLY on its own lines' receipts, and the scope is an
    // explicit allow-list rather than "everything except the other wire": the
    // filter runs in the query, and an exclusion cannot be expressed there
    // without an operator the Turso adapter does not implement.
    const wireLines = await linesForWire(row.tenant_id, wire, run);
    const breaker = await smsSendAllowed(row.tenant_id, { wire, onlyLines: wireLines });
    // Halted but due for a probe: try to CLAIM it. The claim is a conditional
    // update in Postgres, so exactly one caller wins across every concurrent
    // dispatch instance — an in-process flag would let each instance send its
    // own "one" probe into a dead route. Losing the claim means holding, same
    // as any other halted row.
    const probing =
      breaker.halt && breaker.halfOpen && (await claimBreakerProbe(row.tenant_id, Date.now(), wire));
    if (probing) {
      // Drop the cached verdict so the next row re-reads, sees this send
      // outstanding, and holds rather than riding the 60s cache.
      resetBreakerCache(row.tenant_id);
    } else if (breaker.halt) {
      await writeAgentAlert({
        tenantId: row.tenant_id,
        alertType: "sms_carrier_route_dead",
        lane: "sunbiz-ops",
        severity: "urgent",
        title: "SMS halted — the carrier is refusing our sends",
        body:
          `${breaker.reason}. Drip SMS is paused and every affected step reschedules +2h ` +
          `(no attempt burned, no merchant dropped). TextTorrent returns HTTP 201 on these, ` +
          `so nothing else would have caught it.`,
        telegramOncePerOpen: true, // one page per outage, not one per row
      }).catch(() => {});
      return holdOrEmailInstead(
        db, row, data, step, steps, run, emailClass,
        2, `sms_carrier_halt: ${breaker.reason}`,
      );
    }

    // PACING. Adon, 2026-08-17: "Don't do it as a blast. Just do it as a drip
    // throughout the day." There was no SMS volume governor at all — the
    // governor caps email only — so without this every due row goes out in one
    // dispatch tick, which is 40 texts from one number inside five minutes and
    // precisely the shape carriers filter on.
    //
    // Placed AFTER the breaker and identity resolution so a held row has
    // already proven it could otherwise have sent, and BEFORE sendDripSms so
    // the cap is a real ceiling rather than an after-the-fact count.
    {
      const caps = smsPacingCaps();
      // Keyed by TENANT. A dispatch batch spans tenants, and one shared counter
      // would govern every later tenant by the FIRST one's send history, either
      // holding valid sends or letting a tenant blow past its own cap. Same
      // per-tenant shape as the rest of the run state.
      let counts = run.smsCountsByTenant.get(row.tenant_id);
      if (!counts) {
        counts = await loadSmsCounts(db, row.tenant_id);
        run.smsCountsByTenant.set(row.tenant_id, counts);
      }
      const pace = pacingDecision(counts, caps, new Date());
      if (!pace.send) {
        return markRescheduled(db, row, pace.resumeAt.toISOString(), pace.reason);
      }
    }

    const result = await sendDripSms(row.tenant_id, phone, clean.cleaned, identity);
    if (!result.ok) {
      // GLOBAL transient: TT credit exhaustion hits EVERY send at once. Burning
      // per-lead retry budgets mass-fails the fleet (2026-07-22 incident: 49
      // runs failed in one evening and cascaded into wrongful auto-deads).
      // Park the row (+6h, no attempt spent) + ONE deduped urgent alert.
      if (result.code === "insufficient_credits" || /enough credits/i.test(result.error)) {
        // Latch so the main loop stops claiming further rows. Without this the
        // batch keeps running and every remaining row still executes the FREE
        // Step 1, leaving an empty chat in the rep's inbox for a send that can
        // never go out.
        run.creditExhausted = true;
        await writeAgentAlert({
          tenantId: row.tenant_id,
          alertType: "tt_credits_exhausted",
          lane: "sunbiz-ops",
          severity: "urgent",
          title: "TextTorrent credits exhausted — SMS drips parked",
          body: "Drip SMS sends are failing with 'not enough credits'. Every affected row reschedules +6h (no retry burn, no auto-dead) until credits are topped up.",
          telegramOncePerOpen: true, // one page per outage, not one per row
        }).catch(() => {});
        return markRescheduled(db, row, new Date(Date.now() + 6 * 3_600_000).toISOString(), "tt_credits_exhausted - parked 6h");
      }
      // Per-lead permanent: TT says the contact is blacklisted — retrying is
      // pointless and burns three dispatch slots per lead.
      if (/blacklisted/i.test(result.error)) {
        return skipStep(db, row, steps, `sms_delivery_failed: ${result.error}`, { deliveryFailed: true });
      }
      const attempts = (row.attempts || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        return skipStep(db, row, steps, `sms_delivery_failed_after_retries: ${result.error}`, { deliveryFailed: true });
      }
      return markRetryOrFail(db, row, result.error);
    }
    fromIdentity = `${identity.repKey}:${result.fromNumber}`;

    // Open a delivery receipt. A 201 means TextTorrent accepted the REQUEST;
    // the carrier rules on it seconds-to-minutes later and that verdict is the
    // only proof of arrival. /api/cron/reconcile-sms closes this out.
    //
    // Best-effort by design: bookkeeping must never fail a merchant's step. A
    // receipt that fails to open surfaces as missing coverage in the
    // sms.receipt_coverage health check, not as a lost send.
    if (result.chatId) {
      await openReceipt(db, {
        tenantId: row.tenant_id,
        dripRunId: row.id,
        leadId: row.lead_id,
        chatId: String(result.chatId),
        repKey: identity.repKey,
        actAsEmail: identity.actAsEmail,
        fromNumber: result.fromNumber,
        toPhone: phone,
        body: clean.cleaned,
      });
    }
  }

  // Count it against the pacing ceiling BEFORE the batch moves on. The counts
  // were read once at the top of the run, so without this every row in the
  // batch sees the same stale number and 40/day becomes 40/tick.
  const paced = run.smsCountsByTenant.get(row.tenant_id);
  if (paced) {
    paced.sentToday += 1;
    paced.sentThisHour += 1;
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
  run: RunState,
): Promise<StepOutcome> {
  const email = typeof data.email === "string" ? data.email.trim() : "";
  // No email for an email step: SKIP + advance (the sequence may have SMS steps
  // this lead CAN receive) rather than fail the whole chain (audit H5).
  if (!email) return skipStep(db, row, steps, "no_email_for_email_step");

  const supp = await checkEmailSuppressed(row.tenant_id, email);
  if (supp.suppressed) return markPermanentFail(db, row, "suppressed (unsubscribed)");
  if (supp.checkFailed) return markRetryOrFail(db, row, "suppression_check_failed");

  // CROSS-CHANNEL COOL-OFF. Adon, 2026-08-17: someone who says stop must not be
  // contacted again for a couple of weeks.
  //
  // The phone suppression list stops TEXTING permanently, but it is keyed by
  // number and this path reads the EMAIL list — two different lists, so a
  // merchant could reply STOP to a text at 4pm and receive a Bluerise
  // follow-up at 9am. Technically two channels, obviously the same company
  // ignoring them, and exactly the complaint that costs a domain.
  //
  // Rescheduled rather than failed: an email opt-out and an SMS opt-out are
  // genuinely different permissions, so this is a pause, not a deletion. The
  // SMS suppression itself is untouched and does not expire.
  {
    const cool = emailCooloff(data.sms_opt_out_at, new Date(), cooloffDays());
    if (cool.held) return markRescheduled(db, row, cool.until.toISOString(), cool.reason);
  }

  // Email business-hours gate ("every morning"): reschedule an off-hours email
  // step to the next window-start (no attempt burn) — mirrors the SMS TCPA
  // reschedule above. Keeps drip email out of the middle of the night.
  const emailWait = emailWindowNextStart();
  if (emailWait) {
    return markRescheduled(db, row, emailWait.toISOString(), `email_window (outside ${EMAIL_WIN_START}:00-${EMAIL_WIN_END}:00 ${EMAIL_WIN_TZ})`);
  }

  // Which company is speaking to this merchant. The lead's STAGE decides first
  // (Adon 2026-08-11: submissions@ carries viewed + signed, Bluerise carries
  // the follow-ups tab); the brand stamped on the lead at enrolment is the
  // fallback for stages that carry no rule. Absent both => sunbiz, the
  // pre-existing behaviour.
  //
  // A lead therefore CAN change voice mid-lifecycle, where it changes desk.
  // Within one sequence it cannot: a stage-triggered run is cancelled the
  // moment the lead leaves its stage (the stage-recheck in processRow), so no
  // merchant ever receives two steps of the same sequence from two companies.
  //
  // Resolved here, before BOTH the copy lookup and the volume gate: the copy
  // pool is scoped per brand, and the daily/hourly ceilings are per-brand
  // because each brand carries its own domain reputation. Gating both against
  // one shared pool would mean splitting across two domains bought no extra
  // throughput.
  // brandForSend, not the stage-then-stamp chain this used to be: a stamp must
  // never promote a lead onto the Bluerise domain for a stage nobody assigned
  // to Bluerise. See brand-routing.ts for why that was reachable.
  const brand: BrandKey = brandForSend({
    stage: data.stage,
    stampedBrand: run.brandByLead.get(row.lead_id),
  });

  // Resolve the copy first so the app-link pre-flight can inspect it.
  // Drawn from the APPROVED pool for this brand+stage+role when one exists;
  // otherwise the step's own variants, unchanged.
  const copy = resolveStepCopy(step, row.lead_id, row.step_index, {
    brand,
    stage: typeof data.stage === "string" ? data.stage : undefined,
    pool: run.templatePoolByTenant.get(row.tenant_id) ?? [],
  });

  // ── Dynamic application-link pre-flight (2026-07-21) ────────────────────────
  // If this email injects the merchant's resumable application link
  // ({{lead.application_url}}) but the lead has none on file, MINT a fresh
  // per-lead link on the fly (HMAC-signed, carries lead_id → one URL both starts
  // a new app and resumes an in-progress one). If a real per-lead link can't be
  // produced (no enabled intake form / HMAC key missing), HALT this email rather
  // than fall back to the generic no-lead link — never send a merchant a broken
  // or generic application link.
  const usesLink = /\{\{\s*lead\.application_url\s*\}\}/.test(
    `${copy.subject || ""}\n${copy.body}\n${copy.bodyHtml || ""}`,
  );
  if (usesLink) {
    const existing = typeof data.application_url === "string" && data.application_url.trim() ? data.application_url.trim() : "";
    if (!existing) {
      const minted = await maybeMintApplicationUrl(db, row.tenant_id, "lead", row.lead_id, data);
      if (minted) {
        data.application_url = minted; // buildContext below renders the REAL per-lead link
        // Persist so later steps don't re-mint + the board/other sends see it.
        await updateRecord({ tenant_id: row.tenant_id, entity: "lead", id: row.lead_id, patch: { application_url: minted } }).catch(() => {});
      } else {
        // Couldn't mint a real per-lead link. Retry a few times (a form/HMAC-key
        // config issue may get fixed), alerting on the FIRST hold and at give-up
        // only (never every tick), then SKIP this email and advance the sequence
        // rather than rescheduling forever — a stage/template mismatch won't
        // self-heal the way a TCPA/quiet-hours reschedule does.
        const attempts = (row.attempts || 0) + 1;
        const CAP = 4;
        if (attempts === 1 || attempts >= CAP) {
          await writeAgentAlert({
            tenantId: row.tenant_id,
            alertType: "drip_missing_app_link",
            lane: "sunbiz-ops",
            severity: attempts >= CAP ? "urgent" : "warn",
            title: `Drip email ${attempts >= CAP ? "skipped" : "held"}: no application link (${row.sequence_name})`,
            body: `Lead ${row.lead_id} has no application link and one couldn't be minted (no enabled intake form or HMAC key). ${attempts >= CAP ? "Skipped this email after retries so the sequence keeps moving." : "Holding this email so no generic link reaches the merchant."}`,
            subjectType: "drip_sequence",
            subjectId: row.sequence_id,
            payload: { step_index: row.step_index, lead_id: row.lead_id, attempts },
          }).catch(() => {});
        }
        if (attempts >= CAP) {
          return skipStep(db, row, steps, "missing_application_link: skipped after retries (no form/HMAC key)", { deliveryFailed: true });
        }
        await db
          .from("drip_runs")
          .update({ status: "scheduled", attempts, scheduled_for: new Date(Date.now() + 6 * 3_600_000).toISOString(), last_error: "missing_application_link (no form/HMAC key)" })
          .eq("id", row.id);
        return "rescheduled";
      }
    }
  }

  const ctx = buildContext(data);
  const subjectRaw = renderTemplate(copy.subject, ctx) || "Following up";
  const rendered = renderTemplate(copy.body, ctx);
  const renderedCustomHtml = copy.bodyHtml ? renderTemplate(copy.bodyHtml, ctx) : "";
  // Guard subject + body in ONE lender-lookup (was two separate calls — halves
  // the fail-closed surface + cost). positioning/lender is validated on the
  // COMBINED text; stripDashes is then the only per-field transform, matching
  // what sanitizeBlastMessage itself applies to each field.
  const htmlAsText = renderedCustomHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const guard = await sanitizeBlastMessage(
    row.tenant_id,
    `${subjectRaw}\n${rendered}\n${htmlAsText}`,
    { checkPositioning: true },
  );
  if (!guard.ok) return handleGuardBlock(db, row, steps, guard, "email");
  const subject = stripDashes(subjectRaw).slice(0, 200) || "Following up";
  const cleanBody = stripDashes(rendered);

  const dripsLive = process.env.DRIPS_LIVE === "1";
  const shouldSend = dripSendEnabled();

  // Backstop: never re-send this lead the same sequence step (audit safety net).
  if (shouldSend && (await alreadySentStep(db, row))) {
    return finishStep(db, row, steps, "dedup:submissions@sunbizfunding.com", false);
  }

  // EMAIL VOLUME GATE (2026-07-29, governor.ts). The pre-existing DRIPS_HOURLY_CAP
  // paces the SYSTEM; this paces what one PERSON receives, which is the thing a
  // recipient actually experiences as spam. Only consulted on a real send: a dry
  // run moves no bytes, so capping it would just distort the rehearsal.
  //
  // HOLD, never fail: hitting a cap is a "not yet", not an error, so the row is
  // rescheduled to when the window reopens and keeps its attempt budget.
  if (shouldSend && run.emailBudget) {
    // The per-lead weekly ceiling varies BY STAGE: a merchant mid-application
    // expects contact, a lead six weeks into follow-up does not. Passing the
    // stage raises the cap only where engagement justifies it.
    const gateStage = typeof data.stage === "string" ? data.stage : undefined;
    // Tenant + sequence, so an operator's own per-sequence daily cap is honoured
    // and the hold reason names THEIR setting rather than a system rule.
    const seqRef = { tenantId: row.tenant_id, id: row.sequence_id, name: row.sequence_name };
    const gated = emailGateReason(run.emailBudget, row.lead_id, brand, gateStage, seqRef);
    if (gated) {
      return markRescheduled(
        db,
        row,
        holdUntilIso(gated),
        `email_volume_gate (${brand}/${gateStage || "no-stage"}: ${gated})`,
      );
    }
  }

  // send_id pins the lead_interactions row id so /api/track/open|click/<send_id>
  // resolves this exact send (tenant + lead) without trusting the URL. Generated
  // up front so the open pixel + click-wrapped links in the HTML body and the
  // logged interaction row all share the one key.
  const sendId = randomUUID();
  let fromIdentity = "dry:submissions@sunbizfunding.com";
  let providerMessageId: string | undefined;
  let htmlPayload: string | null = null;
  // The origin the HTML was actually built on, recorded on the interaction row.
  // Defaults to the platform origin so a dry run (which builds no HTML) records
  // the truthful "nothing aligned happened here".
  let sentTrackingBase: string = platformTrackingBase();
  // The brand this message ACTUALLY went out as, recorded on the interaction
  // row. Telemetry that cannot say which company sent a message cannot
  // reconstruct a complaint, and after a handoff the lead's current brand is no
  // longer what older mail carried.
  let sentBrand: BrandKey = "sunbiz";
  if (shouldSend) {
    // ALLOCATION GATE for email, mirroring the SMS path. Without it the routing
    // policy only ever governed half the fleet: PROVIDER_GWS_ENABLED had no
    // effect on email at all, and a Bluerise lead with missing mailbox
    // credentials burned retries instead of holding as the policy promises.
    //
    // HOLD, never fail — the merchant is fine, we are the ones not ready.
    const availability =
      run.availabilityByTenant.get(row.tenant_id) ?? (await loadProviderAvailability(row.tenant_id));
    const route = routeOutbound({ channel: "email", purpose: "drip", brand, available: availability });
    if (!route.send) {
      return markRescheduled(
        db, row, new Date(Date.now() + 6 * 3_600_000).toISOString(),
        `email_channel_unavailable: ${route.reason}`,
      );
    }

    // Transactional/relationship email (application nudges, statements, etc.) is
    // CAN-SPAM opt-out-exempt → NO visible unsubscribe footer. The invisible
    // List-Unsubscribe header stays for BOTH classes (cuts spam complaints +
    // protects inbox placement). Commercial mail keeps the footer.
    const unsub = emailClass === "transactional" ? "none" : "footer";
    // Drip mail is genuinely sent From submissions@sunbizfunding.com, so its
    // links belong on the SunBiz sending domain rather than the shared platform
    // one. Resolved ONCE here and passed everywhere, so every URL in this message
    // agrees, and so the exact origin used can be recorded on the interaction row
    // below. Cold outreach deliberately does NOT do this: it sends from isolated
    // domains and its links must stay on the platform origin.
    const trackingBase = dripTrackingBase();

    // A brand missing its CAN-SPAM postal address must never reach a merchant.
    // HOLD the row rather than failing it: the fix is configuration, and the
    // message is still worth sending once it lands.
    const sendable = brandIsSendable(brand);
    if (!sendable.ok) {
      return markRetryOrFail(db, row, `brand_not_sendable: ${sendable.reason}`);
    }

    // Custom-HTML templates get the SAME brand footer as the plain path, or a
    // templated drip would ship with no postal address while a plain one carries
    // it. Transactional drops only the unsubscribe line, never the address.
    const customFooter = brandFooter(
      brand,
      emailClass === "transactional" ? null : unsubscribeUrl(email, SUNBIZ_BRAND, trackingBase),
    );
    const customTracking = `<img src="${pixelUrl(sendId, trackingBase)}" width="1" height="1" alt="" style="display:none;max-height:0;overflow:hidden" />`;
    const instrumentedCustomHtml = renderedCustomHtml
      ? renderedCustomHtml.replace(/<\/body>/i, `${customFooter}${customTracking}</body>`)
      : "";
    const html =
      instrumentedCustomHtml ||
      buildDripHtml(cleanBody, { sendId, email, unsub, trackingBase, sendingBrand: brand });
    htmlPayload = html;
    sentTrackingBase = trackingBase;
    sentBrand = brand;
    const result = await sendDripEmail(row.tenant_id, email, subject, cleanBody, {
      html,
      // SUNBIZ_BRAND here is the SUPPRESSION brand (the tenant resolver on the
      // opt-out write path), NOT the sending brand. It deliberately does not
      // follow `brand`: both brands share one tenant so a single opt-out stops
      // both, and a value matching no tenant would land tenant_id = NULL.
      listUnsubscribe: listUnsubscribeHeader(email, SUNBIZ_BRAND, trackingBase),
      brand,
    });
    if (!result.ok) return markRetryOrFail(db, row, result.error);
    fromIdentity = result.fromAddress;
    providerMessageId = result.messageId;
    // Spend the budget only on a send that actually left, so later rows in this
    // same run see the decremented remainder without re-querying. A failed send
    // deliberately does not consume: nothing reached the recipient.
    if (run.emailBudget) {
      consumeEmail(run.emailBudget, row.lead_id, brand, {
        tenantId: row.tenant_id,
        id: row.sequence_id,
        name: row.sequence_name,
      });
    }
  }

  const interactionLog = logInteraction(db, {
    tenantId: row.tenant_id,
    leadId: row.lead_id,
    sequenceName: row.sequence_name,
    channel: "email",
    toPhone: null,
    toEmail: email,
    subject,
    body: cleanBody,
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
      // The RESOLVED origin this message's tracked URLs were actually built on,
      // not the intent. Stamped at SEND time because it is the only reliable
      // record: the telemetry reconciler rebuilds payload_html from this row long
      // afterwards, and inferring the domain from today's config would
      // misreconstruct any message sent before the rollout, or sent while the
      // variable was unset and silently fell back. Absence means the platform
      // origin, which is exactly right for historical rows (Codex review P2).
      tracking_base: sentTrackingBase,
      // The brand this message ACTUALLY went out as. Recorded for the same
      // reason tracking_base is: a lead that has since been handed off now
      // carries a different sending_brand than the mail already in its inbox,
      // so re-deriving from the lead row would misattribute every historical
      // send. Absence means sunbiz, correct for every row predating this.
      sending_brand: sentBrand,
    },
  });
  await Promise.all([
    interactionLog,
    ...(shouldSend && htmlPayload
      ? [
          logDripEmailEvent(db, {
            tenantId: row.tenant_id,
            merchantId: row.lead_id,
            sequenceId: row.sequence_id,
            dripRunId: row.id,
            stepIndex: row.step_index,
            recipientEmail: email,
            subject,
            payloadText: cleanBody,
            payloadHtml: htmlPayload,
            providerMessageId,
          }),
        ]
      : []),
  ]);
  const outcome = await finishStep(db, row, steps, fromIdentity, shouldSend, providerMessageId);
  await nudgeConversations(row.tenant_id);
  return outcome;
}

async function processRow(
  db: Db,
  row: ClaimedRow,
  leadMap: Map<string, LeadData>,
  seqMap: Map<string, SequenceRow>,
  run: RunState,
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

  // PER-LEAD PAUSE (2026-07-29). /api/leads/[id]/drip-toggle has written
  // data.drip_paused since it shipped and nothing ever read it, so an operator
  // pausing a lead changed nothing and the drip kept sending. If anyone ever
  // paused a lead because the merchant asked them to stop, that request was
  // silently ignored.
  //
  // HOLD, do not cancel: a pause is a reversible operator act, so the row is
  // rescheduled rather than killed. Un-pausing resumes the sequence where it
  // left off instead of requiring a re-enrollment. Checked here (before any
  // channel work, guard, or send) so a paused lead costs nothing.
  if (isPaused(data)) {
    return markRescheduled(
      db,
      row,
      new Date(Date.now() + PAUSE_HOLD_MS).toISOString(),
      "drip_paused (operator paused this lead)",
    );
  }

  // OFF THE LEADS BOARD (Adon, 2026-08-11). The single most common shape of the
  // "who is it even mailing" problem: a merchant signs, an operator transfers
  // them to the Applications board, and a step queued days earlier fires anyway.
  // The stage-recheck below cannot see it — `transferred_at` is stamped without
  // the stage changing at all, so from the lead's side nothing moved.
  //
  // Checked BEFORE the stage recheck because it is the stronger statement: off
  // the board means no lead-stage sequence may speak, whatever the stage says.
  // Cancelled rather than rescheduled — a transfer is not a timing problem, and
  // a lead that legitimately returns to the board re-enrolls cleanly.
  if (seq.triggerStage && !isOnLeadsBoard(data)) {
    return markCancelled(db, row, "off_board: lead transferred to the Applications board");
  }

  // Cancel-old-start-new (2026-07-20): if the lead has moved to a different
  // stage than the one this sequence targets, this sequence is stale for them —
  // cancel it (no send, no advance) instead of continuing to nag about an old
  // stage. The enroller (also stage-matched) is already starting the lead's
  // CURRENT-stage sequence, so this is a clean handoff and stops the "stacking"
  // where a fast-moving lead accumulates several stages' emails at once.
  if (seq.triggerStage && String(data.stage ?? "") !== seq.triggerStage) {
    return markCancelled(db, row, `stage_changed: lead now at ${String(data.stage ?? "unknown")}`);
  }

  // Flag-cancel (accelerated chase): a flag-triggered sequence stops the instant
  // its flag clears on the lead — the manage cron clears accelerated_followup
  // when the lead advances to an in-funnel stage, gets marked dead, or a rep
  // toggles it off, and this cancels the remaining chase within one dispatch
  // tick instead of waiting for the hourly enroll pass.
  if (seq.triggerFlag && !isTruthyFlag(data[seq.triggerFlag])) {
    return markCancelled(db, row, `flag_cleared: ${seq.triggerFlag}`);
  }

  // Shopped-out recheck (2026-07-22 stage-buffer fix): the enroller refuses to
  // ENROLL a recently-shopped lead, but a lead shopped AFTER enrollment sailed
  // through — shop-out advances the APPLICATION's status while the lead's
  // stage stays put, so the stage-recheck above can't see it. Same guard,
  // applied at dispatch time.
  if (await wasShoppedRecently(db, row.tenant_id, row.lead_id, data)) {
    return markCancelled(db, row, "shopped_recently");
  }

  // DEAL-CLOSED recheck (Adon 2026-08-11: "it's sending it to funded deals").
  // The same blind spot the shopped-out recheck above names, in its general
  // form: the deal's real state lives on the APPLICATION's `status`, the drip
  // triggers on the LEAD's `stage`, and nothing syncs them — so a merchant who
  // funded, declined or died is still parked at `signed_application` and the
  // stage-recheck above sees nothing wrong. Measured 2026-08-11: 291 of the 311
  // leads in that stage were already-closed deals, and 4 emails had reached 3
  // funded merchants.
  //
  // Only stage-triggered sequences are gated. A flag-triggered chase owns its
  // own lifecycle (it clears its flag on `funded`), and double-gating it here
  // would cancel rows its own manager intends to keep.
  if (seq.triggerStage) {
    const gateRes = await loadDealGate(db, row.tenant_id, row.lead_id, data);
    if (!gateRes.ok) {
      // RESCHEDULE, never cancel. A transient read failure must not be able to
      // permanently kill a live sequence — that would convert a database hiccup
      // into silent lead loss, which is the failure mode this whole engine has
      // been bitten by before.
      return markRescheduled(
        db,
        row,
        new Date(Date.now() + PAUSE_HOLD_MS).toISOString(),
        `deal_state_unavailable: ${gateRes.error}`,
      );
    }
    if (!gateRes.gate.open) {
      return markCancelled(db, row, `deal_closed: application is ${gateRes.gate.status}`);
    }
  }

  // Overlap suppression, the mirror of the flag-cancel above (Adon 2026-07-22):
  // while a lead IS being chased, its STAGE drips stand down — one track at a
  // time, never both texting the same merchant. The predicate is an ACTIVE
  // chase run (not the flag alone — codex review P1: a flagged lead the chase
  // can't enroll must keep its stage drips or it sits on no track at all).
  // Gated on the chase master switch so the dormant system can't strip stage
  // drips before go-live. 'cancelled' (not skip) so the enroller restarts the
  // stage drip cleanly once the chase ends.
  if (
    seq.triggerStage &&
    acceleratedSystemLive() &&
    isTruthyFlag(data[ACCELERATED_FLAG]) &&
    (await hasActiveAcceleratedRun(db, row.tenant_id, row.lead_id))
  ) {
    return markCancelled(db, row, "accelerated_chase_active: stage drip stands down");
  }

  // CHANNEL FALLBACK — reach them on whatever we actually have.
  //
  // Adon, 2026-08-10: "The ones that have emails will answer an email. The ones
  // that don't, if we have their number, we have to write a text to them."
  //
  // Previously the step's channel was fixed, so an email step for a phone-only
  // lead was skipped and the sequence walked on. 420 of 1,197 leads are
  // phone-only and 68 rows had already been skipped as no_email_for_email_step:
  // the run reported healthy and those merchants heard nothing.
  //
  // A step may opt out with `channel_locked` when it cannot survive translation
  // — a statement request carrying an attachment is not the same thing as a
  // text — in which case the miss is reported rather than rewritten.
  const contact = contactabilityOf(data);
  // SMS-ONLY STAGES (Live Subs). Locking the channel is what stops
  // resolveChannel from helpfully substituting email — the same substitution
  // that has already put an email address in the from_identity of 127
  // channel='sms' rows since 2026-07-20.
  const smsOnly = isSmsOnly(data);
  const locked = isTruthyFlag((step as unknown as Record<string, unknown>).channel_locked) || smsOnly;
  const decision = resolveChannel(step.channel, contact, { channelLocked: locked });

  if (!decision.send) {
    // Unreachable is a DATA problem, not a delivery one, and it must land in the
    // record as such. Advancing silently is what let 23 of the 84 live subs sit
    // in a sequence with no contact method at all.
    return skipStep(db, row, steps, `unreachable: ${decision.detail}`);
  }
  if (decision.substituted) {
    console.warn("[dispatch-drips] channel substituted", {
      leadId: row.lead_id,
      authored: step.channel,
      using: decision.channel,
      reason: decision.reason,
    });
  }

  // The channel lock above stops SUBSTITUTION into email, but an email step
  // authored directly against an SMS-only stage would still send. Locking
  // cannot express that — a locked email step is locked TO email — so the stage
  // rule is enforced on its own terms here.
  //
  // Skipped rather than held: nothing about this lead will change, so a hold
  // would be another silent loop, and the sequence's SMS steps must still run.
  if (smsOnly && decision.channel === "email") {
    return skipStep(db, row, steps, `sms_only_stage: ${String(data.stage ?? "")} is not emailed`);
  }

  const emailClass = seq.emailClass || "commercial";
  if (decision.channel === "sms") return processSmsStep(db, row, data, step, steps, run, emailClass);
  return processEmailStep(db, row, data, step, steps, emailClass, run);
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
    creditHalted: false,
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
      // Count settled sends this hour PLUS any rows a concurrent run has already
      // claimed ('sending', always recent — reclaimed after STALE_SENDING_MINUTES).
      // Counting in-flight rows stops two overlapping ticks (the Vercel cron and
      // the external pinger) from each budgeting a full HOURLY_CAP and stacking
      // past it — the "pace, not blast" guarantee must hold under overlap.
      const [settled, inflight] = await Promise.all([
        db.from("drip_runs").select("id", { count: "exact", head: true }).in("status", ["sent", "done"]).gte("sent_at", oneHourAgoIso),
        db.from("drip_runs").select("id", { count: "exact", head: true }).eq("status", "sending"),
      ]);
      const sentLastHour = (settled.count || 0) + (inflight.count || 0);
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
      // Mirror the enroller's own "stage-triggered" definition (enroller.ts
      // filter): entity is lead-or-absent AND field is stage-or-absent. Only
      // then is trigger_filter.to a STAGE we can compare to data.stage. A
      // sequence keyed on some other field (e.g. status) gets triggerStage=null
      // so the stage-match cancel never touches it.
      const tf = r.trigger_filter as { to?: unknown; field?: unknown; entity?: unknown } | null;
      const isStageTrigger = !!tf && (!tf.field || tf.field === "stage") && (!tf.entity || tf.entity === "lead");
      const triggerStage = isStageTrigger && typeof tf!.to === "string" && tf!.to.trim() ? (tf!.to as string).trim() : null;
      // Flag-triggered sequence (e.g. accelerated_followup): trigger_filter.field
      // names a BOOLEAN lead-data flag rather than "stage", targeting `to:"true"`.
      // Captured so the dispatcher cancels the run the instant that flag goes
      // false (the lead was handled / unflagged) — the flag-based analogue of
      // the stage-match cancel. The `to === "true"` requirement is load-bearing
      // (codex review P1, 2026-07-22): without it a sequence keyed on an
      // ordinary STRING field (e.g. { field: "status", to: "approved" }) would
      // be misread as a boolean flag and every run instantly cancelled.
      const triggerFlag =
        !!tf && (!tf.entity || tf.entity === "lead") && typeof tf.field === "string" && tf.field.trim() && tf.field !== "stage" && tf.to === "true"
          ? (tf.field as string).trim()
          : null;
      seqMap.set(`${r.tenant_id}|${r.id}`, { id: r.id, name: r.name, enabled: r.enabled, steps: r.steps, emailClass: r.email_class || "commercial", triggerStage, triggerFlag });
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
  // Email volume budget, computed once for the whole run (2 aggregate queries +
  // one batched per-lead query) so per-row gating costs nothing. Only loaded
  // when real sends are enabled: a dry run moves no bytes, so there is no
  // volume to govern.
  //
  // EVERY claimed lead, not just the rows AUTHORED as email. An SMS step can be
  // substituted to email at send time (resolveChannel, when there is no lawful
  // basis to text but there is an address) and land in processEmailStep. Keying
  // this on `channel === "email"` meant a batch of only SMS-authored steps
  // loaded NO budget at all — so those substituted emails bypassed the brand
  // daily and hourly ceilings, the per-lead weekly cap and the per-sequence cap
  // together. Every email guard, off, silently, on the path least likely to be
  // watched.
  const emailLeadIds = Array.from(new Set(claimed.map((r) => r.lead_id)));
  // Sending brand per lead, resolved ONCE for the run alongside the budget.
  // Read-only: the brand is stamped at enrolment, never derived here, so a lead
  // cannot flip brand mid-sequence. Fails safe to sunbiz.
  //
  // Built from EVERY claimed lead, not just the email ones. Scoping it to
  // emailLeadIds left any lead whose batch contained only SMS steps absent from
  // the map, so it silently defaulted to sunbiz — which picked SunBiz copy for a
  // Bluerise merchant and, once the allocation gate landed, waved that merchant
  // straight through to a SunBiz TextTorrent number. The gate would have been
  // bypassed in precisely the case it exists for. One batched query either way.
  //
  // Loaded PER TENANT. A batch can span tenants, and keying the whole load on
  // claimed[0].tenant_id left every later tenant's leads absent from the map and
  // defaulting to sunbiz — the same bypass as above, plus a tenant-filtering
  // violation: it would have looked up one tenant's leads under another's id.
  const leadIdsByTenant = new Map<string, Set<string>>();
  for (const r of claimed) {
    const set = leadIdsByTenant.get(r.tenant_id) ?? new Set<string>();
    set.add(r.lead_id);
    leadIdsByTenant.set(r.tenant_id, set);
  }
  const brandByLead = new Map<string, BrandKey>();
  for (const [tid, ids] of leadIdsByTenant) {
    if (ids.size === 0) continue;
    const m = await loadBrandsForLeads(db, tid, Array.from(ids));
    for (const [leadId, brand] of m) brandByLead.set(leadId, brand);
  }

  // Approved template pool, loaded once per run alongside the budget and brand
  // map. Fails SAFE to empty, which makes copy resolution fall back to the
  // step's own variants — today's behaviour — rather than stalling the engine
  // over a template table being briefly unreachable.
  // Per tenant, for the same reason the brand map is: claimed[0].tenant_id
  // would have rendered every tenant's merchants from the first tenant's
  // approved copy.
  const templatePoolByTenant = new Map<string, PoolTemplate[]>();
  const availabilityByTenant = new Map<string, ProviderAvailability>();
  for (const tid of leadIdsByTenant.keys()) {
    templatePoolByTenant.set(tid, await loadApprovedPool(db, tid));
    // Only when real sends are possible: a dry run never consults a provider.
    if (dripSendEnabled()) {
      availabilityByTenant.set(tid, await loadProviderAvailability(tid));
    }
  }

  const run: RunState = {
    creditExhausted: false,
    emailBudget:
      dripSendEnabled() && emailLeadIds.length > 0
        // EVERY tenant in the batch, not claimed[0] — the same correction the
        // brand map and the template pool each needed.
        ? await loadEmailBudget(db, emailLeadIds, Array.from(leadIdsByTenant.keys()))
        : null,
    brandByLead,
    templatePoolByTenant,
    availabilityByTenant,
    linesByWire: new Map<string, string[]>(),
    smsCountsByTenant: new Map<string, PacingCounts>(),
  };
  if (run.emailBudget?.degraded) {
    // The global counts are best-effort this run; the per-lead cap still holds
    // (it fails closed inside emailGateReason). Visible, not silent.
    console.warn("[dispatch-drips] email budget degraded — global caps are best-effort this run");
  }
  for (const row of claimed) {
    if (Date.now() - startedAt > SOFT_BUDGET_MS) break;
    let outcome: StepOutcome;
    try {
      outcome = await processRow(db, row, leadMap, seqMap, run);
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

    // Account-wide credit outage: every remaining row would 422 on the billable
    // Step 2 while its FREE Step 1 still left an empty chat in a rep's inbox.
    // Stop the batch here. Rows already claimed but unprocessed stay 'sending'
    // and are returned to 'scheduled' by the stale-reclaim on a later run —
    // exactly how the SOFT_BUDGET_MS break above already behaves.
    if (run.creditExhausted) {
      console.error("[dispatch-drips] HALTING run — TextTorrent credits exhausted", {
        processedBeforeHalt: processed,
        claimedButUnprocessed: claimed.length - processed,
      });
      break;
    }
  }

  return {
    ok: true, reclaimed, claimed: claimed.length, processed, sent, dryRun,
    rescheduled, retryPending, failed, cancelled, creditHalted: run.creditExhausted,
  };
}
