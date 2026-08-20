/**
 * lib/drips/scoreboard-core.ts — per-sequence rollup for the Drips tab.
 *
 * WHY THIS EXISTS. Adon, 2026-08-20: "I don't even see the eleven ones that you
 * texted." They WERE on the tab — rows 18 through 52 of a flat, ~600-row,
 * seven-day table with a sequence dropdown. Present and unfindable are the same
 * thing to an operator. The activity table answers "show me every step"; nothing
 * answered "is each sequence working", which is the question actually being
 * asked when someone opens this screen.
 *
 * TWO RULES, BOTH LEARNED THE HARD WAY.
 *
 * 1. SENT IS NOT DELIVERED, and this file will not let the screen conflate
 *    them. TextTorrent returns 201 for a message the carrier then refuses. On
 *    2026-08-20 the Live Subs sequence read as 11 sent; asked directly, the
 *    carrier said 8 delivered and 3 FAILED. A scoreboard that showed "11 sent"
 *    would have been a green light over a route that was one third dead.
 *    So for SMS the headline is the carrier's verdict, and everything without a
 *    terminal receipt is counted as `unconfirmed` — never folded into either
 *    column. Email has no carrier receipt at all, so `delivered` is NULL there
 *    rather than a copy of `sent`: claiming delivery we cannot observe is the
 *    same lie in the other direction.
 *
 * 2. A partial read must say so. Both halves of the activity query are capped,
 *    and on 2026-08-20 both were genuinely over the cap (643 open, 498 done
 *    against 300 each). Counts over a truncated sample are a floor, and a floor
 *    rendered as a total is how "nothing was sent" and "we only looked at some
 *    of it" become indistinguishable.
 */

import { classifyRunStatus, isHeldForPolicy, type RunShape } from "./activity-core";

/** A drip_runs row plus the carrier verdict for it, when one exists. */
export type ScoredRun = RunShape & {
  id?: string | null;
  sequence_name?: string | null;
  channel?: string | null;
  sent_at?: string | null;
  scheduled_for?: string | null;
  /** Not on RunShape (which only needs status + from_identity to classify), but
   *  required here to tell a policy hold from a real failure. */
  last_error?: unknown;
  /** From sms_delivery_receipts, joined on drip_run_id. Absent for email and
   *  for any SMS whose receipt has not resolved yet. */
  carrier_status?: string | null;
  /** Null while the reconciler has not reached a terminal answer. */
  receipt_resolved_at?: string | null;
};

export type SequenceScore = {
  sequenceName: string;
  channel: "sms" | "email" | "mixed" | "unknown";
  /** Null when the sequence row could not be matched — unknown, not "off". */
  enabled: boolean | null;
  /** Scheduled ahead, nothing sent yet. */
  queued: number;
  /** Handed to a provider. The denominator, and NOT a success count. */
  sent: number;
  /**
   * Carrier-confirmed delivered. NULL for email, which has no receipt: a
   * number here would be an unearned claim.
   */
  delivered: number | null;
  /** Carrier-failed, or the run itself failed before a provider took it. */
  failed: number;
  /** Sent, but no terminal carrier verdict yet. SMS only. */
  unconfirmed: number;
  /** Consent / no-channel holds. Policy working, not an error. */
  held: number;
  /** Advanced without ever reaching a provider. */
  skipped: number;
  lastActivityAt: string | null;
};

function channelOf(rows: ScoredRun[]): SequenceScore["channel"] {
  const set = new Set(rows.map((r) => String(r.channel ?? "").toLowerCase()).filter(Boolean));
  if (set.size === 0) return "unknown";
  if (set.size > 1) return "mixed";
  const only = [...set][0];
  return only === "sms" || only === "email" ? only : "unknown";
}

/** Terminal carrier verdicts. Anything else (including 'unknown' and 'pending')
 *  is NOT an answer and must not be counted as one. */
function verdict(r: ScoredRun): "delivered" | "failed" | null {
  const s = String(r.carrier_status ?? "").toLowerCase();
  if (!r.receipt_resolved_at) return null;
  if (s === "delivered") return "delivered";
  if (s === "failed" || s === "undelivered") return "failed";
  return null;
}

function laterOf(a: string | null, b: string | null | undefined): string | null {
  const bb = b ?? null;
  if (!a) return bb;
  if (!bb) return a;
  return Date.parse(bb) > Date.parse(a) ? bb : a;
}

/**
 * Roll runs up per sequence.
 *
 * `enabledByName` comes from drip_sequences. A name missing from it yields
 * `enabled: null` — an unmatched sequence is unknown, and rendering unknown as
 * "off" would tell an operator a live sequence is stopped.
 */
