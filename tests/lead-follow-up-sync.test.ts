/**
 * tests/lead-follow-up-sync.test.ts — the follow-up state machine.
 *
 * The property every one of these exists to protect: A CALENDAR FAILURE MUST
 * NEVER COST THE FOLLOW-UP. The lead is the source of truth and Google is a
 * mirror, so `follow_up_at` has to survive every failure mode below. If one of
 * these ever goes red by dropping that field, a rep who promised a prospect a
 * Thursday callback silently has no Thursday anything.
 */

import assert from "node:assert/strict";
import {
  syncFollowUpReminder,
  isDueForRetry,
  nextAttemptAt,
  describeFollowUpSync,
  FOLLOW_UP_FIELDS,
  MAX_SYNC_ATTEMPTS,
  RETRY_BACKOFF_MINUTES,
  type FollowUpDeps,
} from "@/lib/leads/follow-up";
import type { ReminderFailure } from "@/lib/integrations/calendar-reminder";

const NOW = Date.parse("2026-08-25T12:00:00.000Z");
const AT = "2026-08-27T14:00:00.000Z";
const LEAD = {
  leadId: "lead-1",
  tenantId: "tenant-1",
  operatorUserId: "user-1",
  businessName: "Rosetti Plumbing",
  phone: "+15551234567",
  leadUrl: "https://app/pipeline/lead-1",
  timeZone: "America/Toronto",
};

