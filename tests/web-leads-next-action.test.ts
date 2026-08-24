import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  CALL_DISPOSITIONS,
  callDispositionPatch,
  isTerminalDisposition,
  isNoContactDisposition,
  requiresNextAction,
  suggestedNextActionAt,
  WORKFLOW_ERRORS,
  type CallDisposition,
} from "../lib/website-sales-workflow";
import { WEBSITE_SALES_STAGES } from "../lib/website-sales";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const STAGES: readonly string[] = WEBSITE_SALES_STAGES;
const NOW = "2026-08-23T15:00:00.000Z";

// ===========================================================================
// WHY THIS FILE EXISTS
//
// components/today/RepToday.tsx ranks a rep's entire day on `next_action_at`
// and labels each row with `last_disposition`. Until 2026-08-23 NOTHING in the
// path reps actually call from ever wrote either field: the Web Leads outcome
// logger wrote `data.stage` and nothing else, while a second call-logging path
// (/api/website-sales/[leadId], reached from the pipeline lifecycle panel) had
// the fields and a different four-word vocabulary.
//
// So "call these first" ranked on a column no rep could populate, and a
// prospect who said "call me Thursday at 2" produced no Thursday anything. The
// failure was invisible: a queue with nothing scheduled and a queue that cannot
// schedule render identically.
//
// These tests pin the behaviour that closes that loop.
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. A CALLBACK CANNOT BE SAVED WITHOUT A TIME.
//
// This is the one hard requirement in the whole disposition set. A prospect who
// named a time and then appears in nobody's queue is the worst data loss here,
// because the rep believes it is handled and nothing will ever remind them.
// ---------------------------------------------------------------------------
assert.equal(requiresNextAction("callback"), true, "callback must require a next action");
for (const d of CALL_DISPOSITIONS) {
  if (d === "callback") continue;
  assert.equal(requiresNextAction(d), false, `${d} must not hard-require a next action`);
}

assert.throws(
  () => callDispositionPatch({ disposition: "callback", nextActionAt: null, currentStage: "assigned", stages: STAGES, occurredAt: NOW }),
  new RegExp(WORKFLOW_ERRORS.nextActionRequired),
  "a callback with no time must be refused",
);

// ---------------------------------------------------------------------------
// 2. A NEXT ACTION MUST BE IN THE FUTURE, and "future" is measured against when
// the call happened, not against whenever this code runs. A callback scheduled
// into the past never surfaces: RepToday sorts it into the overdue tier at the
// top of a rep's day, which is worse than refusing it, because it looks like a
// real promise the rep already broke.
// ---------------------------------------------------------------------------
assert.throws(
  () => callDispositionPatch({ disposition: "callback", nextActionAt: "2026-08-23T14:00:00.000Z", currentStage: "assigned", stages: STAGES, occurredAt: NOW }),
  new RegExp(WORKFLOW_ERRORS.nextActionMustBeFuture),
  "a callback before the call itself must be refused",
);
assert.throws(
  () => callDispositionPatch({ disposition: "callback", nextActionAt: NOW, currentStage: "assigned", stages: STAGES, occurredAt: NOW }),
  new RegExp(WORKFLOW_ERRORS.nextActionMustBeFuture),
  "a callback at exactly the call time must be refused, not rounded into the future",
);
assert.throws(
  () => callDispositionPatch({ disposition: "callback", nextActionAt: "not a date", currentStage: "assigned", stages: STAGES, occurredAt: NOW }),
  new RegExp(WORKFLOW_ERRORS.nextActionMustBeFuture),
  "an unparseable next action must be refused, never coerced to null and silently dropped",
);

const goodCallback = callDispositionPatch({
  disposition: "callback",
  nextActionAt: "2026-08-27T18:00:00.000Z",
  currentStage: "assigned",
  stages: STAGES,
  occurredAt: NOW,
});
assert.equal(goodCallback.next_action_at, "2026-08-27T18:00:00.000Z", "a valid callback time must be written through unchanged");
assert.equal(goodCallback.last_disposition, "callback", "last_disposition must record what the rep chose");
assert.equal(goodCallback.last_contact_at, NOW, "last_contact_at must be the call time");
assert.equal(goodCallback.stage, "connected", "a callback means they were reached");

