import assert from "node:assert/strict";
import {
  instantEnabled,
  maskEmail,
  skipToStatus,
  statusFromRow,
  type EnrollNowSkip,
} from "../lib/drips/immediate-core";
import { shouldApplyEmailWindow } from "../lib/drips/drip-rules-core";

/**
 * Outcome policy for the instant "Send Application" send (2026-07-30).
 *
 * The load-bearing property here is HONESTY: this path must never report 'sent'
 * for anything it did not verify, and must never report a status the system
 * cannot determine (there is no 'filtered' — Gmail returns 250 OK for mail it
 * files as spam, so placement is invisible from here).
 */

// ── The switch. Default ON, and independent of DRIPS_LIVE by design ─────────

assert.equal(instantEnabled({} as NodeJS.ProcessEnv), true, "unset means ON");
assert.equal(instantEnabled({ SEND_APPLICATION_INSTANT: "" } as NodeJS.ProcessEnv), true, "blank means ON");
assert.equal(instantEnabled({ SEND_APPLICATION_INSTANT: "0" } as NodeJS.ProcessEnv), false, "'0' disables");
assert.equal(instantEnabled({ SEND_APPLICATION_INSTANT: " 0 " } as NodeJS.ProcessEnv), false, "whitespace is trimmed");
assert.equal(
  instantEnabled({ SEND_APPLICATION_INSTANT: "1", DRIPS_LIVE: "0" } as NodeJS.ProcessEnv),
  true,
  "DRIPS_LIVE=0 does NOT disable the instant send (spec 4.4, deliberate)",
);

// ── Every skip reason maps to an explicit status ────────────────────────────
// No fallback: an unmapped skip silently reading as 'queued' is how a lead that
// will NEVER be mailed gets reported as merely waiting.

const ALL_SKIPS: EnrollNowSkip[] = [
  "no_sequence", "sequence_steps_invalid", "dead_or_declined", "opted_out",
  "paused", "docs_on_file", "no_contact_method", "already_enrolled",
  "shopped_recently", "accelerated_chase", "insert_failed",
];
for (const s of ALL_SKIPS) {
  const got = skipToStatus(s);
  assert.notEqual(got, "sent", `a skip must never map to 'sent': ${s}`);
}

assert.equal(skipToStatus("opted_out"), "skipped_suppressed", "opted out reads as suppressed to the rep");
assert.equal(skipToStatus("paused"), "skipped_paused", "paused is reported as paused");
assert.equal(skipToStatus("no_contact_method"), "skipped_no_email", "no contact is reported plainly");
assert.equal(skipToStatus("already_enrolled"), "duplicate", "a second Save reads as a duplicate");
assert.equal(
  skipToStatus("no_sequence"),
  "skipped_other",
  "no sequence means no row and no send, so it must not read as queued",
);

// ── Row read-back mapping ───────────────────────────────────────────────────
// dispatchRuns returns only coarse tallies, while suppression and the app-link
// halt are decided INSIDE processEmailStep and recorded on the row, so the row
// is read back.

assert.equal(statusFromRow({ status: "sent", last_error: null }), "sent", "a sent row is sent");
assert.equal(statusFromRow({ status: "done", last_error: null }), "sent", "a done row is sent");

assert.equal(
  statusFromRow({ status: "failed", last_error: "suppressed (unsubscribed)" }),
  "skipped_suppressed",
  "a suppression is reported as suppression, not as a generic failure",
);

assert.equal(
  statusFromRow({ status: "failed", last_error: "no_email_for_email_step" }),
  "skipped_no_email",
  "a missing address is reported plainly",
);

assert.equal(
  statusFromRow({ status: "failed", last_error: "smtp 550" }),
  "failed",
  "an unrecognised failure stays a failure",
);

// The exact strings executor.ts writes. Verified against lib/drips/executor.ts
// (lines 683, 810, 813, 867, 870, 1055) — matching invented text instead of
// these is how a halt silently degrades into a generic failure.
assert.equal(
  statusFromRow({ status: "scheduled", last_error: "missing_application_link (no form/HMAC key)" }),
  "held_no_app_link",
  "the 6h app-link HOLD is reported specifically",
);
assert.equal(
  statusFromRow({ status: "sent", last_error: "skipped: missing_application_link: skipped after retries (no form/HMAC key)" }),
  "held_no_app_link",
  "the app-link GIVE-UP is reported specifically, not as a generic failure (the row shape that actually occurs: status sent, prefixed last_error)",
);
assert.equal(
  statusFromRow({ status: "failed", last_error: "lead_opted_out_or_dead" }),
  "skipped_suppressed",
  "an opted-out lead reads as suppressed, not as a failure",
);
assert.equal(
  statusFromRow({ status: "failed", last_error: "opted_out (replied STOP)" }),
  "skipped_suppressed",
  "a STOP reply reads as suppressed",
);
assert.equal(
  statusFromRow({ status: "failed", last_error: "email_volume_gate (per_lead_weekly_cap)" }),
  "failed",
  "an unmatched reason stays a failure rather than being guessed at",
);

