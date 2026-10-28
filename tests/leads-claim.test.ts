/**
 * leads-claim.test.ts — lead ownership, and the ways it could quietly go
 * wrong.
 *
 * Two failures matter more than the rest, and neither is visible on a screen:
 *
 *   1. TWO REPS CALL THE SAME BUSINESS. The whole point of claiming.
 *   2. A LEAD SILENTLY VANISHES. Until 2026-10-28 an untouched claim expired
 *      back into the Prospects pool. That pool retired, so an expiry would now
 *      hide a lead with nowhere to come back from. Nothing ages out any more.
 *
 * And one that is not a bug but a breach: a business on the internal
 * do-not-call list being handed to a rep because some other rule got there
 * first.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  availability, isInBookOf, claimPatch, releasePatch, factsFrom, type ClaimFacts,
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
// 1. Do-not-call outranks every other rule.
// ---------------------------------------------------------------------------

assert.equal(
  availability(f({ dnc: true }), NOW).reason,
  "do_not_call",
  "an unclaimed do-not-call lead must never be claimable",
);
assert.equal(
  availability(f({ dnc: true, assignedTo: "rep-a", claimedAt: iso(30 * DAY) }), NOW).reason,
  "do_not_call",
  "an old claim on a do-not-call lead reads as do-not-call, never as anything a rep may work",
);
assert.equal(
  availability(f({ dnc: true, stage: "lost", lostAt: iso(400 * DAY) }), NOW).available,
  false,
  "an old loss must not resurrect a do-not-call lead",
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
// 2. Nothing ages out (2026-10-28).
//
// The 7-day claim expiry and the 90-day lost recycle fed the shared Prospects
// pool. With the pool retired, either rule would hide a lead from its owner
// AND from every admin, with no screen left to recover it from (Codex review
// of the retirement). A held lead stays held until someone reassigns it.
// ---------------------------------------------------------------------------

assert.equal(availability(base, NOW).reason, "unclaimed", "an unowned lead is available");
assert.equal(
  availability(f({ stage: "assigned" }), NOW).reason,
  "unclaimed",
  "an unowned lead at a working stage is available, which is what lets an admin assign it",
);

assert.equal(
  availability(f({ assignedTo: "rep-a", claimedAt: iso(1 * DAY) }), NOW).reason,
  "held",
  "a fresh claim is honoured",
);
for (const days of [8, 30, 400]) {
  const old = f({ assignedTo: "rep-a", stage: "assigned", claimedAt: iso(days * DAY) });
  assert.equal(
    availability(old, NOW).reason,
    "held",
    `a claim never dialled in ${days} days stays held: no pool remains for it to fall back into`,
  );
  assert.equal(isInBookOf(old, "rep-a"), true, `and after ${days} days it is still in its owner's book`);
}

// "NOT INTERESTED" IS A FACT ABOUT THE CONVERSATION, NOT ABOUT WHO HOLDS THE
// RECORD. An unowned lost lead must not read as available just because nobody
// holds it: a business that said no yesterday would be callable again by
// anyone. (Codex review, 2026-08-23.) And with the recycle gone, a loss is
// permanent whoever holds it.
for (const days of [1, 91, 400]) {
  assert.equal(
    availability(f({ stage: "lost", lostAt: iso(days * DAY) }), NOW).available,
    false,
    `an UNOWNED lead lost ${days} days ago stays lost`,
  );
  assert.equal(
    availability(f({ assignedTo: "rep-a", stage: "lost", lostAt: iso(days * DAY) }), NOW).available,
    false,
    `an owned lead lost ${days} days ago stays lost; nothing recycles it`,
  );
}
assert.equal(
  availability(
    f({
      assignedTo: "rep-a", stage: "lost", lostAt: iso(200 * DAY),
      claimedAt: iso(300 * DAY), lastCallAt: iso(200 * DAY),
    }),
    NOW,
  ).available,
  false,
  "an old lost lead with a logged call stays lost too",
);

for (const stage of ["founder_meeting_booked", "proposal_sent", "won", "onboarding", "in_build", "client_review", "launched"]) {
  const activeWorkflow = f({
    assignedTo: "rep-a",
    stage,
    claimedAt: iso(37 * DAY),
    lastCallAt: null,
  });
  assert.equal(
    availability(activeWorkflow, NOW).reason,
    "in_progress",
    `${stage} is active paid/handoff work, never prospect inventory`,
  );
  assert.equal(
    isInBookOf(activeWorkflow, "rep-a"),
    true,
    `${stage} stays in its recorded owner's book`,
  );
}
assert.equal(
  availability(f({ assignedTo: null, stage: "won", claimedAt: iso(40 * DAY) }), NOW).reason,
  "in_progress",
  "an orphaned paid record must fail closed instead of becoming assignable inventory",
);

// A logged call says the lead is being worked, however old the claim is.
assert.equal(
  availability(
    f({ assignedTo: "rep-a", claimedAt: iso(30 * DAY), lastCallAt: iso(2 * DAY) }),
    NOW,
  ).reason,
  "in_progress",
  "a claim with any logged call reads as in progress",
);

// ---------------------------------------------------------------------------
// 3. Malformed or missing timestamps change nothing.
// ---------------------------------------------------------------------------

assert.equal(
  availability(f({ assignedTo: "rep-a", claimedAt: "not a date" }), NOW).reason,
  "held",
  "an unparseable claim date must not yank the lead away",
);
assert.equal(
  availability(f({ assignedTo: "rep-a", claimedAt: null }), NOW).reason,
  "held",
  "a missing claim date must not free the lead",
);
assert.equal(
  availability(f({ assignedTo: "rep-a", stage: "lost", lostAt: null }), NOW).available,
  false,
  "a lost lead with no lost_at stamp stays lost -- fail closed toward the prospect who said no",
);

// ---------------------------------------------------------------------------
// 4. A rep's own book.
// ---------------------------------------------------------------------------

assert.equal(isInBookOf(f({ assignedTo: "REP-A" }), "rep-a"), true, "ownership compare is case-insensitive");
assert.equal(isInBookOf(f({ assignedTo: "rep-b" }), "rep-a"), false);
assert.equal(isInBookOf(base, "rep-a"), false, "an unowned lead is in nobody's book");

// ---------------------------------------------------------------------------
// 5. A new claim clears the previous owner's history stamps.
//
// Without this, a reassigned lead keeps the old owner's lost_at and call
// stamps, so it reads as already lost, or already worked, to the new rep.
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
  // not still lost.
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
// 6. factsFrom is strict about dnc in BOTH directions.
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
// 7. No rule reads the clock, and no expiry rule comes back.
// ---------------------------------------------------------------------------

{
  const src = fs.readFileSync(path.join(process.cwd(), "lib/leads/claim.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // Ownership changes only when somebody assigns or releases a lead, never
  // because time passed. A rule that read the clock would be an expiry, and an
  // expiry needs a surface to recover the lead from, which no longer exists.
  assert.doesNotMatch(code, /Date\.now\(\)/, "claim rules must not read the clock");
  assert.doesNotMatch(
    code,
    /claim_expired|lost_recycled|STALE_DAYS|RECYCLE_DAYS/,
    "no claim expiry or lost recycle may return without a screen to recover the lead from",
  );
}

// ---------------------------------------------------------------------------
// 8. Releasing is a swap.
// ---------------------------------------------------------------------------

{
  const ops = fs.readFileSync(path.join(process.cwd(), "lib/leads/release.ts"), "utf8");

  // An unconditional release writes back a snapshot read moments earlier. If
  // another rep claimed the lead in between, that write restores the stale
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
// 9. A held lead stays its owner's to work.
// ---------------------------------------------------------------------------

{
  const access = fs.readFileSync(path.join(process.cwd(), "lib/leads/rep-lead-access.ts"), "utf8");
  assert.doesNotMatch(access, /claim_released/,
    "a held lead no longer lapses, so the shared OASIS mutation gate has no released-claim refusal");
  assert.match(access, /availability\(facts, now\)\.reason === "do_not_call"/,
    "do-not-call must still be refused explicitly by the shared mutation gate");
  const booking = fs.readFileSync(path.join(process.cwd(), "app/api/website-sales/[leadId]/route.ts"), "utf8");
  assert.doesNotMatch(booking, /claim_released/, "nor does booking a founder meeting refuse a lapsed claim");
}

console.log("leads-claim ok");
