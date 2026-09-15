import assert from "node:assert";
import { CAPABILITIES, codeToCapability, STAGES } from "../lib/web-leads/automations";
import { INDUSTRY_AUTOMATIONS } from "../lib/industry-automations";
import { REMEDIES } from "../lib/web-leads/remedies";

// ---------------------------------------------------------------------------
// The catalogue is what a rep sells from. The scoring model is what we measure.
// If they drift apart, a rep is either quoting for something we cannot measure
// or measuring something we cannot explain. This file is the seam.
//
// NOTHING HERE HARDCODES A COUNT. The count changes when the scoring model
// changes, and a test asserting "44" would fail for the wrong reason, or worse
// be updated to the new number by someone who never checked the new code was
// actually bundled.
// ---------------------------------------------------------------------------

const allCodes = Object.keys(REMEDIES);
assert.ok(allCodes.length > 0, "REMEDIES must not be empty");

// Every measurable defect belongs to exactly one thing we can sell.
{
  const seen = new Map<string, string[]>();
  for (const cap of CAPABILITIES) {
    for (const code of cap.codes) {
      seen.set(code, [...(seen.get(code) || []), cap.id]);
    }
  }

  const unmapped = allCodes.filter((c) => !seen.has(c));
  assert.deepEqual(unmapped, [], `every REMEDIES code must be in a bundle, unmapped: ${unmapped.join(",")}`);

  const duplicated = [...seen.entries()].filter(([, caps]) => caps.length > 1);
  assert.deepEqual(
    duplicated.map(([code, caps]) => `${code}->${caps.join("+")}`),
    [],
    "a code in two bundles makes a rep contradict themselves on a call",
  );

  const unknown = [...seen.keys()].filter((c) => !allCodes.includes(c));
  assert.deepEqual(unknown, [], `a bundle cites a code the model does not measure: ${unknown.join(",")}`);
}

// codeToCapability is the lookup the detail layer uses; it must agree with the map.
for (const code of allCodes) {
  const cap = codeToCapability(code);
  assert.ok(cap, `codeToCapability must resolve ${code}`);
  assert.ok(cap.codes.includes(code), `codeToCapability(${code}) returned a bundle that does not claim it`);
}
assert.equal(codeToCapability("not_a_real_code"), null);

// Stage is a closed set and every capability declares one.
for (const cap of CAPABILITIES) {
  assert.ok((STAGES as readonly string[]).includes(cap.stage), `${cap.id} has an unknown stage ${cap.stage}`);
}

// Ladder entries carry no codes; website capabilities carry at least one.
for (const cap of CAPABILITIES) {
  if (cap.stage === "today") {
    assert.ok(cap.codes.length > 0, `${cap.id} is sellable today but covers no measurable check`);
  } else {
    assert.equal(cap.codes.length, 0, `${cap.id} is a ladder entry and must not claim scoring codes`);
    assert.ok(cap.stageReason && cap.stageReason.trim().length > 0, `${cap.id} must say why it is not sellable today`);
  }
}

// Ids are unique and stable-looking.
{
  const ids = CAPABILITIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "capability ids must be unique");
}

console.log("web-leads-automations: OK");

// ---------------------------------------------------------------------------
// The copy rules. These are rep-facing and owner-facing strings; a violation
// reaches a stranger's ear on a cold call, which is why they are pinned here
// rather than left to review.
// ---------------------------------------------------------------------------

// The em dash is written as an escape so this guard file does not itself
// contain the character it bans.
const DASH = /\u2014|--/;
// Money, in the three shapes this copy could plausibly carry it. Kept as
// three named arms rather than one regex because the third is the only one
// that needed inventing and it is the one most likely to need tuning.
const MONEY_SYMBOL = /[$£€]/;
const MONEY_NOUN = /\b(?:dollars?|cents?|bucks|grand|quid|CAD|USD)\b/i;
// A figure with a period attached: "497 a month", "four ninety seven a month",
// "two thousand a month", "a couple hundred a week". This is the shape the
// CA$497 / CA$197 offer price takes when a rep says it out loud without the
// currency, which is the one number this file actually risks carrying.
const NUM =
  "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|" +
  "fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|couple|few|dozen)";
