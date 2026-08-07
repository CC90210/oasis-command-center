/**
 * lib/drips/governor.ts — the ONE volume/eligibility chokepoint every REAL
 * drip send passes through.
 *
 * Originally written 2026-07-14 against the go-live engine (commit 2e028f0 on
 * apex/drip-hardening) and never shipped. Re-landed 2026-07-29 on top of a much
 * changed executor, with one deliberate behaviour change noted below.
 *
 * It closes three gaps the live engine shipped with:
 *
 *   1. No per-recipient or daily email cap. The engine had only a GLOBAL
 *      ~30/hour ceiling, which paces the SYSTEM but says nothing about what one
 *      human experiences. A single lead enrolled in several sequences could be
 *      hit by all of them on the same morning while the system's own metrics
 *      looked calm. That is the mechanical cause of mail that "feels spammy".
 *   2. The per-lead `drip_paused` toggle was written by the UI and read by
 *      NOBODY, so pausing a lead did nothing. Honored here via isPaused().
 *   3. No kill switch a human or watchdog can trip -> circuitOpen().
 *
 * SCOPE: EMAIL only. Email funnels through one Google Workspace mailbox
 * (submissions@sunbizfunding.com, ~150/day reputation-safe), so it is the
 * bottleneck. SMS goes per-rep on Text Torrent with thousands/day of headroom
 * and is bounded upstream by DRIPS_ENROLL_LIMIT.
 *
 * FAIL BEHAVIOUR, and the 2026-07-29 change:
 *   - The two GLOBAL caps fail SOFT. A transient count-query failure must not
 *     stall the whole engine, and the CAS claim, suppression checks and enroll
 *     ramp remain the primary guards; these are a reputation smoothing layer.
 *   - The PER-LEAD cap now fails CLOSED. The original returned full budget on a
 *     read error, which meant a transient failure re-opened the exact hole the
 *     cap exists to close: unlimited sends to one person. A per-lead read error
 *     now HOLDS the row for an hour instead. Holding is cheap and self-healing;
 *     over-mailing one merchant is not.
 *
 * All windows are ROLLING (last-24h / last-60min / last-7d), matching how Gmail
 * actually enforces limits rather than a calendar day.
 *
 * NOTE ON SCOPE: the counts are GLOBAL (all tenants), matching the existing
 * DRIPS_HOURLY_CAP in executor.ts. Correct while SunBiz is the only drip tenant;
 * make both per-tenant together if a second one goes live.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import type { EmailBudget } from "./drip-rules-core";

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

/** Runtime kill switch. DRIPS_CIRCUIT_OPEN=1 halts ALL real drip sends this run.
 *  BRAVO_FORCE_DRY_RUN=1 remains the global hard kill above this. */
export function circuitOpen(): boolean {
  return (process.env.DRIPS_CIRCUIT_OPEN || "").trim() === "1";
}

const ISO = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Count REAL (non-dry-run) drip EMAIL sends in a rolling window, from the
 *  lead_interactions audit trail — the same source alreadySentStep() trusts.
 *  agent_source LIKE 'sequence:%' scopes to drip sends only, not lender
 *  shop-out from the same mailbox. Returns -1 on error. */
async function countDripEmail(db: Db, sinceIso: string): Promise<number> {
  try {
    const r = await db
      .from("lead_interactions")
      .select("id", { count: "exact", head: true })
      .eq("type", "email_sent")
      .eq("direction", "outbound")
      .eq("metadata->>dry_run", "false")
      .like("agent_source", "sequence:%")
      .gte("created_at", sinceIso);
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
  let perLeadDegraded = false;

  const [today, thisHour] = await Promise.all([
    countDripEmail(db, ISO(DAY)),
    countDripEmail(db, ISO(HOUR)),
  ]);
  if (today < 0 || thisHour < 0) degraded = true;

  const dailyRemaining = today < 0 ? emailDailyCap() : Math.max(0, emailDailyCap() - today);
  const hourlyRemaining = thisHour < 0 ? emailHourlyCap() : Math.max(0, emailHourlyCap() - thisHour);

  if (emailLeadIds.length > 0) {
    try {
      const r = await db
        .from("lead_interactions")
        .select("lead_id")
        .eq("type", "email_sent")
        .eq("direction", "outbound")
        .eq("metadata->>dry_run", "false")
        .like("agent_source", "sequence:%")
        .gte("created_at", ISO(WEEK))
        .in("lead_id", emailLeadIds);
      if (r.error) perLeadDegraded = true;
      for (const row of (r.data || []) as Array<{ lead_id: string }>) {
        perLeadSent7d.set(row.lead_id, (perLeadSent7d.get(row.lead_id) || 0) + 1);
      }
    } catch {
      perLeadDegraded = true;
    }
  }

  return { dailyRemaining, hourlyRemaining, perLeadSent7d, perLeadCap: cap, degraded, perLeadDegraded };
}

// The pure rules (pause, cap gating, hold windows, the stage-entry edge) live in
// drip-rules-core.ts so they can be unit-tested without a server runtime.
// Re-exported here so existing import sites keep working unchanged.
export {
  emailGateReason,
  consumeEmail,
  holdUntilIso,
  isPaused,
  isReEntryEligible,
  type EmailBudget,
  type EmailGateReason,
} from "./drip-rules-core";