// ── last_error is never cleared, so on a TERMINAL row it is stale residue ───
// The 6h app-link hold can later succeed: the row sends via finishStep, which
// does not touch last_error. Reporting that as "held" would call a delivered
// email undelivered — the honesty contract failing in the opposite direction.
assert.equal(
  statusFromRow({ status: "sent", last_error: "missing_application_link (no form/HMAC key)" }),
  "sent",
  "REGRESSION GUARD: stale hold residue on a terminal row must not mask a real send",
);
assert.equal(
  statusFromRow({ status: "done", last_error: "blast_safety_check_failed(subject) - retrying" }),
  "sent",
  "stale retry residue on a terminal row must not mask a real send",
);

// ── but on a NON-terminal row, last_error IS the current reason ─────────────
assert.equal(
  statusFromRow({ status: "scheduled", last_error: "missing_application_link (no form/HMAC key)" }),
  "held_no_app_link",
  "the 6h app-link HOLD is non-terminal and unprefixed, and must still report the halt",
);
assert.equal(
  statusFromRow({ status: "failed", last_error: "suppressed (unsubscribed)" }),
  "skipped_suppressed",
  "a failed row's last_error is current, not stale",
);

// ── skipStep rows: terminal status, but nothing was sent ────────────────────
// advanceRow gives these the SAME 'sent'/'done' status as a real send. Reading
// status first is how a rep gets told "emailed" for mail that never left.
assert.equal(
  statusFromRow({ status: "sent", last_error: "skipped: no_email_for_email_step" }),
  "skipped_no_email",
  "THE FABRICATED-SEND BUG: a skipped row must never report sent",
);
assert.equal(
  statusFromRow({ status: "done", last_error: "skipped: missing_application_link: skipped after retries (no form/HMAC key)" }),
  "held_no_app_link",
  "the app-link give-up terminalizes as 'done' and must still report the halt",
);
assert.equal(
  statusFromRow({ status: "sent", last_error: "skipped: blast_safety_skipped(email): lender mention" }),
  "held_blocked_by_guard",
  "a compliance guard block is reported as a block, not as a send",
);
assert.equal(
  statusFromRow({ status: "sent", last_error: "skipped: some_future_reason_we_have_not_mapped" }),
  "skipped_other",
  "an unmapped skip says plainly that it was skipped rather than claiming sent",
);
assert.equal(
  statusFromRow({ status: "sent", last_error: null }),
  "sent",
  "a genuine send (no skip prefix) still reports sent",
);

assert.equal(
  statusFromRow({ status: "scheduled", last_error: "email_window (outside 8:00-20:00)" }),
  "queued",
  "a reschedule is queued, NEVER sent",
);

assert.equal(
  statusFromRow({ status: "sending", last_error: null }),
  "queued",
  "an in-flight row is queued, NEVER sent",
);

// No reachable input may yield 'sent' except a genuinely settled row.
for (const st of ["scheduled", "sending", "failed", "cancelled"]) {
  assert.notEqual(
    statusFromRow({ status: st, last_error: null }),
    "sent",
    `an unsettled row must never report sent: ${st}`,
  );
}