export function scoreSequences(
  runs: ScoredRun[],
  enabledByName: Map<string, boolean> = new Map(),
): SequenceScore[] {
  const bySeq = new Map<string, ScoredRun[]>();
  for (const r of runs) {
    const name = String(r.sequence_name ?? "").trim();
    if (!name) continue; // an unnamed run cannot be attributed; counting it anywhere is a guess
    const list = bySeq.get(name) ?? [];
    list.push(r);
    bySeq.set(name, list);
  }

  const out: SequenceScore[] = [];
  for (const [sequenceName, rows] of bySeq) {
    const channel = channelOf(rows);
    // Receipts are a PER-ROW concept, not a per-sequence one. Several live
    // sequences are `mixed` — "Follow-up sequence" ran 221 emails and 106 texts
    // in the same week. Deciding from the sequence's aggregate channel filed
    // all 140 of its sends under `unconfirmed`, which for the email majority is
    // not a blind spot at all: email has no carrier receipt to be missing.
    // A meaningless amber number is worse than none, because it teaches people
    // that amber means nothing.
    let smsSent = 0;
    const score: SequenceScore = {
      sequenceName,
      channel,
      enabled: enabledByName.has(sequenceName) ? !!enabledByName.get(sequenceName) : null,
      queued: 0, sent: 0, delivered: 0,
      failed: 0, unconfirmed: 0, held: 0, skipped: 0, lastActivityAt: null,
    };

    for (const r of rows) {
      const status = classifyRunStatus(r);

      if (status === "scheduled" || status === "sending") {
        score.queued++;
        score.lastActivityAt = laterOf(score.lastActivityAt, r.scheduled_for);
        continue;
      }
      score.lastActivityAt = laterOf(score.lastActivityAt, r.sent_at ?? r.scheduled_for);

      if (status === "dry_run" || status === "cancelled" || status === "unknown") continue;

      // OUTCOME FIRST, then the reason. `last_error` is not cleared when a
      // later attempt succeeds, so a row that was quiet-houred at 07:00 and
      // sent at 09:00 still carries `quiet_hours`. Measured 2026-08-20: rows
      // with status 'sent'/'done' carried email_window (17), tcpa_unresolved_tz
      // (11) and email_volume_gate (70+). Reading the hold before the status
      // would file every one of those under "held" and quietly delete a real
      // send from the count — an under-report on the one screen that exists to
      // say what went out.
      if (status !== "failed" && status !== "skipped") {
        // status === "sent": it reached a provider.
        score.sent++;
        // Only SMS has a carrier receipt. An email row is complete at "sent";
        // asking what the carrier said about it is a question with no answer,
        // and bucketing it as `unconfirmed` invents a blind spot.
        if (String(r.channel ?? "").toLowerCase() !== "sms") continue;
        smsSent++;
        const v = verdict(r);
        if (v === "delivered") score.delivered!++;
        else if (v === "failed") score.failed++;
        else score.unconfirmed++;
        continue;
      }

      // It did NOT send. Now the reason decides whether that was the rules
      // working or something breaking.
      if (isHeldForPolicy(r.last_error)) { score.held++; continue; }
      if (status === "failed") { score.failed++; continue; }
      score.skipped++;
      continue;

    }
    // NULL, not 0, when there was no SMS send to have a receipt for. Zero would
    // read as "nothing was delivered" on an email sequence that delivered fine.
    if (smsSent === 0) score.delivered = null;
    out.push(score);
  }

  // Most recently active first: the sequence someone is asking about is nearly
  // always the one that just moved.
  out.sort((a, b) => {
    const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    if (bt !== at) return bt - at;
    return a.sequenceName.localeCompare(b.sequenceName);
  });
  return out;
}

/**
 * The one-line verdict for a sequence card.
 *
 * Deliberately conservative: anything we cannot see is "unknown", never "ok".
 * The 2026-08-20 incident is precisely a case where an optimistic default would
 * have painted a dead route green.
 */
export type ScoreVerdict = "failing" | "degraded" | "unconfirmed" | "idle" | "ok";

/**
 * What the Drips tab receives.
 *
 * Declared HERE rather than beside the query because client components import
 * it, and the query module is "server-only" — a type-only import from it works
 * right up until someone reaches for a value and the build breaks in a way that
 * has nothing to do with what they changed.
 */
export type ScoreboardResult = {
  scores: SequenceScore[];
  days: number;
  /** True when the read hit its ceiling, so every count is a FLOOR. */
  truncated: boolean;
  /** Set when a read failed. "Nothing sent" and "we could not find out" must
   *  never render alike. */
  error: string | null;
};

export function verdictFor(s: SequenceScore): ScoreVerdict {
  const attempted = s.sent + s.failed;
  if (attempted === 0) return s.queued > 0 ? "idle" : "idle";
  const failRate = s.failed / attempted;
  if (failRate >= 0.5) return "failing";
  if (s.failed > 0) return "degraded";
  // Everything sent, nothing confirmed, and this is a channel that HAS
  // receipts. That is not success — it is the blind spot that hid three
  // carrier failures for two days.
  if (s.delivered !== null && s.delivered === 0 && s.unconfirmed > 0) return "unconfirmed";
  return "ok";
}
