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
import type { TelegramLane } from "@/lib/notify/telegram";

type Db = ReturnType<typeof getServiceSupabase>;

export type DripCheck = {
  id: string;
  severity: "critical" | "high" | "medium";
  rule: CheckRule;
  /**
   * Who gets paged. Omitted means `sunbiz-ops`, which is where every check in
   * this file belongs and where all of them went before this field existed.
   *
   * It exists because the runner hardcoded that lane, and the estate stopped
   * being only SunBiz: an OASIS check added in #334 would have announced an
   * OASIS booking outage into the SunBiz ops channel — the client's lane, for a
   * product they do not operate. Wrong-audience alerts are ignored alerts, and
   * an ignored alert is the same as no alert.
   */
  lane?: TelegramLane;
  /** Observed value for a window ending at `endMs`. Returns null if the query
   *  itself failed — which evaluate() reports as check_broken, never as ok. */
  observe: (db: Db, tenantId: string, endMs: number) => Promise<number | null>;
  /**
   * Rebuild the rule at EVALUATION time.
   *
   * DRIP_CHECKS is a module-level const, so a threshold computed inside `rule`
   * is frozen at import. For a target an operator is expected to move, that
   * means the check keeps grading against a stale number while reporting green
   * — the same shape as every other bug found on 2026-08-20. Supplying this
   * makes the threshold live.
   */
  resolveRule?: () => CheckRule;
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

/**
 * The daily drip-text target. Adon set this to 40 on 2026-08-20.
 *
 * Read from env at CALL time, not at module load, so the number can move
 * without a deploy — and so a list of checks captured at process start cannot
 * keep grading against a stale target while reporting green.
 */
export function smsTargetPerDay(): number {
  const n = parseInt((process.env.DRIPS_SMS_DAILY_TARGET || "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 40;
}

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
    /**
     * THE CHECK THAT WOULD HAVE CAUGHT 2026-08-16 ON DAY ONE.
     *
     * sms.receipt_coverage above verifies receipts are CREATED. Nothing
     * verified they are RESOLVED, and that is precisely what broke: from
     * 2026-08-16 the reconciler could no longer match our message inside the
     * provider's thread (TextTorrent stopped returning the `platform` field we
     * were gating on), so every receipt was opened, never answered, and quietly
     * retired as 'unknown' three days later.
     *
     * 47 receipts reached a real carrier verdict between 08-07 and 08-16. From
     * 08-16 to 08-20: zero. Coverage stayed green the whole time, because the
     * receipts existed. They were just empty.
     *
     * This matters far beyond reporting. smsSendAllowed() reads these same
     * receipts, so with nothing ever resolving the circuit breaker could not
     * open no matter how many sends died — the guard was inert while looking
     * healthy. Three carrier failures on a live wire went unnoticed for two
     * days underneath it.
     *
     * Six hours of grace: the reconciler runs every 15 minutes and ignores
     * anything younger than 90 seconds, so a healthy pipeline resolves well
     * inside an hour. Six is generous enough that a transient provider outage
     * does not page, and tight enough that a broken matcher is caught the same
     * working day.
     */
    id: "sms.receipts_unresolved",
    severity: "high",
    rule: { kind: "must_be_zero" },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("sms_delivery_receipts").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .is("resolved_at", null)
          // Older than the grace window...
          .lt("sent_at", iso(endMs - 6 * 3_600_000))
          // ...but inside the retirement cutoff. Past three days the reconciler
          // force-resolves as 'unknown', so anything older cannot be counted
          // here and this check would silently read zero during a total outage.
          .gte("sent_at", iso(endMs - 3 * DAY)),
      ),
    describe: (r) =>
      `${r.observed} delivery receipt(s) have gone more than 6h without a carrier verdict. ` +
      `The receipts exist but are empty, so every SMS check above is reading an instrument ` +
      `that is not measuring anything — and the send breaker cannot open, because it reads these.`,
  },
  {
    /**
     * Verify CONTRIBUTION, not presence: is the reconciler actually producing
     * verdicts, or merely running?
     *
     * The count above catches a full stop. This catches the partial case — a
     * matcher that resolves some threads and silently drops the rest — which
     * would otherwise sit under the grace window forever, always a few rows
     * short of alarming.
     *
     * Measured over receipts old enough to have been answered. Returns null
     * when there is nothing in the window, and evaluate() reports that as
     * check_broken rather than a pass: no sample is not the same as a clean
     * one, and "no texts went out" is a finding in its own right that
     * drips.enrolments_24h and sms.delivered_24h already speak to.
     */
    id: "sms.carrier_verdict_rate",
    severity: "high",
    rule: { kind: "must_reach", target: 95, failingBelow: 80 },
    observe: async (db, tenantId, endMs) => {
      const startMs = Math.max(endMs - 3 * DAY, RECEIPTS_LIVE_FROM_MS);
      const cutoff = iso(endMs - 6 * 3_600_000);
      if (startMs >= endMs - 6 * 3_600_000) return null;
      const total = await countOrNull(
        db.from("sms_delivery_receipts").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).gte("sent_at", iso(startMs)).lt("sent_at", cutoff),
      );
      const answered = await countOrNull(
        db.from("sms_delivery_receipts").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).gte("sent_at", iso(startMs)).lt("sent_at", cutoff)
          // A REAL verdict. 'unknown' is what a retired receipt carries, so
          // counting it would let the three-day give-up path masquerade as
          // successful reconciliation — the exact outage, reported as health.
          .in("carrier_status", ["delivered", "failed", "undelivered"]),
      );
      if (total === null || answered === null) return null;
      if (total === 0) return null;
      return Math.round((answered / total) * 100);
    },
    describe: (r) =>
      `${r.observed}% of delivery receipts older than 6h carry a real carrier verdict. ` +
      `Below this, sends are going out unverified and the breaker is running on partial evidence.`,
  },
  {
    /**
     * IS THE TEXT PROGRAMME ACTUALLY HITTING ITS NUMBER?
     *
     * Adon, 2026-08-20: "it should be at 40 a day - how can we ensure this
     * happens."
     *
     * You cannot ensure it by setting the cap to 40. The cap is a CEILING and
     * has never been the binding constraint: measured that day, sends ran at
     * 2 to 17 a day against a cap already set to 40, while 1,269 leads had a
     * phone number, 4 were landlines and none had opted out. Raising a ceiling
     * nobody was touching changes nothing.
     *
     * What ensures it is measuring the gap and saying so. Every reason volume
     * falls short is diagnosable and none of them announce themselves:
     *   - too few working lines (six of twelve were dead and nobody knew)
     *   - enrolment starved, so the queue has nothing due
     *   - the deal gate closing more leads than expected
     *   - sequence step delays spacing sends further apart than the target
     *
     * DEGRADED below target, FAILING below a third of it. A programme merely
     * behind should not page like a dead pipe, but it must still be visible —
     * that is the whole ask.
     */
    id: "sms.sent_vs_target",
    severity: "high",
    // Placeholder; the live threshold comes from resolveRule below.
    rule: { kind: "must_reach", target: 40, failingBelow: 13 },
    resolveRule: () => ({
      kind: "must_reach",
      target: smsTargetPerDay(),
      failingBelow: Math.max(1, Math.floor(smsTargetPerDay() / 3)),
    }),
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("lead_interactions").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("type", "sms_sent")
          .eq("direction", "outbound")
          // Sequence sends only. Reps send far more by hand than the engine
          // does, and counting those would show a healthy number while the
          // drip programme sat at zero.
          .like("agent_source", "sequence:%")
          .gte("created_at", iso(endMs - DAY)).lt("created_at", iso(endMs)),
      ),
    describe: (r) =>
      `${r.observed} drip texts in 24h against a target of ${smsTargetPerDay()}. ` +
      `The cap is a ceiling, not a source: check working lines, enrolment, and the deal gate before raising it.`,
  },
  {
    /**
     * THE PHONE-LOOKUP QUEUE HAS A DRAINER, AND IT STOPS.
     *
     * Found 2026-08-20 while working out why texting cannot reach 40/day: the
     * last completed lookup was 2026-08-05 and one job had been pending since
     * 08-12, 197 hours. Nobody knew. The queue is FILLED in the cloud on a
     * 10-minute cron but DRAINED by a worker on a single desktop, so the two
     * halves fail independently and only the filling half is visible anywhere.
     *
     * This matters far beyond tidiness. 1,099 leads at SMS-relevant stages have
     * never had a lookup, and the numbers those leads gave us are mostly office
     * landlines (0 delivered / 53 failed). A working lookup queue is the only
     * route from those leads to a textable mobile, so a dead drainer is a hard
     * ceiling on drip volume that looks exactly like "not many leads today".
     *
     * Measured in HOURS since the oldest pending job was created, so a queue
     * that is filling but not draining fails even while enrolment reports
     * healthy. 24h is generous for a worker that normally turns a job around in
     * minutes.
     */
    id: "leads.phone_lookup_stalled",
    severity: "high",
    rule: { kind: "must_be_below", ceiling: 24 },
    observe: async (db, tenantId, endMs) => {
      const r = await db
        .from("phone_lookup_jobs")
        .select("created_at")
        .eq("tenant_id", tenantId)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(1);
      if (r.error) return null;
      const oldest = r.data?.[0]?.created_at;
      // An EMPTY queue is healthy, not unmeasurable: nothing is waiting.
      if (!oldest) return 0;
      const ms = endMs - Date.parse(oldest);
      return Number.isFinite(ms) ? Math.round(ms / 3_600_000) : null;
    },
    describe: (r) =>
      `the oldest un-drained phone lookup has been waiting ${r.observed}h. ` +
      `The queue fills in the cloud but drains on one desktop worker, so this fails ` +
      `silently and caps how many leads can ever become textable.`,
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
    //
    // This remains the backstop even now that recordDispatchFailure moves a
    // failed dispatch to 'error'. That handler only runs if the route lives
    // long enough to run it; a serverless function killed at its maxDuration,
    // or a deploy mid-request, leaves rows at pending with nothing recorded.
    // That is precisely the case with no other witness, so the check that
    // needs no cooperation from the failing code path is the one worth having.
    //
    // Age is measured from updated_at, NOT created_at. Both retry routes move a
    // thread back to pending and stamp updated_at while leaving created_at at
    // the original queue time, so a created_at window reports every retried
    // thread as critically stuck the instant the operator clicks Retry — on a
    // deal that is legitimately in flight. updated_at is the time it entered
    // its CURRENT state, which is the thing being measured. On a first send the
    // two are equal, so nothing is lost. (Codex review, 2026-08-11.)
    id: "shopout.threads_stuck_pending",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("application_lender_threads").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("status", "pending")
          .lt("updated_at", iso(endMs - 30 * 60_000)),
      ),
    describe: (r) =>
      `${r.observed} lender thread(s) queued more than 30 minutes ago and still not sent. ` +
      `These deals are NOT in front of a lender. Open Shopping Out and use Retry, ` +
      `or check the bridge — this is the exact state that hid the 2026-08-06 outage for five days.`,
  },
  {
    // The un-fakeable one, mirroring sms.sent_without_proof. A thread at 'sent'
    // is a claim; a receipt is the evidence. A row carrying the claim with NO
    // receipt of any kind means something moved the status with no send behind
    // it.
    //
    // The two send paths write DIFFERENT receipts, and this check has been
    // wrong about it twice:
    //
    //   sunbiz  — send_gateway via the VPS sender. _mark_sent() writes
    //             send_interaction_id (the lead_interactions row). It sets
    //             gmail_thread_id only when a provider returns a real Gmail
    //             threadId, which the SMTP path never does: null on 55 of 55.
    //   funmate — direct SMTP in the retry route. Writes gmail_thread_id and
    //             last_message_id from the RFC822 message id, and never
    //             send_interaction_id. Exactly inverse.
    //
    // So keying on either column ALONE false-alarms on 100% of the other
    // path's traffic. The first draft used gmail_thread_id (red on every
    // sunbiz send); the second used send_interaction_id (red on every funmate
    // send, caught by Codex review 2026-08-11). Requiring that SOME receipt
    // exists is identity-agnostic, needs no branch on email_identity, and stays
    // correct if a third sender arrives — provided it records something.
    //
    // Bounded to a trailing week so one bad historical row cannot pin it red —
    // measured on sent_at, the moment the claim was made, NOT created_at. A
    // thread queued three weeks ago and retried into 'sent' today is exactly
    // the unsupported claim this check exists to find, and a created_at window
    // would exclude it permanently. Same mistake as the one fixed in
    // threads_stuck_pending two entries up: a row's age is not the age of the
    // state it is in. (Codex review, 2026-08-11.)
    id: "shopout.sent_without_proof",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("application_lender_threads").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("status", "sent")
          .is("send_interaction_id", null)
          .is("gmail_thread_id", null)
          .gte("sent_at", iso(endMs - 7 * DAY)).lt("sent_at", iso(endMs)),
      ),
    describe: (r) =>
      `${r.observed} lender thread(s) marked sent with no receipt of any kind — neither a ` +
      `send_interaction_id (SunBiz) nor a message id (FundMate). The status claims a send that ` +
      `left no evidence behind it.`,
  },
  {
    // The reply side, which is worth as much as the send side: an approval that
    // nobody reads is a dead deal.
    //
    // The obvious check — "threads at 'sent' with no movement for N days" — is
    // WRONG, and the first draft of this shipped it at N=3. A lender that
    // simply has not replied leaves its thread at 'sent' by design; 898 rows
    // sit at 'no_response' precisely because that is normal and the SLA sweep
    // eventually retires them. A 3-day window therefore alerts on every quiet
    // lender, which is routine business, not an outage. (Codex review,
    // 2026-08-11.)
    //
    // What IS an invariant: the sweep retires a thread at 10 days with
    // "SLA 10d exceeded". A thread still sitting at 'sent' well past that
    // window means the sweep itself did not run — a real fault, and one that
    // cannot be produced by lender behaviour no matter how quiet they are.
    // 14 days gives the sweep four days of grace before this speaks.
    //
    // Honest limitation: this lags. It would not have caught the 2026-08-06
    // classifier stall until 2026-08-17. The right instrument for that is a
    // run-heartbeat on the classifier itself, which does not exist yet and is
    // tracked as follow-up. A late true signal beats a prompt false one.
    id: "shopout.sla_sweep_stalled",
    severity: "high",
    rule: { kind: "must_be_zero" },
    observe: (db, tenantId, endMs) =>
      countOrNull(
        db.from("application_lender_threads").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId).eq("status", "sent")
          .lt("sent_at", iso(endMs - 14 * DAY)),
      ),
    describe: (r) =>
      `${r.observed} lender thread(s) are still 'sent' more than 14 days after dispatch, past the ` +
      `10-day SLA sweep that should have retired them. The sweep or the reply classifier is not ` +
      `running — check scan-lender-replies and the submissions@ mailbox credential.`,
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
  // A live threshold beats the one captured at import. See DripCheck.resolveRule.
  const rule = check.resolveRule ? check.resolveRule() : check.rule;
  const history: number[] = [];
  if (rule.kind === "baseline_drop") {
    // Skip the most recent window: including the outage in its own baseline is
    // how a slow decline normalises itself into invisibility.
    for (let d = 1; d <= historyDays; d++) {
      const v = await check.observe(db, tenantId, nowMs - d * DAY);
      if (v !== null) history.push(v);
    }
  }
  return evaluate(check.id, rule, observed, history);
}
