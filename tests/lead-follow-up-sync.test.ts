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
import { readFileSync } from "node:fs";
import {
  syncFollowUpReminder,
  isDueForRetry,
  nextAttemptAt,
  describeFollowUpSync,
  planReminderOwnership,
  workerQueueFlag,
  isStrandedDue,
  WORKER_QUEUE_ON,
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

/* ------------------------------------------------- handover of ownership */

{
  // Nothing stored yet: create fresh, nothing to hand over.
  const plan = planReminderOwnership({
    existingEventId: null,
    storedOperatorUserId: null,
    currentOperatorUserId: "user-1",
  });
  assert.deepEqual(plan, { removeAs: null, pushWithEventId: null });
}

{
  // Same operator: move their own event, do not create a second one.
  const plan = planReminderOwnership({
    existingEventId: "evt_1",
    storedOperatorUserId: "user-1",
    currentOperatorUserId: "user-1",
  });
  assert.deepEqual(plan, { removeAs: null, pushWithEventId: "evt_1" });
}

{
  // THE ONE THAT MATTERS. The lead changed hands, or an admin is scheduling on
  // someone else's lead. Google addresses events per-calendar, so patching this
  // id through the NEW operator would 404, create a second event, and overwrite
  // the id -- stranding a live reminder on the old rep's phone with nothing
  // able to clear it. Delete it as its owner, then create fresh.
  const plan = planReminderOwnership({
    existingEventId: "evt_1",
    storedOperatorUserId: "user-1",
    currentOperatorUserId: "user-2",
  });
  assert.equal(
    plan.removeAs,
    "user-1",
    "the old event must be deleted as the operator who owns it, not the one clicking",
  );
  assert.equal(
    plan.pushWithEventId,
    null,
    "the new operator must get a FRESH event: the old id is not addressable on their calendar",
  );
}

/* ----------------------------- the worker queue: two jobs, one scan key
 *
 * The cron finds work by ONE equality filter. If either job can clear the flag
 * while the other still owes something, that work becomes unreachable: the
 * record is never scanned again, nothing retries, and nothing alerts.
 */

assert.equal(
  workerQueueFlag({ syncState: "pending", strandedEventId: null }),
  WORKER_QUEUE_ON,
  "a pending sync must stay findable",
);
assert.equal(
  workerQueueFlag({ syncState: "synced", strandedEventId: null }),
  null,
  "nothing outstanding means nothing to scan",
);
assert.equal(
  workerQueueFlag({ syncState: "off", strandedEventId: null }),
  null,
);

for (const terminal of ["synced", "off", "blocked"] as const) {
  assert.equal(
    workerQueueFlag({ syncState: terminal, strandedEventId: "evt_old" }),
    WORKER_QUEUE_ON,
    `a stranded event must keep the record findable even when the sync is "${terminal}" -- ` +
      "clearing a reassigned lead's follow-up, or handing it to a rep with no Google connection, " +
      "must not leave the previous rep's phone ringing with no worker able to touch it",
  );
}

/* ------------------------------- stranded cleanup runs on its own clock */

assert.equal(
  isStrandedDue({}, NOW),
  false,
  "nothing stranded, nothing to do",
);
assert.equal(
  isStrandedDue(
    { [FOLLOW_UP_FIELDS.strandedEventId]: "evt_old" },
    NOW,
  ),
  false,
  "an id with no owner cannot be deleted from anyone's calendar",
);
assert.equal(
  isStrandedDue(
    {
      [FOLLOW_UP_FIELDS.strandedEventId]: "evt_old",
      [FOLLOW_UP_FIELDS.strandedOperatorUserId]: "user-1",
    },
    NOW,
  ),
  true,
  "never attempted yet must mean due NOW: a missing clock read as 'never run' is how the exhausted case vanished",
);
assert.equal(
  isStrandedDue(
    {
      [FOLLOW_UP_FIELDS.strandedEventId]: "evt_old",
      [FOLLOW_UP_FIELDS.strandedOperatorUserId]: "user-1",
      [FOLLOW_UP_FIELDS.strandedNextAttemptAt]: new Date(NOW + 60_000).toISOString(),
    },
    NOW,
  ),
  false,
  "backoff must be respected for the cleanup too",
);
assert.equal(
  isStrandedDue(
    {
      [FOLLOW_UP_FIELDS.strandedEventId]: "evt_old",
      [FOLLOW_UP_FIELDS.strandedOperatorUserId]: "user-1",
      [FOLLOW_UP_FIELDS.strandedNextAttemptAt]: new Date(NOW - 1).toISOString(),
      // A stranded cleanup is due on its OWN clock regardless of the sync state.
      [FOLLOW_UP_FIELDS.state]: "synced",
    },
    NOW,
  ),
  true,
  "the cleanup must not wait on the sync job being pending: they are independent",
);

/* ------------------------------------------------------- route wiring
 *
 * These two ARE source assertions, and only because the behaviour lives inside
 * a route handler and a cron whose collaborators (session, tenant records, the
 * bridge) cannot be injected today. The ledger's rule is followed as written:
 * behaviour where a pure function exists (everything above), source matching
 * kept only for module-private wiring. Each one names what breaks if it goes.
 */

{
  const route = readFileSync("app/api/leads/[id]/notes/route.ts", "utf8");
  assert.match(
    route,
    /leadReadFailed = true/,
    "a failed lead read must be recorded, not swallowed: pushing without knowing the existing event id creates a second reminder and strands the first",
  );
  assert.match(
    route,
    /const unreadablePending = leadReadFailed[\s\S]{0,700}?"pending"/,
    "an unreadable lead must hand the mirror to the cron, which re-reads and finds the real event id",
  );
  const mirrorAt = route.indexOf("const outcome = await syncFollowUpReminder");
  const guardAt = route.indexOf("if (leadReadFailed)");
  assert.ok(
    guardAt > 0 && guardAt < mirrorAt,
    "the read-failure guard must come BEFORE the calendar push, or it guards nothing",
  );

  // The pending state must ride the SOURCE-OF-TRUTH write, not a second one.
  // As two writes, a failure of the second left the lead holding follow_up_at
  // with no pending state, so the cron never saw it and the reminder was never
  // created. One write cannot half-apply.
  const sotAt = route.indexOf("...unreadablePending,");
  assert.ok(
    sotAt > 0 && sotAt < mirrorAt,
    "the pending fields must be part of the same updateRecord that stores follow_up_at",
  );
}

{
  const cron = readFileSync("app/api/cron/reconcile-calendar-reminders/route.ts", "utf8");
  assert.match(
    cron,
    /\.order\("updated_at", \{ ascending: true \}\)/,
    "an unordered LIMIT can return the same page every run, starving pending reminders past it for days during an outage",
  );
  // The queue flag is newer than the feature. A record written before it
  // existed carries only the legacy pending state, and a filter on the new key
  // alone would exclude that whole backlog permanently and silently -- an
  // excluded row is indistinguishable from a row with no work.
  assert.match(
    cron,
    new RegExp(`data->>\\$\\{FOLLOW_UP_FIELDS\\.state\\}\`, "pending"`),
    "the compatibility scan on the legacy pending state must survive, or pre-existing retries are stranded",
  );
}

{
  const route = readFileSync("app/api/leads/[id]/notes/route.ts", "utf8");
  // A stranded cleanup this lead was ALREADY carrying must keep the record on
  // the worker queue when an ordinary later save recomputes the flag. Using
  // only this request's handover result drops the older one out of reach.
  assert.match(
    route,
    /strandedEventId: strandedEventId \|\| priorStrandedEventId/,
    "the queue flag must consider a stranded cleanup already on the lead, not just one created by this save",
  );
  // ...but NOT one that already gave up. Its next-attempt is null, which reads
  // as "due now", so requeueing it would fire a Google call and a terminal
  // alert on every later save of this lead.
  assert.match(
    route,
    /leadData\[FOLLOW_UP_FIELDS\.strandedReason\] !== "retry_exhausted"/,
    "an exhausted cleanup has already paged a human and must not be revived by an ordinary save",
  );
}

{
  const cron = readFileSync("app/api/cron/reconcile-calendar-reminders/route.ts", "utf8");
  // Two queries each capped at SCAN_LIMIT can return disjoint sets, so the cap
  // has to be re-applied to the union or the loop does double the intended
  // serial Google calls and can run the function past its time limit.
  assert.match(
    cron,
    /merged\.slice\(0, SCAN_LIMIT\)/,
    "the scan ceiling must apply to the MERGED set, not to each query separately",
  );
  // Truncation is the only backlog signal this run emits, so it must never
  // under-report. If both queries hit their limit and returned the SAME rows,
  // the union is not sliced -- and a merged-only check would call that "all
  // clear" while each query still had unseen rows behind it.
  assert.match(
    cron,
    /truncated:\s*\n\s*merged\.length > rows\.length \|\|\s*\n\s*\(queued\.data \|\| \[\]\)\.length > SCAN_LIMIT \|\|\s*\n\s*\(legacyPending\.data \|\| \[\]\)\.length > SCAN_LIMIT/,
    "truncation must consider the merged slice AND each query exceeding its own limit, with a strict > so a full page alone is not a false alarm",
  );
  // The extra row is what PROVES there is more behind the page. Without it,
  // `>= SCAN_LIMIT` cries backlog on every run that found exactly a full page
  // and nothing more, and a signal that is always on is one nobody reads.
  assert.match(
    cron,
    /\.limit\(SCAN_LIMIT \+ 1\)/,
    "each query must fetch one extra row, so truncation is proven rather than assumed from a full page",
  );
}

console.log("lead-follow-up-sync.test.ts passed");

}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
