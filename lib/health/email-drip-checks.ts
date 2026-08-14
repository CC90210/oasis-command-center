/**
 * lib/health/email-drip-checks.ts — deep monitoring for the email drip engine.
 *
 * Adon, 2026-08-14: "create one specifically for the email drips... the second
 * that it is either not functional or sending out the volume that we want, I
 * should be alerted via Telegram. This should be a very deep health system
 * because it's a very important part of our overall SunBiz system."
 *
 * WHY THE EXISTING email.sent_24h CHECK WAS NOT ENOUGH — and why it is the
 * cautionary tale this file is built around.
 *
 * That check uses `baseline_drop`: it compares today against a ROLLING baseline
 * of recent days. Which means the bar follows the failure down. Send 10 a day
 * for a week and the baseline becomes 10, the check turns green, and the
 * monitor now certifies the broken state as normal. On 2026-08-13 it read
 * "19 vs a normal 51.5" — degraded, not failing — while the true figure against
 * what we had actually agreed was roughly a fifth of target. A relative check
 * cannot answer "are we sending the volume we want" because it does not know
 * what we want.
 *
 * So the volume checks here are ABSOLUTE, measured against the agreed number.
 * A drifting baseline is still useful for spotting a sudden cliff, so it stays;
 * it just no longer stands alone.
 *
 * THE SECOND FAILURE MODE THESE COVER: the engine was not blocked in August, it
 * was STARVED. Zero rows due, 305 scheduled ahead, 404 emailable leads never
 * enrolled. Every send-side check was green because sending was fine — there
 * was simply nothing to send. Monitoring the send path alone would have shown
 * nothing wrong for as long as that lasted, so enrolment and the due queue are
 * checked as first-class signals rather than inferred from output.
 *
 * TARGETS come from env so the six-week ramp can move without a deploy:
 *   DRIPS_TARGET_EMAILS_PER_DAY   total across brands (default 40)
 *   DRIPS_TARGET_BLUERISE_PER_DAY Bluerise's own floor. Default 0, and the rule
 *                                 is a STRICT floor, so the default already
 *                                 means "at least one Bluerise email a day".
 *                                 That is deliberate: the brand's whole failure
 *                                 mode was sending exactly zero while looking
 *                                 configured. Raise it as the brand ramps.
 *   DRIPS_MAX_SILENT_HOURS        business-hours silence before it is a fault
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import type { CheckRule } from "./checks-core";

type Db = ReturnType<typeof getServiceSupabase>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

function intEnv(name: string, def: number): number {
  const n = parseInt((process.env[name] || "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/** The number we have actually agreed to send, not the number we happen to be
 *  sending. This is the whole point of the file. */
export const targetEmailsPerDay = () => intEnv("DRIPS_TARGET_EMAILS_PER_DAY", 40);
export const targetBluerisePerDay = () => intEnv("DRIPS_TARGET_BLUERISE_PER_DAY", 0);
export const maxSilentHours = () => intEnv("DRIPS_MAX_SILENT_HOURS", 6);

import type { DripCheck } from "./drip-checks";

async function countOrNull(
  q: PromiseLike<{ error: unknown; count: number | null }>,
): Promise<number | null> {
  try {
    const r = await q;
    if (r.error) return null;
    return r.count ?? 0;
  } catch {
    return null;
  }
}

/** Drip emails actually sent in a window, optionally for one brand.
 *
 *  Counted from lead_interactions — the same source governor.ts enforces the
 *  caps against — so the monitor and the throttle can never disagree about what
 *  "an email" is. Only an EXPLICIT dry_run is excluded, matching the governor,
 *  so a second writer inflates the number rather than hiding from it. */
async function countDripEmails(
  db: Db,
  tenantId: string,
  sinceMs: number,
  endMs: number,
  brand?: "sunbiz" | "bluerise",
): Promise<number | null> {
  try {
    const r = await db
      .from("lead_interactions")
      .select("metadata")
      .eq("tenant_id", tenantId)
      .eq("type", "email_sent")
      .eq("direction", "outbound")
      .like("agent_source", "sequence:%")
      .gte("created_at", iso(sinceMs))
      .lt("created_at", iso(endMs))
      .limit(5000);
    if (r.error) return null;
    let n = 0;
    for (const row of (r.data || []) as Array<{ metadata: Record<string, unknown> | null }>) {
      const md = row.metadata || {};
      if (String(md.dry_run) === "true") continue;
      if (brand) {
        // An absent stamp means sunbiz, matching brand-routing's safe default.
        const b = String(md.sending_brand || "sunbiz").toLowerCase();
        if (b !== brand) continue;
      }
      n++;
    }
    return n;
  } catch {
    return null;
  }
}

