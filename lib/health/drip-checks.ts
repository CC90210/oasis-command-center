/**
 * lib/health/drip-checks.ts — the outcome checks for the drip estate.
 *
 * Each check is a query against a table the feature already writes, so a
 * feature nobody remembered to instrument is still covered. The rules live in
 * checks-core.ts and are pure; this file is the I/O.
 *
 * Every check here is derived from a REAL failure observed on 2026-08-06:
 * SMS had been dead for three weeks and email for a day, and the existing
 * watchdog (9 local PM2 processes, 8 of them liveness-only, zero Vercel
 * coverage) reported healthy throughout.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { evaluate, type CheckResult, type CheckRule } from "./checks-core";

type Db = ReturnType<typeof getServiceSupabase>;

export type DripCheck = {
  id: string;
  severity: "critical" | "high" | "medium";
  rule: CheckRule;
  /** Observed value for a window ending at `endMs`. Returns null if the query
   *  itself failed — which evaluate() reports as check_broken, never as ok. */
  observe: (db: Db, tenantId: string, endMs: number) => Promise<number | null>;
  describe: (r: CheckResult) => string;
};

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * When delivery receipts started being written.
 *
 * sms.receipt_coverage compares sends against receipts. Sends that went out
 * BEFORE this code shipped have no receipt and never will, so without a floor
 * the check fires red the moment it deploys and pages about history rather than
 * about a fault. A monitor whose first act is a false alarm is one people learn
 * to ignore, which is the failure this whole subsystem exists to prevent.
 *
 * Self-expiring: once the deploy is more than 24h old the clamp stops binding.
 */
const RECEIPTS_LIVE_FROM_MS = Date.parse("2026-08-08T00:00:00Z");

async function countOrNull(q: PromiseLike<{ error: unknown; count: number | null }>): Promise<number | null> {
  try {
    const r = await q;
    if (r.error) return null;
    return r.count ?? 0;
  } catch {
    return null;
  }
}

