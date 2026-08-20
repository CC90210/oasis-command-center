/**
 * tests/destination-health.test.ts — stop texting numbers that cannot receive
 * texts.
 *
 * THE MEASUREMENT (2026-08-20), carrier verdicts by where the phone came from:
 *
 *   looked up (TruePeopleSearch)   8 delivered   3 failed
 *   typed in on the application    0 delivered  53 failed
 *
 * The "outage" of 2026-08-19 was this and nothing else. Live Subs delivered 8
 * of 8 on 08-18 to looked-up mobiles; the next day the viewed-application
 * sequence began working through application-provided numbers, which are office
 * landlines, and every send failed. Proven by replaying the exact refused
 * message from the same line to a mobile: it delivered.
 */

import assert from "node:assert/strict";
import {
  destinationVerdict, chooseTextableNumber, normalizeLast10,
  lineTypeFor, wirelessCandidates,
  FAILURES_BEFORE_UNTEXTABLE, type DestinationOutcome, type DestinationVerdict,
} from "../lib/sms/destination-health-core";

const o = (status: DestinationOutcome["status"], last10 = "7329943864"): DestinationOutcome =>
  ({ last10, status, at: "2026-08-19T18:01:00Z" });

// ── The landline signature: repeated failure, never a delivery ────────────
{
  const v = destinationVerdict([o("failed"), o("failed")]);
  assert.equal(v.textable, false);
  assert.match(v.reason, /landline/);
  assert.equal(v.failed, 2);
}

// ── ONE DELIVERY SETTLES IT FOREVER ──────────────────────────────────────
// A landline never delivers once. So a number that has delivered is a mobile,
// and later failures are about the handset (off, full, no coverage) — they must
// not bench a number we have proven reachable.
{
  const v = destinationVerdict([o("delivered"), o("failed"), o("failed"), o("failed")]);
  assert.equal(v.textable, true, "a proven mobile stays textable through later failures");
  assert.equal(v.delivered, 1);
  assert.equal(v.failed, 3);
  assert.match(v.reason, /delivered/);
}

// ── One failure is not enough to bench ───────────────────────────────────
// A handset can be off. Benching a real mobile costs a reachable merchant, and
// the second attempt costs one credit to buy certainty.
{
  const v = destinationVerdict([o("failed")]);
  assert.equal(v.textable, true);
  assert.match(v.reason, new RegExp(String(FAILURES_BEFORE_UNTEXTABLE)));
}

// ── FAILS OPEN on an unknown number, deliberately ────────────────────────
// We cannot learn that a number is a mobile without trying it once. Failing
// closed here would stop the channel entirely, which is a bigger error than one
// wasted message.
{
  const v = destinationVerdict([]);
  assert.equal(v.textable, true);
  assert.equal(v.reason, "no history");
}

// ── 'unknown' is not evidence in either direction ────────────────────────
// 15 receipts sat at 'unknown' for four days while the reconciler was broken.
// If those counted as failures, that outage would have benched every merchant
// it touched.
{
  const v = destinationVerdict([o("unknown"), o("unknown"), o("unknown")]);
  assert.equal(v.textable, true);
  assert.equal(v.failed, 0);
  assert.equal(v.delivered, 0);
  assert.equal(v.reason, "no history", "unknowns must not accumulate toward benching");
}

// ── Last-10 comparison, because formatting silently never matches ────────
for (const [input, expected] of [
  ["+1 (732) 994-3864", "7329943864"],
  ["17329943864", "7329943864"],
  ["732-994-3864", "7329943864"],
  ["7329943864", "7329943864"],
  ["", ""],
  ["12345", ""],
  [null, ""],
] as const) {
  assert.equal(normalizeLast10(input), expected, `normalizeLast10(${JSON.stringify(input)})`);
}