/** Hours since the most recent REAL drip email. Large number = silence.
 *
 *  Dry runs are excluded, matching countDripEmails and the governor. With
 *  DRIPS_LIVE off the executor still writes email_sent interactions stamped
 *  dry_run — so taking the newest row of any kind would hold this check green
 *  forever while nothing left the building, which is precisely the silent
 *  failure it was written to catch. Codex caught it in review.
 *
 *  A page of rows rather than one, so a burst of dry runs cannot mask the last
 *  real send. If every row in that page is a dry run then there has been no
 *  real send across at least that span, and maximal silence is the honest
 *  answer rather than a guess. */
async function hoursSinceLastEmail(db: Db, tenantId: string, endMs: number): Promise<number | null> {
  try {
    const r = await db
      .from("lead_interactions")
      .select("created_at, metadata")
      .eq("tenant_id", tenantId)
      .eq("type", "email_sent")
      .eq("direction", "outbound")
      .like("agent_source", "sequence:%")
      .order("created_at", { ascending: false })
      .limit(200);
    if (r.error) return null;
    const rows = (r.data || []) as Array<{ created_at: string; metadata: Record<string, unknown> | null }>;
    const last = rows.find((row) => String((row.metadata || {}).dry_run) !== "true")?.created_at;
    // Never sent at all is maximal silence, not "unknown". Returning null here
    // would render as check_broken and hide a genuinely dead engine behind an
    // infrastructure-looking amber.
    if (!last) return 999;
    const t = Date.parse(last);
    if (!Number.isFinite(t)) return 999;
    return Math.max(0, Math.round(((endMs - t) / HOUR) * 10) / 10);
  } catch {
    return null;
  }
}

/**
 * A failure that means the system worked, not that it broke.
 *
 * Kept deliberately short. Every entry added here is a class of real breakage
 * the monitor can no longer see, so a new one needs the same scrutiny as
 * deleting a check.
 */
export function isBenignSendFailure(lastError: string | null | undefined): boolean {
  const e = (lastError || "").toLowerCase();
  // Declining to email an opt-out is compliance succeeding.
  return e.includes("suppress") || e.includes("unsubscrib") || e.includes("opted out");
}

/** Drip email sends that were attempted and refused, minus the benign class. */
async function countRealFailures(
  db: Db,
  tenantId: string,
  sinceMs: number,
  endMs: number,
): Promise<number | null> {
  try {
    const r = await db
      .from("drip_runs")
      .select("last_error")
      .eq("tenant_id", tenantId)
      .eq("channel", "email")
      .eq("status", "failed")
      // claimed_at, NOT sent_at: sent_at is stamped on success only, so a
      // sent_at window matches no failed row ever. See the check's note.
      .gte("claimed_at", iso(sinceMs))
      .lt("claimed_at", iso(endMs))
      .limit(2000);
    if (r.error) return null;
    return ((r.data || []) as Array<{ last_error: string | null }>).filter(
      (row) => !isBenignSendFailure(row.last_error),
    ).length;
  } catch {
    return null;
  }
}