export const DRIP_CHECKS: DripCheck[] = [
  {
    // THE check that would have caught the SMS outage on day one, and the one
    // that is impossible to fake: a row claiming it sent, with no provider id
    // and a recorded delivery failure.
    id: "sms.sent_without_proof",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("drip_runs").select("id", { count: "exact", head: true })
          // 'done' as well as 'sent': a sequence-final SMS lands as 'done', and
          // a delivery failure on the LAST step is no less invisible than one
          // in the middle.
          .eq("tenant_id", tenantId).eq("channel", "sms").in("status", ["sent", "done"])
          .is("provider_message_id", null).like("last_error", "delivery_failed:%")
          .gte("created_at", iso(endMs - DAY)).lt("created_at", iso(endMs)),
      ),
    describe: (r) =>
      `${r.observed} SMS row(s) marked sent with no provider message id and a recorded delivery failure. ` +
      `These did NOT reach anyone. This exact condition hid a three-week outage.`,
  },
  {
    id: "sms.delivered_24h",
    severity: "critical",
    rule: { kind: "baseline_drop", failingBelowPct: 0.25, degradedBelowPct: 0.6 },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("lead_interactions").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("type", "sms_sent").eq("direction", "outbound")
          .gte("created_at", iso(endMs - DAY)).lt("created_at", iso(endMs)),
      ),
    describe: (r) => `SMS sends in the last 24h: ${r.observed} (normal ${r.baseline}). ${r.reason}`,
  },
  {
    id: "email.sent_24h",
    severity: "critical",
    rule: { kind: "baseline_drop", failingBelowPct: 0.25, degradedBelowPct: 0.6 },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("lead_interactions").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("type", "email_sent").eq("direction", "outbound")
          .gte("created_at", iso(endMs - DAY)).lt("created_at", iso(endMs)),
      ),
    describe: (r) => `Emails sent in the last 24h: ${r.observed} (normal ${r.baseline}). ${r.reason}`,
  },
  {
    // THE check for the 2026-07-27 outage: the carrier's own verdict. 51
    // consecutive API sends were refused over ten days while every row read
    // 'sent', because nothing compared what we sent against what arrived.
    // must_be_zero on FAILURES rather than a rate, so a low-volume day cannot
    // dilute a dead route into looking merely quiet.
    id: "sms.carrier_failures_24h",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("sms_delivery_receipts").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("carrier_status", "failed")
          .gte("sent_at", iso(endMs - DAY)).lt("sent_at", iso(endMs)),
      ),
    describe: (r) =>
      `${r.observed} SMS rejected by the carrier in the last 24h. These were billed and did NOT arrive. ` +
      `TextTorrent returns HTTP 201 on exactly these, so no other signal shows them.`,
  },
  {
    // Receipts are the instrument. If sends stop producing them, the instrument
    // is broken and every other SMS check silently reads clean — the precise
    // shape of failure this whole subsystem exists to prevent.
    id: "sms.receipt_coverage",
    severity: "high",
    rule: { kind: "must_be_zero" },
    observe: async (db, tenantId, endMs) => {
      // Never look back past the day receipts began. Both sides use the same
      // clamped start so the comparison stays like-for-like.
      const startMs = Math.max(endMs - DAY, RECEIPTS_LIVE_FROM_MS);
      if (startMs >= endMs) return 0; // window fully predates instrumentation
      // Counted against DRIP sends only, not every outbound SMS. Reps send far
      // more by hand than the drip engine does (530 vs 113 on 2026-08-07) and
      // those never open a receipt, so comparing against all sms_sent traffic
      // would leave this check permanently red. A check that is always failing
      // is one nobody reads, which is the alert-fatigue failure this subsystem
      // exists to prevent.
      //
      // Two exclusions, both explicit on purpose:
      //   from_identity NULL  — the row was ADVANCED, never sent. Measured
      //     2026-08-07: 864 of 1,348 'sent' rows, of which a 400-row sample was
      //     100% skips ("no_email_for_email_step",
      //     "sms_delivery_failed_after_retries") and 0% carried a provider id.
      //   from_identity "dry:%" — a rehearsal under DRIPS_LIVE unset.
      // `NULL NOT LIKE 'dry:%'` is NULL in SQL, so a single not-like would have
      // dropped the first group silently. Relying on that would be the same
      // accident this file exists to catch, so both are stated.
      const sent = await countOrNull(
        db.from("drip_runs").select("id", { count: "exact", head: true })
          // BOTH terminal statuses. advanceRow writes `isLast ? "done" : "sent"`,
          // so every sequence-final SMS lands as 'done' — 84 of 568 real sends
          // over 60 days, 15%. Keyed on 'sent' alone this check ignored all of
          // them, and a one-step SMS sequence would leave both sides of the
          // comparison at zero: perfectly healthy-looking, entirely unmeasured.
          .eq("tenant_id", tenantId).eq("channel", "sms").in("status", ["sent", "done"])
          .not("from_identity", "is", null)
          .not("from_identity", "like", "dry:%")
          // Bounded on sent_at, NOT created_at. A drip row is created when the
          // step is scheduled and sent much later: measured 2026-08-07, 91 of
          // 200 sampled sends had a gap over 24h, the widest 171h. Keyed on
          // created_at this check would have ignored roughly half of all real
          // sends while receipts were counted on their true send time, so it
          // could read "no missing receipts" over a total outage.
          .gte("sent_at", iso(startMs)).lt("sent_at", iso(endMs)),
      );
      const receipts = await countOrNull(
        db.from("sms_delivery_receipts").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .gte("sent_at", iso(startMs)).lt("sent_at", iso(endMs)),
      );
      if (sent === null || receipts === null) return null;
      return Math.max(0, sent - receipts);
    },
    describe: (r) =>
      `${r.observed} drip SMS send(s) in the last 24h have no delivery receipt. ` +
      `Those sends are unverifiable: we cannot tell whether they arrived.`,
  },
  {
    // A backlog that stops draining is the shape of a stalled dispatcher, and
    // it is visible before output drops to zero.
    id: "drips.overdue_backlog",
    severity: "high",
    rule: { kind: "must_be_above", floor: -1 }, // never fails on its own; the digest reports it
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("drip_runs").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("status", "scheduled").lt("scheduled_for", iso(endMs)),
      ),
    describe: (r) => `${r.observed} drip row(s) are past their scheduled time.`,
  },

  // ---------------------------------------------------------------------------
  // Shopping out.
  //
  // Every check above watches merchant outreach. Until 2026-08-11 not one of
  // them watched the lender side, so shop-out was physically dead from
  // 2026-08-06 and the monitoring reported green the whole time. These are the
  // checks that would have caught it, written against the conditions that
  // actually occurred rather than the ones that seemed likely.
  // ---------------------------------------------------------------------------
  {
    // THE check for the 2026-08-11 outage. Six lender packages were queued at
    // 14:38Z, the dispatch failed, and the rows sat at pending with last_error
    // NULL — indistinguishable from "still sending" to anything that only
    // looked at status. A pending thread is a deal that is not in front of a
    // lender; after 30 minutes that is never in-flight, it is stuck.
    //
    // Deliberately NOT keyed on last_error being set: the whole failure mode
    // was that nothing wrote one. Age in the pending state is the signal that
    // cannot be suppressed by a caller forgetting to record something.
    id: "shopout.threads_stuck_pending",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("application_lender_threads").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("status", "pending")
          .lt("created_at", iso(endMs - 30 * 60_000)),
      ),
    describe: (r) =>
      `${r.observed} lender thread(s) queued more than 30 minutes ago and still not sent. ` +
      `These deals are NOT in front of a lender. Open Shopping Out and use Retry, ` +
      `or check the bridge — this is the exact state that hid the 2026-08-06 outage for five days.`,
  },
  {
    // The un-fakeable one, mirroring sms.sent_without_proof. A thread at 'sent'
    // is a claim; the receipt is send_interaction_id — the lead_interactions row
    // that send_gateway wrote when it actually handed the message to SMTP.
    // _mark_sent() in shop_out_sender.py writes both in a single update, so a
    // row carrying the claim without the receipt means something moved the
    // status with no send behind it.
    //
    // NOT gmail_thread_id, which was the obvious choice and is wrong: the
    // sender only sets it when a provider returns a real Gmail threadId, and
    // the SMTP path never does. It is null on 55 of 55 sent threads. A check
    // written against it would have gone red on 100% of history the moment it
    // deployed — the false-alarm-on-arrival failure this file warns about two
    // checks up. send_interaction_id is populated on 55 of 55. Verified against
    // production before shipping, which is the only reason the difference
    // surfaced.
    //
    // Bounded to a trailing week so one bad historical row cannot pin it red.
    id: "shopout.sent_without_proof",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("application_lender_threads").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("status", "sent")
          .is("send_interaction_id", null)
          .gte("created_at", iso(endMs - 7 * DAY)).lt("created_at", iso(endMs)),
      ),
    describe: (r) =>
      `${r.observed} lender thread(s) marked sent with no send_interaction_id. ` +
      `The status claims a send that left no receipt behind it.`,
  },
  {
    // The reply side, which is worth as much as the send side: an approval that
    // nobody reads is a dead deal. The classifier reads submissions@ and moves
    // threads off 'sent' — so a pile of threads sitting at 'sent' for days with
    // no movement means the classifier is not doing its job, whether it is down,
    // orphaned by a scheduler, or locked out of the mailbox.
    //
    // On 2026-08-11 this stood at 55 threads untouched since 2026-08-05, because
    // scan-lender-replies was left out of the GitHub Actions cron driver when
    // Vercel's scheduler died.
    id: "shopout.replies_unclassified",
    severity: "high",
    rule: { kind: "must_be_zero" },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("application_lender_threads").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("status", "sent")
          .lt("updated_at", iso(endMs - 3 * DAY)),
      ),
    describe: (r) =>
      `${r.observed} lender thread(s) have sat at 'sent' for over 3 days with no reply classified. ` +
      `Lender approvals and declines may be piling up unread in submissions@. ` +
      `Check that scan-lender-replies is running and that the mailbox credential is live.`,
  },
];

/**
 * Run one check across a trailing history so it has a baseline to judge against.
 * `historyDays` samples are taken as consecutive 24h windows ending at `nowMs`.
 */
export async function runCheck(
  db: Db,
  tenantId: string,
  check: DripCheck,
  nowMs: number,
  historyDays = 14,
): Promise<CheckResult> {
  const observed = await check.observe(db, tenantId, nowMs);
  const history: number[] = [];
  if (check.rule.kind === "baseline_drop") {
    // Skip the most recent window: including the outage in its own baseline is
    // how a slow decline normalises itself into invisibility.
    for (let d = 1; d <= historyDays; d++) {
      const v = await check.observe(db, tenantId, nowMs - d * DAY);
      if (v !== null) history.push(v);
    }
  }
  return evaluate(check.id, check.rule, observed, history);
}