// ── Choosing between a lead's two numbers ────────────────────────────────
{
  const APP = "7329943864";      // typed on the application, proven untextable
  const MOBILE = "6154284280";   // looked up, proven to deliver
  const verdicts = new Map<string, DestinationVerdict>([
    [APP, destinationVerdict([o("failed", APP), o("failed", APP)])],
    [MOBILE, destinationVerdict([o("delivered", MOBILE)])],
  ]);

  // The whole point: do not drop the lead, switch to the number that works.
  const pick = chooseTextableNumber(
    [{ phone: "+1 732-994-3864", source: "provided" }, { phone: MOBILE, source: "looked_up" }],
    verdicts,
  );
  assert.deepEqual(pick, { last10: MOBILE, source: "looked_up" });

  // Proven delivery beats an unproven looked-up number.
  const preferProven = chooseTextableNumber(
    [{ phone: MOBILE, source: "provided" }, { phone: "5551234567", source: "looked_up" }],
    verdicts,
  );
  assert.equal(preferProven?.last10, MOBILE, "a number we have delivered to wins");

  // Nothing textable must return null, never a fallback to the bad number.
  const none = chooseTextableNumber([{ phone: "+1 732-994-3864", source: "provided" }], verdicts);
  assert.equal(none, null, "must not fall back to a number proven undeliverable");

  // No numbers at all.
  assert.equal(chooseTextableNumber([], verdicts), null);
  assert.equal(chooseTextableNumber([{ phone: "", source: "provided" }], verdicts), null);

  // An unknown number is usable — that is how we learn.
  const fresh = chooseTextableNumber([{ phone: "5559998888", source: "provided" }], verdicts);
  assert.equal(fresh?.last10, "5559998888");
}

// ── THE LOOKUP ALREADY TOLD US, AND WE WERE NOT LOOKING ──────────────────
// Every lead that has been through a phone lookup carries candidates tagged
// Wireless or Landline. Reading that costs nothing and is right the FIRST
// time. Failure-counting could never do this job: measured 2026-08-20, the 53
// failed destinations had exactly ONE failure each, so a two-strike rule would
// have texted every desk phone a second time to learn what was already on file.
{
  const CANDIDATES = [
    { type: "Wireless", number: "+12314630084" },
    { type: "Wireless", number: "+12314638020" },
    { type: "Landline", number: "+16165258310" },
    { type: "Landline", number: "+12162526271" },
  ];
  assert.equal(lineTypeFor("+1 616-525-8310", CANDIDATES), "landline");
  assert.equal(lineTypeFor("2314630084", CANDIDATES), "wireless");
  assert.equal(lineTypeFor("+15559998888", CANDIDATES), "unknown", "a number not in the list is unknown, not landline");
  assert.equal(lineTypeFor("+12314630084", null), "unknown");
  assert.equal(lineTypeFor("", CANDIDATES), "unknown");
  // Vendors spell it differently; all three mean the same thing.
  for (const t of ["Wireless", "mobile", "CELL"]) {
    assert.equal(lineTypeFor("+15551112222", [{ type: t, number: "+15551112222" }]), "wireless", t);
  }
  assert.deepEqual(wirelessCandidates(CANDIDATES), ["2314630084", "2314638020"], "landlines are excluded");
  assert.deepEqual(wirelessCandidates(null), []);

  // A landline is benched immediately, with no failures required at all.
  const v = destinationVerdict([], { lineType: "landline", last10: "6165258310" });
  assert.equal(v.textable, false);
  assert.match(v.reason, /landline/);
  assert.equal(v.failed, 0, "zero messages spent to reach this conclusion");

  // OBSERVATION BEATS CLASSIFICATION. If the lookup says landline but the
  // number has actually delivered, the lookup is wrong about it.
  const contradicted = destinationVerdict([o("delivered", "6165258310")], { lineType: "landline" });
  assert.equal(contradicted.textable, true, "a real delivery overrules the lookup's label");

  // Wireless is not a free pass: a wireless number that keeps failing still
  // gets benched by the failure rule.
  const badMobile = destinationVerdict([o("failed"), o("failed")], { lineType: "wireless" });
  assert.equal(badMobile.textable, false);
}

console.log("destination-health.test.ts — all assertions passed");