// ---------------------------------------------------------------------------
// 3. THE SUGGESTED SPACING IS PER-DISPOSITION, and the three no-contact
// outcomes are genuinely different problems. Pinned as ORDERING rather than
// exact minutes so the intent survives a tuning change: a second voicemail
// hours after the first reads as pestering, and a gatekeeper must be met at a
// different hour of a different day, not the same hour tomorrow.
// ---------------------------------------------------------------------------
const at = (d: CallDisposition) => {
  const iso = suggestedNextActionAt(d, NOW);
  assert.ok(iso, `${d} must have a suggested next attempt`);
  return Date.parse(iso!);
};
const base = Date.parse(NOW);
assert.ok(at("no_answer") > base, "a no-answer retry must be in the future");
assert.ok(at("no_answer") < at("gatekeeper"), "no answer must be retried sooner than a gatekeeper");
assert.ok(at("gatekeeper") < at("voicemail"), "a gatekeeper must be retried sooner than a second voicemail");
assert.ok(at("gatekeeper") > base + 24 * 60 * 60 * 1000, "a gatekeeper retry must land past 24h so it misses the same shift");

// The system must NOT guess a time for anything else. A suggestion for
// `callback` would be a fabricated appointment the prospect never agreed to,
// and one for a terminal outcome would schedule a lead we were told to leave.
for (const d of ["callback", "connected", "interested", "not_interested", "do_not_call"] as const) {
  assert.equal(suggestedNextActionAt(d, NOW), null, `${d} must have no suggested time`);
}

// A malformed clock input must produce no suggestion rather than an Invalid
// Date that serializes to null further down and looks like "the rep declined".
assert.equal(suggestedNextActionAt("no_answer", "not a date"), null, "an unparseable base time must yield no suggestion");

// ---------------------------------------------------------------------------
// 4. A TERMINAL DISPOSITION CLEARS ANY CALLBACK, even one passed in.
//
// Accepting both would put a prospect who just said "never call me again" at
// the top of a rep's queue tomorrow morning. This is enforced in the seam, not
// in the UI, because the UI is not the only caller.
// ---------------------------------------------------------------------------
for (const d of ["not_interested", "do_not_call"] as const) {
  assert.equal(isTerminalDisposition(d), true, `${d} must be terminal`);
  const patch = callDispositionPatch({
    disposition: d,
    nextActionAt: "2026-09-01T15:00:00.000Z",
    currentStage: "connected",
    stages: STAGES,
    occurredAt: NOW,
  });
  assert.equal(patch.next_action_at, null, `${d} must CLEAR a next action, even one explicitly supplied`);
  assert.equal(patch.stage, "lost", `${d} must move an early-funnel lead to lost`);
}

// do_not_call additionally stamps a durable mark. A stage of `lost` alone is
// not a do-not-call record: `lost` is reversible and reused for ordinary
// rejections, and nothing downstream could tell the two apart.
const dnc = callDispositionPatch({ disposition: "do_not_call", nextActionAt: null, currentStage: "connected", stages: STAGES, occurredAt: NOW });
assert.equal(dnc.do_not_call, true, "do_not_call must stamp a durable flag, not rely on the stage");
assert.equal(dnc.do_not_call_at, NOW, "do_not_call must record when");
assert.ok(dnc.do_not_call_source, "do_not_call must record where the instruction came from");
const notInterested = callDispositionPatch({ disposition: "not_interested", nextActionAt: null, currentStage: "connected", stages: STAGES, occurredAt: NOW });
assert.equal(notInterested.do_not_call, undefined, "an ordinary rejection must NOT be recorded as a do-not-call instruction");

// ---------------------------------------------------------------------------
// 5. THE PATCH MUST OMIT `stage` ENTIRELY when the forward-only guard says not
// to touch it.
//
// This is the sharpest edge in the change. The patch is MERGED into the lead's
// existing data, so a `stage: null` would blank the stage of every lead CC's
// engine has already advanced, silently dragging won and in-build deals out of
// the pipeline. The key must be absent, not null.
// ---------------------------------------------------------------------------
for (const current of ["won", "onboarding", "in_build", "launched", "proposal_sent", "qualified"]) {
  for (const d of CALL_DISPOSITIONS) {
    const patch = callDispositionPatch({
      disposition: d,
      nextActionAt: isTerminalDisposition(d) ? null : "2026-09-01T15:00:00.000Z",
      currentStage: current,
      stages: STAGES,
      occurredAt: NOW,
    });
    assert.ok(
      !("stage" in patch),
      `a disposition logged against a ${current} lead must omit the stage key entirely (got ${JSON.stringify(patch.stage)})`,
    );
  }
}

