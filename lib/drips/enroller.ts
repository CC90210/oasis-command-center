/**
 * lib/drips/enroller.ts — stage-triggered drip enrollment (Vercel-native
 * replacement for the abandoned-but-still-churning VPS `sequence_runner`
 * enrollment path). Called by /api/cron/enroll-drips on a ~15 min tick.
 *
 * For every ENABLED `drip_sequences` row whose trigger is a lead-stage
 * change (`trigger_filter.entity` unset-or-"lead", `.field` unset-or-"stage",
 * `.to` a stage key), find every `tenant_records` lead (entity_type='lead')
 * currently sitting at `data.stage === trigger_filter.to` that does NOT
 * already have an active (scheduled|sending) `drip_runs` row for that
 * sequence, run it through the enrollment guardrails, and — only when
 * DRIPS_LIVE=1 — insert a `drip_runs` step-0 row.
 *
 * Idempotent by construction: re-running this is always safe.
 *   1. The unique index `uq_drip_runs_active_per_lead_sequence` on
 *      (tenant_id, lead_id, sequence_id) WHERE status IN ('scheduled','sending')
 *      is the DB-level backstop — even a race between two overlapping
 *      invocations can't create two active rows for the same lead+sequence.
 *   2. This function ALSO pre-filters leads with an existing active row
 *      before attempting an insert, so the common case never even reaches
 *      the DB constraint.
 *
 * DRY-RUN BY DEFAULT: this function reports counts (candidates, guardrail
 * skips, would-enroll) on every call, but only WRITES anything — including
 * the timezone/rep_name backfill on the lead row — when BOTH: (1)
 * process.env.DRIPS_LIVE === '1', AND (2) the lead's stage is on the
 * DRIPS_ENROLL_STAGES allowlist (see the staging controls below). With either
 * unset, this cron is a pure read + report; it can run on a schedule
 * indefinitely without ever touching a lead or creating a drip_runs row.
 * That's deliberate: nothing downstream (dispatch-drips) can send to a
 * merchant if enroll-drips never created the row that would let it — and the
 * allowlist is what makes go-live STAGED (one stage at a time) instead of a
 * whole-backlog blast the instant DRIPS_LIVE flips on.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { checkTcpaWindow } from "@/lib/tcpa-window";
import type { DripStep } from "./types";
import { computeStep0DelayMinutes, stageBufferMinutes } from "./stage-buffer";

type Db = ReturnType<typeof getServiceSupabase>;

// Terminal-negative lead stages that must never receive a drip touch, even
// if some future sequence is misconfigured to target one of them directly
// (today none of the seeded SUNBIZ_DEFAULT_SEQUENCES do — see
// lib/sunbiz-stage-meta.ts LEAD_PIPELINE_STAGES). Kept as an explicit
// allow-nothing list rather than relying solely on "current stage matches
// trigger_filter.to" so a future sequence edit can't accidentally start
// drip-touching a dead file.
const DEAD_STAGES = new Set(["dead_file"]);

const SHOPPED_LOOKBACK_DAYS = 7;

/**
 * Staged go-live controls, read fresh at every enroll run:
 *  - DRIPS_ENROLL_STAGES: comma-list of stage keys allowed to ENTER the funnel,
 *    or "*" for all. UNSET/empty => enroll NOTHING (fail-closed). DRIPS_LIVE=1
 *    lets already-scheduled drips SEND (executor.ts), but no NEW lead is
 *    enrolled until its stage is explicitly listed here — so go-live is done
 *    one stage at a time, not as a whole-backlog blast.
 *  - DRIPS_ENROLL_LIMIT: max NEW enrollments per sequence per run (default 25;
 *    0 = unlimited). Caps each run's blast radius while ramping.
 */
