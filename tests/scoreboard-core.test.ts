/**
 * tests/scoreboard-core.test.ts — the Drips-tab scoreboard must not turn "we
 * sent it" into "it arrived".
 *
 * Built after Adon could not find the 11 Live Subs texts on a 600-row table
 * (2026-08-20). The rollup is the fix for findability; these assertions are
 * about the thing that would make the rollup WORSE than no rollup — a big
 * green number over a route that is one third dead.
 *
 * The live numbers that day: 11 sent, and the carrier's own answer was 8
 * delivered / 3 failed. Any summary that reported "11 sent" as the headline
 * would have been accurate and useless.
 */

import assert from "node:assert/strict";
import { scoreSequences, verdictFor, type ScoredRun } from "../lib/drips/scoreboard-core";
import { isHeldForPolicy } from "../lib/drips/activity-core";

const sms = (over: Partial<ScoredRun> = {}): ScoredRun => ({
  status: "sent", from_identity: "ai_followup:+19703237557", channel: "sms",
  sent_at: "2026-08-19T18:01:30Z", last_error: null, ...over,
});

// ── THE LIVE SUBS CASE, exactly as it stood ───────────────────────────────
{
  const runs: ScoredRun[] = [
    ...Array.from({ length: 8 }, () => sms({ sequence_name: "Live Subs", carrier_status: "delivered", receipt_resolved_at: "2026-08-20T15:00:00Z" })),
    ...Array.from({ length: 3 }, () => sms({ sequence_name: "Live Subs", carrier_status: "failed", receipt_resolved_at: "2026-08-20T15:00:00Z" })),
  ];
  const [s] = scoreSequences(runs);
  assert.equal(s.sent, 11, "11 reached the provider");
  assert.equal(s.delivered, 8, "but only 8 reached a handset");
  assert.equal(s.failed, 3, "and 3 were refused by the carrier");
  assert.equal(s.unconfirmed, 0);
  assert.equal(verdictFor(s), "degraded", "any carrier failure must show as degraded, not ok");
}

// ── THE BLIND SPOT: sent, but no receipt ever resolved ────────────────────
// This is the state the AI wire was ACTUALLY in for two days. It must never
// read as healthy — that is the whole failure being designed out.
{
  const runs = Array.from({ length: 11 }, () =>
    sms({ sequence_name: "Live Subs", carrier_status: "unknown", receipt_resolved_at: null }));
  const [s] = scoreSequences(runs);
  assert.equal(s.sent, 11);
  assert.equal(s.delivered, 0, "nothing is confirmed");
  assert.equal(s.unconfirmed, 11, "and every one of them is explicitly unconfirmed");
  assert.equal(s.failed, 0, "unconfirmed is NOT failure — we do not know");
  assert.equal(verdictFor(s), "unconfirmed", "must not be 'ok': that is the two-day blind spot");
}

// A non-terminal receipt is not an answer, even with a status attached.
for (const [status, resolved] of [["pending", null], ["unknown", null], ["delivered", null]] as const) {
  const [s] = scoreSequences([sms({ sequence_name: "S", carrier_status: status, receipt_resolved_at: resolved })]);
  assert.equal(s.unconfirmed, 1, `${status}/unresolved must count as unconfirmed`);
  assert.equal(s.delivered, 0, "an unresolved receipt must never be counted as delivered");
}

// ── EMAIL HAS NO CARRIER RECEIPT, so delivered must be NULL, not sent ─────
// Copying `sent` into `delivered` would claim an observation we never made.
{
  const runs: ScoredRun[] = Array.from({ length: 5 }, () => ({
    status: "sent", from_identity: "Bluerise <x@y.com>", channel: "email",
    sent_at: "2026-08-20T12:00:00Z", last_error: null, sequence_name: "Bluerise follow-up",
  }));
  const [s] = scoreSequences(runs);
  assert.equal(s.channel, "email");
  assert.equal(s.sent, 5);
  assert.equal(s.delivered, null, "email delivery is not observable here; NULL, never a number");
  assert.equal(s.unconfirmed, 0, "and it must not be reported as a blind spot either");
  assert.equal(verdictFor(s), "ok");
}