const PERIOD = "(?:a|an|per|each|every)\\s+(?:month|week|year|day|hour|job|call|lead|visit|customer)";
const MONEY_RATE = new RegExp(
  "\\b(?:\\d[\\d,]*k?|(?:a\\s+)?" + NUM + "(?:[\\s-]+(?:and\\s+)?" + NUM + ")*)\\s+" + PERIOD + "\\b",
  "i",
);
const statesMoney = (s: string) => MONEY_SYMBOL.test(s) || MONEY_NOUN.test(s) || MONEY_RATE.test(s);

const repFacing = (c: (typeof CAPABILITIES)[number]) => [
  c.title,
  c.summary,
  c.whatItIs,
  c.howYouSayIt,
  c.costsThem ?? "",
  c.stageReason ?? "",
  ...(c.whatWeDeliver ?? []),
];

for (const cap of CAPABILITIES) {
  for (const layer of ["title", "summary", "whatItIs", "howYouSayIt"] as const) {
    assert.ok(cap[layer] && String(cap[layer]).trim().length > 0, `${cap.id}.${layer} must not be empty`);
  }
  // `whatWeDeliver` is optional, because a rep reads each bullet aloud as a
  // commitment and some capabilities deliberately make no scope promise. What
  // is NOT allowed is the layer being present and saying nothing: an empty
  // array reads to the UI as "there is a scope list" while carrying none, and
  // it is the shape a half-finished removal leaves behind. Absent is a
  // decision; empty is a mistake. This asserts exactly that distinction.
  if (cap.whatWeDeliver !== undefined) {
    assert.ok(
      cap.whatWeDeliver.length > 0,
      `${cap.id}.whatWeDeliver is present but empty: omit the field entirely instead`,
    );
    for (const line of cap.whatWeDeliver) {
      assert.ok(line.trim().length > 0, `${cap.id}.whatWeDeliver must not carry an empty line`);
    }
  }

  // Website bundles are defect-driven, so they must say how a customer is lost
  // today. Ladder entries are not, and may omit it.
  if (cap.stage === "today") {
    assert.ok(
      cap.costsThem && cap.costsThem.trim().length > 0,
      `${cap.id} covers measurable checks, so it must say how a customer is lost today`,
    );
  }

  for (const s of repFacing(cap)) {
    assert.ok(!DASH.test(s), `${cap.id}: no em dash and no "--" in copy a rep reads aloud: ${s.slice(0, 60)}`);
  }

  // Rule 4 of the offer strategy: never lead with AI. It may appear inside a
  // later-stage entry's own detail; it may not appear on a row a rep opens with.
  if (cap.stage === "today") {
    assert.ok(!/\bAI\b/i.test(cap.title), `${cap.id}: a today-stage title must not lead with AI`);
    assert.ok(!/\bAI\b/i.test(cap.summary), `${cap.id}: a today-stage summary must not lead with AI`);
  }

  // Rule 3, spec 7.3. We have no revenue data for these businesses, so a
  // customer outcome is never stated in money.
  //
  // WHAT THIS CATCHES, exactly. Three shapes, and nothing else:
  //   1. A currency symbol anywhere: $, £, €. So "$400", "CA$497".
  //   2. The money nouns, as whole words: dollar(s), cent(s), bucks, grand,
  //      quid, CAD, USD. So "five grand a month", "four hundred dollars".
  //   3. A figure with a period attached: a digit run, or a spelled-out
  //      number, IMMEDIATELY followed by (a|an|per|each|every) + (month,
  //      week, year, day, hour, job, call, lead, visit, customer). So
  //      "497 a month", "four ninety seven a month", "two thousand a month",
  //      "a couple hundred a week", "5k a month".
  //
  // WHAT IT MISSES, stated so nobody trusts it further than it goes:
  //   - A bare figure with neither a symbol nor a period phrase. "We charge
  //     497" passes. So does "the price is four ninety seven".
  //   - A figure separated from its period by other words: "497, billed
  //     every month" passes.
  //   - A period noun not on the list above: "497 a location" passes.
  //   - Any amount implied without either signal at all.
  // A clean run is therefore NOT proof that no price is present. It is proof
  // that none of the three matched shapes is.
  //
  // It is word-list and shape matching, not money semantics, and it does not
  // pretend otherwise: "a grand old firm" false-positives on arm 2. That is
  // harmless here (the fix is to reword) and it is the honest evidence that
  // arm 2 matches a word, not a meaning.
  //
  // WHY A FLAT BAN AND NOT THE SOURCE-GATED CHECK 7.3 DESCRIBES. A regex
  // cannot tell a customer outcome from a competitor price, and the earlier
  // source-gated version proved it: a dollar figure attached to an outcome
  // passed as long as the capability carried any `source` at all, including
  // a junk one. And 7.3's competitor-price exemption has nowhere to live
  // here anyway: `Capability` has no field for a note a rep READS rather
  // than SPEAKS, every string below is spoken or read off the screen
  // mid-call, and `angles.ts` holds the standing rule that not one spoken
  // sentence carries a number. If a competitor price is ever genuinely
  // needed, the fix is a new coaching-note field with `source` required on
  // it, not a hole punched in this.
  for (const s of repFacing(cap)) {
    assert.ok(
      !statesMoney(s),
      `${cap.id}: copy an owner hears never states money, we have no revenue data: ${s.slice(0, 60)}`,
    );
  }

  // The two registers must actually differ.
  assert.notEqual(
    cap.howYouSayIt.trim().toLowerCase(),
    cap.whatItIs.trim().toLowerCase(),
    `${cap.id}: the spoken line and the owner explanation must be different writing`,
  );
}

