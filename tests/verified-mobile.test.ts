/**
 * tests/verified-mobile.test.ts — "no reason to think it will fail" is not the
 * same as "we know it works", and tomorrow depends on the difference.
 *
 * THE SITUATION (measured 2026-08-20). The follow-up cohort is 347 leads and
 * 100% of their numbers came off an application form. That provenance has
 * delivered 0 of 53. But not one of those numbers has failed TWICE yet, and
 * none carries a line type — so `textable` says yes to every single one,
 * correctly, because textable fails open so a new number can be tried and
 * learned from.
 *
 * Sending 40/day into that cohort would fail nearly every message. Three
 * consecutive carrier failures bench a line and five halt a wire, so the
 * programme would stop itself within the hour and deliver LESS than a careful
 * one. Hence a second, stricter question.
 */

import assert from "node:assert/strict";
import {
  isVerifiedMobile, destinationVerdict, lineTypeFor,
  type DestinationOutcome,
} from "../lib/sms/destination-health-core";

const o = (status: DestinationOutcome["status"], last10 = "7329943864"): DestinationOutcome =>
  ({ last10, status, at: "2026-08-19T18:01:00Z" });

// ── OBSERVATION OUTRANKS CLASSIFICATION ──────────────────────────────────
// A number that actually reached a handset is a mobile, whatever a lookup
// called it. This is the same precedence destinationVerdict already uses.
{
  assert.equal(isVerifiedMobile([o("delivered")], undefined).verified, true);
  assert.equal(isVerifiedMobile([o("delivered")], "landline").verified, true,
    "a real delivery overrules a landline label");
  assert.match(isVerifiedMobile([o("delivered"), o("delivered")], undefined).reason, /delivered 2/);
}

// ── A LOOKUP SAYING WIRELESS IS ENOUGH, WITH NO SENDS AT ALL ─────────────
// This is what makes tomorrow possible: 48 leads qualify on the lookup alone.
{
  const r = isVerifiedMobile([], "wireless");
  assert.equal(r.verified, true);
  assert.match(r.reason, /wireless/);
}

// ── THE 347: textable YES, verified NO ──────────────────────────────────
// The exact shape of the cohort. No line type, no history, one failure at most.
// This divergence is the entire point of the new predicate.
{
  const fresh: DestinationOutcome[] = [];
  assert.equal(destinationVerdict(fresh).textable, true, "textable fails open, as designed");
  assert.equal(isVerifiedMobile(fresh, undefined).verified, false, "but it is NOT verified");

  const oneFailure = [o("failed")];
  assert.equal(destinationVerdict(oneFailure).textable, true, "one failure is below the bench limit");
  assert.equal(isVerifiedMobile(oneFailure, undefined).verified, false);
  assert.match(isVerifiedMobile(oneFailure, undefined).reason, /never verified/);
}

// ── A LANDLINE LABEL DISQUALIFIES ───────────────────────────────────────
{
  const r = isVerifiedMobile([o("failed")], "landline");
  assert.equal(r.verified, false);
  assert.match(r.reason, /landline/);
}

// ── 'unknown' receipts are not evidence of anything ─────────────────────
// 15 receipts sat unresolved for four days while the reconciler was broken. If
// those counted as deliveries, a blind system would verify every number it
// touched.
{
  assert.equal(isVerifiedMobile([o("unknown"), o("unknown")], undefined).verified, false);
  assert.equal(isVerifiedMobile([o("unknown")], "wireless").verified, true,
    "the wireless label still stands on its own");
}

// ── It composes with the real lookup payload ────────────────────────────
// End to end from the shape actually stored on a lead.
{
  const CANDIDATES = [
    { type: "Wireless", number: "+12314630084" },
    { type: "Landline", number: "+16165258310" },
  ];
  assert.equal(isVerifiedMobile([], lineTypeFor("+12314630084", CANDIDATES)).verified, true);
  assert.equal(isVerifiedMobile([], lineTypeFor("+16165258310", CANDIDATES)).verified, false);
  // A number absent from the candidate list is unknown, not landline — and
  // unknown is not verified either.
  assert.equal(isVerifiedMobile([], lineTypeFor("+15559998888", CANDIDATES)).verified, false);
}

// ── VERIFIED IS ALWAYS A SUBSET OF TEXTABLE ─────────────────────────────
// A number we would refuse to text must never come back as verified, or the
// stricter gate would be a way to bypass the looser one.
{
  const cases: Array<[DestinationOutcome[], Parameters<typeof isVerifiedMobile>[1]]> = [
    [[], undefined], [[o("failed")], undefined], [[o("failed"), o("failed")], undefined],
    [[o("delivered")], undefined], [[], "wireless"], [[], "landline"],
    [[o("unknown")], undefined], [[o("delivered"), o("failed"), o("failed")], "landline"],
  ];
  for (const [outcomes, lineType] of cases) {
    const v = isVerifiedMobile(outcomes, lineType);
    if (!v.verified) continue;
    const t = destinationVerdict(outcomes, { lineType });
    assert.equal(t.textable, true,
      `verified must imply textable, broke on ${JSON.stringify({ outcomes, lineType })}`);
  }
}

console.log("verified-mobile.test.ts — all assertions passed");