// A no-contact disposition never sets a stage either, from anywhere.
for (const d of CALL_DISPOSITIONS.filter(isNoContactDisposition)) {
  for (const current of ["researched", "assigned", "attempting_contact", "connected"]) {
    const patch = callDispositionPatch({ disposition: d, nextActionAt: "2026-09-01T15:00:00.000Z", currentStage: current, stages: STAGES, occurredAt: NOW });
    assert.ok(!("stage" in patch), `${d} from ${current} must not carry a stage key`);
    assert.equal(patch.next_action_at, "2026-09-01T15:00:00.000Z", `${d} must keep its scheduled retry`);
  }
}

// ---------------------------------------------------------------------------
// 6. THE PATCH TOUCHES NOTHING COMMERCIAL. Same list the outcome guards pin
// against the older, narrower patch: a disposition is a rep pressing a button
// on a call, and it must never be able to move money, ownership or price.
// ---------------------------------------------------------------------------
const ALLOWED_KEYS = new Set([
  "stage", "last_disposition", "last_contact_at", "next_action_at",
  "do_not_call", "do_not_call_at", "do_not_call_source",
]);
for (const d of CALL_DISPOSITIONS) {
  const patch = callDispositionPatch({
    disposition: d,
    nextActionAt: isTerminalDisposition(d) || requiresNextAction(d) === false ? null : "2026-09-01T15:00:00.000Z",
    currentStage: "assigned",
    stages: STAGES,
    occurredAt: NOW,
  });
  for (const key of Object.keys(patch)) {
    assert.ok(ALLOWED_KEYS.has(key), `a call disposition must never write "${key}" onto a lead`);
  }
}

// ---------------------------------------------------------------------------
// 7. THE FIELDS THE PATCH WRITES ARE THE FIELDS REP TODAY READS.
//
// The two halves of this feature live in different files, and a rename on
// either side would restore the exact silent-empty-queue bug this change fixes
// -- with every unit test still green, because each half would be internally
// consistent. This reads the queue component's source and requires it to be
// keyed on the same two field names the patch emits.
// ---------------------------------------------------------------------------
const repToday = read("components/today/RepToday.tsx");
const sample = callDispositionPatch({ disposition: "callback", nextActionAt: "2026-09-01T15:00:00.000Z", currentStage: "assigned", stages: STAGES, occurredAt: NOW });
for (const field of ["next_action_at", "last_disposition"]) {
  assert.ok(field in sample, `the disposition patch must write ${field}`);
  assert.match(
    repToday,
    new RegExp(`"${field}"`),
    `components/today/RepToday.tsx must read "${field}" -- if it stops, the rep's queue silently empties again`,
  );
}

// ---------------------------------------------------------------------------
// 8. BOTH CALL-LOGGING SURFACES USE THE ONE SEAM.
//
// The root cause was two vocabularies. A future edit that reintroduces a local
// disposition list, a local retry interval, or a local "is this required" rule
// in either UI recreates it. Both must import those decisions.
// ---------------------------------------------------------------------------
for (const surface of ["components/web-leads/CallOutcomeLog.tsx", "components/web-leads/CallMode.tsx"]) {
  const src = read(surface);
  assert.match(
    src,
    /from "@\/lib\/website-sales-workflow"/,
    `${surface} must take its disposition rules from lib/website-sales-workflow.ts, not redefine them`,
  );
  assert.match(src, /requiresNextAction/, `${surface} must ask the seam which outcomes need a time`);
  assert.match(src, /isTerminalDisposition/, `${surface} must ask the seam which outcomes end the conversation`);
  // A hardcoded interval here is the drift, in its most likely form.
  assert.doesNotMatch(
    src,
    /\b(?:3|26|48)\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    `${surface} must not hardcode a retry interval -- suggestedNextActionAt owns that`,
  );
}

// Both surfaces must send the next action to the server. Rendering a time and
// then not transmitting it is a failure mode that looks completely correct on
// screen, and it is the single easiest way to reintroduce the original bug.
for (const surface of ["components/web-leads/CallOutcomeLog.tsx", "components/web-leads/CallMode.tsx"]) {
  assert.match(
    read(surface),
    /body:\s*JSON\.stringify\(\{[^}]*nextActionAt/,
    `${surface} must POST nextActionAt with the outcome`,
  );
}

console.log("web-leads-next-action ok");
