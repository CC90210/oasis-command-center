/**
 * leads-claim.test.ts — lead ownership, and the ways it could quietly go
 * wrong.
 *
 * Two failures matter more than the rest, and neither is visible on a screen:
 *
 *   1. TWO REPS CALL THE SAME BUSINESS. The whole point of claiming.
 *   2. THE POOL SILENTLY DRAINS. Claims that never expire look identical to a
 *      healthy system until a rep says "there's nothing left to call".
 *
 * And one that is not a bug but a breach: a business on the internal
 * do-not-call list being handed to a rep because some other rule got there
 * first.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  availability, isActionableBy, isInBookOf, isReleasedFromBook, planClaim, claimPatch, releasePatch, factsFrom,
  CLAIM_STALE_DAYS, LOST_RECYCLE_DAYS, MAX_LEADS_PER_REP, type ClaimFacts,
} from "../lib/leads/claim";
import { CURRENT_OASIS_PIPELINE_CYCLE } from "../lib/pipeline-cycle";

const NOW = Date.parse("2026-08-23T12:00:00Z");
const ACTIVE_CYCLE_ASSIGNMENT_AT = "2026-09-23T12:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const base: ClaimFacts = {
  assignedTo: null, claimedAt: null, lastCallAt: null, stage: null, lostAt: null, dnc: false,
};
const f = (over: Partial<ClaimFacts>): ClaimFacts => ({ ...base, ...over });

// ---------------------------------------------------------------------------
// 1. Do-not-call outranks every other rule, including the ones that free leads.
// ---------------------------------------------------------------------------

assert.equal(
  availability(f({ dnc: true }), NOW).reason,
  "do_not_call",
  "an unclaimed do-not-call lead must never be claimable",
);
assert.equal(
  availability(f({ dnc: true, assignedTo: "rep-a", claimedAt: iso(30 * DAY) }), NOW).available,
  false,
  "an EXPIRED claim must not release a do-not-call lead back into the pool",
);
assert.equal(
  availability(f({ dnc: true, stage: "lost", lostAt: iso(400 * DAY) }), NOW).available,
  false,
  "the 90-day lost recycle must not resurrect a do-not-call lead",
);
// The release path must not quietly un-suppress someone.
assert.equal(
  Object.prototype.hasOwnProperty.call(releasePatch(), "dnc"),
  false,
  "releasing a lead must never write the dnc field -- opting back in is not ours to do",
);
assert.equal(
  Object.prototype.hasOwnProperty.call(claimPatch("rep-a", ACTIVE_CYCLE_ASSIGNMENT_AT), "dnc"),
  false,
  "claiming a lead must never write the dnc field",
);
assert.equal(
  Object.prototype.hasOwnProperty.call(claimPatch("rep-a", ACTIVE_CYCLE_ASSIGNMENT_AT), "lead_source_track"),
  false,
  "claiming must not rewrite frozen source provenance",
);
assert.equal(
  Object.prototype.hasOwnProperty.call(claimPatch("rep-a", ACTIVE_CYCLE_ASSIGNMENT_AT), "sourced_by_user_id"),
  false,
  "claiming must preserve the immutable sourcing identity",
);
assert.equal(
  ({ lead_source_track: "self", sourced_by_user_id: "rep-original", ...claimPatch("rep-a", ACTIVE_CYCLE_ASSIGNMENT_AT) }).lead_source_track,
  "self",
  "a reassignment must retain its frozen source track; payout checks the durable source identity",
);
assert.equal(
  ({ sourced_by_user_id: "rep-original", ...claimPatch("rep-a", ACTIVE_CYCLE_ASSIGNMENT_AT) }).sourced_by_user_id,
  "rep-original",
);

// ---------------------------------------------------------------------------
// 2. The pool keeps circulating.
// ---------------------------------------------------------------------------

assert.equal(availability(base, NOW).reason, "unclaimed", "an unowned lead is claimable");

assert.equal(
  isActionableBy(f({ assignedTo: "rep-a", claimedAt: iso(DAY) }), "rep-a", NOW),
  true,
  "a current owner must be able to work their lead",
);
assert.equal(
  isActionableBy(f({ assignedTo: "rep-a", claimedAt: iso(8 * DAY) }), "rep-a", NOW),
  false,
  "an expired claim may stay visible for history but must not remain actionable",
);
assert.equal(
  isActionableBy(f({ assignedTo: "rep-a", stage: "lost", lostAt: iso(91 * DAY) }), "rep-a", NOW),
  false,
  "a recycled loss must not remain actionable by its former owner",
);

// "NOT INTERESTED" IS A FACT ABOUT THE CONVERSATION, NOT ABOUT WHO HOLDS THE
// RECORD. A first draft checked "nobody holds it" before the lost branch, which
// made the 90-day rule unreachable for any lost lead with no owner: a business
// that said no yesterday was immediately callable again, by anyone, forever.
// (Codex review, 2026-08-23.)
assert.equal(
  availability(f({ stage: "lost", lostAt: iso(1 * DAY) }), NOW).available,
  false,
  "an UNOWNED lead lost yesterday must not be callable again -- ownership is irrelevant to whether they said no",
);
assert.equal(
  availability(f({ stage: "lost", lostAt: iso((LOST_RECYCLE_DAYS + 1) * DAY) }), NOW).reason,
  "lost_recycled",
  "and after 90 days it comes back, still without an owner",
);

assert.equal(
  availability(f({ assignedTo: "rep-a", claimedAt: iso(1 * DAY) }), NOW).reason,
  "held",
  "a fresh claim is honoured",
);

assert.equal(
  availability(f({ assignedTo: "rep-a", claimedAt: iso((CLAIM_STALE_DAYS + 1) * DAY) }), NOW).reason,
  "claim_expired",
  "a claim with no call logged in 7 days returns to the pool",
);

for (const stage of ["founder_meeting_booked", "proposal_sent", "won", "onboarding", "in_build", "client_review", "launched"]) {
  const activeWorkflow = f({
    assignedTo: "rep-a",
    stage,
    claimedAt: iso((CLAIM_STALE_DAYS + 30) * DAY),
    lastCallAt: null,
  });
  assert.equal(
    availability(activeWorkflow, NOW).reason,
    "in_progress",
    `${stage} must never recycle through the prospect pool just because claimed_at is old`,
  );
  assert.equal(
    isReleasedFromBook(activeWorkflow, NOW),
    false,
    `${stage} must stay visible as active paid/handoff work`,
  );
  assert.equal(
    isActionableBy(activeWorkflow, "rep-a", NOW),
    true,
    `${stage} must remain actionable by its recorded owner`,
  );
}
assert.equal(
  availability(f({ assignedTo: null, stage: "won", claimedAt: iso(40 * DAY) }), NOW).reason,
  "in_progress",
  "an orphaned paid record must fail closed instead of becoming claimable inventory",
);

// ONE LOGGED CALL RESETS IT. A rep working a lead must not lose it on day 8
// just because the conversation is slow -- and this is what makes logging pay
// for itself rather than being a chore.
assert.equal(
  availability(
    f({ assignedTo: "rep-a", claimedAt: iso(30 * DAY), lastCallAt: iso(2 * DAY) }),
    NOW,
  ).reason,
  "in_progress",
  "a claim with any logged call is not stale, however old the claim is",
);

assert.equal(
  availability(f({ assignedTo: "rep-a", stage: "lost", lostAt: iso(10 * DAY) }), NOW).available,
  false,
  "a recently lost lead stays out of the pool",
);
assert.equal(
  availability(
    f({ assignedTo: "rep-a", stage: "lost", lostAt: iso((LOST_RECYCLE_DAYS + 1) * DAY) }),
    NOW,
  ).reason,
  "lost_recycled",
  "'not interested' 90 days ago is worth another conversation",
);

// A lost lead has by definition been called, so the never-dialled rule can
// never free it. Without the lost branch running FIRST it would be locked to
// its last owner permanently -- the silent drain this feature exists to avoid.
assert.equal(
  availability(
    f({
      assignedTo: "rep-a", stage: "lost", lostAt: iso(200 * DAY),
      claimedAt: iso(300 * DAY), lastCallAt: iso(200 * DAY),
    }),
    NOW,
  ).available,
  true,
  "an old lost lead recycles even though it has a logged call",
);

// ---------------------------------------------------------------------------
// 3. Malformed or missing timestamps fail toward the rep, never toward chaos.
// ---------------------------------------------------------------------------

assert.equal(
  availability(f({ assignedTo: "rep-a", claimedAt: "not a date" }), NOW).reason,
  "held",
  "an unparseable claim date must not read as ancient and yank the lead away",
);
assert.equal(
  availability(f({ assignedTo: "rep-a", claimedAt: null }), NOW).reason,
  "held",
  "a missing claim date must not instantly expire the claim",
);
assert.equal(
  availability(f({ assignedTo: "rep-a", stage: "lost", lostAt: null }), NOW).available,
  false,
  "a lost lead with no lost_at stamp stays held -- fail closed toward the prospect who said no",
);

// ---------------------------------------------------------------------------
// 4. A rep's own book, and the released marker.
// ---------------------------------------------------------------------------

assert.equal(isInBookOf(f({ assignedTo: "REP-A" }), "rep-a"), true, "ownership compare is case-insensitive");
assert.equal(isInBookOf(f({ assignedTo: "rep-b" }), "rep-a"), false);
assert.equal(isInBookOf(base, "rep-a"), false, "an unowned lead is in nobody's book");

// A lapsed lead stays visible to its rep, flagged, rather than vanishing.
// Silent disappearance is how a rep stops trusting the tool and starts keeping
// their own spreadsheet.
const lapsed = f({ assignedTo: "rep-a", claimedAt: iso(9 * DAY) });
assert.equal(isInBookOf(lapsed, "rep-a"), true, "a lapsed lead is still in the rep's book");
assert.equal(isReleasedFromBook(lapsed, NOW), true, "and it is marked as released");
assert.equal(
  isReleasedFromBook(f({ assignedTo: "rep-a", claimedAt: iso(1 * DAY) }), NOW),
  false,
  "a fresh claim is not marked released",
);

// ---------------------------------------------------------------------------
// 5. Bulk claim: partial success is reported, never rounded up or refused.
// ---------------------------------------------------------------------------

{
  const candidates = [
    { id: "free-1", facts: base },
    { id: "taken", facts: f({ assignedTo: "rep-b", claimedAt: iso(1 * DAY) }) },
    { id: "free-2", facts: base },
    { id: "suppressed", facts: f({ dnc: true }) },
  ];
  const plan = planClaim(candidates, 0, NOW);
  assert.deepEqual(plan.granted, ["free-1", "free-2"], "only the available leads are granted");
  assert.deepEqual(
    plan.refused,
    [{ id: "taken", reason: "held" }, { id: "suppressed", reason: "do_not_call" }],
    "every refusal is reported with its reason -- a rep must not be told 4 when they got 2",
  );
}

{
  // At capacity, the cap binds mid-batch and the overflow is named.
  const candidates = Array.from({ length: 5 }, (_, i) => ({ id: `l${i}`, facts: base }));
  const plan = planClaim(candidates, MAX_LEADS_PER_REP - 2, NOW);
  assert.equal(plan.granted.length, 2, "the cap binds mid-batch");
  assert.equal(plan.refused.length, 3);
  assert.ok(
    plan.refused.every((r) => r.reason === "at_capacity"),
    "overflow is reported as capacity, not as unavailable -- the leads are fine, the rep is full",
  );
}

{
  const plan = planClaim([{ id: "a", facts: base }], MAX_LEADS_PER_REP, NOW);
  assert.deepEqual(plan.granted, [], "a rep at the cap gets nothing");
  assert.equal(plan.refused[0].reason, "at_capacity");
}

// ---------------------------------------------------------------------------
// 6. Claiming a RECYCLED lead clears the previous owner's history stamps.
//
// Without this, a lead recycled out of `lost` keeps its old lost_at, so it
// reads as already-lost to the new rep and recycles again on the old clock --
// no matter what the new rep does with it.
// ---------------------------------------------------------------------------

{
  const patch = claimPatch("rep-b", ACTIVE_CYCLE_ASSIGNMENT_AT);
  assert.equal(patch.assigned_to, "rep-b");
  assert.deepEqual(patch.collaborators, [], "a new claim must clear the previous owner's collaborators");
  assert.equal(patch.assigned_at, ACTIVE_CYCLE_ASSIGNMENT_AT);
  assert.equal(patch.claimed_at, ACTIVE_CYCLE_ASSIGNMENT_AT);
  assert.equal(patch.pipeline_cycle, CURRENT_OASIS_PIPELINE_CYCLE.id);
  assert.equal(patch.stage_entered_at, ACTIVE_CYCLE_ASSIGNMENT_AT);
  assert.equal(patch.last_contacted_at, ACTIVE_CYCLE_ASSIGNMENT_AT, "claiming into Assigned counts as a lifecycle touch");
  assert.equal(patch.last_call_at, null, "the previous owner's call stamp must be cleared");
  assert.equal(patch.lost_at, null, "the previous owner's lost stamp must be cleared");
  assert.equal(patch.stage, "assigned", "a claimed lead enters the pipeline at 'assigned'");
  assert.equal(patch.sales_program, "website_sales_v1", "a claimed prospect is visible to the website-sales pipeline query");
  assert.equal(patch.sales_motion, "cold_outbound", "a claim enters only the cold outbound sales engine");

  // Prove the round trip: apply the patch and the lead is held by the new rep,
  // not instantly stale and not still lost.
  const after = factsFrom(patch as Record<string, unknown>);
  assert.equal(availability(after, NOW).reason, "held");
  assert.equal(isInBookOf(after, "rep-b"), true);
}

assert.deepEqual(
  releasePatch().collaborators,
  [],
  "releasing a lead must revoke every collaborator's write grant",
);

// ---------------------------------------------------------------------------
// 7. factsFrom is strict about dnc in BOTH directions.
// ---------------------------------------------------------------------------

assert.equal(factsFrom({ dnc: true }).dnc, true);
assert.equal(factsFrom({ dnc: 1 }).dnc, true, "libSQL returns booleans as 0/1");
assert.equal(factsFrom({ dnc: 0 }).dnc, false);
assert.equal(factsFrom({}).dnc, false, "absent means not suppressed");
assert.equal(
  factsFrom({ dnc: "no" }).dnc,
  false,
  "a stray string must not be read as opt-out (Boolean('no') is true) -- but see below",
);
assert.equal(
  factsFrom({ dnc: "true" }).dnc,
  false,
  "nor as consent-to-suppress from an unvalidated string; only a real boolean or 1 counts",
);

// ---------------------------------------------------------------------------
// 8. The rules are computed on read, with no background job to fail silently.
// ---------------------------------------------------------------------------

{
  const src = fs.readFileSync(path.join(process.cwd(), "lib/leads/claim.ts"), "utf8");
  // availability() takes `now` as an argument rather than calling Date.now()
  // internally: that is what makes every rule above testable at an exact
  // instant, and what keeps expiry a pure derivation instead of a scheduled
  // side effect that can stop running without anyone noticing.
  assert.doesNotMatch(
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
    /Date\.now\(\)/,
    "claim rules must take `now` as a parameter, not read the clock -- expiry is derived on read, never swept by a job that can silently stop",
  );
}

// ---------------------------------------------------------------------------
// 9. Releasing is a swap.
// ---------------------------------------------------------------------------

{
  const ops = fs.readFileSync(path.join(process.cwd(), "lib/leads/release.ts"), "utf8");

  // An unconditional release writes back a snapshot read moments earlier. If
  // another rep claimed a stale lead in between, that write restores the stale
  // data AND clears the new owner -- silently erasing a claim on a lead they
  // are about to call.
  const releaseFn = ops.match(/export async function releaseLeads\([\s\S]*?\n\}/);
  assert.ok(releaseFn, "releaseLeads must be findable");
  assert.match(
    releaseFn![0],
    /\.eq\("data->>assigned_to", prevOwner as string\)/,
    "releasing must compare the observed owner, or it can erase another rep's claim",
  );
  assert.match(
    releaseFn![0],
    /\.eq\("updated_at", r\.updated_at\)/,
    "releasing must also pin the row version so it cannot erase a concurrent contact/context edit while the owner stays the same",
  );
  assert.match(
    releaseFn![0],
    /\.from\("lead_interactions"\)\.insert\(/,
    "a successful explicit release must append an interaction ledger entry",
  );
  assert.match(
    releaseFn![0],
    /trackingFailed/,
    "a release whose ownership write lands but audit insert fails must report the tracking gap",
  );

}

// ---------------------------------------------------------------------------
// 10. A lapsed owner keeps read history, not write authority.
// ---------------------------------------------------------------------------

{
  const access = fs.readFileSync(path.join(process.cwd(), "lib/leads/rep-lead-access.ts"), "utf8");
  assert.match(access, /isActionableBy\(facts, args\.userId, now\)/,
    "the shared OASIS mutation gate must re-check derived claim expiry server-side");
  assert.match(access, /claim_released/, "a former owner must receive a specific released-claim refusal");
  assert.match(access, /availability\(facts, now\)\.reason === "do_not_call"/,
    "do-not-call must be refused explicitly instead of being mislabeled as an expired claim");
}

console.log("leads-claim ok");
