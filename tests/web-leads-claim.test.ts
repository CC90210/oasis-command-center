/**
 * web-leads-claim.test.ts — lead ownership, and the ways it could quietly go
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
  availability, isInBookOf, isReleasedFromBook, planClaim, claimPatch, releasePatch, factsFrom,
  CLAIM_STALE_DAYS, LOST_RECYCLE_DAYS, MAX_LEADS_PER_REP, type ClaimFacts,
} from "../lib/web-leads/claim";

const NOW = Date.parse("2026-08-23T12:00:00Z");
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
  Object.prototype.hasOwnProperty.call(claimPatch("rep-a", "2026-08-23T12:00:00Z"), "dnc"),
  false,
  "claiming a lead must never write the dnc field",
);

// ---------------------------------------------------------------------------
// 2. The pool keeps circulating.
// ---------------------------------------------------------------------------

assert.equal(availability(base, NOW).reason, "unclaimed", "an unowned lead is claimable");

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
  const patch = claimPatch("rep-b", "2026-08-23T12:00:00Z");
  assert.equal(patch.assigned_to, "rep-b");
  assert.equal(patch.claimed_at, "2026-08-23T12:00:00Z");
  assert.equal(patch.last_call_at, null, "the previous owner's call stamp must be cleared");
  assert.equal(patch.lost_at, null, "the previous owner's lost stamp must be cleared");
  assert.equal(patch.stage, "assigned", "a claimed lead enters the pipeline at 'assigned'");

  // Prove the round trip: apply the patch and the lead is held by the new rep,
  // not instantly stale and not still lost.
  const after = factsFrom(patch as Record<string, unknown>);
  assert.equal(availability(after, NOW).reason, "held");
  assert.equal(isInBookOf(after, "rep-b"), true);
}

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
  const src = fs.readFileSync(path.join(process.cwd(), "lib/web-leads/claim.ts"), "utf8");
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

console.log("web-leads-claim ok");
