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
import { ACCELERATED_FLAG, acceleratedSystemLive, hasActiveAcceleratedRun } from "@/lib/drips/accelerated";
import type { DripStep } from "./types";
import { computeStep0DelayMinutes, enrollmentBufferForStage } from "./stage-buffer";
/**
 * The guards whose answer does NOT change between one cron pass and the next:
 * a dead file stays dead, an opt-out stays opted out, a lead with no phone and
 * no email stays uncontactable.
 *
 * These are evaluated during candidate COLLECTION rather than after it, and the
 * reason is subtle enough to be worth stating. The enrollment limit bounds how
 * many leads we take per pass. If the limit were filled with leads that a
 * permanent guard then rejects, every pass would select and reject that same
 * set, and leads behind them would never be reached — the exact starvation this
 * change exists to fix, just relocated one step downstream (Codex review P1).
 * Counting a lead against the limit only once it has passed every permanent
 * guard is what makes the limit mean "leads we will actually try to enroll".
 *
 * The two remaining guards in the enrollment loop, wasShoppedRecently and the
 * accelerated-chase overlap, are deliberately NOT here: both are TRANSIENT (a
 * 7-day shopping window, a chase that clears), so a lead they reject becomes
 * eligible on its own without ever being permanently stuck behind them. They
 * are also per-lead DB calls, which is why they stay in the bounded path.
 */
import { isReEntryEligible, isTruthyFlag, staticSkipReason } from "./drip-rules-core";

type Db = ReturnType<typeof getServiceSupabase>;

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
  | "paused"
  | "no_contact_method"
  | "shopped_recently"
  | "accelerated_chase"
  | "docs_on_file"
  | "daily_enroll_cap"
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
    paused: 0,
    no_contact_method: 0,
    shopped_recently: 0,
    accelerated_chase: 0,
    docs_on_file: 0,
    daily_enroll_cap: 0,
    invalid_sequence_steps: 0,
  };
}

/** Global NEW-enrollments-per-rolling-24h cap ACROSS all sequences. The
 *  per-sequence DRIPS_ENROLL_LIMIT only caps a single sequence's single run;
 *  this bounds the whole funnel's intake so that a backlog, an import, or
 *  several stages unfreezing at once cannot flood the one sending mailbox.
 *
 *  This is load-bearing as of 2026-07-29: the two enrollment bugs fixed in this
 *  file were, between them, suppressing most enrollment. Removing them without
 *  a global intake ceiling would convert a stalled funnel straight into a blast.
 *  Ramp via env, 15 -> 50 over the warm-up. 0 = unlimited. */
