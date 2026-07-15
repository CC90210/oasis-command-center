/**
 * lib/drips/governor.ts — the ONE volume/eligibility chokepoint every REAL
 * drip send passes through. Closes the three gaps the go-live engine shipped
 * with (2026-07-14 deliverability plan, docs/EMAIL_DRIP_OPTIMIZATION_PLAN):
 *
 *   1. No daily / hourly / per-lead send cap  -> EMAIL_* caps below.
 *   2. The per-lead `drip_paused` toggle was ignored at send time -> honored
 *      in the executor's processRow via isPaused() (HOLD, not fail — a pause
 *      is reversible; killing the enrollment would not be).
 *   3. No kill-switch a human/watchdog can trip -> circuitOpen().
 *
 * SCOPE: EMAIL only. Email funnels through one Google Workspace mailbox
 * (submissions@sunbizfunding.com, ~150/day reputation-safe, 2,000/day hard),
 * so it is the bottleneck. SMS goes out per-rep on Text Torrent with
 * thousands/day of headroom and is deliberately NOT capped here — the SMS
 * ramp is held by DRIPS_ENROLL_LIMIT upstream.
 *
 * FAIL-SOFT ON READ ERROR: a transient count-query failure must not stall the
 * whole engine, so a failed budget read returns FULL budget (allow) and logs —
 * the CAS claim, suppression checks, and enroll ramp are the primary guards;
 * these caps are a reputation smoothing layer on top. The one hard stop is the
 * circuit breaker, which is an explicit human/watchdog act.
 *
 * All windows are ROLLING (last-24h / last-60min / last-7d) not calendar-day —
 * that matches how Gmail actually enforces its limits.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";

type Db = ReturnType<typeof getServiceSupabase>;

function intEnv(name: string, def: number): number {
  const n = parseInt((process.env[name] || "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** Reputation-safe defaults (warm inbound audience, single mailbox). During the
 *  6-week warm-up these are raised via env: 25 -> 40 -> 60 -> 90 -> 120 -> 150. */
export const emailDailyCap = () => intEnv("DRIPS_EMAIL_DAILY_CAP", 150);
export const emailHourlyCap = () => intEnv("DRIPS_EMAIL_HOURLY_CAP", 25);
export const perLeadWeeklyEmailCap = () => intEnv("DRIPS_PER_LEAD_WEEKLY_EMAIL_CAP", 2);

/** Runtime kill switch. DRIPS_CIRCUIT_OPEN=1 halts ALL real drip sends this
 *  run (deploy-time flag today; the DB-backed, watchdog-trippable version is
 *  the documented fast-follow). BRAVO_FORCE_DRY_RUN=1 remains the global hard
 *  kill above this. */
export function circuitOpen(): boolean {
  return (process.env.DRIPS_CIRCUIT_OPEN || "").trim() === "1";
}

export function isPaused(leadData: Record<string, unknown>): boolean {
  return leadData.drip_paused === true || leadData.drip_paused === "true";
}

export type EmailBudget = {
  dailyRemaining: number;
  hourlyRemaining: number;
  perLeadSent7d: Map<string, number>;
  perLeadCap: number;
  degraded: boolean; // a count query failed; caps are best-effort this run
};

const ISO = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Count REAL (non-dry-run) drip EMAIL sends in a rolling window, from the
 *  lead_interactions audit trail — the same source alreadySentStep() trusts.
 *  agent_source LIKE 'sequence:%' scopes to drip sends only (not lender
 *  shop-out from the same mailbox). Returns -1 on error so the caller can
 *  degrade to allow. */
async function countDripEmail(db: Db, sinceIso: string, leadId?: string): Promise<number> {
  try {
    let q = db
      .from("lead_interactions")
      .select("id", { count: "exact", head: true })
      .eq("type", "email_sent")
      .eq("direction", "outbound")
      .eq("metadata->>dry_run", "false")
      .like("agent_source", "sequence:%")
      .gte("created_at", sinceIso);
    if (leadId) q = q.eq("lead_id", leadId);
    const r = await q;
    if (r.error) return -1;
    return r.count ?? 0;
  } catch {
    return -1;
  }
}

/** Compute the email budget ONCE per dispatch run (2 aggregate queries + one
 *  batched per-lead query), so per-row gating is O(1). `emailLeadIds` are the
 *  leads whose claimed step this run is an email step. */
export async function loadEmailBudget(db: Db, emailLeadIds: string[]): Promise<EmailBudget> {
  const cap = perLeadWeeklyEmailCap();
  const perLeadSent7d = new Map<string, number>();
  let degraded = false;

  const [today, thisHour] = await Promise.all([countDripEmail(db, ISO(DAY)), countDripEmail(db, ISO(HOUR))]);
  if (today < 0 || thisHour < 0) degraded = true;

  const dailyRemaining = today < 0 ? emailDailyCap() : Math.max(0, emailDailyCap() - today);
  const hourlyRemaining = thisHour < 0 ? emailHourlyCap() : Math.max(0, emailHourlyCap() - thisHour);

  if (emailLeadIds.length > 0) {
    try {
      const r = await db
        .from("lead_interactions")
        .select("lead_id")
        .eq("type", "email_sent")
        .eq("metadata->>dry_run", "false")
        .like("agent_source", "sequence:%")
        .gte("created_at", ISO(WEEK))
        .in("lead_id", emailLeadIds);
      if (r.error) degraded = true;
      for (const row of (r.data || []) as Array<{ lead_id: string }>) {
        perLeadSent7d.set(row.lead_id, (perLeadSent7d.get(row.lead_id) || 0) + 1);
      }
    } catch {
      degraded = true;
    }
  }

  return { dailyRemaining, hourlyRemaining, perLeadSent7d, perLeadCap: cap, degraded };
}

export type EmailGateReason = "daily_cap" | "hourly_cap" | "per_lead_weekly_cap";

/** Would a real email to this lead breach a cap RIGHT NOW? Returns the breached
 *  cap (caller HOLDs the row) or null (ok to send). Pure — does not mutate. */
export function emailGateReason(budget: EmailBudget, leadId: string): EmailGateReason | null {
  if (budget.dailyRemaining <= 0) return "daily_cap";
  if (budget.hourlyRemaining <= 0) return "hourly_cap";
  const sent = budget.perLeadSent7d.get(leadId) || 0;
  if (sent >= budget.perLeadCap) return "per_lead_weekly_cap";
  return null;
}

/** Record that a real email just went out, so later rows in the SAME run see
 *  the decremented budget without re-querying. Call only after a successful
 *  real send. */
export function consumeEmail(budget: EmailBudget, leadId: string): void {
  budget.dailyRemaining -= 1;
  budget.hourlyRemaining -= 1;
  budget.perLeadSent7d.set(leadId, (budget.perLeadSent7d.get(leadId) || 0) + 1);
}

/** How long to HOLD a row that hit a cap, before it re-tries. Daily-cap holds
 *  roll to the next window; hourly to the next hour; per-lead to ~3 days so the
 *  2/week spacing is real. Returned as an ISO string for markRescheduled. */
export function holdUntilIso(reason: EmailGateReason): string {
  const ms = reason === "hourly_cap" ? HOUR : reason === "daily_cap" ? DAY : 3 * DAY;
  return new Date(Date.now() + ms).toISOString();
}
