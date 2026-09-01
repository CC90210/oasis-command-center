/**
 * web-leads-battlecard.test.ts — the numbers a rep says out loud.
 *
 * The battle card exists to convert a measurement into a sentence: *"you score
 * lower than 91% of 218 hair salons in Mississauga."* That sentence is said to
 * a stranger, on a live call, by someone who cannot check it. So the tests here
 * are not about rendering. They are about the four ways this feature could
 * hand a rep something false:
 *
 *   1. THE PERCENTILE COULD OVERSTATE. Counting ties as "worse than" turns a
 *      site level with its peers into the worst in town.
 *   2. THE PEER GROUP COULD BE TOO SMALL, OR SILENTLY SWAPPED. "Worse than 88%
 *      of them" against four businesses is arithmetic pretending to be
 *      evidence, and a percentile that quietly widened from "salons in
 *      Mississauga" to "every site in Canada" is a rep saying one thing while
 *      the number means another.
 *   3. THE EVIDENCE COULD INVENT A MEASUREMENT. A signal the crawler never
 *      recorded, printed as "0" or "No", is a fabricated finding.
 *   4. THE CARD COULD SCORE AN UNSCORED SITE. A radar with seven axes at the
 *      origin, for a site our crawler was simply blocked from, is an accusation
 *      with a chart around it.
 *
 * Plus the standing structural guards: the new endpoint is a new door onto the
 * same tenant_records table and must carry the identical auth gate, and the
 * competitor panel must never become a second way to read another rep's book.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  percentileAmong, median, groupStats, bucketOf, distributionOf, chooseSlice, labelFor, MIN_SLICE, TOP_N,
} from "../lib/web-leads/competitors";
import { ANGLES, OBJECTIONS, IF_THE_ANSWER_IS_CLEAN, selectAngle, recoverablePoints } from "../lib/web-leads/angles";
import { evidenceFrom } from "../lib/web-leads/evidence";
import { designateLead, CRATER_DESIGNATIONS, SHAPE_DESIGNATIONS } from "../lib/web-leads/lead-profile";
import { checkEvidenceFor, EXPLAINED_CODES } from "../lib/web-leads/check-evidence";
import { assessTrust, isShellSuspect, STALE_AFTER_DAYS } from "../lib/web-leads/trust";
import { validatedRecheckUrl, isPrivateIpv4 } from "../lib/web-leads/recheck-url";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
/** Assertions about CODE must not trip on the prose explaining the code. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// 1. The percentile understates, always.
// ---------------------------------------------------------------------------

assert.deepEqual(
  percentileAmong([80, 70, 60], 50),
  { lowerThanPct: 100, rank: 4, outOf: 4 },
  "a site below every peer is below 100% of them, ranked last",
);

assert.deepEqual(
  percentileAmong([10, 20, 30], 50),
  { lowerThanPct: 0, rank: 1, outOf: 4 },
  "a site above every peer is below none of them",
);

// THE TIE RULE, and the reason it is written the way it is. `>` not `>=`: four
// peers tied with the lead means nobody is beating them, which is what a rep
// can defend. Counting ties as "higher" would produce "lower than 100% of the
// salons in your area" for a business that is exactly average -- true of
// nothing, said aloud, unrecoverable.
assert.deepEqual(
  percentileAmong([50, 50, 50, 50], 50),
  { lowerThanPct: 0, rank: 1, outOf: 5 },
  "peers tied with the lead do not count as scoring higher",
);

// One peer higher out of four is 25%, not 20% and not 33%: the denominator is
// the peer group, and the lead is not its own competitor.
assert.deepEqual(percentileAmong([90, 40, 30, 20], 50), { lowerThanPct: 25, rank: 2, outOf: 5 });

// An empty peer group must not divide by zero and must not fabricate a rank.
assert.deepEqual(percentileAmong([], 50), { lowerThanPct: 0, rank: 1, outOf: 1 });

assert.equal(median([1, 2, 3]), 2);
assert.equal(median([1, 2, 3, 4]), 3, "an even split rounds rather than returning a fraction of a point");
assert.equal(median([]), 0);

// THE EXTREMA DESCRIBE THE GROUP THE LEAD IS RANKED IN, not the peers alone.
// The card renders "Rank 1 of 5. Best in that group scores 86" off these two
// side by side; computed over peers only, a lead scoring 90 against a best peer
// of 86 renders exactly that -- ranked first in a group whose stated best is
// lower than it is. A prospect spots that without knowing any statistics.
// (Codex review, 2026-08-24.)
{
  const peers = [86, 60, 40, 20];
  const stats = groupStats(peers, 90);
  assert.equal(stats.best, 90, "a lead above every peer IS the best of the group it is ranked in");
  assert.equal(percentileAmong(peers, 90).rank, 1);
  assert.ok(
    stats.best >= 90,
    "rank 1 with a stated group best below the lead's own score is a self-contradiction on screen",
  );

  const low = groupStats(peers, 5);
  assert.equal(low.worst, 5, "a lead below every peer IS the lowest of the group it is ranked in");
  assert.equal(low.best, 86);
}

// ---------------------------------------------------------------------------
// 2. Bucketing, and the eleventh-bucket artefact it avoids.
// ---------------------------------------------------------------------------

assert.equal(bucketOf(0), 0);
assert.equal(bucketOf(9), 0);
assert.equal(bucketOf(10), 1);
assert.equal(bucketOf(99), 9);
// 100 shares the top band rather than getting a bucket of its own: an eleventh
// bucket holding only perfect scores renders as a spike that is an artefact of
// the bucketing, not a fact about the corpus.
assert.equal(bucketOf(100), 9);

{
  const { buckets, leadBucket } = distributionOf([5, 15, 95], 45);
  assert.equal(buckets.length, 10);
  assert.equal(buckets[0], 1);
  assert.equal(buckets[1], 1);
  assert.equal(buckets[4], 1, "the lead itself is one of the measured sites in its own distribution");
  assert.equal(buckets[9], 1);
  assert.equal(buckets.reduce((a, b) => a + b, 0), 4);
  assert.equal(leadBucket, 4);
}

// ---------------------------------------------------------------------------
// 3. The fallback ladder never quotes a group too small, and never quotes one
//    silently.
// ---------------------------------------------------------------------------

assert.equal(MIN_SLICE, 8, "the floor a percentile may be quoted against");
assert.ok(TOP_N >= 1 && TOP_N <= 5, "a rep mid-call reads the top of a list, not a list");

{
  const thin = new Array(3).fill(0);
  const wide = new Array(12).fill(0);
  const { chosen, rejected } = chooseSlice([
    { kind: "industry_city", label: "Hair salon sites in Mississauga", peers: thin },
    { kind: "industry_province", label: "Hair salon sites in Ontario", peers: wide },
    { kind: "national", label: "Canadian sites", peers: new Array(500).fill(0) },
  ]);
  assert.equal(chosen?.kind, "industry_province", "a slice under MIN_SLICE is skipped");
  // The rejected slice is RETURNED, not discarded. This is what lets the card
  // say which comparison it actually made -- a percentile that widened without
  // saying so is the failure mode this whole ladder exists to avoid.
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0], {
    kind: "industry_city",
    label: "Hair salon sites in Mississauga",
    peerCount: 3,
  });
}

{
  // Exactly MIN_SLICE qualifies -- the floor is inclusive, or the boundary is
  // untested and the real threshold is 9.
  const { chosen } = chooseSlice([
    { kind: "industry_city", label: "x", peers: new Array(MIN_SLICE).fill(0) },
  ]);
  assert.equal(chosen?.kind, "industry_city");
}

{
  // Nothing wide enough anywhere: no percentile at all, rather than one against
  // seven sites with a hope that nobody asks.
  const { chosen, rejected } = chooseSlice([
    { kind: "industry_city", label: "a", peers: [1] },
    { kind: "national", label: "b", peers: [1, 2] },
  ]);
  assert.equal(chosen, null);
  assert.equal(rejected.length, 2);
}

assert.equal(
  labelFor("industry_city", { industry: "Hair Salon", city: "Mississauga", province: "Ontario" }),
  "Hair Salon sites in Mississauga",
);
assert.equal(
  labelFor("industry_province", { industry: "Hair Salon", city: "Mississauga", province: "Ontario" }),
  "Hair Salon sites in Ontario",
);
assert.equal(
  labelFor("industry_national", { industry: "Hair Salon", city: null, province: null }),
  "Hair Salon sites in Canada",
);
assert.equal(labelFor("national", { industry: null, city: null, province: null }), "Canadian sites");

// EVERY label must read correctly in EVERY sentence the card puts it in, not
// just the one it was written against. The national label used to be "sites we
// have measured across Canada", which produced "the 17,052 sites we have
// measured across Canada we have measured" in two of the three sentences below.
for (const kind of ["industry_city", "industry_province", "industry_national", "national"] as const) {
  const label = labelFor(kind, { industry: "Hair Salon", city: "Mississauga", province: "Ontario" });
  for (const sentence of [
    `Scores lower than 78% of the 218 ${label} we have measured.`,
    `The best-scoring ${label} we have measured.`,
    `Score bands across the ${label} we have measured`,
  ]) {
    assert.doesNotMatch(sentence, /we have measured[\s\S]*we have measured/, `${kind}: doubled phrasing in "${sentence}"`);
    assert.doesNotMatch(sentence, /across[\s\S]*across/, `${kind}: doubled "across" in "${sentence}"`);
  }
}
// The industry string is the tenant's own free text and is rendered as stored.
// Normalising it here is how "Health & Medical" reaches a prospect's screen as
// "health and medical".
assert.match(
  labelFor("industry_city", { industry: "Restaurants & Bars", city: "Québec", province: "QC" }),
  /Restaurants & Bars sites in Québec/,
);

// ---------------------------------------------------------------------------
// 4. The angles: complete, weighted, and hand-written.
// ---------------------------------------------------------------------------

const DIMENSION_KEYS = ["conversion", "trust", "design", "mobile", "content", "performance", "discoverability"];
for (const key of DIMENSION_KEYS) {
  const a = ANGLES[key];
  assert.ok(a, `no angle for ${key} -- a dimension with no angle is a hole in the product`);
  assert.ok(a.opener.length >= 40, `${key}: opener is a stub`);
  // The diagnostic question is the Sandler/SPIN beat: the prospect finds the
  // gap himself and cannot argue with a conclusion he reached. An angle that
  // ships without one is a rep asserting a defect at a stranger, which is the
  // exact pitch the SMB web-design field research says loses the call.
  assert.ok(a.diagnostic.length >= 30, `${key}: diagnostic is a stub`);
  assert.ok(a.diagnostic.includes("?"), `${key}: the diagnostic must actually be a question`);
  // OPEN, never yes-or-no. A dimension score is a total across several checks,
  // so a site can be losing an area badly and still pass the single thing the
  // rep asked about. A closed question invites the "yes, that works fine" that
  // makes the very next line on the card a false statement about a named
  // business on a live call. An open question survives a good answer.
  // (Codex review, 2026-08-24: the mobile diagnostic used to read "Can you get
  // to your phone number without pinching?" and the teach after it opened "That
  // is the whole thing, really.")
  //
  // Tested on the QUESTION SENTENCE, not on the whole string. A diagnostic may
  // legitimately open with an imperative ("Have a look at it now."), and a
  // whole-string match on a leading auxiliary flags that as closed when the
  // actual question three sentences later is "What did you have to do to get
  // there?". Split first, then judge only the parts that end in a question
  // mark.
  const questions = a.diagnostic.split(/(?<=[.?!])\s+/).filter((s) => s.trim().endsWith("?"));
  assert.ok(questions.length >= 1, `${key}: the diagnostic contains no question sentence`);
  for (const q of questions) {
    assert.doesNotMatch(
      q,
      /^(can|could|do|does|did|is|are|was|were|am|have|has|had|will|would|shall|should|may|might|must)\b/i,
      `${key}: "${q}" is answerable yes or no, so a clean answer makes the next line on the card a false claim`,
    );
  }
  // And it must actually open something up, not merely avoid a closed verb.
  assert.match(
    a.diagnostic,
    /\b(what|where|when|how|why|who|which|walk me through|tell me)\b/i,
    `${key}: the diagnostic asks nothing open`,
  );
  assert.ok(a.cost.length >= 40, `${key}: cost is a stub`);
  assert.ok(a.objection.says.length >= 8, `${key}: objection is a stub`);
  assert.ok(a.objection.response.length >= 30, `${key}: objection response is a stub`);
  assert.ok(a.build.length >= 30, `${key}: build is a stub`);
}
assert.equal(Object.keys(ANGLES).length, DIMENSION_KEYS.length, "one angle per dimension, no extras");

{
  // House rule for anything read aloud to a customer, same as remedies.ts.
  //
  // SPOKEN fields only. `proof` is deliberately NOT in this string: it is the
  // one field allowed to carry a research figure, it is labelled on the card as
  // held-in-reserve rather than as pitch copy, and it is checked separately
  // below for the thing that actually matters about a statistic, which is
  // whether a challenged rep can find where it came from.
  const all = Object.values(ANGLES)
    .map((a) => `${a.opener}${a.diagnostic}${a.cost}${a.objection.says}${a.objection.response}${a.build}`)
    .join(" ");
  assert.ok(!all.includes("—"), "no em dashes in anything a rep reads aloud");
  // A rep says these to a plumber, not to an engineer.
  assert.doesNotMatch(all, /viewport|schema\.org|\bDOM\b|render-block|\bLCP\b|\bTTFB\b|\bCTA\b/i, "jargon in an angle");
  // NOT ONE ANGLE QUOTES A MEASUREMENT. Copy that names a number is copy that
  // can be wrong about a specific business; the measured numbers are rendered
  // beside this, from the audit, where they are true by construction.
  assert.doesNotMatch(all, /\b\d+(\.\d+)?\s?(seconds?|MB|KB|ms|%)\b/i, "an angle quotes a measurement it cannot know");
  // We hold no revenue data for a single one of these businesses, so no spoken
  // line may put a currency figure on the problem. "You are losing $4,000 a
  // month" is the most persuasive sentence available and we cannot back one
  // word of it.
  assert.doesNotMatch(all, /[$£€]\s?\d|\bdollars?\b|\bper month in\b/i, "a spoken line puts money on a cost we never measured");
}

// The open question is only half the fix. A rep still needs to be told what to
// do with an answer that does not go his way, because the alternative is that
// he reads the next line anyway. This must exist, must be substantial, and must
// actually reach the card (asserted in section 8 below).
{
  assert.ok(IF_THE_ANSWER_IS_CLEAN.length >= 120, "the clean-answer instruction is a stub");
  assert.ok(!IF_THE_ANSWER_IS_CLEAN.includes("—"), "no em dashes in anything a rep reads");
  // It must send the rep somewhere real rather than just saying "back off".
  // "What is worth fixing first" is a panel that is already on the card.
  assert.match(
    IF_THE_ANSWER_IS_CLEAN,
    /what is worth fixing first/i,
    "the clean-answer instruction must route the rep to the ranked list already on the card",
  );
}

// Every proof is optional, but a proof WITHOUT a source is worse than no proof:
// it hands a rep a number to say and nothing to say when the prospect asks
// where it came from. The source must name a year so it can be looked up and so
// a rep can tell how old it is before quoting it.
for (const [key, a] of Object.entries(ANGLES)) {
  if (!a.proof) continue;
  assert.ok(a.proof.stat.length >= 40, `${key}: proof stat is a stub`);
  assert.ok(a.proof.source.length >= 20, `${key}: proof has no findable source`);
  assert.match(a.proof.source, /\b(19|20)\d{2}\b/, `${key}: proof source must name a year`);
  assert.ok(!`${a.proof.stat}${a.proof.source}`.includes("—"), `${key}: no em dashes in proof copy`);
}

// ---------------------------------------------------------------------------
// 4b. The objection panel: the brush-offs that arrive whatever the site is.
//
// PROVED TO FIRE, 2026-08-24, by planting each failure once and watching the
// assertion fail before reverting: a proof whose source was replaced with "a
// blog said so" (failed: "trust: proof has no findable source"), an objection
// whose prevention note was stubbed to "tbd" (failed: 'no prevention note for
// "Call me back in a few months."'), and the panel removed from the card
// (failed: "must render the objection panel"). The colour ban on
// ObjectionPanel.tsx was proved the same way in web-leads-guards.test.ts by
// planting text-red-400 on a heading.
// ---------------------------------------------------------------------------

// Every one of these was named by the operator as something reps hit on every
// call. Fewer than this and the panel has a hole a rep falls into mid-sentence.
assert.ok(OBJECTIONS.length >= 8, "the objection panel must cover at least the eight standing brush-offs");

{
  const seen = new Set<string>();
  for (const o of OBJECTIONS) {
    assert.ok(o.says.length >= 10, `objection is a stub: ${o.says}`);
    // EVERY objection has a response. This is the completeness guarantee the
    // panel exists to make: a card that renders a brush-off with no answer
    // under it is worse than not rendering it at all.
    assert.ok(o.response.length >= 40, `no usable response for "${o.says}"`);
    // Sandler: the stated objection is rarely the real one, and a rep who
    // answers the stated one convincingly wins the argument and loses the call.
    assert.ok(o.meaning.length >= 40, `no reading of what "${o.says}" actually means`);
    // Rackham, 35,000 observed calls: top performers did not answer objections
    // better, they received about a third as many. The prevention line is the
    // more valuable half and must never be optional.
    assert.ok(o.prevent.length >= 40, `no prevention note for "${o.says}"`);
    assert.ok(!seen.has(o.says), `duplicate objection: ${o.says}`);
    seen.add(o.says);
  }
}

{
  // Spoken half of the panel, same rules as an angle.
  const spoken = OBJECTIONS.map((o) => o.response).join(" ");
  assert.ok(!spoken.includes("—"), "no em dashes in an objection response");
  assert.doesNotMatch(spoken, /viewport|schema\.org|\bDOM\b|render-block|\bLCP\b|\bTTFB\b|\bCTA\b/i, "jargon in a response");
  assert.doesNotMatch(spoken, /\b\d+(\.\d+)?\s?(seconds?|MB|KB|ms|%)\b/i, "a response quotes a measurement");
  // Nor a price. We do not know what a rep is authorised to quote, and a number
  // baked into this table is a number a rep says on a call it does not apply
  // to. The "how much" entry answers the question and then scopes it.
  assert.doesNotMatch(spoken, /[$£€]\s?\d/, "a response quotes a price this table cannot know");

  // Coaching half. Numbers ARE allowed here because it is never read aloud,
  // which is exactly why it needs the stricter rule: any entry that cites a
  // figure must carry the source that figure came from.
  for (const o of OBJECTIONS) {
    const coaching = `${o.meaning} ${o.prevent}`;
    assert.ok(!coaching.includes("—"), `no em dashes in the coaching notes for "${o.says}"`);
    if (/\d+(\.\d+)?\s?%|\b\d+(\.\d+)?x\b|\b\d{2,3},\d{3}\b/.test(coaching)) {
      assert.ok(
        (o.source || "").length >= 20,
        `"${o.says}" cites a figure with no source -- a rep challenged on it has nothing to point at`,
      );
    }
  }
}

// CASL is the one legal edge in this panel. These are cold VOICE calls, which
// CASL does not govern, but "just send me an email" turns a call into a
// commercial electronic message and the onus of proving consent is ours. The
// response must actually ASK for permission rather than assume it, because a
// panel that coaches a rep to promise an email he is not allowed to send is a
// compliance defect wearing sales copy.
{
  const email = OBJECTIONS.find((o) => /send me an email/i.test(o.says));
  assert.ok(email, "the objection panel must cover 'just send me an email'");
  assert.match(email.response, /is it alright if I email you/i, "the email response must ask for consent in words");
  assert.match(email.prevent, /CASL/, "the email objection must flag the consent requirement to the rep");
  assert.match(email.prevent, /log it|record/i, "spoken consent we cannot evidence is consent we do not have");
  assert.ok((email.source || "").length >= 20, "the CASL note must cite where the rule comes from");

  // A yes is not consent unless the ASK was properly formed. CASL s.10(1)
  // requires a request for express consent to set out the purpose, to identify
  // who is asking with the contact information prescribed in the regulations,
  // and to say the person may withdraw. A script that skips those collects a
  // yes and still leaves us sending on defective consent, which is worse than
  // not asking, because the card told the rep it was handled. (Codex review,
  // 2026-08-24, confirmed against CASL s.10(1) and the ECPR before fixing.)
  assert.match(
    email.response,
    /same company and the same number/i,
    "the consent request must identify who is asking and how to reach them",
  );
  assert.match(
    email.response,
    /only ever be about your website/i,
    "the consent request must state the purpose it is being sought for",
  );
  assert.match(
    email.response,
    /tell me to stop at any time/i,
    "the consent request must state that consent can be withdrawn",
  );
  assert.match(email.source || "", /10\(1\)/, "the source must cite the section that sets the shape of the request");
}

// Weighted, not raw. A conversion 50 (weight 0.28) is losing 14 composite
// points; a discoverability 0 (weight 0.05) is losing 5. Ranking on the raw
// score sends a rep into the smaller conversation and the smaller build.
{
  const picked = selectAngle([
    { key: "conversion", label: "Turning visitors into calls", score: 50, weight: 0.28 },
    { key: "discoverability", label: "Being found", score: 0, weight: 0.05 },
  ]);
  assert.equal(picked?.key, "conversion", "the angle follows weighted points, not the lowest raw score");
}

// Floating point, so compared within a tolerance rather than exactly: 50 * 0.28
// is 14.000000000000002 in IEEE 754, and the card renders it to one decimal.
assert.ok(Math.abs(recoverablePoints({ score: 50, weight: 0.28 }) - 14) < 1e-9);
assert.equal(recoverablePoints({ score: 100, weight: 0.28 }), 0, "a full-marks dimension has nothing to recover");
assert.equal(recoverablePoints({ score: 120, weight: 0.28 }), 0, "never a negative recoverable amount");

{
  // A genuine tie resolves toward conversion, then trust -- the two that
  // convert into money fastest for the prospect and are cheapest for us.
  const tie = [
    { key: "content", label: "Explaining the service", score: 50, weight: 0.1 },
    { key: "trust", label: "Looking credible", score: 50, weight: 0.1 },
    { key: "conversion", label: "Turning visitors into calls", score: 50, weight: 0.1 },
  ];
  assert.equal(selectAngle(tie)?.key, "conversion");
  assert.equal(selectAngle(tie.filter((d) => d.key !== "conversion"))?.key, "trust");
}

// An unknown dimension key must not produce an angle, and must not throw: a
// future model version adding a dimension must degrade to "no angle", never to
// a card that renders `undefined` at a prospect.
assert.equal(selectAngle([{ key: "not_a_dimension", label: "x", score: 0, weight: 1 }]), null);
assert.equal(selectAngle([]), null);

// ---------------------------------------------------------------------------
// 5. The evidence never invents a measurement.
// ---------------------------------------------------------------------------

assert.deepEqual(evidenceFrom(null), []);
assert.deepEqual(evidenceFrom(undefined), []);
assert.deepEqual(evidenceFrom({}), [], "an empty signal blob renders no headings, not empty ones");

{
  // A MEASURED ZERO IS A MEASUREMENT and must render. This is the mirror of the
  // rule below it, and the two are easy to conflate: "we looked and found none"
  // is a finding, "we never looked" is not.
  const groups = evidenceFrom({ telLinks: 0 });
  const flat = groups.flatMap((g) => g.rows);
  assert.equal(flat.length, 1);
  assert.equal(flat[0].value, "0");
  assert.match(flat[0].label, /Tap-to-call/);
  // A key the crawler never wrote is absent, not a zero and not a "No".
  assert.ok(
    !groups.some((g) => g.rows.some((r) => /Viewport/.test(r.label))),
    "a signal we did not measure must not render as an absence we did measure",
  );
}

{
  const rows = evidenceFrom({ hasViewportMeta: false, isHttps: true }).flatMap((g) => g.rows);
  assert.deepEqual(
    rows.map((r) => r.value).sort(),
    ["Not found", "Yes"],
    "booleans render as what the crawler saw, never as a verdict like 'Missing'",
  );
}

{
  // Formatting is for reading aloud. 4,404,019 is unreadable; 4.2 MB is a
  // sentence a rep can say.
  const rows = evidenceFrom({ bytes: 4_404_019, ttfbMs: 412, wordCount: 128 }).flatMap((g) => g.rows);
  const values = rows.map((r) => r.value);
  assert.ok(values.includes("4.2 MB"), `expected a human page weight, got ${values.join(", ")}`);
  assert.ok(values.includes("412 ms"));
  assert.ok(values.includes("128 words"));
}

// A signal of the wrong TYPE is dropped rather than coerced. `String(raw)` here
// would print "many" as though we had counted it.
assert.deepEqual(evidenceFrom({ telLinks: "many" }), []);
assert.deepEqual(evidenceFrom({ hasViewportMeta: "sort of" }), []);

// ---------------------------------------------------------------------------
// 6. The endpoint is a NEW DOOR onto tenant_records and carries the same gate.
//
// libSQL has no row-level security, so the route IS the authorization boundary.
// The sibling routes ACTUALLY leaked every Web Studio lead to any authenticated
// user of any tenant by resolving session.tenantId and never reading it, and a
// presence-only grep for `status: 401` passed the entire time that was broken.
// ---------------------------------------------------------------------------

{
  const route = "app/api/web-leads/[id]/battlecard/route.ts";
  const src = read(route);
  assert.match(src, /resolveSessionContext/, `${route} must resolve the caller`);
  assert.match(
    src,
    /if\s*\(\s*!\s*session\.ok\s*\)/,
    `${route} must branch on session.ok -- resolveSessionContext returns a union that is always truthy`,
  );
  assert.match(src, /status:\s*401/, `${route} must fail closed on an unresolved caller`);
  assert.match(src, /session\.tenantId\s*!==\s*WEBDEV_TENANT_ID/, `${route} must constrain the caller to the tenant`);
  assert.match(src, /status:\s*403/, `${route} must refuse a caller from another tenant`);
  // The outside-contractor role lives INSIDE this tenant (#237), so a tenant
  // match is not proof a caller may see every lead in it.
  //
  // Accept EITHER an inline viewer or delegation to the canonical resolver, and
  // assert the resolver itself carries role + admin. This mirrors the identical
  // check in tests/web-leads-guards.test.ts, and it is not a loosening: before,
  // this grep only proved the route MENTIONED the role, which a route could do
  // while dropping it on the floor. Pinning the shared resolver proves the bits
  // actually reach the viewer for every route that delegates -- which this one
  // now does, via lib/web-leads/viewer.ts.
  const buildsViewerInline =
    /session\.teamRole/.test(src) && /session\.isAdmin/.test(src);
  const usesCanonicalViewer = /resolveWebLeadViewer\(session\)/.test(src);
  assert.equal(
    buildsViewerInline || usesCanonicalViewer,
    true,
    `${route} must build a viewer carrying the caller's role and admin flag, inline or via resolveWebLeadViewer`,
  );
  const battlecardViewerResolver = read("lib/web-leads/viewer.ts");
  assert.match(
    battlecardViewerResolver,
    /session\.teamRole/,
    "lib/web-leads/viewer.ts must put the caller's role on the viewer",
  );
  assert.match(
    battlecardViewerResolver,
    /session\.isAdmin/,
    "lib/web-leads/viewer.ts must put the caller's admin flag on the viewer",
  );
  // An id outside the viewer's scope must read exactly like an id that does not
  // exist, or the endpoint becomes a way to probe which leads exist.
  assert.match(src, /fetchLead\(id, viewer\)[\s\S]{0,200}?status:\s*404/, `${route} must 404 an out-of-scope id`);

  // RULE 4: competitor data is only ever attached to a SCORED audit. Treating
  // "we could not reach the site" as a zero would rank a business dead last in
  // its own city on the strength of a failed crawl.
  assert.match(
    src,
    /audit\.state !== "scored"[\s\S]{0,240}?competitors: null/,
    `${route} must not attach a percentile, a rank or a head-to-head to a non-scored audit`,
  );
}

// ---------------------------------------------------------------------------
// 7. The competitor read: complete, tenant-pinned, and not a second door onto
//    another rep's book.
// ---------------------------------------------------------------------------

{
  const src = read("lib/web-leads/competitors.ts");
  const code = stripComments(src);

  const froms = (code.match(/\.from\(/g) || []).length;
  const pins = (code.match(/\.eq\("tenant_id",\s*WEBDEV_TENANT_ID\)/g) || []).length;
  assert.ok(froms > 0, "competitors.ts must actually read something");
  assert.equal(pins, froms, `every read must pin the tenant (${froms} reads, ${pins} pinned)`);

  // A short read here does not blank the card. It quietly SHRINKS the peer
  // group, and a percentile computed against a silently-truncated slice is a
  // wrong number a rep reads aloud. Proved against the read's own match count,
  // never against our cap -- PostgREST enforces a server-side max-rows a cap
  // comparison never sees.
  assert.match(code, /\{ count: "exact" \}/, "the corpus scan must request an exact count");
  assert.match(code, /assertCompleteRead\(/, "the corpus scan must prove it was not truncated");
  assert.match(code, /memo\(/, "the corpus must be memoised -- it is a whole-table read");
  assert.match(code, /TTL\.CORPUS/, "the corpus TTL must be its own, not the ten-second leads TTL");

  // `.is("profile", "not.null")` reads better and only works on our Turso
  // adapter: real supabase-js serialises it to `profile=is.not.null`, which
  // PostgREST rejects outright, so every request 500s on that path. Banned by
  // name here so it cannot creep back in through this module.
  assert.doesNotMatch(
    code,
    /\.is\(\s*["']profile["']\s*,\s*["']not\.null["']\s*\)/,
    'the adapter-only `.is("profile","not.null")` form must never appear -- use .not("profile","is",null)',
  );

  // NOTHING FROM ANOTHER REP'S BOOK. A competitor is a public business name, a
  // location, a public URL and OUR measurement. No lead id, no phone, no
  // address, no owner, no stage, no claim state -- otherwise this panel becomes
  // a way to enumerate somebody else's pipeline, which is exactly what PR #237
  // closed.
  for (const forbidden of ["phone", "assigned_to", "assignedTo", "business_address", "lastCallAt"]) {
    assert.doesNotMatch(
      code,
      new RegExp(`\\b${forbidden}\\b`),
      `competitors.ts must never surface ${forbidden} -- a competitor is a measurement, not a lead`,
    );
  }
  // `stage` guarded separately: the word appears in no code path here, and if
  // one is ever added it must be caught by the same rule.
  assert.doesNotMatch(code, /\bstage\b/, "competitors.ts must never surface a lead's pipeline stage");
}

// ---------------------------------------------------------------------------
// 8. The card itself: sentences for the three non-scored states, safe external
//    links, and no chart library.
// ---------------------------------------------------------------------------

{
  const view = "components/web-leads/BattleCard.tsx";
  const src = read(view);

  // The three honest states, VERBATIM. A radar with all seven axes at the
  // origin for a site our crawler was blocked from is a fabricated accusation
  // with a gradient on it.
  assert.match(src, /No website found yet, needs checking/, `${view} must render the hedged no-website sentence`);
  assert.match(src, /We could not check this site\./, `${view} must render a sentence for the unreachable state`);
  assert.match(src, /Not scored yet\./, `${view} must render a sentence for the never-scored state`);
  assert.doesNotMatch(src, /"No website"/, `${view} must not render a bare "No website" verdict`);

  // The gate itself, not just the sentences: no chart may render for a
  // non-scored lead.
  assert.match(
    src,
    /audit\.state !== "scored"[\s\S]{0,160}?<NotScored/,
    `${view} must route every non-scored state to the sentence renderer before any chart`,
  );

  // Every external link goes through preferredSiteUrl (bare domains navigate
  // inside our own dashboard; these URLs come from OpenStreetMap, which anyone
  // can edit) and carries rel="noopener noreferrer" (without it the opened tab
  // reaches back through window.opener). Twice: the prospect's site, and the
  // competitor's -- the second is the one a refactor forgets.
  const preferred = (src.match(/preferredSiteUrl\(/g) || []).length;
  assert.ok(preferred >= 2, `${view} must resolve BOTH the prospect's and the competitors' URLs safely`);
  const externals = (src.match(/target="_blank"[\s\S]{0,160}?rel="noopener noreferrer"/g) || []).length;
  const blanks = (src.match(/target="_blank"/g) || []).length;
  assert.equal(externals, blanks, `every target="_blank" in ${view} must carry rel="noopener noreferrer"`);

  // prefers-reduced-motion disables all of it. Non-negotiable: a rep on a call
  // does not need things moving.
  assert.match(src, /prefers-reduced-motion/, `${view} must honour prefers-reduced-motion`);

  // "The best-scoring" is only ever said about the actual best-scoring site.
  // buildHeadToHead falls through to the next candidate when the top one has no
  // readable profile, and the card previously described whatever came back as
  // the best in the slice -- a false claim about a named business, on a live
  // call, in exactly the case the fallback exists to handle. (Codex review,
  // 2026-08-24.) The superlative must sit behind the rank check.
  assert.match(
    src,
    /headToHead\.rankInSlice === 1[\s\S]{0,200}?The best-scoring/,
    `${view} must gate the "best-scoring" claim on the competitor actually being ranked first`,
  );
  const superlatives = (src.match(/The best-scoring of the/g) || []).length;
  assert.equal(superlatives, 1, `${view} must not repeat the superlative outside the rank check`);

  // Hand-rolled SVG, on purpose. A chart library ships its own colour defaults
  // into a surface whose central rule is that no colour may be keyed to a
  // score. (recharts IS in package.json for other surfaces, which is exactly
  // why this is asserted rather than assumed.)
  for (const lib of ["recharts", "chart.js", "d3", "victory", "nivo"]) {
    assert.doesNotMatch(src, new RegExp(`from ["']${lib.replace(".", "\\.")}`), `${view} must not import ${lib}`);
  }

  // Copy is hand-written and rendered verbatim. Nothing on this page is
  // generated per lead, ever.
  assert.doesNotMatch(src, /claudeMessages|anthropic|openai|generateText/i, `${view} must never generate copy per lead`);
  assert.match(src, /remedyFor/, `${view} must render the hand-written remedy copy`);
  assert.match(src, /selectAngle/, `${view} must render the hand-written angle copy`);

  // All three spoken beats reach the screen, in order. Rendering the opener and
  // the teach but dropping the diagnostic question would leave a rep asserting
  // a defect at a stranger with nothing asked in between, which is the one
  // sequence the SMB field research and Rackham's objection-prevention data
  // agree destroys the call. The ORDER is asserted, not just the presence:
  // delivering the teach before the prospect has answered is precisely what
  // manufactures the objection to it.
  assert.match(
    src,
    /angle\.angle\.opener[\s\S]{0,900}?angle\.angle\.diagnostic[\s\S]{0,1200}?angle\.angle\.cost/,
    `${view} must render opener, then diagnostic, then cost, in that order`,
  );
  // The reserve statistic never renders without the source beside it.
  assert.match(
    src,
    /angle\.angle\.proof\.stat[\s\S]{0,400}?angle\.angle\.proof\.source/,
    `${view} must render a proof's source alongside the figure`,
  );
  // The standing brush-offs are on the card, not in a rep's memory. `bare`
  // because BattleSection provides the shell and heading -- the panel's copy
  // is unchanged, and its own file is asserted on below either way.
  assert.match(src, /<ObjectionPanel bare \/>/, `${view} must render the objection panel`);

  // The clean-answer instruction sits WITH the question, before the teach. A
  // rep reads down this card in real time, so the order on screen is the order
  // he speaks: if this lands after the cost block it arrives one sentence too
  // late to stop the false claim it exists to prevent.
  assert.match(
    src,
    /angle\.angle\.diagnostic[\s\S]{0,700}?IF_THE_ANSWER_IS_CLEAN[\s\S]{0,700}?angle\.angle\.cost/,
    `${view} must render the clean-answer instruction between the diagnostic and the teach`,
  );
}

// ---------------------------------------------------------------------------
// 8b. PROGRESSIVE DISCLOSURE (Adon, 2026-08-31): every section collapsible,
//     with the call-critical ones open by default.
//
// The card originally rendered everything open; Adon reviewed it in use and
// asked for per-section collapse ("it's just so much information that's in
// front of your face"). The compromise that keeps the original mid-call
// argument alive is THE DEFAULT MAP: the opening script, the lead line, the
// two graphs and the competitors cost zero clicks, and only the reference
// blocks start closed. This section pins that map, because the failure mode
// of a collapsible card is one edit quietly flipping `defaultOpen` on "How to
// open" and a rep discovering it mid-dial.
// ---------------------------------------------------------------------------

{
  const view = "components/web-leads/BattleCard.tsx";
  const src = read(view);

  // The map itself. Prop order (id, then defaultOpen) is part of the contract
  // so these stay one-line greppable.
  for (const [id, open] of [
    ["facts", false],
    ["lead-with", true],
    ["opening", true],
    ["brushoffs", false],
    ["shape", true],
    ["fixes", true],
    ["competitors", true],
    ["faults", false],
    ["evidence", false],
  ] as const) {
    assert.match(
      src,
      new RegExp(`<BattleSection\\s+id="${id}"\\s+defaultOpen=\\{${open}\\}`),
      `${view}: section "${id}" must default ${open ? "OPEN -- it is read mid-call and may not cost a click" : "CLOSED -- it is reference material behind a labelled teaser"}`,
    );
  }

  // Every closed-by-default section carries a teaser. A closed section with no
  // teaser is a mystery drawer, and a rep will not open a mystery mid-call.
  for (const id of ["facts", "brushoffs", "faults", "evidence"]) {
    assert.match(
      src,
      new RegExp(`id="${id}"[\\s\\S]{0,600}?teaser=`),
      `${view}: closed section "${id}" must say what is inside it while closed`,
    );
  }

  // The card's one write surface is NOT collapsible: logging an outcome IS the
  // transfer to the pipeline, and it must never end a call behind a closed
  // drawer. CallOutcomeLog stays in a plain Panel, not a BattleSection.
  assert.doesNotMatch(
    src,
    /<BattleSection[^>]*>[\s\S]{0,400}?<CallOutcomeLog/,
    `${view} must not put the call log behind a disclosure`,
  );

  // The escape hatch back to the original everything-open page.
  assert.match(src, /<SectionToolbar \/>/, `${view} must render the expand-all / collapse-all controls`);

  // The shell itself: accessible, persistent, and named per section.
  const shell = read("components/web-leads/BattleSection.tsx");
  assert.match(shell, /aria-expanded/, "BattleSection must expose its open state to assistive tech");
  assert.match(shell, /localStorage/, "BattleSection must persist a rep's choice across leads");
  assert.match(
    shell,
    /oasis\.battlecard\.section\./,
    "BattleSection keys persistence per section -- one key for all sections is one preference pretending to be nine",
  );
  assert.match(shell, /Expand all/, "the toolbar must offer the one-click return to everything-open");

  // The graphs' interactivity is selection, and selection is buttons in the
  // dimension list -- the radar's pointer targets are a convenience layered on
  // top, because the radar is display:none below `sm`. If the buttons go, the
  // phone loses the interaction entirely.
  assert.match(src, /aria-pressed=\{active\}/, `${view}: the dimension list must be the accessible selection path`);

  // 8c. THE HUD PALETTE (Adon, 2026-09-01): colour is IDENTITY, never verdict.
  // Every dimension must have its own fixed hue in DIM_HUES (now in
  // battle-hud.ts, shared by the SVG hologram and the WebGL radar so two
  // charts can never disagree about which blue is "trust") -- one area
  // falling through to the grey fallback breaks the "this colour IS trust"
  // coding on the radar, the list, and the fix ranking at once. The verdict
  // colours stay banned by web-leads-guards.test.ts; this asserts the
  // identity half of the rule.
  const hud = read("components/web-leads/battle-hud.ts");
  for (const key of DIMENSION_KEYS) {
    assert.match(
      hud,
      new RegExp(`DIM_HUES[\\s\\S]{0,700}?\\b${key}:`),
      `battle-hud.ts: dimension "${key}" must carry a fixed identity hue in DIM_HUES`,
    );
  }
  // The four SVG hologram layers must all exist -- they are the ONLY radar on
  // phones, under reduced motion, and wherever WebGL is unavailable. Lose one
  // and the fallback either goes flat (no shadow/data separation) or dead
  // (no hits).
  for (const layerName of ['layer="base"', 'layer="shadow"', 'layer="data"', 'layer="hits"']) {
    assert.ok(src.includes(layerName), `${view}: the hologram stack must render ${layerName}`);
  }

  // 8d. THE WEBGL RADAR (Adon, 2026-09-01: "3D imaging... a big leap"). The
  // operator overrode the no-chart-library weight rule for this one chart;
  // what survives is its cost discipline, and THAT is what gets pinned:
  const r3d = read("components/web-leads/Radar3D.tsx");
  // three.js must be code-split: a static import would put ~600KB into the
  // shared bundle for every rep on every surface, including the phones and
  // reduced-motion users who never see the scene.
  assert.match(r3d, /await import\("three"\)/, "Radar3D must lazy-load three.js inside an effect");
  assert.doesNotMatch(
    r3d,
    /^import (?!type\b)[^\n]*from "three"/m,
    "Radar3D must not import three statically -- `import type` only, so the runtime library stays code-split",
  );
  // A rep pages through many leads a shift; a leaked GL context per lead
  // kills the tab by lunch.
  assert.match(r3d, /renderer\.dispose\(\)/, "Radar3D must dispose the WebGL renderer on unmount");
  // The mount gate: never on phones (state, not CSS -- hidden canvas still
  // downloads the library), never under reduced motion, and one frame late so
  // the reduced-motion preference has actually been read.
  assert.match(
    src,
    /drawn && !reduced && desktop && gl !== "off"/,
    `${view}: the WebGL radar must be gated on drawn + reduced-motion + desktop + not-failed`,
  );
  // The failure path must exist and must fall back, not blank: onStatus(false)
  // flips gl to "off", which re-mounts nothing and keeps the SVG stack.
  assert.match(src, /onStatus=\{\(ok\) => setGl\(ok \? "on" : "off"\)\}/, `${view}: the 3D radar must report failure so the SVG fallback stays`);
  // Both Codex-found blank-radar holes, pinned (2026-09-01): the SVG hides on
  // the LIVE condition (so a reduced-motion flip after init brings it back),
  // and a lost GL context reports failure instead of freezing over a hidden
  // fallback.
  assert.match(
    src,
    /const glLive = drawn && !reduced && desktop && gl === "on"/,
    `${view}: the SVG fallback must key on the full is-3D-actually-visible condition, not on gl alone`,
  );
  assert.match(r3d, /webglcontextlost/, "Radar3D must fall back to the SVG when the GL context is lost");
}

// ---------------------------------------------------------------------------
// 8e. THE SCORE EXPLAINS ITSELF (Adon, 2026-09-01): "you have to explain in
//     detail why you're giving that score... pinpoint things in the website
//     that are showing that. If it is just random numbers you're generating,
//     that's a problem of its own."
//
// The numbers were never random -- every area score is check-points earned
// out of 100, every check a boolean the crawler computed from a measured
// signal (services/leadgen/lib/quality-model.js). What was missing was the
// JOIN on the card: check-evidence.ts verbalizes the stored measurement
// behind each check. These tests hold that layer to the same honesty rules
// as everything else a rep reads aloud.
// ---------------------------------------------------------------------------

// The canonical code list, mirrored from quality-model.js CHECKS. If the
// model gains a check, this list and check-evidence.ts must both learn it in
// the same change -- an unexplained check renders as a bare verdict again.
const MODEL_CODES = [
  // conversion
  "tel_link", "phone_in_header", "contact_form", "short_form", "cta_present",
  "cta_above_fold", "booking", "email_route", "chat", "multi_route",
  // trust
  "testimonials", "review_platform", "credentials", "real_photos", "address",
  "map", "years_trading", "guarantee", "social_proof",
  // design
  "modern_layout", "web_fonts", "not_default_tpl", "image_rich",
  "no_dated_markup", "consistent_brand", "favicon", "no_builder_badge",
  // mobile
  "viewport", "responsive_css", "no_fixed_width", "tap_targets", "no_flash",
  // content
  "substantial", "service_detail", "headings", "service_area",
  "pricing_signal", "fresh",
  // performance
  "fast_ttfb", "lean_html", "few_blocking", "https",
  // discoverability
  "title", "meta_desc", "local_schema", "og_tags", "h1", "analytics", "sitemap",
];

{
  // Complete, and exactly complete: an orphan explanation is a sentence about
  // a check that no longer exists, which a rep would still read aloud.
  for (const code of MODEL_CODES) {
    assert.ok(EXPLAINED_CODES.includes(code), `check-evidence.ts must explain "${code}"`);
  }
  assert.equal(
    EXPLAINED_CODES.length,
    MODEL_CODES.length,
    "check-evidence.ts explains codes the model does not have -- stale copy about a retired check",
  );

  // NEVER INVENTS. An empty or missing blob produces no sentence for any
  // code: a missing line is honest, a guessed one is not.
  for (const code of MODEL_CODES) {
    assert.equal(checkEvidenceFor(code, {}), null, `${code}: must render nothing when the crawl recorded nothing`);
    assert.equal(checkEvidenceFor(code, null), null, `${code}: must render nothing for a null blob`);
  }
  assert.equal(checkEvidenceFor("not_a_check", { telLinks: 3 }), null, "an unknown code renders nothing, never a guess");

  // A MEASURED ZERO IS A MEASUREMENT. "0 found" is the exact pinpoint the
  // operator asked for; suppressing it would hide the strongest evidence.
  assert.match(checkEvidenceFor("tel_link", { telLinks: 0 })!, /^0 tap-to-call links found/);
  assert.match(checkEvidenceFor("substantial", { wordCount: 0 })!, /^0 words/);

  // THE BARS ARE NAMED, WITH THE SITE'S OWN NUMBER BESIDE THEM. These
  // literals are display copy of quality-model.js thresholds; if the model's
  // bars ever move, this pin fails loudly instead of the copy lying quietly.
  const ttfb = checkEvidenceFor("fast_ttfb", { ttfbMs: 2340 })!;
  assert.match(ttfb, /2,340 ms/, "the site's own measured number must be in the sentence");
  assert.match(ttfb, /800 ms/, "the pass bar must be named beside the measurement");
  const weight = checkEvidenceFor("lean_html", { bytes: 4_404_019 })!;
  assert.match(weight, /4\.2 MB/);
  assert.match(weight, /500 KB/);
  assert.match(checkEvidenceFor("substantial", { wordCount: 128 })!, /128 words[\s\S]*300 or more/);
  assert.match(checkEvidenceFor("short_form", { formCount: 1, maxFormFields: 11 })!, /11 fields[\s\S]*six or fewer/);
  assert.match(checkEvidenceFor("few_blocking", { blockingScripts: 9 })!, /9 scripts[\s\S]*five or fewer/);
  assert.match(checkEvidenceFor("image_rich", { contentImages: 2 })!, /2 content images[\s\S]*six or more/);
  assert.match(checkEvidenceFor("real_photos", { contentImages: 1, stockOnly: true })!, /stock[\s\S]*four or more/);
  // Both measurements or nothing: a count without the stock verdict would let
  // the sentence contradict the stored FAIL it explains. (Codex, 2026-09-01.)
  assert.equal(
    checkEvidenceFor("real_photos", { contentImages: 8 }),
    null,
    "real_photos must not render evidence from the image count alone",
  );

  // Every code produces a sentence when its signals ARE recorded, in both the
  // failing and the passing shape, and every sentence obeys the house rules
  // for words a rep reads aloud (same bans as angles.ts / remedies.ts).
  const FAIL_BLOB: Record<string, unknown> = {
    telLinks: 0, phoneInHeader: false, formCount: 0, maxFormFields: 0, ctaCount: 0,
    ctaAboveFold: false, hasBooking: false, mailtoLinks: 0, hasChat: false,
    hasTestimonials: false, hasReviewWidget: false, hasCredentials: false,
    contentImages: 1, stockOnly: true, hasPostalAddress: false, hasMap: false,
    hasYearsInBusiness: false, hasGuarantee: false, socialLinks: 0,
    usesFlexOrGrid: false, hasWebFonts: false, looksDefaultTemplate: true,
    deprecatedTagCount: 7, layoutTables: 5, hasLogo: false, distinctColors: 1,
    hasFavicon: false, builderBadge: true, hasViewportMeta: false,
    hasMediaQueries: false, hasResponsiveFramework: false, hasFixedWidthBody: true,
    hasMobileNav: false, hasFlash: true, wordCount: 128, serviceMentions: 1,
    internalPages: 1, headingCount: 1, mentionsServiceArea: false,
    mentionsPricing: false, copyrightFresh: false, ttfbMs: 2340, bytes: 4_404_019,
    blockingScripts: 9, isHttps: false, hasTitle: false, hasMetaDescription: false,
    hasLocalBusinessSchema: false, hasOgTags: false, h1Count: 0,
    hasAnalytics: false, hasSitemapRef: false,
  };
  const PASS_BLOB: Record<string, unknown> = {
    telLinks: 2, phoneInHeader: true, formCount: 1, maxFormFields: 4, ctaCount: 3,
    ctaAboveFold: true, hasBooking: true, mailtoLinks: 1, hasChat: true,
    hasTestimonials: true, hasReviewWidget: true, hasCredentials: true,
    contentImages: 8, stockOnly: false, hasPostalAddress: true, hasMap: true,
    hasYearsInBusiness: true, hasGuarantee: true, socialLinks: 3,
    usesFlexOrGrid: true, hasWebFonts: true, looksDefaultTemplate: false,
    deprecatedTagCount: 0, layoutTables: 0, hasLogo: true, distinctColors: 4,
    hasFavicon: true, builderBadge: false, hasViewportMeta: true,
    hasMediaQueries: true, hasResponsiveFramework: true, hasFixedWidthBody: false,
    hasMobileNav: true, hasFlash: false, wordCount: 900, serviceMentions: 6,
    internalPages: 9, headingCount: 8, mentionsServiceArea: true,
    mentionsPricing: true, copyrightFresh: true, ttfbMs: 240, bytes: 180_000,
    blockingScripts: 1, isHttps: true, hasTitle: true, hasMetaDescription: true,
    hasLocalBusinessSchema: true, hasOgTags: true, h1Count: 1,
    hasAnalytics: true, hasSitemapRef: true,
  };
  const allLines: string[] = [];
  for (const code of MODEL_CODES) {
    const fail = checkEvidenceFor(code, FAIL_BLOB);
    const pass = checkEvidenceFor(code, PASS_BLOB);
    assert.ok(fail, `${code}: must produce a sentence from a fully-recorded failing crawl`);
    assert.ok(pass, `${code}: must produce a sentence from a fully-recorded passing crawl`);
    allLines.push(fail!, pass!);
  }
  const all = allLines.join(" ");
  assert.ok(!all.includes("—"), "no em dashes in anything a rep reads aloud");
  assert.doesNotMatch(all, /viewport|schema\.org|\bDOM\b|render-block|\bLCP\b|\bTTFB\b|\bCTA\b/i, "jargon in a measured sentence");
  assert.doesNotMatch(all, /[$£€]\s?\d|\bdollars?\b/i, "a measured sentence puts money on a cost we never measured");

  // And the card actually renders the join: the measured line beside every
  // failing check in all three detail surfaces, and the arithmetic beside
  // every area score.
  const view = "components/web-leads/BattleCard.tsx";
  const src = read(view);
  assert.match(src, /import \{ checkEvidenceFor \}/, `${view} must render the measured sentences`);
  const measuredUses = (src.match(/<MeasuredLine code=/g) || []).length;
  assert.ok(measuredUses >= 3, `${view}: the measured line must reach the faults list, the fix drill-down and the detail panel (found ${measuredUses})`);
  assert.match(src, /of 100 points earned/, `${view} must show the area score's arithmetic`);
  assert.match(src, /of this area(&apos;|')s 100 pts/, `${view} must show each failing check's exact worth`);
}

// ---------------------------------------------------------------------------
// 8f. TRUST, OR NO NUMBER (Adon, 2026-09-01): "if you can't scrape certain
//     data, or you can't really score the website, or if you're uncertain,
//     then you don't generate information. You just say it."
//
// His decision on the record: a score we cannot stand behind is HIDDEN with
// the reason in plain words, never shown wearing a warning label. The trust
// module derives everything from STORED data; these tests pin every verdict
// and the wiring that renders them.
// ---------------------------------------------------------------------------

{
  const scored = {
    state: "scored" as const,
    url: "https://example.test",
    measuredAt: new Date().toISOString(),
    composite: 42,
    dimensions: [],
  };
  const unknownUrl = { verdict: "unknown" as const, verifiedAt: null };

  // THE SHELL FINGERPRINT hides the score: almost no readable text plus
  // machinery = a browser-built site our raw-HTTP crawler cannot read.
  assert.equal(isShellSuspect({ wordCount: 12, blockingScripts: 9, bytes: 900_000 }), true);
  const shell = assessTrust({ audit: scored, signals: { wordCount: 12, blockingScripts: 9, bytes: 900_000 }, urlVerification: unknownUrl });
  assert.equal(shell.hide?.reason, "shell_suspect", "a shell-suspect score must be hidden, not warned over");

  // A TRULY THIN site keeps its score -- low words WITHOUT the machinery is a
  // genuinely empty site, and that thinness IS the pitch. Hiding it would
  // delete the best leads.
  assert.equal(isShellSuspect({ wordCount: 12, blockingScripts: 0, bytes: 40_000 }), false);
  const thin = assessTrust({ audit: scored, signals: { wordCount: 12, blockingScripts: 0, bytes: 40_000 }, urlVerification: unknownUrl });
  assert.equal(thin.hide, null, "a thin-but-honest site's score must stand");

  // UNRECORDED wordCount never triggers the heuristic -- a missing
  // measurement is not evidence of anything (the whole point of this work).
  assert.equal(isShellSuspect({}), false);
  assert.equal(isShellSuspect(null), false);

  // REJECTED ownership hides everything, whatever the audit state: every
  // number on file is about a stranger's website.
  const rejected = assessTrust({ audit: scored, signals: null, urlVerification: { verdict: "rejected", verifiedAt: null } });
  assert.equal(rejected.hide?.reason, "rejected_url");
  const rejectedUnscored = assessTrust({ audit: { state: "not_scored" }, signals: null, urlVerification: { verdict: "rejected", verifiedAt: null } });
  assert.equal(rejectedUnscored.hide?.reason, "rejected_url", "rejected ownership must hide the card's site facts even without a score");

  // STALENESS warns (never hides) once the crawl is older than the window,
  // with an injected clock so this test does not rot.
  const old = { ...scored, measuredAt: "2026-01-01T00:00:00.000Z" };
  const staleCheck = assessTrust({
    audit: old, signals: { wordCount: 500 }, urlVerification: unknownUrl,
    now: new Date(Date.parse(old.measuredAt) + (STALE_AFTER_DAYS + 40) * 86_400_000),
  });
  assert.ok(staleCheck.warnings.some((w) => w.code === "stale"), "an old measurement must warn");
  assert.equal(staleCheck.hide, null, "staleness warns; it does not hide");
  const freshCheck = assessTrust({
    audit: old, signals: { wordCount: 500 }, urlVerification: unknownUrl,
    now: new Date(Date.parse(old.measuredAt) + 10 * 86_400_000),
  });
  assert.ok(!freshCheck.warnings.some((w) => w.code === "stale"), "a fresh measurement must not cry stale");

  // UNVERIFIED ownership warns calmly -- it is the default state for ~99% of
  // the corpus (202 verified of ~27k, 2026-09-01 sweep), so the words are
  // factual, not alarming, and verified produces NO warning.
  assert.ok(thin.warnings.some((w) => w.code === "unverified_url"));
  const verified = assessTrust({ audit: scored, signals: { wordCount: 500 }, urlVerification: { verdict: "verified", verifiedAt: null } });
  assert.ok(!verified.warnings.some((w) => w.code === "unverified_url"));

  // House copy rules on every rep-facing sentence the module can emit.
  const allTrustCopy = [
    shell.hide!.headline, shell.hide!.detail,
    rejected.hide!.headline, rejected.hide!.detail,
    ...staleCheck.warnings.map((w) => w.line),
    ...thin.warnings.map((w) => w.line),
  ].join(" ");
  assert.ok(!allTrustCopy.includes("—"), "no em dashes in trust copy");
  assert.doesNotMatch(allTrustCopy, /viewport|schema\.org|\bDOM\b|\bTTFB\b|\bCTA\b/i, "jargon in trust copy");

  // THE WIRING: the card computes trust, hides through it, renders the
  // honesty panel and the re-check control, and the API carries the fields.
  const view = "components/web-leads/BattleCard.tsx";
  const src = read(view);
  assert.match(src, /assessTrust\(\{ audit, signals, urlVerification \}\)/, `${view} must assess trust from the payload`);
  assert.match(src, /trust\.hide \? \(/, `${view} must branch the body on the trust verdict`);
  assert.match(src, /<UntrustedPanel hide=\{trust\.hide\} \/>/, `${view} must render the honest no-score panel when hidden`);
  assert.match(src, /scoreHidden=\{Boolean\(trust\.hide\)\}/, `${view} must hide the hero score too -- a hidden body under a big glowing number is not hidden`);
  assert.match(src, /<MeasurementHonesty/, `${view} must render the honesty strip on every card`);
  assert.match(src, /Re-check this site now/, `${view} must offer the one-lead re-check`);
  assert.match(src, /UNMEASURABLE_CHECKS/, `${view} must name checks the model cannot measure for prospects`);
  assert.match(src, /sitemap:/, `${view}: the sitemap check must be annotated as unmeasurable (integrity finding 4)`);
  assert.match(src, /Not recorded:/, `${view}: a failed check with no recorded signal must say so, never stay silent`);

  const route = read("app/api/web-leads/[id]/battlecard/route.ts");
  assert.match(route, /urlVerification/, "the battlecard payload must carry the URL-ownership verdict");
  assert.match(route, /recheck/, "the battlecard payload must carry the re-check status");

  const recheckRoute = read("app/api/web-leads/[id]/recheck/route.ts");
  assert.match(recheckRoute, /validatedRecheckUrl/, "the recheck route must validate a supplied URL through the SSRF-hardened module");
  assert.match(recheckRoute, /\.in\("status", \["pending", "running"\]\)/, "the recheck route must dedupe open requests per lead");
  assert.match(recheckRoute, /unique|constraint/i, "the dedupe must handle the atomic unique-index conflict path, not just the read");
  assert.match(recheckRoute, /status: 202/, "a fresh queue insert answers 202");

  // THE SSRF GATE (Codex P1, 2026-09-01): a pasted re-check URL is fetched by
  // OUR crawler from OUR network. Loopback, private ranges, link-local (cloud
  // metadata) and CGNAT must all be refused at validation, and the JARVIS
  // worker re-refuses after DNS resolution at the point of use.
  const urlMod = read("lib/web-leads/recheck-url.ts");
  assert.match(urlMod, /u\.protocol !== "http:" && u\.protocol !== "https:"/, "the URL allowlist must be scheme-first");
}

{
  // Direct unit coverage of the SSRF refusals -- imported, not regexed.
  for (const bad of [
    "http://127.0.0.1:3000",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/admin",
    "http://172.16.4.4",
    "http://192.168.1.1",
    "http://100.64.1.1",
    "http://0.0.0.0",
    "http://localhost",
    "http://foo.localhost",
    "http://printer.local",
    "http://db.internal",
    "ftp://example.com",
    "javascript:alert(1)",
    "http://user:pass@example.com",
    "http://[::1]/",
    "not a url",
  ]) {
    assert.equal(validatedRecheckUrl(bad), null, `recheck URL validation must refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(validatedRecheckUrl("example.com"), "https://example.com/", "a bare public domain gets https and passes");
  assert.equal(validatedRecheckUrl("http://joesplumbing.ca/about"), "http://joesplumbing.ca/about", "a public http site passes untouched");
  assert.equal(isPrivateIpv4("8.8.8.8"), false);
  assert.equal(isPrivateIpv4("169.254.169.254"), true);
  // The worker-side gate (post-DNS-resolution refusal) is pinned in the
  // JARVIS repo's own tests -- this suite must stay runnable on machines
  // without a JARVIS checkout.
}

// The panel itself renders every field of every objection. Asserting the data
// is complete (above) proves nothing if the component drops half of it.
{
  const panel = read("components/web-leads/ObjectionPanel.tsx");
  for (const field of ["o.says", "o.meaning", "o.response", "o.prevent", "o.source"]) {
    assert.ok(panel.includes(field), `ObjectionPanel must render ${field}`);
  }
  assert.match(panel, /OBJECTIONS\.map/, "ObjectionPanel must render every objection, not a hand-picked subset");
  // Same rule as the rest of the feature: nothing on this surface is generated.
  assert.doesNotMatch(panel, /claudeMessages|anthropic|openai|generateText/i, "ObjectionPanel must never generate copy");
}

// ---------------------------------------------------------------------------
// 9. It is actually reachable. A page nobody can navigate to is not shipped.
// ---------------------------------------------------------------------------

{
  const page = read("app/web-leads/[id]/page.tsx");
  assert.match(page, /BattleCard/, "the dynamic lead route must render the battle card");

  // Re-aimed 2026-08-25 from LeadsTable.tsx to LeadCells.tsx, where
  // BattleCardLink now lives. The results list grew a second layout (cards
  // below `xl`, the table above) and the two share one link component -- so
  // this one assertion now covers BOTH surfaces instead of the desktop table
  // alone, which is stronger, not weaker. The other half of that guarantee is
  // asserted below: both layouts must actually render it.
  assert.match(
    read("components/web-leads/LeadCells.tsx"),
    /href=\{`\/web-leads\/\$\{encodeURIComponent\(id\)\}`\}/,
    "LeadCells must link a lead to its battle card",
  );
  // The table reaches it through RowActions (which pairs it with "View site");
  // the card renders it directly, next to a differently-sized "View site". Both
  // shapes are accepted, an absence in either is not: a rep on a phone must
  // reach the battle card from the list exactly as on a desktop.
  assert.match(read("components/web-leads/LeadCells.tsx"), /function RowActions/, "RowActions must live beside the link it wraps");
  for (const [surface, needle] of [
    ["components/web-leads/LeadsTable.tsx", /<RowActions /],
    ["components/web-leads/LeadCards.tsx", /<BattleCardLink /],
  ] as const) {
    assert.match(read(surface), needle, `${surface} must give a rep a way into the battle card from the list`);
  }
  assert.match(
    read("components/web-leads/CallMode.tsx"),
    /href=\{`\/web-leads\/\$\{encodeURIComponent\(lead\.id\)\}`\}/,
    "Call Mode's 'Full detail' must lead to the battle card",
  );
}

// ---------------------------------------------------------------------------
// 10. THE CARD SAYS WHO THE REP IS CALLING.
//
// The card shipped on 2026-08-24 with the analysis and without the business.
// Measured on the file as merged: ZERO occurrences of address, postal,
// osmCategory or territoryName. The drawer had all of them. A rep opening a
// lead from their own book got a full screen of percentile charts and no way
// to see where the business was, which the operator reported in exactly those
// words: "When the lead is in their pipeline they can't view the address and
// they can't view a lot of information."
//
// This section is the regression guard. It asserts the FIELDS reach a screen,
// not that a component exists: the previous card imported WebLead, typed it,
// passed it around, and rendered four of its fourteen fields.
// ---------------------------------------------------------------------------

{
  const facts = "components/web-leads/BusinessFacts.tsx";
  const src = read(facts);

  // The full address, assembled once. Street and postal code included -- city
  // and province alone cannot tell a rep which branch they have.
  assert.match(
    src,
    /\[lead\.address, lead\.city, lead\.province, lead\.postal\]\s*\.filter\(Boolean\)\s*\.join\(", "\)/,
    `${facts} must join the full address the way the drawer has always joined it`,
  );
  assert.match(src, /export function fullAddress/, `${facts} must own the one address join`);

  // Every field the operator asked for, by name. A block that renders the
  // address and drops the territory is the same bug one field smaller.
  for (const field of [
    "lead.industry",
    "lead.websiteUrl",
    "lead.websiteCondition",
    "lead.auditFindings",
    "lead.osmCategory",
    "lead.territoryName",
    "lead.phone",
  ]) {
    assert.ok(src.includes(field), `${facts} must render ${field}`);
  }

  // VERBATIM, and not merely present. The two hedged directory strings must
  // reach the screen with no badge, no icon-as-verdict and no shortening --
  // they are unverified statements about a stranger's business that a rep
  // reads aloud on a live call.
  assert.doesNotMatch(
    src,
    /(websiteCondition|auditFindings)\s*[.?]?\.?(slice|substring|split|replace|toUpperCase|toLowerCase)/,
    `${facts} must not transform the verbatim directory strings`,
  );
  assert.doesNotMatch(src, /truncate|line-clamp/, `${facts} must not clip a verbatim directory string`);

  // A missing field says so in words. A blank cell mid-call is indistinguishable
  // from a half-rendered page.
  assert.match(src, /Not on file/, `${facts} must name a missing field rather than leaving it blank`);

  // Nothing on this surface is generated. Same rule as the rest of the feature.
  assert.doesNotMatch(src, /claudeMessages|anthropic|openai|generateText/i, `${facts} must never generate copy`);
}

{
  const view = "components/web-leads/BattleCard.tsx";
  const src = read(view);

  // The block is ON the card, and ABOVE the analysis. "Near the top" is the
  // requirement, not "somewhere on the page": a rep confirms who they are
  // calling before they pitch, and a block under four charts is a block they
  // reach after the pitch is already wrong.
  assert.match(
    src,
    /<BusinessFacts lead=\{lead\} layout="grid" \/>[\s\S]*?audit\.state !== "scored"/,
    `${view} must render the business facts block BEFORE it branches on the audit state`,
  );

  // Rendered in EVERY state, scored or not. The old card put the two verbatim
  // directory strings inside the not-scored branch only, so a lead that DID
  // score showed neither -- the exact case where a rep has a number in front
  // of them and most needs to know nobody verified the rest.
  const factsUses = (src.match(/<BusinessFacts/g) || []).length;
  assert.equal(factsUses, 1, `${view} must render the facts block once, outside the scored/not-scored branch`);

  // The full address is under the business name in the hero too, not just the
  // city. Asserted on the hero's own subtitle line so a later edit cannot drop
  // the street back out of it.
  assert.match(
    src,
    /\[lead\.industry, fullAddress\(lead\)\]/,
    `${view} must put the full address, not just the city, under the business name`,
  );

  // A prominent way out to the site, near the top, using the allowlisting
  // helper and rendering NOTHING when it returns null -- a missing control is
  // honest, a dead one is not. Asserted as three separate facts rather than
  // one wide regex: the gate, the href it feeds, and the words on it. A single
  // pattern spanning them would have to allow ~800 characters of class list in
  // between, which is a window wide enough to match almost anything.
  assert.match(src, /\{websiteHref && \(/, `${view} must render nothing when preferredSiteUrl returns null`);
  assert.match(src, /href=\{websiteHref\}/, `${view} must use the resolved URL as the href`);
  assert.match(src, /\/>View website/, `${view} must label the control "View website"`);
  assert.match(
    src,
    /const websiteHref = preferredSiteUrl\(lead\.websiteUrl\)/,
    `${view} must resolve the prospect's URL through preferredSiteUrl`,
  );

  // The duplicates are gone. Two renderings of the same unverified sentence on
  // one screen invite a rep to wonder which one is current.
  const conditionUses = (src.match(/lead\.websiteCondition/g) || []).length;
  assert.equal(conditionUses, 0, `${view} must read the verbatim directory strings through BusinessFacts, once`);
}

// ---------------------------------------------------------------------------
// 8e. THE DESIGNATION (round 5, Adon: "really outlining the graph of what
//     type of bad it is"). lead-profile.ts names the SHAPE of a scored
//     profile from hand-written tables; the plate on the card renders it
//     verbatim. What gets pinned: the tables are COMPLETE (a crater in any
//     dimension has a name -- one missing entry and the plate says less than
//     the chart), no entry is a stub, the classifier is TOTAL (every profile
//     in a sweep classifies -- a plate that can render blank is a question
//     mark on the most prominent line of the section), and each ordered rule
//     actually fires on the profile shape it exists for.
// ---------------------------------------------------------------------------

{
  const mkDim = (key: string, score: number) => ({
    key,
    label: key,
    score,
    weight: 1,
    checks: [],
    missing: [],
  });
  const profile = (scores: Record<string, number>) => DIMENSION_KEYS.map((k) => mkDim(k, scores[k] ?? 70));

  // The crater table covers every dimension, and nothing in either table is a
  // stub. A one-word `meaning` or an empty `play` is a plate that stamps a
  // name and then has nothing for the rep to SAY about it.
  for (const key of DIMENSION_KEYS) {
    const entry = CRATER_DESIGNATIONS[key];
    assert.ok(entry, `lead-profile.ts: no crater designation for "${key}" -- a collapse there would render a generic label`);
    assert.ok(entry.name.length >= 8, `${key}: crater name is a stub`);
    assert.ok(entry.meaning.length >= 40, `${key}: crater meaning is a stub`);
    assert.ok(entry.play.length >= 40, `${key}: crater play is a stub`);
  }
  assert.equal(
    Object.keys(CRATER_DESIGNATIONS).length,
    DIMENSION_KEYS.length,
    "one crater designation per dimension, no extras -- an extra entry is dead copy nothing can select",
  );
  for (const [code, entry] of Object.entries(SHAPE_DESIGNATIONS)) {
    assert.ok(entry.name.length >= 8, `${code}: shape name is a stub`);
    assert.ok(entry.meaning.length >= 40, `${code}: shape meaning is a stub`);
    assert.ok(entry.play.length >= 40, `${code}: shape play is a stub`);
  }

  // Each ordered rule fires on the shape it exists for.
  for (const key of DIMENSION_KEYS) {
    const d = designateLead(profile({ [key]: 20 }), 62);
    assert.equal(d.code, `crater_${key}`, `one collapsed area (${key} at 20, rest 70) must classify as that crater`);
    assert.deepEqual(d.primary, [key], `the ${key} crater's defining area must be ${key} itself`);
  }
  assert.equal(designateLead(profile(Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 30]))), 30).code, "rebuild", "everything under 45 must classify as the rebuild");
  assert.equal(designateLead(profile({ conversion: 72 }), 80).code, "contender", "a high composite with no crater must classify as the contender");
  assert.equal(
    designateLead(profile({ conversion: 40, trust: 42 }), 58).code,
    "two_front",
    "two areas dragging together (40/42 against a 70 field) must classify as the two-front fight",
  );
  assert.equal(
    designateLead(profile({ conversion: 55, trust: 60, design: 62, mobile: 65, content: 68, performance: 70, discoverability: 72 }), 62).code,
    "erosion",
    "spread-out decay with no dominant crater must fall through to erosion",
  );
  // Rule ORDER: a deep crater on a site whose composite still clears the
  // contender floor is sold as the crater -- "strong contender" above a
  // radar with one axis on the floor is the plate contradicting the chart.
  assert.equal(
    designateLead(profile({ discoverability: 30 }), 78).code,
    "crater_discoverability",
    "a deep crater must outrank the contender floor",
  );

  // Totality sweep: every profile in a coarse grid classifies to a designation
  // with words on it, and every defining area it names is real. 6^3 shapes x 7
  // rotations covers all rule boundaries without a combinatorial test.
  const GRID = [0, 20, 40, 60, 80, 100];
  for (const worst of GRID) {
    for (const mid of GRID) {
      for (const rest of GRID) {
        for (const key of DIMENSION_KEYS) {
          const scores: Record<string, number> = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, rest]));
          scores[key] = worst;
          scores[DIMENSION_KEYS[(DIMENSION_KEYS.indexOf(key) + 3) % DIMENSION_KEYS.length]] = mid;
          const composite = Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / DIMENSION_KEYS.length);
          const d = designateLead(profile(scores), composite);
          assert.ok(d && d.name.length >= 8 && d.meaning.length >= 40 && d.play.length >= 40, `unclassifiable profile: ${JSON.stringify(scores)}`);
          assert.ok(d.primary.length >= 1 && d.primary.length <= 3, `designation for ${JSON.stringify(scores)} names ${d.primary.length} defining areas`);
          for (const p of d.primary) assert.ok(DIMENSION_KEYS.includes(p), `designation names unknown area "${p}"`);
        }
      }
    }
  }

  // The plate is ON the card, inside the shape section, rendering the
  // hand-written entry verbatim -- name, meaning AND play. A plate that
  // renders only the name is a verdict with no sentence to say.
  const src = read("components/web-leads/BattleCard.tsx");
  assert.match(src, /import \{ designateLead \} from "@\/lib\/web-leads\/lead-profile"/, "the card must classify through lead-profile.ts, never inline");
  assert.match(src, /id="shape"[\s\S]{0,400}?<DesignationPlate audit=\{audit\} \/>/, "the designation plate must open the shape section");
  assert.match(src, /\{designation\.name\}/, "the plate must render the designation's name");
  assert.match(src, /\{designation\.meaning\}/, "the plate must render what the shape means");
  assert.match(src, /\{designation\.play\}/, "the plate must render how to sell the shape");
}

// ---------------------------------------------------------------------------
// 8f. THE HUD FACES (round 5): every font the card declares must exist as a
//     vendored file. next/font/local fails the BUILD on a missing file, but
//     only when the importing route builds -- this catches a lost woff2 at
//     test time, with a message that names the file instead of a webpack
//     stack. And the three faces stay three: display (Chakra Petch), numeral
//     (Orbitron, the hero score only), telemetry (JetBrains Mono).
// ---------------------------------------------------------------------------

{
  const view = "components/web-leads/BattleCard.tsx";
  const src = read(view);
  const declared = [...src.matchAll(/path: "\.\.\/\.\.\/(app\/fonts\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(declared.length >= 6, `${view} declares only ${declared.length} font files -- the three-face system lost a weight`);
  for (const rel of declared) {
    assert.ok(fs.existsSync(path.join(process.cwd(), rel)), `${view} declares ${rel} but the file is not vendored -- the build will fail on it`);
  }
  for (const face of ["ChakraPetch-", "Orbitron-700", "JetBrainsMono-"]) {
    assert.ok(declared.some((p) => p.includes(face)), `${view} lost the ${face} face`);
  }
  // Orbitron is the hero score's dial face and nothing else's: one declared
  // weight, worn via --battle-numeral exactly once. The moment it spreads,
  // it stops reading as an instrument and starts reading as a theme.
  assert.equal(declared.filter((p) => p.includes("Orbitron")).length, 1, "Orbitron stays a single weight");
  assert.equal((src.match(/--battle-numeral\)/g) || []).length, 1, "the numeral face is worn by the hero score alone");
}

// ---------------------------------------------------------------------------
// 8g. ROUND 5 OF THE WEBGL RADAR: bloom is a TREATMENT, labels are DOM.
//     What gets pinned is the failure discipline, same as 8d: the bloom
//     modules load in a try whose catch leaves the round-4 direct render
//     (never a blank chart because a postprocessing chunk failed), the
//     screen-blend composite is only applied on the bloomed path, the
//     composer's targets are disposed with everything else, and the
//     projected labels ride OUTSIDE the GL scene as aria-hidden DOM -- the
//     dimension list beside the chart stays the accessible path.
// ---------------------------------------------------------------------------

{
  const r3d = read("components/web-leads/Radar3D.tsx");
  assert.match(r3d, /UnrealBloomPass/, "Radar3D must attempt the bloom treatment");
  assert.match(r3d, /catch \{\s*composer = null;\s*\}/, "a failed postprocessing import must fall back to the direct render, not blank the chart");
  assert.match(r3d, /mixBlendMode = "screen"/, "the bloomed path must composite onto the panel via screen blend (bloom cannot render on a transparent canvas)");
  const stripped = stripComments(r3d);
  assert.ok(
    !/setClearColor\(0x000000, 1\)/.test(stripped.split("try")[0] || ""),
    "the opaque clear colour belongs to the bloomed path only -- setting it unconditionally black-boxes the fallback render",
  );
  assert.match(r3d, /composer\?\.dispose\?\.\(\)/, "the composer's render targets must be disposed with the renderer");
  // composer.dispose() does NOT dispose added passes, and UnrealBloomPass
  // owns its own pyramid of render targets -- without per-pass disposal,
  // paging through leads leaks GPU memory until the tab dies. (Codex review,
  // 2026-09-01.)
  assert.match(r3d, /passDisposers\.push/, "each postprocessing pass that can dispose must be collected for teardown");
  assert.match(r3d, /for \(const disposePass of passDisposers\) disposePass\(\)/, "the collected passes must actually be disposed in cleanup");
  assert.match(r3d, /composer\?\.setSize/, "the composer must resize with the canvas or bloom renders at the mount-time resolution forever");
  assert.match(r3d, /labelLayer\.setAttribute\("aria-hidden", "true"\)/, "the projected labels are a pointer convenience -- the dimension list stays the accessible path");
  assert.match(r3d, /removeChild\(labelLayer\)/, "the label layer must be torn down with the scene");
}

console.log("web-leads-battlecard ok");