// ── from_identity: the swallowed-resend / forced-dry-run honesty fix ───────
// CRITICAL 1 (final whole-branch review): alreadySentStep's dedup backstop and
// a forced dry run both terminalize the row to 'sent'/'done' via finishStep,
// which does NOT set a "skipped: " prefix on last_error (advanceRow only adds
// that prefix via skippedReason, which finishStep never passes). Before this
// fix, statusFromRow's terminal check ran first and read BOTH cases as a
// genuine send, so sendApplicationNow's clamp (mapped === "sent" ? "queued" :
// mapped) turned them into "queued" — mail that was never sent and never
// would be, on a row already terminal so the cron never revisits it.
// from_identity is checked BEFORE the terminal/skip logic, using the exact
// prefixes executor.ts stamps: "dedup:<repKey>:<senderId>" /
// "dedup:submissions@sunbizfunding.com" for the backstop, and
// "dry:<repKey>:<senderId>" / "dry:submissions@sunbizfunding.com" for a
// forced dry run (see lib/drips/executor.ts lines ~402, 737, 740, 912, 939).
assert.equal(
  statusFromRow({ status: "done", last_error: null, from_identity: "dedup:submissions@sunbizfunding.com" }),
  "duplicate",
  "THE SWALLOWED-RESEND BUG: a dedup-backstopped terminal row must report duplicate, never sent/queued",
);
assert.equal(
  statusFromRow({ status: "sent", last_error: null, from_identity: "dedup:accel:12065551234" }),
  "duplicate",
  "the per-rep SMS dedup identity shape is recognized too (repKey:senderId)",
);
assert.equal(
  statusFromRow({ status: "done", last_error: null, from_identity: "dry:submissions@sunbizfunding.com" }),
  "disabled",
  "THE FORCED-DRY-RUN BUG: a dry-run terminal row must report disabled, never sent/queued",
);
assert.equal(
  statusFromRow({ status: "sent", last_error: null, from_identity: "dry:accel:12065551234" }),
  "disabled",
  "the per-rep SMS dry-run identity shape is recognized too",
);
// from_identity wins even over an unrelated stale last_error on the row —
// it is checked strictly before the skip-prefix / terminal logic.
assert.equal(
  statusFromRow({
    status: "sent",
    last_error: "email_volume_gate (per_lead_weekly_cap)",
    from_identity: "dedup:submissions@sunbizfunding.com",
  }),
  "duplicate",
  "from_identity is checked before stale last_error residue is consulted",
);
// REGRESSION GUARD: a genuine send stamps the row with the REAL sender
// address (executor.ts: fromIdentity = result.fromAddress on the real-send
// path), which starts with neither prefix — must still report sent.
assert.equal(
  statusFromRow({ status: "sent", last_error: null, from_identity: "submissions@sunbizfunding.com" }),
  "sent",
  "REGRESSION GUARD: a genuine send's real from_identity must still report sent",
);
assert.equal(
  statusFromRow({ status: "done", last_error: null, from_identity: null }),
  "sent",
  "a terminal row with no from_identity at all (older rows, or the SMS non-real-sender shape) still reports sent",
);
assert.equal(
  statusFromRow({ status: "sent", last_error: "skipped: no_email_for_email_step", from_identity: "dedup:submissions@sunbizfunding.com" }),
  "duplicate",
  "from_identity is checked strictly BEFORE the skip-prefix branch too (this combination doesn't occur in practice — finishStep never passes skippedReason — but the ordering must hold regardless of what last_error happens to carry)",
);

// ── maskEmail: PII-safe recipient surfaced in the 'sent' outcome (IMPORTANT 4) ─
// Never returns the full address. Never throws on malformed input.
assert.equal(maskEmail(""), "", "empty string masks to empty string, never throws");
assert.equal(maskEmail("acme@example.com"), "a***@example.com", "normal case: first char + *** + @domain verbatim");
assert.equal(maskEmail("a@acme.com"), "a***@acme.com", "single-character local part still masks correctly");
assert.equal(maskEmail("notanemail"), "n***", "a missing '@' masks the first character with no domain revealed");
assert.equal(maskEmail("@acme.com"), "***@acme.com", "an empty local part (leading '@') never crashes on undefined[0]");

// ── The forbidden status ────────────────────────────────────────────────────
// There is no test here: "filtered" is not a member of InstantEmailStatus, so
// tsc already makes it unconstructible from either skipToStatus or
// statusFromRow. Gmail spam placement is not observable over SMTP, and the
// type system is what enforces that this policy can never claim otherwise.

// ── The double-keyed window/volume gate (implemented in Task 1) ─────────────

assert.equal(
  shouldApplyEmailWindow({ immediate: true, emailClass: "transactional" }),
  false,
  "an operator-initiated transactional send is not held to the 8am-8pm window",
);
assert.equal(
  shouldApplyEmailWindow({ immediate: true, emailClass: "commercial" }),
  true,
  "THE SECOND KEY: an immediate COMMERCIAL send still respects the window",
);
assert.equal(
  shouldApplyEmailWindow({ immediate: false, emailClass: "transactional" }),
  true,
  "the cron path is unchanged, even for transactional mail",
);
assert.equal(
  shouldApplyEmailWindow({ immediate: false, emailClass: "commercial" }),
  true,
  "the ordinary drip case is unchanged",
);

console.log("send-application-core.test.ts — all assertions passed ✓");
