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
import { ALL_BRAND_KEYS, resolveBrandKey, type BrandKey } from "@/lib/email/brands";
import { sequenceSentToday, sequenceDailyCaps } from "./sequence-volume";

type Db = ReturnType<typeof getServiceSupabase>;

function intEnv(name: string, def: number): number {
  const n = parseInt((process.env[name] || "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** Reputation-safe defaults (warm inbound audience, single mailbox). During the
 *  6-week warm-up these are raised via env: 25 -> 40 -> 60 -> 90 -> 120 -> 150. */
/** Per-brand ceilings. Each brand carries its own domain reputation, so each
 *  gets its own ceiling, and a per-brand override wins over the shared one.
 *
 *  A BRAND THAT HAS NEVER SENT DOES NOT INHERIT A WARMED BRAND'S CEILING.
 *  bluerisebusinesscapital.com has no sending history, and the shared default
 *  of 150/day is the END of SunBiz's six-week warm-up, not its start. Routing
 *  the follow-ups desk to Bluerise (brand-routing.ts, 2026-08-11) points 512
 *  leads at that domain, so falling through to the shared value would open a
 *  cold domain at full throttle — the single most reliable way to land the new
 *  brand in spam and take the shared IP reputation down with it.
 *
 *  So Bluerise carries its OWN default at the start of the ramp, and is raised
 *  through DRIPS_EMAIL_DAILY_CAP_BLUERISE (25 -> 40 -> 60 -> 90 -> 120 -> 150)
 *  on the same schedule SunBiz already walked. An explicit env override still
 *  wins, so this delays nothing that an operator has decided. */
const WARMUP_START_DAILY = 25;
const WARMUP_START_HOURLY = 10;

export const emailDailyCap = (brand: BrandKey = "sunbiz") =>
  intEnv(
    `DRIPS_EMAIL_DAILY_CAP_${brand.toUpperCase()}`,
    brand === "bluerise" ? WARMUP_START_DAILY : intEnv("DRIPS_EMAIL_DAILY_CAP", 150),
  );
export const emailHourlyCap = (brand: BrandKey = "sunbiz") =>
  intEnv(
    `DRIPS_EMAIL_HOURLY_CAP_${brand.toUpperCase()}`,
    brand === "bluerise" ? WARMUP_START_HOURLY : intEnv("DRIPS_EMAIL_HOURLY_CAP", 25),
  );
/** Brand-BLIND on purpose: this cap is about how mail feels to one human, and
 *  two emails in a week is two emails whichever company sent them. */
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
/**
 * Count REAL drip EMAIL sends in a rolling window, bucketed by SENDING BRAND.
 *
 * TWO CORRECTIONS OVER THE ORIGINAL (2026-08-05), both found by measuring
 * production rather than reading the code:
 *
 * 1. It counted `metadata->>dry_run = 'false'` EXACTLY, so any row whose
 *    metadata lacks a dry_run key was invisible to the cap. That was not
 *    hypothetical: a SECOND sender (the VPS send_gateway, metadata shape
 *    {brand,intent,sent_at,reservation_status}) writes rows for the SAME
 *    sequences and never sets dry_run. Over 30 days it sent 105 emails the cap
 *    could not see, against 320 from this engine. A cap of 25 would really have
 *    permitted ~33. Now anything not EXPLICITLY dry_run counts, so an unknown
 *    writer makes the cap bite sooner rather than disappear. Fail closed.
 *
 * 2. The counts were global across brands. With two brands on one tenant, a
 *    shared ceiling means splitting the volume across two domains buys no extra
 *    throughput, which defeats the reason for the split. Counts are now
 *    per-brand, read from metadata.sending_brand, defaulting to sunbiz for
 *    every historical row (correct: they all predate Bluerise).
 *
 * Counted in JS rather than by a PostgREST predicate because "dry_run is absent
 * OR false" and "sending_brand is absent OR equals X" are both awkward to
 * express as filters, and the daily window is only a few hundred rows.
 *
 * Returns null on error so the caller can degrade explicitly.
 */
async function countDripEmailByBrand(
  db: Db,
  sinceIso: string,
): Promise<Record<BrandKey, number> | null> {
  const out: Record<BrandKey, number> = { sunbiz: 0, bluerise: 0 };
  try {
    // Bounded: a rolling day of drip mail is small. Paginate defensively anyway
    // so a backlog cannot silently truncate the count and under-report volume.
    for (let page = 0; page < 6; page++) {
      const r = await db
        .from("lead_interactions")
        .select("metadata")
        .eq("type", "email_sent")
        .eq("direction", "outbound")
        .like("agent_source", "sequence:%")
        .gte("created_at", sinceIso)
        .range(page * 1000, page * 1000 + 999);
      if (r.error) return null;
      const rows = (r.data || []) as Array<{ metadata: Record<string, unknown> | null }>;
      for (const row of rows) {
        const md = row.metadata || {};
        // Only an EXPLICIT dry run is excluded. Absent means "some writer we do
        // not control produced this", and that must count against the ceiling.
        if (String(md.dry_run) === "true") continue;
        out[resolveBrandKey(md.sending_brand)] += 1;
      }
      if (rows.length < 1000) break;
    }
    return out;
  } catch {
    return null;
  }
}

/** Compute the email budget ONCE per dispatch run (2 aggregate queries + one
 *  batched per-lead query), so per-row gating is O(1). `emailLeadIds` are the
 *  leads whose claimed step this run is an email step. */
export async function loadEmailBudget(
  db: Db,
  emailLeadIds: string[],
  /** Tenants for the per-SEQUENCE caps. A dispatch batch can span tenants, so
   *  this is a LIST — passing only claimed[0].tenant_id is the exact mistake
   *  this file's brand map and template pool each had to be fixed for. Empty
   *  means no per-sequence gating this run, which is the pre-2026-08-11
   *  behaviour. */
  tenantIds: string[] = [],
): Promise<EmailBudget> {
  const cap = perLeadWeeklyEmailCap();
  const perLeadSent7d = new Map<string, number>();
  let degraded = false;
  let perLeadDegraded = false;
  const perSequenceSentToday = new Map<string, number>();
  const perSequenceCap = new Map<string, number>();
  const perSequenceDegraded = new Set<string>();

  const [today, thisHour] = await Promise.all([
    countDripEmailByBrand(db, ISO(DAY)),
    countDripEmailByBrand(db, ISO(HOUR)),
  ]);
  if (today === null || thisHour === null) degraded = true;

  // Per-brand remaining. Each brand carries its own domain reputation, so each
  // gets its own ceiling; a shared one would mean splitting across two domains
  // bought no throughput.
  const dailyRemaining = {} as Record<BrandKey, number>;
  const hourlyRemaining = {} as Record<BrandKey, number>;
  for (const b of ALL_BRAND_KEYS) {
    dailyRemaining[b] = today === null ? emailDailyCap(b) : Math.max(0, emailDailyCap(b) - today[b]);
    hourlyRemaining[b] =
      thisHour === null ? emailHourlyCap(b) : Math.max(0, emailHourlyCap(b) - thisHour[b]);
  }

  if (emailLeadIds.length > 0) {
    try {
      // The per-lead cap is about how mail FEELS to one human, so it is
      // deliberately brand-BLIND: two emails this week is two emails whichever
      // company sent them. It also drops the dry_run predicate for the same
      // reason the global counts did — a send from an unknown writer still
      // landed in that person's inbox.
      const r = await db
        .from("lead_interactions")
        .select("lead_id, metadata")
        .eq("type", "email_sent")
        .eq("direction", "outbound")
        .like("agent_source", "sequence:%")
        .gte("created_at", ISO(WEEK))
        .in("lead_id", emailLeadIds);
      if (r.error) perLeadDegraded = true;
      for (const row of (r.data || []) as Array<{ lead_id: string; metadata: Record<string, unknown> | null }>) {
        if (String(row.metadata?.dry_run) === "true") continue;
        perLeadSent7d.set(row.lead_id, (perLeadSent7d.get(row.lead_id) || 0) + 1);
      }
    } catch {
      perLeadDegraded = true;
    }
  }

  // Per-SEQUENCE caps and today's counts. Loaded only when a tenant is known.
  //
  // BOTH READS OR NEITHER. Counts without caps gate nothing; caps without
  // counts would read every sequence as having sent zero today and let an
  // already-exhausted one carry on. Either half missing means degraded, and
  // emailGateReason then holds only the sequences that actually HAVE a cap set
  // — failing closed where a human asked for a limit, without stalling the
  // engine for everyone else.
  for (const tenantId of new Set(tenantIds.filter(Boolean))) {
    try {
      const [sent, caps] = await Promise.all([sequenceSentToday(tenantId), sequenceDailyCaps(tenantId)]);
      if (sent === null || caps === null) perSequenceDegraded.add(tenantId);
      // Keys are namespaced by tenant (sequenceBudgetKeys). A sequence id is a
      // uuid and would survive a shared map, but a NAME is not unique across
      // tenants, and two tenants with a "Cold Outreach" would otherwise share
      // one counter — one silently eating the other's daily allowance.
      //
      // Whichever half succeeded is kept: the caps map is what decides whether
      // a sequence is gated at all, so a degraded run still knows WHICH
      // sequences to hold.
      for (const [k, v] of caps || []) perSequenceCap.set(`${tenantId}|${k}`, v);
      for (const [k, v] of sent || []) perSequenceSentToday.set(`${tenantId}|${k}`, v);
    } catch {
      perSequenceDegraded.add(tenantId);
    }
  }

  return {
    dailyRemaining,
    hourlyRemaining,
    perLeadSent7d,
    perLeadCap: cap,
    perSequenceSentToday,
    perSequenceCap,
    perSequenceDegraded,
    degraded,
    perLeadDegraded,
  };
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