// ── Holds are policy working, not failures ────────────────────────────────
// Counting a consent gate as an error makes a healthy compliance stop look like
// an outage, and trains whoever reads this to ignore the red number.
{
  const runs: ScoredRun[] = [
    sms({ sequence_name: "S", status: "failed", from_identity: null, last_error: "suppressed (unsubscribed)" }),
    sms({ sequence_name: "S", carrier_status: "delivered", receipt_resolved_at: "2026-08-20T15:00:00Z" }),
  ];
  const [s] = scoreSequences(runs);
  assert.equal(s.held, 1, "the suppression is a hold");
  assert.equal(s.failed, 0, "and NOT a failure");
  assert.equal(s.delivered, 1);
}

// ── 'sent' with no from_identity never reached a provider ─────────────────
// 864 of 1,348 rows were in this state on 2026-08-10. Counting them as sent is
// the original sin this whole surface exists to correct.
{
  const [s] = scoreSequences([sms({ sequence_name: "S", from_identity: null })]);
  assert.equal(s.sent, 0);
  assert.equal(s.skipped, 1);
}

// ── enabled is TRISTATE: an unmatched sequence is unknown, not off ────────
{
  const runs = [sms({ sequence_name: "Known" }), sms({ sequence_name: "Orphan" })];
  const scores = scoreSequences(runs, new Map([["Known", false]]));
  const known = scores.find((s) => s.sequenceName === "Known")!;
  const orphan = scores.find((s) => s.sequenceName === "Orphan")!;
  assert.equal(known.enabled, false);
  assert.equal(orphan.enabled, null, "unmatched must be null; rendering it as 'off' misreports a live sequence");
}

// ── Queued rows are counted, not silently dropped ─────────────────────────
// The 111 phone-only follow-ups sat in exactly this state.
{
  const runs = [
    sms({ sequence_name: "S", status: "scheduled", from_identity: null, sent_at: null, scheduled_for: "2026-08-21T16:20:00Z" }),
    sms({ sequence_name: "S", carrier_status: "delivered", receipt_resolved_at: "2026-08-20T15:00:00Z" }),
  ];
  const [s] = scoreSequences(runs);
  assert.equal(s.queued, 1);
  assert.equal(s.sent, 1);
  assert.equal(s.lastActivityAt, "2026-08-21T16:20:00Z", "a future send is still the latest thing on the sequence");
}

// ── Unnamed runs are dropped, never bucketed into a neighbour ─────────────
assert.equal(scoreSequences([sms({ sequence_name: null })]).length, 0);
assert.equal(scoreSequences([sms({ sequence_name: "   " })]).length, 0);

// ── Ordering: most recently active first ──────────────────────────────────
{
  const scores = scoreSequences([
    sms({ sequence_name: "Old", sent_at: "2026-08-01T00:00:00Z", carrier_status: "delivered", receipt_resolved_at: "x" }),
    sms({ sequence_name: "New", sent_at: "2026-08-20T00:00:00Z", carrier_status: "delivered", receipt_resolved_at: "x" }),
  ]);
  assert.deepEqual(scores.map((s) => s.sequenceName), ["New", "Old"]);
}

// ── verdictFor thresholds ─────────────────────────────────────────────────
{
  const base = {
    sequenceName: "s", channel: "sms" as const, enabled: true,
    queued: 0, held: 0, skipped: 0, carrierFailed: 0, lastActivityAt: null,
  };
  assert.equal(verdictFor({ ...base, sent: 0, delivered: 0, failed: 0, unconfirmed: 0 }), "idle");
  assert.equal(verdictFor({ ...base, sent: 9, delivered: 9, failed: 0, unconfirmed: 0 }), "ok");

  // A pre-provider failure was never counted in `sent`, so it adds to the
  // denominator.
  assert.equal(
    verdictFor({ ...base, sent: 1, delivered: 1, failed: 1, carrierFailed: 0, unconfirmed: 0 }),
    "failing", "1 sent + 1 never-sent = 50%",
  );
  assert.equal(
    verdictFor({ ...base, sent: 9, delivered: 9, failed: 1, carrierFailed: 0, unconfirmed: 0 }),
    "degraded", "one failure is never ok",
  );
}