function parseEnrollStages(raw: string | undefined): "ALL" | Set<string> {
  const s = (raw || "").trim();
  if (!s) return new Set(); // fail-closed: no stage enrolls
  if (s === "*") return "ALL";
  return new Set(
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
}
function parseEnrollLimit(raw: string | undefined): number {
  const n = parseInt((raw || "").trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 25; // default per-sequence cap
  return n; // 0 = unlimited
}

// Enroll-time jitter (minutes) — spread a cohort's step-0 scheduled_for across a
// window so a batch enrolled in the SAME pass doesn't all come due at the exact
// same instant and detonate on the next dispatch tick (the clustering half of
// the blast, 2026-07-20). Combined with the dispatch hourly cap this makes a
// mass enrollment bleed out as a paced drip. Env, default 90 min; 0 disables.
const ENROLL_SPREAD_MS = (() => {
  // Blank/whitespace env → default (a blank secret → Number("")===0 would
  // silently kill de-clustering). Non-numeric also falls back.
  const raw = (process.env.DRIPS_ENROLL_SPREAD_MIN ?? "").trim();
  const n = raw ? Number(raw) : 90;
  return Math.max(0, Number.isFinite(n) ? n : 90) * 60_000;
})();
function enrollJitterMs(): number {
  return ENROLL_SPREAD_MS > 0 ? Math.floor(Math.random() * ENROLL_SPREAD_MS) : 0;
}


export type SkipReason =
  | "already_enrolled"
  | "dead_or_declined"
  | "opted_out"
  | "no_contact_method"
  | "shopped_recently"
  | "invalid_sequence_steps";

export type SequenceEnrollSummary = {
  sequenceId: string;
  tenantId: string;
  sequenceName: string;
  stage: string;
  candidates: number;
  skipped: Record<SkipReason, number>;
  enrolled: number; // 0 whenever !live
  error?: string;
};

export type EnrollDripsResult = {
  live: boolean;
  sequencesScanned: number;
  perSequence: SequenceEnrollSummary[];
  totals: { candidates: number; enrolled: number; skipped: number };
};

type SequenceRow = {
  id: string;
  tenant_id: string;
  name: string;
  enabled: boolean;
  trigger_filter: { entity?: string; field?: string; to?: string; from?: string } | null;
  steps: unknown;
};

type LeadRow = { id: string; data: Record<string, unknown> };

function emptySkipCounts(): Record<SkipReason, number> {
  return {
    already_enrolled: 0,
    dead_or_declined: 0,
    opted_out: 0,
    no_contact_method: 0,
    shopped_recently: 0,
    invalid_sequence_steps: 0,
  };
}

function isTruthyFlag(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

function isOptedOut(data: Record<string, unknown>): boolean {
  return (
    isTruthyFlag(data.opted_out) ||
    isTruthyFlag(data.sms_opt_out) ||
    isTruthyFlag(data.email_opt_out) ||
    data.stage === "opted_out"
  );
}

/**
 * Best-effort "shopped to funders in the last 7 days" check — the standing
 * guard from [[feedback_shopped_deal_guard]]: never auto-follow-up on a deal
 * Adon shopped out while it's awaiting a funder response. Two signals, either
 * one blocks:
 *   1. A `lead_interactions` row for this lead in the lookback window whose
 *      agent_source mentions "shop_out" (the shop-out sender's attribution —
 *      naming isn't fully pinned down repo-wide, so this matches loosely).
 *   2. A recency timestamp on the lead's own data blob, checked defensively
 *      under a few plausible field names (shopped_at / last_shopped_at) or a
 *      shopped_funders array whose most recent entry falls in the window.
 * UNCERTAIN: neither signal is confirmed against the live SunBiz schema at
 * build time (see the handoff notes) — this is best-effort defense-in-depth,
 * not a fail-closed compliance gate. checkPhoneOptOut/checkEmailSuppressed
 * (fail-closed) remain the load-bearing suppression checks at DISPATCH time.
 */
export async function wasShoppedRecently(
  db: Db,
  tenantId: string,
  leadId: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const cutoff = Date.now() - SHOPPED_LOOKBACK_DAYS * 24 * 60 * 60_000;

  const directTimestamp =
    (typeof data.shopped_at === "string" && data.shopped_at) ||
    (typeof data.last_shopped_at === "string" && data.last_shopped_at) ||
    null;
  if (directTimestamp) {
    const t = Date.parse(directTimestamp);
    if (Number.isFinite(t) && t >= cutoff) return true;
  }
  if (Array.isArray(data.shopped_funders)) {
    for (const entry of data.shopped_funders as unknown[]) {
      if (entry && typeof entry === "object") {
        const ts =
          (typeof (entry as Record<string, unknown>).shopped_at === "string" &&
            (entry as Record<string, unknown>).shopped_at) ||
          (typeof (entry as Record<string, unknown>).sent_at === "string" &&
            (entry as Record<string, unknown>).sent_at) ||
          null;
        if (typeof ts === "string") {
          const t = Date.parse(ts);
          if (Number.isFinite(t) && t >= cutoff) return true;
        }
      }
    }
  }

  try {
    const r = await db
      .from("lead_interactions")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("lead_id", leadId)
      .gte("created_at", new Date(cutoff).toISOString())
      .ilike("agent_source", "%shop_out%")
      .limit(1);
    if (!r.error && Array.isArray(r.data) && r.data.length > 0) return true;
  } catch {
    /* best-effort — a query failure here does not block enrollment */
  }

  return false;
}

/** Best-effort display-name lookup for a rep by user_profiles.auth_user_id. */
async function lookupRepName(db: Db, assignedTo: string): Promise<string | null> {
  try {
    const r = await db
      .from("user_profiles")
      .select("display_name, full_name, email")
      .eq("auth_user_id", assignedTo)
      .maybeSingle();
    if (r.error || !r.data) return null;
    const row = r.data as { display_name: string | null; full_name: string | null; email: string };
    return row.display_name || row.full_name || (row.email ? row.email.split("@")[0] : null);
  } catch {
    return null;
  }
}

/**
 * Backfill data.timezone (derived from the lead's phone area code via the
 * same NANP map lib/tcpa-window.ts uses for quiet-hours) and data.rep_name
 * (looked up from data.assigned_to) when either is missing. No-op (returns
 * null) when nothing needs to change. Only called when DRIPS_LIVE=1 — see
 * file header.
 */
async function backfillLeadMetadata(
  db: Db,
  lead: LeadRow,
): Promise<Record<string, unknown> | null> {
  const data = lead.data || {};
  const patch: Record<string, unknown> = {};

  if (!data.timezone) {
    const phone = typeof data.phone === "string" ? data.phone : null;
    if (phone) {
      const tz = checkTcpaWindow(phone);
      if (!tz.usedFallback) patch.timezone = tz.timeZone;
    }
  }
  if (!data.rep_name && typeof data.assigned_to === "string" && data.assigned_to) {
    const name = await lookupRepName(db, data.assigned_to);
    if (name) patch.rep_name = name;
  }
  if (Object.keys(patch).length === 0) return null;
  return { ...data, ...patch };
}

function parseStepsSafe(steps: unknown): DripStep[] | null {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const first = steps[0];
  if (!first || typeof first !== "object") return null;
  const channel = (first as Record<string, unknown>).channel;
  const delay = (first as Record<string, unknown>).delay_minutes;
  if (channel !== "sms" && channel !== "email") return null;
  if (typeof delay !== "number" || !Number.isFinite(delay)) return null;
  return steps as DripStep[];
}

/**
 * Run one enrollment pass across every enabled, stage-triggered
 * drip_sequences row for every tenant. Multi-tenant by construction (no
 * hardcoded tenant filter) — the same engine picks up a new tenant's
 * sequences with zero code change, matching the "extensible to new email
 * drips" goal in the plan.
 */
export async function runEnrollDrips(): Promise<EnrollDripsResult> {
  const live = process.env.DRIPS_LIVE === "1";
  const enrollStages = parseEnrollStages(process.env.DRIPS_ENROLL_STAGES);
  const enrollLimit = parseEnrollLimit(process.env.DRIPS_ENROLL_LIMIT);
  const db = getServiceSupabase();

  const seqRes = await db
    .from("drip_sequences")
    .select("id, tenant_id, name, enabled, trigger_filter, steps")
    .eq("enabled", true);
  if (seqRes.error) {
    return { live, sequencesScanned: 0, perSequence: [], totals: { candidates: 0, enrolled: 0, skipped: 0 } };
  }

  const sequences = ((seqRes.data || []) as SequenceRow[]).filter((s) => {
    const tf = s.trigger_filter || {};
    const entityOk = !tf.entity || tf.entity === "lead";
    const fieldOk = !tf.field || tf.field === "stage";
    return entityOk && fieldOk && typeof tf.to === "string" && tf.to.length > 0;
  });

  const perSequence: SequenceEnrollSummary[] = [];
  let totalCandidates = 0;
  let totalEnrolled = 0;
  let totalSkipped = 0;

  for (const seq of sequences) {
    const stage = (seq.trigger_filter as { to: string }).to;
    const stageAllowed = enrollStages === "ALL" || enrollStages.has(stage);
    const skipped = emptySkipCounts();
    let candidates = 0;
    let enrolled = 0;
    let errorMsg: string | undefined;

    const firstStep = parseStepsSafe(seq.steps);
    if (!firstStep) {
      skipped.invalid_sequence_steps++;
      perSequence.push({
        sequenceId: seq.id,
        tenantId: seq.tenant_id,
        sequenceName: seq.name,
        stage,
        candidates: 0,
        skipped,
        enrolled: 0,
        error: "sequence_steps_invalid_or_empty",
      });
      totalSkipped++;
      continue;
    }

    const leadsRes = await db
      .from("tenant_records")
      .select("id, data")
      .eq("tenant_id", seq.tenant_id)
      .eq("entity_type", "lead")
      .filter("data->>stage", "eq", stage)
      .order("created_at", { ascending: true }) // stable order so >500-lead stages don't starve later leads (audit L13)
      .limit(500);
    if (leadsRes.error) {
      perSequence.push({
        sequenceId: seq.id,
        tenantId: seq.tenant_id,
        sequenceName: seq.name,
        stage,
        candidates: 0,
        skipped,
        enrolled: 0,
        error: leadsRes.error.message,
      });
      continue;
    }
    const leads = (leadsRes.data || []) as LeadRow[];
    candidates = leads.length;
    totalCandidates += candidates;

    if (leads.length === 0) {
      perSequence.push({ sequenceId: seq.id, tenantId: seq.tenant_id, sequenceName: seq.name, stage, candidates, skipped, enrolled });
      continue;
    }

    // ONCE PER LEAD PER SEQUENCE (audit C2 — the re-enrollment loop fix).
    // Skip any lead that already has a NON-CANCELLED run for this sequence, not
    // just an active (scheduled|sending) one. A terminal run (sent/done/failed)
    // MUST block re-enrollment: the executor never advances a lead's stage and
    // the pipeline often doesn't either, so a lead that just sits at a drip
    // stage would otherwise be re-enrolled and re-sent step 0 on every 15-min
    // pass. 'cancelled' rows (an operator halt) intentionally do NOT block, so a
    // clean first drip can still run after a pause. (Phase 3 upgrades this to a
    // stage-entry edge so a genuine RE-entry into the stage re-drips.)
    const leadIds = leads.map((l) => l.id);
    const priorRes = await db
      .from("drip_runs")
      .select("lead_id")
      .eq("tenant_id", seq.tenant_id)
      .eq("sequence_id", seq.id)
      .in("lead_id", leadIds)
      .neq("status", "cancelled");
    const alreadyRan = new Set(((priorRes.data || []) as { lead_id: string }[]).map((r) => r.lead_id));

    for (const lead of leads) {
      const data = lead.data || {};

      if (alreadyRan.has(lead.id)) {
        skipped.already_enrolled++;
        continue;
      }
      if (DEAD_STAGES.has(String(data.stage))) {
        skipped.dead_or_declined++;
        continue;
      }
      if (isOptedOut(data)) {
        skipped.opted_out++;
        continue;
      }
      const hasPhone = typeof data.phone === "string" && data.phone.trim().length > 0;
      const hasEmail = typeof data.email === "string" && data.email.trim().length > 0;
      if (!hasPhone && !hasEmail) {
        skipped.no_contact_method++;
        continue;
      }
      // The first step needs a matching contact method — sms needs a phone,
      // email needs an address. Route selection at dispatch time re-derives
      // this from the same lead row; checked here too so we don't enroll a
      // lead into a sequence whose step-0 channel it can never receive.
      if (firstStep[0].channel === "sms" && !hasPhone) {
        skipped.no_contact_method++;
        continue;
      }
      if (firstStep[0].channel === "email" && !hasEmail) {
        skipped.no_contact_method++;
        continue;
      }
      // Enrollment writes only when BOTH the global DRIPS_LIVE act holds AND
      // this stage is on the DRIPS_ENROLL_STAGES allowlist; otherwise this is a
      // report-only pass (candidate counted, nothing written). The per-sequence
      // DRIPS_ENROLL_LIMIT caps how many NEW rows this run creates. These gates
      // come BEFORE the wasShoppedRecently() DB call below so a report-only /
      // non-allowlisted run never fires a per-lead query across the whole
      // backlog (that made the endpoint exceed maxDuration on a full scan).
      if (!live || !stageAllowed) continue;
      if (enrollLimit !== 0 && enrolled >= enrollLimit) break;

      // Expensive per-lead guard — only reached for leads we're about to
      // actually enroll (bounded by DRIPS_ENROLL_LIMIT).
      if (await wasShoppedRecently(db, seq.tenant_id, lead.id, data)) {
        skipped.shopped_recently++;
        continue;
      }

      // Step-0 send time = the LATER of the sequence's own delay and the 24h
      // stage buffer (this whole enroll path is stage-triggered), plus jitter.
      const scheduledFor = new Date(
        Date.now() +
          computeStep0DelayMinutes(firstStep[0].delay_minutes, stageBufferMinutes()) * 60_000 +
          enrollJitterMs(),
      ).toISOString();
      const ins = await db.from("drip_runs").insert({
        tenant_id: seq.tenant_id,
        lead_id: lead.id,
        sequence_id: seq.id,
        sequence_name: seq.name,
        step_index: 0,
        channel: firstStep[0].channel,
        scheduled_for: scheduledFor,
        status: "scheduled",
      });
      // A unique-index conflict here means a concurrent invocation won the
      // race for this lead+sequence — not an error, just a no-op.
      if (ins.error) {
        if (!/duplicate key|unique constraint/i.test(ins.error.message)) {
          console.error("[enroll-drips] insert failed", { leadId: lead.id, sequenceId: seq.id, err: ins.error.message });
        }
        continue;
      }
      enrolled++;

      const patch = await backfillLeadMetadata(db, lead);
      if (patch) {
        await db.from("tenant_records").update({ data: patch }).eq("id", lead.id).eq("tenant_id", seq.tenant_id);
      }
    }

    totalEnrolled += enrolled;
    totalSkipped += Object.values(skipped).reduce((a, b) => a + b, 0);
    perSequence.push({ sequenceId: seq.id, tenantId: seq.tenant_id, sequenceName: seq.name, stage, candidates, skipped, enrolled, error: errorMsg });
  }

  return {
    live,
    sequencesScanned: sequences.length,
    perSequence,
    totals: { candidates: totalCandidates, enrolled: totalEnrolled, skipped: totalSkipped },
  };
}
