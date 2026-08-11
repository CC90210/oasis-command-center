/**
 * tests/drip-activity.test.ts — a row that ADVANCED is not a row that SENT.
 *
 * Measured 2026-08-10: 1,348 sms rows read status='sent'; only 484 carried a
 * real from_identity. The other 864 advanced without contacting a provider — a
 * 400-row sample was 100% skips and 0% carried a provider id.
 *
 * So a surface that renders `status` verbatim tells an operator 1,348 messages
 * went out when 484 did, and computes a failure rate against a denominator that
 * is two-thirds fiction. That is the same untruth as the ten-day SMS outage,
 * one layer up. These assertions are what stop the Drips tab repeating it.
 */

import assert from "node:assert/strict";
import { classifyRunStatus, summarizeFailures, isHeldForPolicy, outcomeWindow } from "../lib/drips/activity-core";

// ── from_identity is the discriminator, not status ────────────────────────
assert.equal(classifyRunStatus({ status: "sent", from_identity: "alex:+13055550147" }), "sent");
assert.equal(classifyRunStatus({ status: "sent", from_identity: null }), "skipped");
assert.equal(classifyRunStatus({ status: "sent", from_identity: "" }), "skipped");
assert.equal(classifyRunStatus({ status: "sent", from_identity: "dry:alex:+13055550147" }), "dry_run");

// 'done' is the sequence-FINAL equivalent of 'sent' — advanceRow writes
// `isLast ? "done" : "sent"`. Reading only 'sent' silently drops every last
// step, which was 84 of 568 real sends over 60 days.
assert.equal(classifyRunStatus({ status: "done", from_identity: "alex:+13055550147" }), "sent");
assert.equal(classifyRunStatus({ status: "done", from_identity: null }), "skipped");

assert.equal(classifyRunStatus({ status: "failed", from_identity: null }), "failed");
assert.equal(classifyRunStatus({ status: "cancelled", from_identity: null }), "cancelled");
assert.equal(classifyRunStatus({ status: "scheduled", from_identity: null }), "scheduled");
assert.equal(classifyRunStatus({ status: "sending", from_identity: null }), "sending");
// Never guess in our favour: an unrecognised status is not a send.
assert.equal(classifyRunStatus({ status: "something_new", from_identity: "alex:+1" }), "unknown");
assert.equal(classifyRunStatus({}), "unknown");

// ── The failure rate needs an honest denominator ──────────────────────────
{
  const s = summarizeFailures([
    { status: "sent", from_identity: "a:1" },
    { status: "failed", from_identity: null },
    { status: "sent", from_identity: null },      // a skip
    { status: "sent", from_identity: "dry:a:1" }, // a rehearsal
  ]);
  assert.equal(s.realSends, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.dryRun, 1);
  // 1 failed of (1 sent + 1 failed) = 50%. Counting the skip and the dry run
  // would report 25% and flatter a channel that is half broken.
  assert.equal(s.failureRatePct, 50);
}

// The real production shape: mostly skips. The rate must reflect the sends.
{
  const rows = [
    ...Array.from({ length: 864 }, () => ({ status: "sent", from_identity: null })),
    ...Array.from({ length: 484 }, () => ({ status: "sent", from_identity: "alex:+1" })),
  ];
  const s = summarizeFailures(rows);
  assert.equal(s.realSends, 484, "only the rows that addressed a provider count as sends");
  assert.equal(s.skipped, 864);
  assert.equal(s.failureRatePct, 0);
}

// ── An empty sample is UNKNOWN, never healthy ─────────────────────────────
// "0% failure" from nothing reads as green and is exactly the false comfort
// this whole subsystem exists to remove.
assert.equal(summarizeFailures([]).failureRatePct, null);
assert.equal(summarizeFailures([{ status: "scheduled", from_identity: null }]).failureRatePct, null);

// ── A policy hold is not a failure ────────────────────────────────────────
// Folding deliberate holds into the failure rate would make a working
// compliance gate look like an outage, which trains an operator to ignore the
// number — the same alert-fatigue failure the health system exists to avoid.
assert.equal(isHeldForPolicy("sms_no_lawful_basis: no consent record"), true);
assert.equal(isHeldForPolicy("unreachable: lead has neither an email address nor a phone number"), true);
assert.equal(isHeldForPolicy("sms_channel_unavailable: Bluerise has no SMS numbers yet"), true);
assert.equal(isHeldForPolicy("sms_provider_not_wired: twilio has no sender"), true);
// A genuine delivery failure is NOT a policy hold and must still count.
assert.equal(isHeldForPolicy("delivery_failed: 535 auth"), false);
assert.equal(isHeldForPolicy(null), false);
assert.equal(isHeldForPolicy(""), false);

// -- The window is measured on OUTCOME time -------------------------------
// Codex review 2026-08-11: the summary filtered on scheduled_for, so a step
// queued four days ago and retried until it sent this morning fell outside a
// 24h window -- sends invisible on the tab built to show sends.
//
// The naive fix is worse. markSent is the ONLY writer of sent_at, so filtering
// on sent_at alone reports zero failures however many there were. Both halves
// have to be present or the number is a lie in one direction or the other.
{
  const w = outcomeWindow("2026-08-10T00:00:00.000Z");
  assert.ok(w.includes("sent_at.gte.2026-08-10T00:00:00.000Z"), "sends must be counted by when they SENT");
  assert.ok(
    w.includes("and(sent_at.is.null,scheduled_for.gte.2026-08-10T00:00:00.000Z)"),
    "rows with no sent_at -- every failure, and everything still pending -- must still fall in the window",
  );
  // No stray whitespace: PostgREST parses this string positionally and a space
  // inside the or= list is a 400, which the page would surface as a read error.
  assert.equal(w.trim(), w);
  assert.ok(!/\s/.test(w), "a space anywhere in the or= filter makes PostgREST reject the query");
}

console.log("drip-activity.test.ts — all assertions passed");
