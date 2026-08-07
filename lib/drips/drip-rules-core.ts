/**
 * lib/drips/drip-rules-core.ts — the PURE decision layer of the drip engine.
 *
 * Split out from governor.ts / enroller.ts for the same reason
 * edit-guard-core.ts is split from edit-guard.ts: those modules import
 * "server-only" and a Supabase client, which makes their rules untestable
 * outside a Next server runtime. The rules in here are the parts that decide
 * whether a merchant receives an email, so they are exactly the parts that most
 * need direct tests.
 *
 * Nothing here does I/O or reads a database. Anything that needs a client lives
 * in governor.ts and calls into this.
 */

// ── Send-volume budget ──────────────────────────────────────────────────────

export type EmailBudget = {
  dailyRemaining: number;
  hourlyRemaining: number;
  perLeadSent7d: Map<string, number>;
  perLeadCap: number;
  /** A GLOBAL count query failed; the two global caps are best-effort this run. */
  degraded: boolean;
  /** The PER-LEAD count query failed. Unlike `degraded`, this one is enforced. */
  perLeadDegraded: boolean;
};

export type EmailGateReason =
  | "daily_cap"
  | "hourly_cap"
  | "per_lead_weekly_cap"
  | "per_lead_budget_unavailable";

/**
 * Would a real email to this lead breach a cap right now? Returns the breached
 * cap (the caller HOLDs the row) or null (ok to send).
 *
 * The per-lead check is the one that matters for how mail FEELS. A global
 * hourly ceiling paces the system while still allowing one merchant to receive
 * several messages in a morning from several sequences; that is the shape
 * recipients experience as spam, and it is what this closes.
 *
 * Fail behaviour is deliberately asymmetric:
 *   - global counts fail SOFT, because stalling the whole engine on a transient
 *     count error is worse than briefly over-pacing, and other guards remain.
 *   - the per-lead count fails CLOSED, because the failure mode it guards is
 *     over-mailing one person, and "hold for an hour" costs nothing.
 */
export function emailGateReason(budget: EmailBudget, leadId: string): EmailGateReason | null {
  if (budget.perLeadDegraded) return "per_lead_budget_unavailable";
  if (budget.dailyRemaining <= 0) return "daily_cap";
  if (budget.hourlyRemaining <= 0) return "hourly_cap";
  const sent = budget.perLeadSent7d.get(leadId) || 0;
  if (sent >= budget.perLeadCap) return "per_lead_weekly_cap";
  return null;
}

/** Record that a real email just went out, so later rows in the SAME run see the
 *  decremented budget without re-querying. Call only after a real send. */
export function consumeEmail(budget: EmailBudget, leadId: string): void {
  budget.dailyRemaining -= 1;
  budget.hourlyRemaining -= 1;
  budget.perLeadSent7d.set(leadId, (budget.perLeadSent7d.get(leadId) || 0) + 1);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long to HOLD a row that hit a cap before it retries. Daily rolls to the
 *  next window, hourly to the next hour, per-lead to ~3 days so the 2/week
 *  spacing is real, and an unavailable budget retries within the hour (that is a
 *  transient infrastructure problem, not a decision about this lead). */
export function holdUntilIso(reason: EmailGateReason): string {
  const ms =
    reason === "hourly_cap" || reason === "per_lead_budget_unavailable"
      ? HOUR
      : reason === "daily_cap"
        ? DAY
        : 3 * DAY;
  return new Date(Date.now() + ms).toISOString();
}

// ── Per-lead pause ──────────────────────────────────────────────────────────

/**
 * The per-lead pause toggle written by /api/leads/[id]/drip-toggle.
 *
 * That route has written `drip_paused` since it shipped and NOTHING read it, so
 * pausing a lead did nothing at all and the sequence carried on. Accepts the
 * string form too: the flag reaches readers through JSONB, and a lead an
 * operator believes is paused must be paused under every representation.
 */
export function isPaused(leadData: Record<string, unknown>): boolean {
  const v = leadData.drip_paused;
  return v === true || v === "true";
}

// ── Enrollment: the stage-entry edge ────────────────────────────────────────

/**
 * Is a lead that has ALREADY run a sequence eligible to run it again?
 *
 * Enrollment used to key purely off "is the lead currently in this stage", and
 * blocked any lead with a finished run, forever. That is right for a lead
 * SITTING in a stage (it must not be re-dripped every 15 minutes) and wrong for
 * one that legitimately RE-ENTERS weeks later, which is why follow-ups looked
 * dead: a lead could enter a sequence once per lifetime.
 *
 * Yes only when BOTH hold:
 *   - the lead entered its current stage more recently than its last run for
 *     this sequence was created (a genuine re-entry, not just sitting), and
 *   - that last run is older than the cooldown, so a lead being triaged back and
 *     forth between two stages cannot be re-dripped on every pass.
 *
 * An absent or unparseable `stage_entered_at` is NOT a re-entry. That field is
 * new, so most historical leads lack it, and reading absence as "just arrived"
 * would re-drip the entire back catalogue the first time this deploys.
 */
export function isReEntryEligible(args: {
  lastRunAtMs: number;
  stageEnteredAt: unknown;
  nowMs: number;
  cooldownMs: number;
}): boolean {
  const entered =
    typeof args.stageEnteredAt === "string" ? new Date(args.stageEnteredAt).getTime() : NaN;
  if (!Number.isFinite(entered)) return false;
  if (!(entered > args.lastRunAtMs)) return false;
  return args.nowMs - args.lastRunAtMs >= args.cooldownMs;
}