const CHECKS: DripCheck[] = [
  {
    // THE volume check. Absolute, against the agreed number — see the header for
    // why the existing baseline version could not answer this question.
    id: "drips.email_volume_vs_target",
    severity: "critical",
    rule: { kind: "must_be_above", floor: 0 }, // floor injected at runtime below
    observe: (db, tenantId, endMs) => countDripEmails(db, tenantId, endMs - DAY, endMs),
    describe: (r) =>
      `${r.observed} drip emails in 24h against a target of ${targetEmailsPerDay()}. ${r.reason}`,
  },
  {
    // Functionally dead. Distinct from "below target": below target is a
    // throughput problem, silence is a broken pipe, and they need different
    // reactions at 3am.
    id: "drips.email_silence_hours",
    severity: "critical",
    rule: { kind: "must_be_zero" }, // replaced at runtime with a ceiling rule
    observe: (db, tenantId, endMs) => hoursSinceLastEmail(db, tenantId, endMs),
    describe: (r) =>
      `${r.observed}h since the last drip email (limit ${maxSilentHours()}h). ${r.reason}`,
  },
  {
    // STARVATION, which is what actually happened in August: sending was fine,
    // there was nothing to send. No enrolments means the funnel has stopped
    // feeding the engine, and no send-side check can see it.
    //
    // COUNTED FROM drip_runs, NOT sequence_state. There are two sequence
    // engines against this database: the oasis drip engine (enrols by inserting
    // drip_runs — lib/drips/enroller.ts) and a legacy Python daemon that writes
    // sequence_state directly. The first draft counted sequence_state and so
    // reported on the engine that is NOT sending the emails this file measures
    // everywhere else — a green enrolment number sourced from a different
    // system entirely. Same engine, or the check is decoration.
    id: "drips.enrolments_24h",
    severity: "high",
    rule: { kind: "must_be_above", floor: 1 },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db
          .from("drip_runs")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .gte("created_at", iso(endMs - DAY))
          .lt("created_at", iso(endMs)),
      ),
    describe: (r) => `${r.observed} new drip steps queued in 24h. ${r.reason}`,
  },
  {
    // The dispatcher is dead: rows are DUE and nothing is claiming them. The
    // 2026-08-06 Vercel cron outage looked exactly like this for four days.
    id: "drips.email_due_unclaimed",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db
          .from("drip_runs")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("channel", "email")
          .eq("status", "scheduled")
          // An hour of slack: a row due 30 seconds ago is not a fault, it is
          // waiting for the next five-minute tick.
          .lt("scheduled_for", iso(endMs - HOUR)),
      ),
    describe: (r) =>
      `${r.observed} email rows are overdue by more than an hour — the dispatcher is not claiming them. ${r.reason}`,
  },
  {
    // Bluerise routed but silent. The brand had a warm domain, working
    // credentials, per-brand ceilings and 512 leads pointed at it, and had sent
    // exactly zero emails in its lifetime — invisible because every aggregate
    // check summed both brands together.
    id: "drips.bluerise_sent_24h",
    severity: "high",
    rule: { kind: "must_be_above", floor: 0 },
    observe: (db, tenantId, endMs) => countDripEmails(db, tenantId, endMs - DAY, endMs, "bluerise"),
    describe: (r) =>
      `${r.observed} Bluerise emails in 24h against a floor of ${targetBluerisePerDay()}. ${r.reason}`,
  },
  {
    // Attempted and refused. Volume without delivery is worse than silence
    // because it burns the domain while a send counter still looks healthy.
    //
    // TWO THINGS HERE WERE WRONG IN THE FIRST DRAFT, both caught by running the
    // check against production before merging rather than after:
    //
    // 1. It filtered on sent_at. EVERY failed row has sent_at = NULL — the
    //    column is stamped on success only — so the check counted zero forever
    //    and would have reported green through any outage. A decorative check
    //    is worse than no check, because it occupies the slot.
    //    claimed_at is the attempt timestamp and is populated on all 36.
    //
    // 2. must_be_zero over every failure would have paged on `suppressed
    //    (unsubscribed)`, which is the system CORRECTLY declining to email
    //    someone who opted out. Paging on correct behaviour is how a channel
    //    gets muted. Benign outcomes are excluded, everything else pages.
    //
    // What this would have caught: 10 rows of "Invalid login: 535-5.7.8" on
    // 2026-08-11 — a dead mailbox credential, silently eating drip sends.
    id: "drips.email_failures_24h",
    severity: "high",
    rule: { kind: "must_be_zero" },
    observe: (db, tenantId, endMs) => countRealFailures(db, tenantId, endMs - DAY, endMs),
    describe: (r) =>
      `${r.observed} email drip send(s) were attempted and refused in 24h (opt-out declines excluded). ${r.reason}`,
  },
];

/**
 * Runtime rules. The floors are read at evaluation time rather than baked into
 * the table above, so raising the ramp is an env change and not a deploy.
 *
 * email_silence_hours inverts: the observation is hours-since, so "healthy" is
 * BELOW the limit. Expressed as must_be_above on the remaining headroom.
 */
function ruleFor(check: DripCheck): CheckRule {
  switch (check.id) {
    case "drips.email_volume_vs_target": {
      // Below target is degraded; below a third of target is an outage. A ramp
      // that is merely behind should not page like a dead pipe — but it must
      // still be reported, which is the whole ask.
      //
      // This was must_be_above with a floor of target/3, which has no degraded
      // verdict: 30 against a target of 40 read as plain ok and said nothing.
      // Codex caught it in review. The rule that only knows "broken" cannot
      // answer "are we sending the volume we want".
      const target = targetEmailsPerDay();
      return { kind: "must_reach", target, failingBelow: Math.max(1, Math.floor(target / 3)) };
    }
    case "drips.email_silence_hours":
      return { kind: "must_be_below", ceiling: maxSilentHours() };
    case "drips.bluerise_sent_24h":
      return { kind: "must_be_above", floor: targetBluerisePerDay() };
    default:
      return check.rule;
  }
}

/**
 * The email-drip checks with runtime thresholds applied.
 *
 * A FUNCTION rather than a constant so every run re-reads the env. The ramp
 * moves weekly, and a monitor pinned to whatever the value happened to be at
 * process start would quietly grade against last week's target.
 */
export function emailDripChecks(): DripCheck[] {
  return CHECKS.map((c) => ({ ...c, rule: ruleFor(c) }));
}
