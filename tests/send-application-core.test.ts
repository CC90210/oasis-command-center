import assert from "node:assert/strict";
import {
  instantEnabled,
  skipToStatus,
  statusFromRow,
  type EnrollNowSkip,
  type InstantEmailStatus,
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
  assert.ok(typeof got === "string" && got.length > 0, `every skip maps to a status: ${s}`);
  assert.notEqual(got, "sent", `a skip must never map to 'sent': ${s}`);
}

assert.equal(skipToStatus("opted_out"), "skipped_suppressed", "opted out reads as suppressed to the rep");
assert.equal(skipToStatus("paused"), "skipped_paused", "paused is reported as paused");
assert.equal(skipToStatus("no_contact_method"), "skipped_no_email", "no contact is reported plainly");
assert.equal(skipToStatus("already_enrolled"), "duplicate", "a second Save reads as a duplicate");

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
  statusFromRow({ status: "scheduled", last_error: "no application link (mint failed)" }),
  "held_no_app_link",
  "an app-link halt is reported specifically, not as 'queued'",
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

// ── The forbidden status ────────────────────────────────────────────────────

const REACHABLE: InstantEmailStatus[] = [
  ...ALL_SKIPS.map(skipToStatus),
  statusFromRow({ status: "sent", last_error: null }),
  statusFromRow({ status: "failed", last_error: "suppressed" }),
  statusFromRow({ status: "scheduled", last_error: null }),
];
for (const s of REACHABLE) {
  assert.notEqual(s, "filtered", "'filtered' is not observable over SMTP and must never be reported");
}

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