async function main() {

const ok = (eventId: string, recreated = false): FollowUpDeps => ({
  write: async () => ({ ok: true, eventId, htmlLink: null, recreated }),
  remove: async () => ({ ok: true }),
});
const fails = (reason: ReminderFailure): FollowUpDeps => ({
  write: async () => ({ ok: false, reason, detail: `simulated ${reason}` }),
  remove: async () => ({ ok: false, reason, detail: `simulated ${reason}` }),
});

/* ---------------------------------------------------------- happy path */

{
  const out = await syncFollowUpReminder({
    lead: LEAD,
    followUpAt: AT,
    note: "asked for a callback Thursday",
    existingEventId: null,
    now: () => NOW,
    deps: ok("evt_1"),
  });
  assert.equal(out.state, "synced");
  assert.equal(out.message, null, "working as intended needs no announcement");
  assert.equal(out.patch[FOLLOW_UP_FIELDS.at], AT);
  assert.equal(out.patch[FOLLOW_UP_FIELDS.eventId], "evt_1");
  assert.equal(
    out.patch[FOLLOW_UP_FIELDS.operatorUserId],
    "user-1",
    "the retry worker needs to know whose calendar this belongs to",
  );
  assert.equal(out.patch[FOLLOW_UP_FIELDS.attempts], 0);
  assert.equal(out.patch[FOLLOW_UP_FIELDS.nextAttemptAt], null);
}

/* ------------------- THE CORE PROPERTY: failure never costs the follow-up */

for (const reason of ["retryable", "not_connected", "scope_required", "auth_failed", "rejected"] as const) {
  const out = await syncFollowUpReminder({
    lead: LEAD,
    followUpAt: AT,
    note: "asked for a callback Thursday",
    existingEventId: null,
    now: () => NOW,
    deps: fails(reason),
  });
  assert.equal(
    out.patch[FOLLOW_UP_FIELDS.at],
    AT,
    `the follow-up itself MUST survive a ${reason} failure -- it is the promise, the calendar is only a copy`,
  );
  assert.ok(out.message, `a ${reason} failure must be told to the operator, never swallowed`);
  assert.notEqual(out.state, "synced", `${reason} must never be reported as synced`);
  assert.equal(
    out.patch[FOLLOW_UP_FIELDS.note],
    "asked for a callback Thursday",
    "the note is snapshotted so a retry reproduces THIS reminder, not a drifted one",
  );
}

/* ---------------------------------------- retryable queues, blocked does not */

{
  const out = await syncFollowUpReminder({
    lead: LEAD,
    followUpAt: AT,
    note: "n",
    existingEventId: null,
    now: () => NOW,
    deps: fails("retryable"),
  });
  assert.equal(out.state, "pending", "a transport failure is worth retrying");
  assert.equal(out.patch[FOLLOW_UP_FIELDS.attempts], 1);
  assert.equal(
    out.patch[FOLLOW_UP_FIELDS.nextAttemptAt],
    new Date(NOW + RETRY_BACKOFF_MINUTES[0] * 60_000).toISOString(),
  );
}

for (const blocked of ["not_connected", "scope_required", "auth_failed", "rejected"] as const) {
  const out = await syncFollowUpReminder({
    lead: LEAD,
    followUpAt: AT,
    note: "n",
    existingEventId: null,
    now: () => NOW,
    deps: fails(blocked),
  });
  assert.equal(out.state, "blocked", `${blocked} needs a person, not a timer`);
  assert.equal(
    out.patch[FOLLOW_UP_FIELDS.nextAttemptAt],
    null,
    `${blocked} must NOT be queued: retrying it burns quota forever and never fixes the cause`,
  );
  assert.equal(out.patch[FOLLOW_UP_FIELDS.reason], blocked);
}

/* --------------------------------------------------- the ladder terminates */

{
  // One attempt short of the ceiling still queues.
  const nearly = await syncFollowUpReminder({
    lead: LEAD,
    followUpAt: AT,
    note: "n",
    existingEventId: null,
    attempts: MAX_SYNC_ATTEMPTS - 2,
    now: () => NOW,
    deps: fails("retryable"),
  });
  assert.equal(nearly.state, "pending");

  // At the ceiling it stops, rather than retrying forever in the background.
  const exhausted = await syncFollowUpReminder({
    lead: LEAD,
    followUpAt: AT,
    note: "n",
    existingEventId: null,
    attempts: MAX_SYNC_ATTEMPTS,
    now: () => NOW,
    deps: fails("retryable"),
  });
  assert.equal(exhausted.state, "blocked");
  assert.equal(exhausted.patch[FOLLOW_UP_FIELDS.reason], "retry_exhausted");
  assert.equal(exhausted.patch[FOLLOW_UP_FIELDS.nextAttemptAt], null);
  assert.equal(
    exhausted.patch[FOLLOW_UP_FIELDS.at],
    AT,
    "even after giving up on Google, the follow-up stays on the lead",
  );
}

assert.equal(nextAttemptAt(MAX_SYNC_ATTEMPTS, NOW), null, "the ladder must have an end");
assert.equal(
  nextAttemptAt(0, NOW),
  new Date(NOW + RETRY_BACKOFF_MINUTES[0] * 60_000).toISOString(),
);
for (let i = 1; i < RETRY_BACKOFF_MINUTES.length; i += 1) {
  assert.ok(
    RETRY_BACKOFF_MINUTES[i] > RETRY_BACKOFF_MINUTES[i - 1],
    "backoff must escalate, or it is just a tight loop with extra steps",
  );
}

/* ------------------------------------------------------------- clearing */

{
  const out = await syncFollowUpReminder({
    lead: LEAD,
    followUpAt: null,
    note: null,
    existingEventId: "evt_1",
    now: () => NOW,
    deps: ok("unused"),
  });
  assert.equal(out.state, "off");
  assert.equal(out.patch[FOLLOW_UP_FIELDS.at], null);
  assert.equal(
    out.patch[FOLLOW_UP_FIELDS.eventId],
    null,
    "a cleared reminder must drop its id, so the next push starts clean",
  );
}

{
  // Deleting failed, so the event MAY still be live. Keeping the id is the only
  // thing that lets anything clear it later; dropping it orphans the reminder.
  const out = await syncFollowUpReminder({
    lead: LEAD,
    followUpAt: null,
    note: null,
    existingEventId: "evt_1",
    now: () => NOW,
    deps: fails("retryable"),
  });
  assert.equal(
    out.patch[FOLLOW_UP_FIELDS.eventId],
    "evt_1",
    "a failed delete must KEEP the id: forgetting it strands a live alert on someone's phone",
  );
  assert.equal(out.state, "pending");
}

/* ------------------------------------------------------------ due-ness */

assert.equal(
  isDueForRetry(
    { [FOLLOW_UP_FIELDS.state]: "pending", [FOLLOW_UP_FIELDS.nextAttemptAt]: new Date(NOW - 1).toISOString() },
    NOW,
  ),
  true,
);
assert.equal(
  isDueForRetry(
    { [FOLLOW_UP_FIELDS.state]: "pending", [FOLLOW_UP_FIELDS.nextAttemptAt]: new Date(NOW + 60_000).toISOString() },
    NOW,
  ),
  false,
  "a record not yet due must not be retried early",
);
assert.equal(
  isDueForRetry(
    { [FOLLOW_UP_FIELDS.state]: "blocked", [FOLLOW_UP_FIELDS.nextAttemptAt]: new Date(NOW - 1).toISOString() },
    NOW,
  ),
  false,
  "blocked records are never picked up by the worker, whatever timestamp they carry",
);
assert.equal(isDueForRetry({ [FOLLOW_UP_FIELDS.state]: "pending" }, NOW), false);

/* -------------------------------------------------------------- wording */

assert.equal(describeFollowUpSync("synced"), null);
assert.equal(describeFollowUpSync("off"), null);
for (const reason of ["not_connected", "scope_required", "auth_failed", "retry_exhausted"] as const) {
  const line = describeFollowUpSync("blocked", reason);
  assert.ok(line && line.length > 0, `${reason} must have plain-language wording`);
  assert.match(
    line,
    /saved/i,
    "every failure line must lead with the fact the follow-up was kept, or a rep will re-enter it",
  );
}

console.log("lead-follow-up-sync.test.ts passed");

}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