function parseEnrollDailyCap(raw: string | undefined): number {
  const n = parseInt((raw || "").trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 50;
  return n;
}

/** Count step-0 (NEW) enrollments created in the last rolling 24h. Returns -1 on
 *  error so the caller can fail SOFT — the per-sequence limit and stage
 *  allowlist still bound each run's blast radius. */
async function countEnrolledLast24h(db: Db): Promise<number> {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  try {
    const r = await db
      .from("drip_runs")
      .select("id", { count: "exact", head: true })
      .eq("step_index", 0)
      .gte("created_at", since);
    if (r.error) return -1;
    return r.count ?? 0;
  } catch {
    return -1;
  }
}

/** Re-drip cooldown. Once a lead has run a sequence, a genuine RE-entry into the
 *  trigger stage re-drips (see the stage-entry edge below) — but not sooner than
 *  this, so a lead being triaged back and forth between two stages cannot be
 *  re-dripped every pass. Days. */
function parseRedripCooldownDays(raw: string | undefined): number {
  const n = parseInt((raw || "").trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 14;
  return n;
}

/** How many leads to pull per page while hunting for eligible candidates, and
 *  how many pages we are willing to walk in one pass. 500 x 40 = 20,000 leads
 *  per sequence per run, which comfortably covers every SunBiz stage while
 *  keeping a pathological stage from running the function out of time. */
const CANDIDATE_PAGE_SIZE = 500;
const CANDIDATE_MAX_PAGES = 40;

type CandidateResult = {
  leads: LeadRow[];
  /** Leads examined and rejected because they have already had their run. */
  skippedAlreadyRan: number;
  /** Permanent-guard rejections, counted during collection so they do not
   *  consume the enrollment limit. */
  staticSkips: Partial<Record<SkipReason, number>>;
  /** Set when the stage held more leads than we were willing to walk. */
  truncated: boolean;
  error?: string;
};

/**
 * Find leads in `stage` that are eligible to ENTER this sequence.
 *
 * This replaces two bugs that between them were suppressing most enrollment
 * (audit 2026-07-29):
 *
 * BUG 1, the >500-lead freeze. The old query took the oldest 500 leads in the
 * stage, ordered by created_at ascending, and filtered out already-enrolled ones
 * in application code AFTER the fetch, with no pagination. Once those oldest 500
 * had each run once — which BUG 2 guaranteed they eventually would — every
 * subsequent pass re-fetched the same 500, skipped all of them, and enrolled
 * zero. Lead 501 and everything newer was never loaded. The run reported success
 * with a high skip count, so it looked healthy while being permanently frozen.
 * Fixed by paging until we have enough eligible leads rather than trusting one
 * fixed window to contain them.
 *
 * BUG 2, once per lead per lifetime. The old rule skipped any lead with a
 * non-cancelled run for the sequence, including finished ones. That is correct
 * for a lead SITTING in a stage (it must not be re-dripped every 15 minutes) but
 * wrong for a lead that legitimately RE-ENTERS the stage weeks later, which
 * never re-dripped. The old comment named the missing fix outright: "Phase 3
 * upgrades this to a stage-entry edge so a genuine RE-entry into the stage
 * re-drips." This is that.
 *
 * The stage-entry edge: a lead re-enters the funnel when it entered the stage
 * MORE RECENTLY than its last run for this sequence was created. `stage_entered_at`
 * is stamped centrally in lib/manifest/data.ts updateRecord, so every path that
 * changes a stage sets it without having to know about drips. Sitting still does
 * not move that timestamp, so a parked lead is still skipped forever, which is
 * the property the original rule was protecting.
 *
 * Two safety properties are deliberate:
 *  - A lead with a prior run and NO `stage_entered_at` is skipped, not enrolled.
 *    The column is new, so most historical leads lack it, and reading "absent" as
 *    "just arrived" would re-drip the entire back catalogue on the first deploy.
 *    They become eligible the next time they genuinely change stage.
 *  - Re-entry is additionally rate-limited by `cooldownDays` against the last
 *    run, so a lead being triaged back and forth cannot be re-dripped repeatedly.
 */
async function collectCandidates(
  db: Db,
  seq: SequenceRow,
  stage: string,
  enrollLimit: number,
  cooldownDays: number,
  firstChannel: "sms" | "email",
): Promise<CandidateResult> {
  const out: LeadRow[] = [];
  let skippedAlreadyRan = 0;
  const staticSkips: Partial<Record<SkipReason, number>> = {};
  const noteSkip = (r: SkipReason) => {
    staticSkips[r] = (staticSkips[r] || 0) + 1;
  };
  // Unlimited (enrollLimit === 0) still needs a bound on how many candidates we
  // hand downstream in one pass; the per-run ceiling is the page size.
  const want = enrollLimit > 0 ? enrollLimit : CANDIDATE_PAGE_SIZE;
  const cooldownMs = cooldownDays * 24 * 3_600_000;
  const now = Date.now();

  for (let page = 0; page < CANDIDATE_MAX_PAGES; page++) {
    const from = page * CANDIDATE_PAGE_SIZE;
    const leadsRes = await db
      .from("tenant_records")
      .select("id, data")
      .eq("tenant_id", seq.tenant_id)
      .eq("entity_type", "lead")
      .filter("data->>stage", "eq", stage)
      .order("created_at", { ascending: true })
      .range(from, from + CANDIDATE_PAGE_SIZE - 1);
    if (leadsRes.error) {
      return { leads: out, skippedAlreadyRan, staticSkips, truncated: false, error: leadsRes.error.message };
    }
    const pageLeads = (leadsRes.data || []) as LeadRow[];
    if (pageLeads.length === 0) {
      return { leads: out, skippedAlreadyRan, staticSkips, truncated: false };
    }

    // Most recent run per lead for THIS sequence. 'cancelled' rows do not block
    // (an operator halt should not permanently burn the lead), matching the
    // original rule.
    const pageIds = pageLeads.map((l) => l.id);
    const priorRes = await db
      .from("drip_runs")
      .select("lead_id, created_at")
      .eq("tenant_id", seq.tenant_id)
      .eq("sequence_id", seq.id)
      .in("lead_id", pageIds)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false });
    if (priorRes.error) {
      // Fail CLOSED on this page: without the prior-run history we cannot tell a
      // first-time lead from one we already dripped, and guessing wrong means
      // re-sending step 0 to people who already got it.
      return { leads: out, skippedAlreadyRan, staticSkips, truncated: false, error: priorRes.error.message };
    }
    const lastRunAt = new Map<string, number>();
    for (const r of (priorRes.data || []) as Array<{ lead_id: string; created_at: string }>) {
      // Rows arrive newest-first, so the first one seen per lead is the latest.
      if (!lastRunAt.has(r.lead_id)) {
        lastRunAt.set(r.lead_id, new Date(r.created_at).getTime());
      }
    }

    for (const lead of pageLeads) {
      const prior = lastRunAt.get(lead.id);
      const eligibleByRunHistory =
        prior === undefined ||
        isReEntryEligible({
          lastRunAtMs: prior,
          stageEnteredAt: (lead.data || {}).stage_entered_at,
          nowMs: now,
          cooldownMs,
        });
      if (!eligibleByRunHistory) {
        skippedAlreadyRan++;
        continue;
      }
      // Permanent guards are applied HERE so a rejected lead does not occupy a
      // slot under `want` and block the leads behind it forever.
      const staticSkip = staticSkipReason(lead.data || {}, stage, firstChannel);
      if (staticSkip) {
        noteSkip(staticSkip);
        continue;
      }
      out.push(lead);
      if (out.length >= want) {
        return { leads: out, skippedAlreadyRan, staticSkips, truncated: true };
      }
    }

    // A short page means we reached the end of the stage.
    if (pageLeads.length < CANDIDATE_PAGE_SIZE) {
      return { leads: out, skippedAlreadyRan, staticSkips, truncated: false };
    }
  }
  // Walked the page budget without exhausting the stage. Not silent: the caller
  // surfaces `candidates`, and this flag records that more leads exist behind it.
  return { leads: out, skippedAlreadyRan, staticSkips, truncated: true };
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
  const redripCooldownDays = parseRedripCooldownDays(process.env.DRIPS_REDRIP_COOLDOWN_DAYS);
  const enrollDailyCap = parseEnrollDailyCap(process.env.DRIPS_ENROLL_DAILY_CAP);
  const db = getServiceSupabase();

  // Global intake ceiling across ALL sequences (rolling 24h). Computed once per
  // run. This is the surge brake on the two enrollment fixes in this file: they
  // release leads that have been frozen out of the funnel, potentially many at
  // once, and the send-side caps alone would leave a very large queue of
  // scheduled rows behind. Fails SOFT (-1 -> treat as unlimited) because the
  // per-sequence limit and the stage allowlist still bound each run.
  let enrollBudget = Number.POSITIVE_INFINITY;
  if (enrollDailyCap > 0) {
    const used = await countEnrolledLast24h(db);
    if (used >= 0) enrollBudget = Math.max(0, enrollDailyCap - used);
  }

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

    // Candidate collection — see collectCandidates() for the two bugs this
    // replaces (the >500-lead freeze and the permanent once-per-lifetime block).
    const collected = await collectCandidates(db, seq, stage, enrollLimit, redripCooldownDays, firstStep[0].channel);
    if (collected.error) {
      perSequence.push({
        sequenceId: seq.id,
        tenantId: seq.tenant_id,
        sequenceName: seq.name,
        stage,
        candidates: 0,
        skipped,
        enrolled: 0,
        error: collected.error,
      });
      continue;
    }
    const leads = collected.leads;
    skipped.already_enrolled += collected.skippedAlreadyRan;
    for (const [reason, n] of Object.entries(collected.staticSkips)) {
      skipped[reason as SkipReason] += n ?? 0;
    }
    candidates = leads.length;
    totalCandidates += candidates;

    if (leads.length === 0) {
      perSequence.push({ sequenceId: seq.id, tenantId: seq.tenant_id, sequenceName: seq.name, stage, candidates, skipped, enrolled });
      continue;
    }

    for (const lead of leads) {
      const data = lead.data || {};
      // NOTE: the permanent guards (dead file, opted out, paused, docs-on-file,
      // no contact method) already ran inside collectCandidates. They are
      // applied there rather than here so that a lead they reject does not
      // consume a slot under the enrollment limit and starve the leads behind
      // it — see staticSkipReason() for why that ordering is load-bearing.
      // Enrollment writes only when BOTH the global DRIPS_LIVE act holds AND
      // this stage is on the DRIPS_ENROLL_STAGES allowlist; otherwise this is a
      // report-only pass (candidate counted, nothing written). The per-sequence
      // DRIPS_ENROLL_LIMIT caps how many NEW rows this run creates. These gates
      // come BEFORE the wasShoppedRecently() DB call below so a report-only /
      // non-allowlisted run never fires a per-lead query across the whole
      // backlog (that made the endpoint exceed maxDuration on a full scan).
      if (!live || !stageAllowed) continue;
      if (enrollLimit !== 0 && enrolled >= enrollLimit) break;
      // Global rolling-24h intake ceiling across every sequence. Checked here,
      // inside the write path, so a report-only pass still reports true
      // candidate counts and only real enrollment consumes budget.
      if (enrollBudget <= 0) {
        skipped.daily_enroll_cap++;
        break;
      }

      // Expensive per-lead guards — only reached for leads we're about to
      // actually enroll (bounded by DRIPS_ENROLL_LIMIT).
      if (await wasShoppedRecently(db, seq.tenant_id, lead.id, data)) {
        skipped.shopped_recently++;
        continue;
      }
      // Accelerated-chase overlap suppression (Adon 2026-07-22): a lead being
      // ACTIVELY chased doesn't get stage drips — one track at a time. The
      // predicate is an active chase run, not the flag alone, so a flagged
      // lead the chase can't enroll keeps its stage follow-up (codex P1).
      if (
        acceleratedSystemLive() &&
        isTruthyFlag(data[ACCELERATED_FLAG]) &&
        (await hasActiveAcceleratedRun(db, seq.tenant_id, lead.id))
      ) {
        skipped.accelerated_chase++;
        continue;
      }

      // Step-0 send time = the LATER of the sequence's own delay and the 24h
      // stage buffer (this whole enroll path is stage-triggered), plus jitter.
      const scheduledFor = new Date(
        Date.now() +
          computeStep0DelayMinutes(firstStep[0].delay_minutes, enrollmentBufferForStage(stage)) * 60_000 +
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
      enrollBudget--; // consume from the global rolling-24h intake ceiling

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
