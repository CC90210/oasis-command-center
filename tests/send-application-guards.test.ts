import assert from "node:assert/strict";
import {
  isOptedOut,
  isTruthyFlag,
  staticSkipReason,
  isReEntryEligible,
} from "../lib/drips/drip-rules-core";

/**
 * Guard policy for the instant "Send Application" send (2026-07-30).
 *
 * The instant path calls the SAME guards the batch enroller calls. These
 * assertions pin the ones that must NEVER be bypassed for an operator-initiated
 * transactional email, plus the re-entry rule that stops a duplicate send once
 * the inline run has settled.
 */

const EMAIL_LEAD = { stage: "sent_application", email: "m@example.com" };

// ── Guards that must block an instant send ──────────────────────────────────

assert.equal(
  staticSkipReason({ ...EMAIL_LEAD, opted_out: true }, "sent_application", "email"),
  "opted_out",
  "an opted-out merchant must never receive the application email",
);

assert.equal(
  staticSkipReason({ ...EMAIL_LEAD, email_opt_out: true }, "sent_application", "email"),
  "opted_out",
  "a channel-specific email opt-out counts as opted out",
);

assert.equal(
  staticSkipReason({ ...EMAIL_LEAD, drip_paused: true }, "sent_application", "email"),
  "paused",
  "a human paused this lead; an operator action does not route around that",
);

assert.equal(
  staticSkipReason({ stage: "dead_file", email: "m@example.com" }, "dead_file", "email"),
  "dead_or_declined",
  "a dead file is never mailed",
);

assert.equal(
  staticSkipReason({ stage: "sent_application" }, "sent_application", "email"),
  "no_contact_method",
  "a lead with no phone and no email cannot be reached",
);

assert.equal(
  staticSkipReason({ stage: "sent_application", phone: "5551234567" }, "sent_application", "email"),
  "no_contact_method",
  "a phone-only lead cannot receive an EMAIL-first sequence",
);

// ── The clean case must pass ────────────────────────────────────────────────

assert.equal(
  staticSkipReason(EMAIL_LEAD, "sent_application", "email"),
  null,
  "a clean lead with an email address is eligible",
);

// ── docs_on_file is scoped to uw_sheet only, not to sent_application ────────

assert.equal(
  staticSkipReason({ ...EMAIL_LEAD, docs_on_file: true }, "sent_application", "email"),
  null,
  "docs_on_file must NOT block the application email; it gates uw_sheet only",
);
assert.equal(
  staticSkipReason({ stage: "uw_sheet", email: "m@example.com", docs_on_file: true }, "uw_sheet", "email"),
  "docs_on_file",
  "docs_on_file still gates the uw_sheet first touch (unchanged behaviour)",
);

// ── isOptedOut / isTruthyFlag, moved verbatim, pinned so the move is safe ───

assert.equal(isTruthyFlag("true"), true, "string 'true' is truthy");
assert.equal(isTruthyFlag(1), true, "number 1 is truthy");
assert.equal(isTruthyFlag("1"), true, "string '1' is truthy");
assert.equal(isTruthyFlag(false), false, "false is not truthy");
assert.equal(isTruthyFlag("no"), false, "an arbitrary string is not truthy");
assert.equal(isOptedOut({ stage: "opted_out" }), true, "the opted_out STAGE counts");
assert.equal(isOptedOut({ sms_opt_out: true }), true, "an sms opt-out counts");
assert.equal(isOptedOut({}), false, "an empty record is not opted out");

// ── Duplicate prevention, layer 2: the re-drip cooldown ─────────────────────
// Layer 1 is the partial unique index (DB). Layer 3 is alreadySentStep (executor).
// Layer 2 is the one that covers the window AFTER the inline run settles to
// 'done', where the partial index stops blocking and the batch enroller would
// otherwise re-enroll on its next 15-minute tick.

const DAY = 24 * 3_600_000;
const NOW = 1_800_000_000_000;
const COOLDOWN = 7 * DAY;

assert.equal(
  isReEntryEligible({
    lastRunAtMs: NOW - 3_600_000,
    stageEnteredAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    nowMs: NOW,
    cooldownMs: COOLDOWN,
  }),
  false,
  "THE DUPLICATE CASE: a run an hour ago must not re-enroll inside the cooldown",
);

assert.equal(
  isReEntryEligible({
    lastRunAtMs: NOW - 30 * DAY,
    stageEnteredAt: new Date(NOW - 60_000).toISOString(),
    nowMs: NOW,
    cooldownMs: COOLDOWN,
  }),
  true,
  "a genuine re-entry after the cooldown is eligible again",
);

console.log("send-application-guards.test.ts — all assertions passed ✓");
