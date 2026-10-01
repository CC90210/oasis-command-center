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
import { PRESENCE_EXPLAINED_CODES } from "../lib/web-leads/presence-evidence";
import { DIM_HUES, PILLAR_HUES } from "../components/web-leads/battle-hud";
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
  //
  // CHECKED AGAINST THE CARD, NOT AGAINST A LITERAL (fix round 1,
  // 2026-09-14). This asserted the phrase "what is worth fixing first", which
  // was the section's title until the capability catalogue took it over. The
  // heading stopped existing and this assertion carried on passing, because
  // it only ever compared the sentence against itself: a guard certifying a
  // dead cross-reference, on a line that renders in the opening-script block,
  // open by default, directly under what a rep reads aloud.
  //
  // So the expected phrase is now READ OUT OF BattleCard.tsx. If the section
  // is retitled again, this fails on the next run instead of quietly
  // pointing a rep at a heading that is not on screen.
  const buildTitleMatch = read("components/web-leads/BattleCard.tsx").match(
    /const BUILD_TITLE = "([^"]+)";/,
  );
  assert.ok(
    buildTitleMatch,
    "BattleCard.tsx must define BUILD_TITLE -- if the build section's title moved, re-aim this at wherever it lives now rather than deleting the check",
  );
  assert.match(
    IF_THE_ANSWER_IS_CLEAN,
    new RegExp(buildTitleMatch![1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    `the clean-answer instruction must name a heading that is actually on the card; it must point at "${buildTitleMatch![1]}"`,
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
  //
  // ASSERTED ON THE WHOLE ARM AS OF FIX ROUND 1 (2026-09-14), not on a
  // 160-character window after the condition. That window was a proxy for
  // "NotScored is the first thing in this branch", and it broke the moment
  // the branch gained a second child. Widening it would have been a
  // relaxation; extracting the arm and naming every chart that may not appear
  // in it is what the window was standing in for, and it is stronger: a chart
  // added at the END of the arm was never caught before and is now.
  const notScoredArm = (() => {
    const start = src.indexOf('audit.state !== "scored" ? (');
    if (start === -1) return null;
    const rest = src.slice(start);
    const end = rest.indexOf("\n          ) : (");
    return end === -1 ? null : rest.slice(0, end);
  })();
  assert.ok(
    notScoredArm && notScoredArm.length > 200,
    `${view}: could not extract the non-scored arm of the body ternary -- the extraction broke, and a guard checking an empty string passes while protecting nothing`,
  );
  assert.match(notScoredArm!, /<NotScored/, `${view} must route every non-scored state to the sentence renderer`);
  for (const chart of ["<Radar3D", "<DesignationPlate", "<DimensionShape", "<Competitors", "<CompetitorArena3D", "<Meter", "<PercentileSentence"]) {
    assert.ok(
      !notScoredArm!.includes(chart),
      `${view}: ${chart} must never render for a non-scored lead -- a chart drawn from an audit that does not exist is a fabricated accusation with a gradient on it`,
    );
  }
  // What IS allowed in that arm, and is the reason it now has two children:
  // the capability catalogue, which is the entire pitch for a lead with no
  // website and which renders no chart and no number.
  assert.match(
    notScoredArm!,
    /<BuildCatalogue/,
    `${view}: a lead with no score must still be shown what we would build for them; it is the best lead this feature produces`,
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
  // Re-aimed, not relaxed (compact card, 2026-10-01): the "one thing to lead
  // with" line that called remedyFor directly is gone (it duplicated the
  // script, which is built from the same worst gap). The hand-written remedy
  // copy still renders on every failing check, through the shared RemedyLines.
  assert.match(src, /<RemedyLines code=/, `${view} must render the hand-written remedy copy`);
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
  // because BattleSection provides the shell and heading -- the console's own
  // markup is asserted separately by its own guard-list entry in
  // web-leads-guards.test.ts. Swapped 2026-09-10: ObjectionPanel (a fixed
  // eight-card table, identical on every lead) is replaced by ObjectionConsole
  // (ranked per lead, and the surface that logs a tap to the database).
  //
  // Keyed on `lead.id`, not the top-level `leadId` prop: this section renders
  // inside ScoredBody, a sibling component scope that only has `leadId` via
  // its own `lead` prop (the already-fetched WebLead for this exact render) --
  // the same object CallOutcomeLog's race guard checks elsewhere in this file.
  assert.match(src, /<ObjectionConsole leadId=\{lead\.id\} bare \/>/, `${view} must render the objection console`);

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
  //
  // The objections section defaults OPEN as of 2026-09-10 (see BattleCard.tsx).
  // The opening-script assertion below is untouched on purpose: this file exists
  // so an edit cannot silently collapse it, and an edit amending a neighbouring
  // default is exactly the shape of edit that would.
  //
  // THE COMPACT CARD (Adon, 2026-10-01): fifteen blocks became seven. The
  // reference material folded into two closed drawers -- "before-dial" (history,
  // directory facts, trust) and "proof" (rivals, failing checks, presence, raw
  // crawl) -- and "lead-with" and "shape" are deleted, not hidden. The three
  // sections read mid-call ("opening", "brushoffs", "fixes") keep their ids
  // and stay OPEN, so a rep's saved collapse choices still apply to them.
  for (const [id, open] of [
    ["before-dial", false],
    ["opening", true],
    ["brushoffs", true],
    ["fixes", true],
    ["proof", false],
  ] as const) {
    assert.match(
      src,
      new RegExp(`<BattleSection\\s+id="${id}"\\s+defaultOpen=\\{${open}\\}`),
      `${view}: section "${id}" must default ${open ? "OPEN -- it is read mid-call and may not cost a click" : "CLOSED -- it is reference material behind a labelled teaser"}`,
    );
  }

  // THE "fixes" SECTION IS NOW THE CAPABILITY CATALOGUE (Task 5, 2026-09-14).
  // `FixFirst` ranked the seven scored DIMENSIONS and is deleted;
  // `CapabilityCatalogue` ranks the fifteen reviewed CAPABILITIES and carries
  // the stage ladder. The id and the default-open state above are UNCHANGED
  // and stay pinned by the map: this section is read mid-call and may not
  // cost a click.
  //
  // EVERY OTHER SECTION'S ASSERTION IN THIS BLOCK IS BYTE-IDENTICAL TO WHAT
  // IT WAS BEFORE THIS EDIT. Nothing in the default map moved, no teaser
  // assertion moved, and no neighbouring section's copy was touched. That is
  // said out loud because an edit to a neighbour is exactly the shape of
  // change this block exists to catch, and the person making it is the person
  // least likely to notice.
  //
  // What is pinned here is the SECTION'S PROMISE, because it changed and a
  // stale promise over a new panel is worse than no promise: a rep who reads
  // "what is worth fixing first" over a list that includes things nothing is
  // wrong with, plus a ladder of things we will not sell today, is being set
  // up to say something the panel does not support.
  //
  // TWO MOUNTS AS OF FIX ROUND 1 (2026-09-14), so the title and the sub are
  // constants and the assertions are on the constants. See the two-mount
  // block immediately below for why there are two and how they are held
  // together.
  const buildTitle = src.match(/const BUILD_TITLE = "([^"]+)";/);
  const buildSub = src.match(/const BUILD_SUB =\s*\r?\n?\s*"([^"]+)";/);
  assert.ok(buildTitle, `${view} must define BUILD_TITLE`);
  assert.ok(buildSub, `${view} must define BUILD_SUB`);
  assert.equal(
    buildTitle![1],
    "What we would build for them",
    `${view}: the build section must be titled as what we would build, not only as what is worth fixing -- it lists capabilities that are verified clean and capabilities we will not sell for months`,
  );
  assert.match(
    buildSub![1],
    /Tap a row/,
    `${view}: the build sub must tell a rep the rows open for detail -- everything below the title line is behind a tap`,
  );
  assert.doesNotMatch(
    buildSub![1],
    /worth fixing first/,
    `${view}: the build section must not still promise a ranked defect list; that framing belonged to FixFirst`,
  );
  // The sub must not claim the whole catalogue is on screen. It is not: the
  // capabilities with nothing failing sit behind the catalogue's own "show
  // all" control, and a sub promising "everything" over a one-row panel is
  // the same class of overclaim as the coverage headline Task 4 fixed.
  assert.doesNotMatch(
    buildSub![1],
    /\bEverything\b/i,
    `${view}: the build sub must not say everything is listed -- the clean capabilities are behind "show all"`,
  );
  // And it must not assert an audit unconditionally, because one of the two
  // mounts is for leads that have no audit at all.
  assert.doesNotMatch(
    buildSub![1],
    /^[^.]*\btheir own audit found\b/,
    `${view}: the build sub is shared with the no-audit mount, so it may not open by asserting an audit`,
  );

  // ── THE TWO MOUNTS ──────────────────────────────────────────────────────
  // The catalogue is mounted twice: inside ScoredBody for a scored lead, and
  // at container level for a lead with no score. The second exists because
  // ScoredBody renders only for `state === "scored"`, which made the
  // no-website case -- the single best lead this feature produces -- the one
  // case the catalogue could never render for. The same reason PresenceBlock
  // sits at container level.
  //
  // These assertions are the anti-drift contract: ONE invocation of the
  // catalogue, wrapped, and both sections reading the same two constants. Two
  // hand-written call sites would be two prop sets and two titles that can
  // disagree about one business mid-call.
  assert.equal(
    (src.match(/<CapabilityCatalogue\b/g) || []).length,
    1,
    `${view}: the catalogue must be invoked exactly once, inside BuildCatalogue -- a second invocation is a second prop set that can drift`,
  );
  assert.equal(
    (src.match(/<BuildCatalogue\b/g) || []).length,
    2,
    `${view}: the catalogue must be mounted twice, once for a scored lead and once for a lead with no score`,
  );
  assert.equal(
    (src.match(/title=\{BUILD_TITLE\} sub=\{BUILD_SUB\}|title=\{BUILD_TITLE\}\s*\r?\n\s*sub=\{BUILD_SUB\}/g) || []).length,
    2,
    `${view}: both mounts must wear the same title and sub, from the constants`,
  );
  assert.match(
    src,
    /<BattleSection id="build" defaultOpen=\{true\}/,
    `${view}: the no-score mount must be a section of its own, open by default -- a rep calling a business with no website has nothing else to sell from`,
  );
  // The no-score mount passes the shared empty audit, not a fabricated one.
  assert.match(
    src,
    /dimensions=\{NO_DIMENSIONS\}/,
    `${view}: the no-score mount must pass the empty audit, which is what those leads actually have`,
  );
  // Both mounts read ONE derivation of hasWebsite, and it comes from the
  // audit rather than from the directory's website field.
  // Each mount, extracted, must pass the derived value rather than its own.
  const mounts = src.match(/<BuildCatalogue[\s\S]*?\/>/g) || [];
  assert.equal(mounts.length, 2, `${view}: expected two BuildCatalogue elements, found ${mounts.length}`);
  for (const [i, mount] of mounts.entries()) {
    assert.match(
      mount,
      /hasWebsite=\{hasWebsite\}/,
      `${view}: mount ${i + 1} must read the one derived hasWebsite value, not a literal or a second derivation`,
    );
  }
  assert.match(
    src,
    /const hasWebsite = hasLiveWebsite\(audit\);/,
    `${view}: hasWebsite must be derived from the audit by the one shared function, never from lead.websiteUrl`,
  );
  assert.doesNotMatch(
    src,
    /hasWebsite=\{true\}|hasWebsite=\{Boolean\(lead\.websiteUrl\)\}/,
    `${view}: no mount may assert a website instead of reading the audit`,
  );
  // FixFirst is deleted, not merely unmounted. Both halves are asserted --
  // the definition and any render of it -- because deleting the call site
  // while leaving the function behind is the shape that leaves a second,
  // unreachable ranked list in the file for the next person to wire back in.
  // The NAME is deliberately still allowed to appear: the comment in
  // BattleCard.tsx explaining what this section used to be has to be able to
  // say what it replaced.
  assert.doesNotMatch(src, /function FixFirst\b/, `${view}: FixFirst must be deleted, not left defined and unused`);
  assert.doesNotMatch(src, /<FixFirst\b/, `${view}: nothing may still render FixFirst`);

  // Every closed-by-default section carries a teaser. A closed section with no
  // teaser is a mystery drawer, and a rep will not open a mystery mid-call.
  for (const id of ["before-dial", "brushoffs", "proof"]) {
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

  // 8c. THE HUD PALETTE (Adon, 2026-09-01): colour is IDENTITY, never verdict.
  // Every dimension keeps its own fixed hue in DIM_HUES (battle-hud.ts). The
  // radar that first wore them is gone (compact card, 2026-10-01), but the
  // capability catalogue and its rows still do, so one area falling through to
  // the grey fallback still breaks the "this colour IS trust" coding. The
  // verdict colours stay banned by web-leads-guards.test.ts; this asserts the
  // identity half of the rule.
  const hud = read("components/web-leads/battle-hud.ts");
  for (const key of DIMENSION_KEYS) {
    assert.match(
      hud,
      new RegExp(`DIM_HUES[\\s\\S]{0,700}?\\b${key}:`),
      `battle-hud.ts: dimension "${key}" must carry a fixed identity hue in DIM_HUES`,
    );
  }

  // 8d. THE CHARTS ARE DELETED, NOT HIDDEN (compact card, Adon 2026-10-01).
  // The SVG hologram radar, the WebGL radar, the 3D competitor arena, the
  // designation plate, the sound layer and the hero particle field were
  // removed because none of them told a rep what to say. Their pins (the
  // hologram layers, the three.js code-split, the GL dispose and fallback
  // gates) are retired WITH them: a pin on code that no longer exists guards
  // nothing. What replaces them is this: the deleted pieces stay deleted, so
  // nobody wires a 600KB WebGL scene back into the card a rep reads mid-call
  // without deciding to.
  for (const gone of [
    "components/web-leads/Radar3D.tsx",
    "components/web-leads/CompetitorArena3D.tsx",
    "components/web-leads/battle-sfx.ts",
    "lib/web-leads/lead-profile.ts",
  ]) {
    assert.ok(!fs.existsSync(path.join(process.cwd(), gone)), `${gone} was deleted with the compact card; restoring it is a decision, not a drift`);
  }
  for (const name of ["<Radar", "<DesignationPlate", "<DimensionShape", "<CompetitorArena3D", "<ParticleField", "<DistributionStrip", "<TiltCard", "from \"three\"", "sfx."]) {
    assert.ok(!src.includes(name), `${view}: ${name} was removed with the compact card and must not return silently`);
  }
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
// Model v2 (2026-09-02): 44 codes. Retired: cta_above_fold (unmeasurable
// without rendering), no_flash (dead tech), social_proof + analytics (moved
// to the online-presence layer), sitemap (0.5% corpus pass -- a broken
// measurement fails everyone and reads as our error). modern_layout renamed
// layout_quality (modern engine AND not table-built).
const MODEL_CODES = [
  // conversion
  "tel_link", "phone_in_header", "contact_form", "short_form", "cta_present",
  "booking", "email_route", "chat", "multi_route",
  // trust
  "testimonials", "review_platform", "credentials", "real_photos", "address",
  "map", "years_trading", "guarantee",
  // design
  "layout_quality", "web_fonts", "not_default_tpl", "image_rich",
  "no_dated_markup", "consistent_brand", "favicon", "no_builder_badge",
  // mobile
  "viewport", "responsive_css", "no_fixed_width", "tap_targets",
  // content
  "substantial", "service_detail", "headings", "service_area",
  "pricing_signal", "fresh",
  // performance
  "fast_ttfb", "lean_html", "few_blocking", "https",
  // discoverability
  "title", "meta_desc", "local_schema", "og_tags", "h1",
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
  //
  // RE-AIMED, NOT RELAXED (Task 5, 2026-09-14). The three surfaces used to be
  // three blocks inside BattleCard.tsx, and this counted `<MeasuredLine` in
  // that one file. The third of them, FixFirst's drill-down, is now
  // CapabilityRow's expanded detail in its own file, and `MeasuredLine`
  // itself moved to the shared audit-parts module both files import. So the
  // count over BattleCard.tsx is 2 and the third is asserted where it now
  // lives. The requirement is unchanged: every one of the three surfaces a
  // rep can open on a failing check shows what the crawler actually measured.
  // Dropping the third surface from the count instead of following it is how
  // a guard quietly stops guarding.
  const view = "components/web-leads/BattleCard.tsx";
  const src = read(view);
  const capabilityRow = read("components/web-leads/CapabilityRow.tsx");
  const auditParts = read("components/web-leads/audit-parts.tsx");
  assert.match(auditParts, /import \{ evidenceStateFor/, "audit-parts must render the measured sentences");
  assert.match(src, /from "\.\/audit-parts"/, `${view} must take the measured line from the shared module`);
  assert.match(capabilityRow, /from "\.\/audit-parts"/, "CapabilityRow must take the same measured line, not a second copy of it");
  // COUNTED, NOT MERELY PRESENT (fix round 1, 2026-09-14). The original
  // assertion counted three surfaces; the first re-aim counted two here and
  // checked only for PRESENCE in CapabilityRow, which would have passed with
  // the third surface reduced to a single leftover call. Each file is counted
  // and the total is asserted, so losing any one surface fails.
  const measuredUses = (src.match(/<MeasuredLine code=/g) || []).length;
  const rowMeasuredUses = (capabilityRow.match(/<MeasuredLine code=/g) || []).length;
  //
  // TWO SURFACES SINCE THE COMPACT CARD (2026-10-01). The dimension detail
  // panel under the radar was the third surface, and it was DELETED with the
  // radar, not hidden. Every surface that still exists is counted: the
  // failing-check list in the proof drawer, and the capability drill-down.
  assert.ok(measuredUses >= 1, `${view}: the measured line must reach the failing-check list (found ${measuredUses})`);
  assert.ok(
    rowMeasuredUses >= 1,
    `CapabilityRow: the measured line must reach the capability drill-down, which used to be FixFirst's (found ${rowMeasuredUses})`,
  );
  assert.ok(
    measuredUses + rowMeasuredUses >= 2,
    `the measured line must reach both detail surfaces a rep can open on a failing check (found ${measuredUses + rowMeasuredUses})`,
  );
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
  // THE UNMEASURABLE-CHECK MACHINERY MOVED (Task 5, 2026-09-14), so this is
  // re-aimed at where it lives rather than relaxed. It was module-private in
  // BattleCard.tsx; the capability catalogue needed it too and, unable to
  // import it, grew a second copy that could not see the first. It is now one
  // table in lib/web-leads/check-evidence.ts, beside the function that turns
  // a check code into a sentence, and BattleCard reaches it through the
  // shared MeasuredLine.
  //
  // Aiming this at BattleCard.tsx by name would now pass on the COMMENT there
  // that explains the move, which is a guard certifying prose.
  const evidence = read("lib/web-leads/check-evidence.ts");
  const auditParts = read("components/web-leads/audit-parts.tsx");
  const capabilityRow = read("components/web-leads/CapabilityRow.tsx");
  assert.match(evidence, /export const UNMEASURABLE_CHECKS/, "the unmeasurable-check machinery must survive the move -- the next broken measurement needs it");
  // Model v2 retired the sitemap check outright (0.5% corpus pass -- the
  // measurement, not the sites, was broken), which was the "coordinated
  // MODEL_VERSION bump" the old annotation called for. The map must now be
  // EMPTY: an entry for a check the model no longer scores is dead copy.
  // (Also asserted on the live object, not just the source text, in
  // tests/web-leads-automations-catalogue.test.ts §5.)
  assert.match(evidence, /export const UNMEASURABLE_CHECKS: Record<string, string> = \{\};/, "no unmeasurable entries should remain after the v2 sitemap retirement");
  assert.match(src, /<MeasuredLine code=/, `${view} must still render the unmeasurable/measured/unrecorded line beside a failing check`);
  assert.match(auditParts, /Not recorded:/, "a failed check with no recorded signal must say so, never stay silent");
  // One sentence, not two. It existed twice with two different wordings
  // (Task 4's copy dropped "treat this line with caution" and the data
  // typeface), which is the drift that made this file the wrong place to
  // check it from.
  assert.equal(
    (auditParts.match(/Not recorded:/g) || []).length,
    1,
    "the unrecorded sentence must exist exactly once in the shared module",
  );
  assert.doesNotMatch(src, /Not recorded:/, `${view} must not carry a second copy of the unrecorded sentence`);
  assert.doesNotMatch(capabilityRow, /Not recorded:/, "CapabilityRow must not carry a second copy of the unrecorded sentence");

  const route = read("app/api/web-leads/[id]/battlecard/route.ts");
  assert.match(route, /urlVerification/, "the battlecard payload must carry the URL-ownership verdict");
  assert.match(route, /recheck/, "the battlecard payload must carry the re-check status");

  const recheckRoute = read("app/api/web-leads/[id]/recheck/route.ts");
  assert.match(recheckRoute, /validatedRecheckUrl/, "the recheck route must validate a supplied URL through the SSRF-hardened module");
  assert.match(recheckRoute, /\.in\("status", \["pending", "running"\]\)/, "the recheck route must dedupe open requests per lead");
  assert.match(
    recheckRoute,
    /idx_recheck_one_open\|unique constraint/,
    "the dedupe conflict path must match ONLY the uniqueness collision -- a CHECK or FK violation recovering as ok is a request silently never queued",
  );
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

// ObjectionPanel.tsx (a fixed eight-card table read off a hardcoded array) was
// deleted 2026-09-10 -- Task 9's ObjectionConsole/ObjectionCard render the
// approved catalog ranked per lead instead. The deleted block above (git show
// 7c220f07:tests/web-leads-battlecard.test.ts:1164-1174) pinned three things
// against ObjectionPanel.tsx and nothing replaced them (task-10 fix round 1,
// flagged then fixed): every field renders, every objection renders rather
// than a hand-picked subset, and the surface never generates copy. That third
// rule is the one that matters most -- this feature's whole promise is that
// no unapproved wording reaches a rep, and an approval gate enforced only by
// a person reading the component correctly, forever, is not a gate. Restated
// here against the two components that took ObjectionPanel's place.

{
  const card = read("components/web-leads/ObjectionCard.tsx");
  // The objection's own fields. The shape changed from ObjectionPanel's flat
  // `o.response` -- answers now live on `objection.answers`, so this asserts
  // the real property paths the component reads, not the old ones.
  for (const field of ["objection.says", "objection.meaning", "objection.prevent", "objection.source"]) {
    assert.ok(card.includes(field), `ObjectionCard must render ${field}`);
  }

  // THE SPOKEN LINE. This block used to assert `activeAnswer.body`, and a
  // fix-round-3 review proved that wrong the same way the truncation block
  // below was proved wrong: `activeAnswer.body` appears only in the
  // COMPUTATION of `displayedBody`, so replacing the render with `{null}`
  // left the string in the file and the whole suite passed. Aim at what is
  // actually rendered instead: the JSX node itself, and the computation that
  // feeds it, asserted separately so deleting either one fails.
  // (Final review, M8.)
  assert.match(
    card,
    /<p className="text-sm leading-relaxed text-fg">\{displayedBody\}<\/p>/,
    "ObjectionCard must RENDER the spoken line, not merely compute it -- `{null}` in this node passed the old assertion",
  );
  assert.match(
    card,
    /const displayedBody = activeAnswer[\s\S]{0,200}?activeAnswer\.body/,
    "ObjectionCard's rendered line must resolve to the ACTIVE answer's body, not a constant",
  );

  // LIMITATION, SAME ONE AS THE TRUNCATION BLOCK BELOW, restated here because
  // this block was written under exactly the misapprehension that comment
  // exists to name: these are source-text tripwires, not behavioural tests.
  // The two assertions above are strictly stronger than `card.includes(
  // "activeAnswer.body")` -- the render node and its computation must BOTH
  // survive, so neither a dead-comment decoy nor a hollowed-out render passes
  // on its own. They still cannot prove the matched node is the one React
  // mounts, and a rewrite that keeps the same vocabulary elsewhere (renaming
  // the variable, moving the paragraph into a child component, changing the
  // className) passes or fails on TEXT rather than on behaviour. Proving the
  // rendered output needs a rendering harness this repo's test convention
  // does not use; do not add one to strengthen this further without that
  // conversation happening first.
}

{
  const console_ = read("components/web-leads/ObjectionConsole.tsx");
  // No silent truncation. The console is allowed to open on a short slice
  // (mid-call, a rep should not have to scroll past a wall of cards to reach
  // the ones ranked highest) but there must be an explicit, user-facing way
  // to reach the rest -- a fixed subset with no path to the remainder is
  // exactly the kind of drop the deleted OBJECTIONS.map assertion existed to
  // catch, restated for a component that is allowed to paginate on purpose.
  //
  // LIMITATION, STATED PLAINLY (task-10 fix round 2): these are source-text
  // tripwires, like every other assertion in this file. They catch an
  // outright deletion of the pattern. They CANNOT prove the matched text is
  // the code actually feeding the render rather than a dead comment or an
  // unreachable branch, and they cannot catch a behavioural change that
  // keeps the same vocabulary elsewhere. A fix-round-2 review proved the
  // first version of this block wrong on exactly that gap: it left the
  // ternary regex's own text as a dead comment, changed the real `visible`
  // computation to a hardcoded `state.objections.slice(0, 3)`, and every
  // assertion below still passed. The two checks after the ternary match
  // close THAT specific hole (a decoy plus a second real slice can no longer
  // both satisfy "exactly one `.slice(` in the file" and "no literal-numeric
  // slice bound anywhere in it") -- they do not make this a behavioural test.
  // Nor do they constrain truncation in general: all three checks above match
  // only on the literal text `.slice(`, so a fixed-length cutoff written with
  // a different mechanism -- `.filter((_, i) => i < 3)`, `.splice(0, 3)`, a
  // manual for-loop with a break, `Array.from({length: 3})`, and so on --
  // passes every one of them untouched. This file only ever pins `.slice(`;
  // it does not and cannot pin truncation as a class.
  // Proving the render is actually unsliced needs a rendering harness this
  // repo's test convention does not use; do not add one to strengthen this
  // further without that conversation happening first.
  assert.match(
    console_,
    /expanded\s*\?\s*state\.objections\s*:\s*state\.objections\.slice\(/,
    "ObjectionConsole must fall back to the FULL ranked list once expanded, not a fixed subset",
  );
  // Exactly one `.slice(` call in the whole file. The legitimate console has
  // exactly one (inside the ternary just asserted above); a second one --
  // whether it replaces the real computation while the first survives as a
  // dead comment, or sits anywhere else -- is a competing truncation this
  // file has no business containing.
  const sliceCallCount = (console_.match(/\.slice\(/g) || []).length;
  assert.equal(
    sliceCallCount,
    1,
    `ObjectionConsole.tsx must contain exactly one .slice( call, found ${sliceCallCount} -- a second one is a competing (and possibly live) truncation`,
  );
  // No slice bounded by a literal number anywhere in the file. The only
  // legitimate bound is `state.openCount`, a value the server computed --
  // never a number typed into the component, which is what a silent
  // permanent truncation (`.slice(0, 3)`) looks like in source.
  assert.doesNotMatch(
    console_,
    /\.slice\(\s*0\s*,\s*\d+\s*\)/,
    "ObjectionConsole.tsx must never slice to a literal numeric bound -- the open count comes from the server (state.openCount), not a number typed into the component",
  );
  assert.match(
    console_,
    /onClick=\{\(\)\s*=>\s*setExpanded\(true\)\}/,
    "ObjectionConsole must offer an explicit control that reaches the rest of the list",
  );
  assert.match(console_, /Show all \{state\.objections\.length\}/, "ObjectionConsole's expand control must name the true count, not a guess");
}

// Same rule as the rest of the feature: nothing on either surface is
// generated. AI drafts a catalog row, a human approves it, and only approved
// rows ever render -- neither component may itself call a model.
for (const view of ["components/web-leads/ObjectionCard.tsx", "components/web-leads/ObjectionConsole.tsx"]) {
  const src = read(view);
  assert.doesNotMatch(src, /claudeMessages|anthropic|openai|generateText/i, `${view} must never generate copy`);
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
// 8f. THE CARD'S FACES: every font the card declares must exist as a
//     vendored file. next/font/local fails the BUILD on a missing file, but
//     only when the importing route builds -- this catches a lost woff2 at
//     test time, with a message that names the file instead of a webpack
//     stack. Two faces since the compact card (2026-10-01): display (Chakra
//     Petch) for labels and telemetry (JetBrains Mono). Orbitron left with
//     the animated score ring it existed for.
// ---------------------------------------------------------------------------

{
  const view = "components/web-leads/BattleCard.tsx";
  const src = read(view);
  const declared = [...src.matchAll(/path: "\.\.\/\.\.\/(app\/fonts\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(declared.length >= 5, `${view} declares only ${declared.length} font files -- the two-face system lost a weight`);
  for (const rel of declared) {
    assert.ok(fs.existsSync(path.join(process.cwd(), rel)), `${view} declares ${rel} but the file is not vendored -- the build will fail on it`);
  }
  for (const face of ["ChakraPetch-", "JetBrainsMono-"]) {
    assert.ok(declared.some((p) => p.includes(face)), `${view} lost the ${face} face`);
  }
  assert.ok(!declared.some((p) => p.includes("Orbitron")), `${view}: the Orbitron dial face left with the score ring`);
  assert.equal((src.match(/--battle-numeral/g) || []).length, 0, `${view}: nothing may wear a numeral face the card no longer declares`);
}

// ---------------------------------------------------------------------------
// 8j. ROUND 9 — THE FINAL POLISH IS PHYSICS AND WAYFINDING. Audit findings,
//     each pinned so it cannot regress: no visual state may SNAP (selection
//     and hover blend through damped mixes), no animation may run on a
//     layout property (width -> transform), all per-frame damping is
//     frame-rate-normalized (a flight takes the same time on 60Hz and
//     144Hz), sections animate open/close PHYSICALLY (grid-rows, content
//     inert while closed so a hidden drawer can't swallow focus), and the
//     card gained a section tab strip so a rep six sections deep can jump
//     anywhere -- driven by a registry, never a hand-maintained list that
//     drifts from the page.
// ---------------------------------------------------------------------------

{
  const src = read("components/web-leads/BattleCard.tsx");
  // RE-AIMED, NOT RELAXED (Task 5, 2026-09-14): `Meter` moved to
  // components/web-leads/audit-parts.tsx so the capability catalogue could
  // draw the same bar instead of the near-copy it had grown (which had lost
  // the tick overlay while both bars rendered on the same card). Both drawers
  // are still counted, each in the file it now lives in, and the requirement
  // is unchanged: transform, never width.
  const bars = src + read("components/web-leads/audit-parts.tsx");
  assert.doesNotMatch(bars, /transition[^}]{0,80}width 420ms/, "meters must animate transform, never width -- width re-lays-out every frame");
  const scaleXDraws = (bars.match(/transform: drawn \? "scaleX\(1\)" : "scaleX\(0\)"/g) || []).length;
  assert.ok(scaleXDraws >= 1, `the shared Meter must draw via scaleX (found ${scaleXDraws}); the head-to-head track that was the second bar left with the compact card`);
  // One meter, not two. The catalogue's copy is gone; if a second one comes
  // back, the tick overlay is the first thing it loses.
  assert.doesNotMatch(
    read("components/web-leads/CapabilityRow.tsx"),
    /repeating-linear-gradient/,
    "CapabilityRow must draw the shared Meter, not a second bar of its own",
  );
  assert.match(
    read("components/web-leads/audit-parts.tsx"),
    /repeating-linear-gradient/,
    "the shared Meter keeps the tick overlay every bar on this card wears",
  );

  // Registry callbacks are identity-stable: recreated callbacks invalidate
  // every section's registration effect on every state change -- an
  // unregister/re-register cascade that reorders the tab strip and can
  // loop. (Codex review P1, 2026-09-02.)
  const shell = read("components/web-leads/BattleSection.tsx");
  assert.match(shell, /const registerSection = useCallback\(/, "registry callbacks must be identity-stable or registration cascades");
  assert.match(shell, /const reportOpen = useCallback\(/, "reportOpen must be identity-stable for the same reason");
  assert.match(shell, /registerSection/, "sections must self-register -- a hand-maintained tab list drifts from the page");
  assert.match(shell, /bus\.sections\.map/, "the tab strip must render from the registry");
  assert.match(shell, /gridTemplateRows: isOpen \? "1fr" : "0fr"/, "sections must animate open/close via grid-rows -- the one CSS-only unknown-height animation");
  assert.match(shell, /inert=\{!isOpen\}/, "closed content stays mounted but must be inert -- a hidden drawer must not swallow keyboard focus");
  assert.match(shell, /aria-hidden=\{!isOpen\}/, "closed content must be hidden from assistive tech");
  assert.match(shell, /openOne\(id\)/, "a tab must OPEN its section, not just scroll to a closed drawer");
}


// ---------------------------------------------------------------------------
// 8k. THE PRESENCE LAYER ON THE CARD (phase 2). The pins are the honesty
//     contract: the payload carries onlinePresence at ALL THREE route exits
//     (presence is the whole pitch precisely for the leads with no scored
//     website), null pillars render as "not measured" sentences and never as
//     fabricated failures, every presence check has a hand-written measured
//     sentence, the pillar hues are complete AND disjoint from the website
//     dimension hues, and the card asks the worker at most once per lead per
//     mount with the atomically-deduped route doing the real guarding.
// ---------------------------------------------------------------------------

{
  const route = read("app/api/web-leads/[id]/battlecard/route.ts");
  const exits = (route.match(/onlinePresence/g) || []).length;
  assert.ok(exits >= 4, `the battlecard payload must carry onlinePresence at every exit (saw ${exits} references; 1 fetch + 3 exits)`);

  const presenceLib = read("lib/web-leads/presence.ts");
  assert.match(presenceLib, /export const PRESENCE_VERSION = 1/, "the oasis copy of PRESENCE_VERSION must be declared exactly once and match the JARVIS worker");
  assert.equal((presenceLib.match(/PRESENCE_VERSION = /g) || []).length, 1);
  assert.match(presenceLib, /state: "none"/, "malformed or missing blobs must collapse to the honest none state, never to findings");

  // Every presence check code has a hand-written sentence, and nothing else.
  const PRESENCE_CODES = [
    "gbp_found", "gbp_operational", "gbp_rated", "gbp_reviews_10", "gbp_photos", "gbp_hours",
    "nap_phone_match", "nap_locality", "nap_both_listed",
    "mail_mx", "mail_spf", "mail_dmarc",
    "social_resolve",
  ];
  assert.deepEqual([...PRESENCE_EXPLAINED_CODES].sort(), [...PRESENCE_CODES].sort(),
    "presence-evidence must explain exactly the model's 13 presence checks -- an orphan sentence is copy about a check that does not exist");

  // Copy house rules apply to presence exactly as to the website.
  // Comments may use em dashes (the whole codebase's headers do); the ban is
  // on RENDERED copy, so strip comments before checking the sentence strings.
  const evid = stripComments(read("lib/web-leads/presence-evidence.ts"));
  assert.ok(!evid.includes("—"), "no em dashes in anything a rep reads aloud");

  // Pillar hues: complete for the four pillars, and DISJOINT from every
  // website dimension hue -- one colour meaning two different things on one
  // card is the identity system eating itself.
  const hud = read("components/web-leads/battle-hud.ts");
  for (const pk of ["gbp", "consistency", "email", "social"]) {
    assert.match(hud, new RegExp(`PILLAR_HUES[\\s\\S]{0,600}?\\b${pk}:`), `battle-hud must carry an identity hue for pillar "${pk}"`);
  }
  const dimVals = new Set(Object.values(DIM_HUES).flatMap((h) => [h.from.toLowerCase(), h.to.toLowerCase()]));
  for (const [pk, h] of Object.entries(PILLAR_HUES)) {
    assert.ok(!dimVals.has(h.from.toLowerCase()) && !dimVals.has(h.to.toLowerCase()),
      `pillar "${pk}" reuses a website dimension hue`);
  }

  // The block renders the honest states: not-measured copy, the social
  // deferral sentence (we refuse to probe platforms against their robots),
  // pass/fail as shape.
  const block = read("components/web-leads/PresenceBlock.tsx");
  assert.match(block, /Not measured yet/, "an unmeasured pillar must say so");
  assert.match(block, /has not been measured yet/, "the none state must render the waiting sentence");
  // The empty state may only claim what the CARD actually knows: it says a
  // lookup was requested ONLY on a successful enqueue, and says so honestly
  // when the request itself failed. (Codex review, 2026-09-03.)
  assert.match(block, /ask === "queued" \|\| ask === "asking"/, "the requested-copy must be gated on a real enqueue");
  assert.match(block, /could not be requested just now/, "a refused enqueue must be stated, never papered over");
  assert.match(block, /missing from ours/, "a measurement gap must be named as ours, not as their failing");
  assert.match(block, /a method the platforms allow/, "the social deferral must be explained, not hidden");
  assert.match(block, /separate from the website score/, "the two composites must never read as one");

  // The card asks once per lead per mount; the section sits at the
  // container level (in the map above) so unscored leads still get it.
  const card = read("components/web-leads/BattleCard.tsx");
  assert.match(card, /presenceAskedRef/, "the card must not re-enqueue on every silent refresh");
  // The lead-switch race: a mounted card handed a new leadId clears the ref
  // one render before the new payload lands, so the effect must refuse to
  // act on a payload belonging to another lead.
  assert.match(card, /state\.payload\.lead\?\.id !== leadId/, "the enqueue must refuse a payload from a different lead");
  // A queued measurement must actually come back while the rep watches, and
  // the poll must be bounded so a card left open all shift stops asking.
  assert.match(card, /PRESENCE_POLL_LIMIT/, "a queued presence measurement must be polled for");
  assert.match(card, /presencePolls > PRESENCE_POLL_LIMIT/, "the presence poll must be bounded");
  // The in-flight POST must survive unrelated payload refreshes: the effect
  // depends on `state`, and the card re-polls every 6s during a website
  // re-check, so an effect-cleanup cancel flag would discard the enqueue's
  // own answer and strand the section at "asking". Cancellation is scoped to
  // the LEAD. (Codex review, 2026-09-03.)
  assert.match(card, /presenceGenRef.current !== askedFor/, "an in-flight presence enqueue must only be discarded on a lead change or unmount");
  assert.match(card, /\/presence`, \{ method: "POST" \}/, "the card must enqueue through the deduped route");
  assert.match(card, /<PresenceBlock presence=\{onlinePresence\} ask=\{presenceAsk\.status\} \/>/, "the presence section must render the block, carrying what the card knows about its own request");
}

console.log("web-leads-battlecard ok");
