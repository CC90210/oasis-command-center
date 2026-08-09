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

/** Brand keys, duplicated here as a string union rather than imported, to keep
 *  this module free of every other dependency. Must match lib/email/brands.ts. */
export type BudgetBrand = "sunbiz" | "bluerise";

export type EmailBudget = {
  /** Remaining sends per BRAND. Each brand carries its own domain reputation,
   *  so a shared ceiling would mean splitting across domains bought no extra
   *  throughput — which is the whole point of running two. */
  dailyRemaining: Record<BudgetBrand, number>;
  hourlyRemaining: Record<BudgetBrand, number>;
  /** Brand-BLIND: two emails in a week is two emails whichever company sent
   *  them. This is the cap that decides how mail FEELS to one human. */
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
/**
 * How many emails one lead may receive in a rolling week, BY STAGE.
 *
 * A flat number either starves the hot stages or over-mails the cold ones. A
 * merchant mid-application is expecting to hear from us; a lead sitting in
 * follow-up for six weeks is not. Defaults come from the cadence matrix
 * measured against the real stage populations on 2026-08-06.
 *
 * The cap is raised BY STAGE, never globally, so the extra frequency lands only
 * where engagement is likely to justify it. That is what keeps the complaint
 * budget intact: at ~150 Gmail inbox deliveries/day, 0.1% is one complaint per
 * WEEK, so frequency spent in the wrong place is expensive.
 *
 * An unrecognised stage resolves to the CONSERVATIVE default. A stage we do not
 * know about is not a licence to send more.
 */
const STAGE_WEEKLY_CAP: Record<string, number> = {
  uw_sheet: 7,            // live subs, hottest, daily in week 1
  signed_application: 7,  // chasing bank statements
  sent_application: 7,    // application started, not finished
  missing_info: 4,        // blocked on a specific item
  viewed_application: 4,  // opened the app
  follow_up: 3,           // general nurture
  declined: 1,            // long-cycle re-engagement
  default: 1,
};

const CONSERVATIVE_DEFAULT = 2;

export function perLeadCapForStage(stage: unknown): number {
  const key = String(stage ?? "").trim().toLowerCase();
  if (!key) return CONSERVATIVE_DEFAULT;

  // Per-stage env override, so a stage can be retuned or paused (0) without a
  // deploy. A non-numeric value falls back to the built-in rather than
  // disabling the cap, but an explicit 0 IS honored: pausing a stage is a
  // legitimate operation and must not be indistinguishable from a typo.
  const raw = process.env[`DRIPS_WEEKLY_CAP_${key.toUpperCase()}`];
  if (raw !== undefined && String(raw).trim() !== "") {
    const n = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }

  const builtin = STAGE_WEEKLY_CAP[key];
  return builtin === undefined ? CONSERVATIVE_DEFAULT : builtin;
}

export function emailGateReason(
  budget: EmailBudget,
  leadId: string,
  brand: BudgetBrand = "sunbiz",
  stage?: unknown,
): EmailGateReason | null {
  if (budget.perLeadDegraded) return "per_lead_budget_unavailable";
  if ((budget.dailyRemaining[brand] ?? 0) <= 0) return "daily_cap";
  if ((budget.hourlyRemaining[brand] ?? 0) <= 0) return "hourly_cap";
  const sent = budget.perLeadSent7d.get(leadId) || 0;
  // A supplied stage takes precedence over the budget's flat cap; omitting the
  // stage preserves the pre-2026-08-06 behaviour for any caller not yet passing
  // one, so this is safe to land before every call site is updated.
  const cap = stage === undefined ? budget.perLeadCap : perLeadCapForStage(stage);
  if (sent >= cap) return "per_lead_weekly_cap";
  return null;
}

/** Record that a real email just went out, so later rows in the SAME run see the
 *  decremented budget without re-querying. Call only after a real send. */
export function consumeEmail(
  budget: EmailBudget,
  leadId: string,
  brand: BudgetBrand = "sunbiz",
): void {
  budget.dailyRemaining[brand] = (budget.dailyRemaining[brand] ?? 0) - 1;
  budget.hourlyRemaining[brand] = (budget.hourlyRemaining[brand] ?? 0) - 1;
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