// ── CODEX P2 #1: a carrier failure must not be counted twice ──────────────
// It is already inside `sent`, so `sent + failed` inflates the denominator and
// DEFLATES the failure rate — the difference between "Some failures" and
// "Failing" on the card an operator is reading.
{
  const base = {
    sequenceName: "s", channel: "sms" as const, enabled: true,
    queued: 0, held: 0, skipped: 0, lastActivityAt: null,
  };
  // Codex's example: 2 carrier-failed, 1 delivered. Three texts reached the
  // provider; two died. That is 67%, not 40%.
  const s = { ...base, sent: 3, delivered: 1, failed: 2, carrierFailed: 2, unconfirmed: 0 };
  assert.equal(verdictFor(s), "failing", "2 of 3 texts refused is FAILING, not merely degraded");

  // And the rate is honest at the boundary: 1 of 3 is 33%, still degraded.
  assert.equal(
    verdictFor({ ...base, sent: 3, delivered: 2, failed: 1, carrierFailed: 1, unconfirmed: 0 }),
    "degraded",
  );

  // Mixed causes: one never reached the provider, one the carrier refused.
  // Denominator = 2 sent + 1 pre-provider = 3; failures = 2 → 67%.
  assert.equal(
    verdictFor({ ...base, sent: 2, delivered: 1, failed: 2, carrierFailed: 1, unconfirmed: 0 }),
    "failing",
  );
}

// ── CODEX P2 #2: a confirmed minority must not paint the card green ───────
{
  const base = {
    sequenceName: "s", channel: "sms" as const, enabled: true,
    queued: 0, held: 0, skipped: 0, carrierFailed: 0, lastActivityAt: null,
  };
  // Codex's example: 1 delivered, 10 unknown. Previously fell through to `ok`
  // because `delivered !== 0`.
  assert.equal(
    verdictFor({ ...base, sent: 11, delivered: 1, failed: 0, unconfirmed: 10 }),
    "unconfirmed", "mostly-unknown must never read as Delivering",
  );
  // Nothing confirmed at all — the original blind spot.
  assert.equal(
    verdictFor({ ...base, sent: 11, delivered: 0, failed: 0, unconfirmed: 11 }),
    "unconfirmed",
  );
  // But a short unconfirmed TAIL behind a confirmed majority is reconciliation
  // latency, not a blind spot: a receipt is not looked at for 90 seconds and
  // the cron runs every 15 minutes, so a healthy sequence always has its most
  // recent sends unconfirmed. Permanent amber is a card people stop reading.
  assert.equal(
    verdictFor({ ...base, sent: 10, delivered: 9, failed: 0, unconfirmed: 1 }),
    "ok", "a recent unconfirmed tail behind a confirmed majority is latency",
  );
  assert.equal(
    verdictFor({ ...base, sent: 10, delivered: 5, failed: 0, unconfirmed: 5 }),
    "ok", "exactly half unconfirmed is the boundary and stays ok",
  );
  // Email has no receipts, so unconfirmed is structurally 0 and this never fires.
  assert.equal(
    verdictFor({ ...base, channel: "email" as never, sent: 10, delivered: null, failed: 0, unconfirmed: 0 }),
    "ok",
  );
}

// ── THE POLICY / FAILURE SPLIT, against REAL production strings ───────────
// Every string below was read out of drip_runs.last_error on 2026-08-20. The
// split decides what the red number on the tab means, and a red number that is
// mostly opt-outs being honoured correctly is a red number people learn to
// ignore — which is how the actual carrier failures sat unnoticed for two days.
{
  const POLICY = [
    'skipped: sms_no_lawful_basis: no consent record and "mca webforms may 25-29" is not an inbound source',
    "suppressed (unsubscribed)",
    "tcpa_unresolved_tz (area code unmapped)",
    "quiet_hours (local 7:00 AM America/Chicago)",
    "email_window (outside 8:00-20:00 America/New_York)",
    "email_volume_gate (bluerise/follow_up: daily_cap)",
    "email_volume_gate (sunbiz/viewed_application: hourly_cap)",
    "sms_hourly_cap (6/6)",
    "sms_channel_unavailable: Bluerise has no SMS numbers yet - holding rather than texting as SunBiz",
  ];
  for (const e of POLICY) {
    assert.equal(isHeldForPolicy(e), true, `must read as a HOLD, not a failure: ${e.slice(0, 60)}`);
  }

  // These are real and must stay red. sms_carrier_halt especially: it is the
  // breaker announcing an outage, and amber would bury the one signal that
  // says the route is dead.
  const REAL = [
    "skipped: sms_delivery_failed_after_retries: http_422: Validation Error",
    "skipped: delivery_failed: sms_delivery_failed_after_retries: http_422: Validation Error",
    "lead_not_found",
    "http_500: Chat not found",
    "skipped: sms_delivery_failed_after_retries: rate_limiter_unavailable: (0 , f.getServiceSup",
    "sms_carrier_halt: 19 consecutive carrier failures - the send route is not delivering",
  ];
  for (const e of REAL) {
    assert.equal(isHeldForPolicy(e), false, `must stay a FAILURE: ${e.slice(0, 60)}`);
  }
  assert.equal(isHeldForPolicy(null), false);
  assert.equal(isHeldForPolicy(""), false);
}