console.log("web-leads-automations copy rules: OK");

// ---------------------------------------------------------------------------
// THE STAGE GATE MUST FOLLOW THE PRODUCT ACROSS BOTH LISTS.
//
// `BattleCard.tsx` renders the capability catalogue and then
// `IndustryAutomationGuide`, adjacent, on one screen. The catalogue puts
// `missed-call-text-back` under "Later, once the first evidence reports have
// landed" with "Do not open with them", because spec 3.3 makes that gate a
// PRODUCT constraint and the operator was offered the chance to drop it and
// declined. `lib/industry-automations.ts` carried a literal title collision,
// rendered `defaultOpen`, with an ask-now discovery question and no gate. A
// rep therefore had two contradictory instructions about one product, one
// section apart, and nothing failed.
//
// The fix is `gatedBy`: the colliding entry names the capability, and the
// guide renders that capability's own stage gate instead of its "Ask this"
// block. This is the assertion that makes a future collision loud. It fires
// in three directions:
//   1. a colliding entry with no `gatedBy`, or one pointing at the wrong
//      capability;
//   2. a `gatedBy` naming a capability that does not exist, or set on an
//      entry the catalogue does not also render (which would gate something
//      that is not duplicated, silently deleting a discovery question);
//   3. the SET of colliding entries changing at all, in either file. That
//      last one is deliberately strict rather than "every collision is
//      gated": a vacuous version of this test passes the day somebody
//      retitles both entries, and then passes forever while the next
//      collision is added.
// ---------------------------------------------------------------------------
{
  const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const capabilityByTitle = new Map(CAPABILITIES.map((c) => [normalise(c.title), c]));
  assert.equal(capabilityByTitle.size, CAPABILITIES.length, "two capabilities share a title, so this lookup cannot be trusted");

  const collisions: string[] = [];
  for (const group of INDUSTRY_AUTOMATIONS) {
    for (const item of group.automations) {
      const twin = capabilityByTitle.get(normalise(item.name));
      const where = `${group.id}/${item.name}`;

      if (item.gatedBy !== undefined) {
        assert.ok(
          CAPABILITIES.some((c) => c.id === item.gatedBy),
          `${where}: gatedBy names "${item.gatedBy}", which is not a capability id`,
        );
        assert.ok(
          twin,
          `${where}: gatedBy is for an entry the catalogue ALSO renders. This one has no title twin, so gating it removes a discovery question a rep would otherwise ask`,
        );
      }

      if (!twin) continue;
      collisions.push(where);
      assert.equal(
        item.gatedBy,
        twin.id,
        `${where}: the catalogue renders a capability with this exact title at stage "${twin.stage}". Without gatedBy: "${twin.id}" this menu tells the rep to open with it on the same screen`,
      );
    }
  }

  // The known set, pinned. Both entries are the same capability, in the two
  // industry groups whose owners answer their own phones mid-job.
  assert.deepEqual(
    [...collisions].sort(),
    ["home-services/Missed-call text-back", "restaurants-bars/Missed-call text-back"],
    "the set of titles rendered by BOTH lists changed. A new one must carry gatedBy; a removed one means this pin is stale. Decide which, do not just update the array",
  );
}

// The RENDERING half of this rule (that the guide really does put the gate on
// screen and really does drop the ask-now question) is pinned in
// tests/web-leads-automations-catalogue.test.ts, which spawns a plain node
// process to server-render it. This file runs under --conditions=react-server
// and cannot render a client component at all.
console.log("web-leads-automations stage-gate collision: OK");