// ── A STALE last_error must not erase a real send ─────────────────────────
// The executor does not clear last_error when a later attempt succeeds, so
// rows that DID send still carry the reason they were once held. Measured
// 2026-08-20: 17 sent rows carried email_window, 11 carried tcpa_unresolved_tz,
// 70+ carried email_volume_gate. Checking the hold before the outcome would
// file all of them as "held" and under-report sends on the one screen built to
// report sends.
{
  const runs: ScoredRun[] = [
    sms({ sequence_name: "S", last_error: "quiet_hours (local 7:00 AM America/Chicago)",
          carrier_status: "delivered", receipt_resolved_at: "2026-08-20T15:00:00Z" }),
    sms({ sequence_name: "S", status: "done", last_error: "tcpa_unresolved_tz (area code unmapped)",
          carrier_status: "delivered", receipt_resolved_at: "2026-08-20T15:00:00Z" }),
  ];
  const [s] = scoreSequences(runs);
  assert.equal(s.sent, 2, "both reached a provider despite carrying a stale hold reason");
  assert.equal(s.delivered, 2);
  assert.equal(s.held, 0, "a hold that was later overcome is not a hold");
}

// ── MIXED sequences: receipts are a PER-ROW concept ───────────────────────
// Several live sequences send both. "Follow-up sequence" ran 221 emails and
// 106 texts in the same week. Deciding from the sequence's aggregate channel
// filed all 140 of its sends under `unconfirmed` — for the email majority that
// is not a blind spot, because email has no carrier receipt to be missing. An
// amber number that means nothing teaches people that amber means nothing.
{
  const runs: ScoredRun[] = [
    ...Array.from({ length: 20 }, () => ({
      status: "sent", from_identity: "Bluerise <x@y.com>", channel: "email",
      sent_at: "2026-08-20T12:00:00Z", last_error: null, sequence_name: "Mixed",
    })),
    sms({ sequence_name: "Mixed", carrier_status: "delivered", receipt_resolved_at: "2026-08-20T15:00:00Z" }),
    sms({ sequence_name: "Mixed", carrier_status: "failed", receipt_resolved_at: "2026-08-20T15:00:00Z" }),
    sms({ sequence_name: "Mixed", carrier_status: "unknown", receipt_resolved_at: null }),
  ];
  const [s] = scoreSequences(runs);
  assert.equal(s.channel, "mixed");
  assert.equal(s.sent, 23, "every send counts, both channels");
  assert.equal(s.delivered, 1, "only the text with a delivered receipt");
  assert.equal(s.failed, 1, "only the text the carrier refused");
  assert.equal(s.unconfirmed, 1, "ONLY the text without a verdict — never the 20 emails");
}

// A sequence with no SMS send at all must report delivered as NULL, not 0.
// Zero would read as "nothing was delivered" on an email sequence that
// delivered perfectly well.
{
  const [s] = scoreSequences([{
    status: "sent", from_identity: "Bluerise <x@y.com>", channel: "email",
    sent_at: "2026-08-20T12:00:00Z", last_error: null, sequence_name: "EmailOnly",
  }]);
  assert.equal(s.delivered, null);
}
// ...and a mixed sequence whose only text was HELD (never sent) also has no
// receipt to report.
{
  const [s] = scoreSequences([
    { status: "sent", from_identity: "Bluerise <x@y.com>", channel: "email",
      sent_at: "2026-08-20T12:00:00Z", last_error: null, sequence_name: "M2" },
    sms({ sequence_name: "M2", status: "failed", from_identity: null, last_error: "suppressed (unsubscribed)" }),
  ]);
  assert.equal(s.delivered, null, "a held text never reached a carrier, so there is nothing to confirm");
  assert.equal(s.held, 1);
}

console.log("scoreboard-core.test.ts — all assertions passed");
