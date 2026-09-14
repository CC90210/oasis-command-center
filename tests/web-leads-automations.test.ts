import assert from "node:assert";
import { CAPABILITIES, codeToCapability, STAGES } from "../lib/web-leads/automations";
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
const MONEY = /[$£€]\s?\d|\bCA\$|\b\d+\s?(?:dollars|bucks)\b/i;

const repFacing = (c: (typeof CAPABILITIES)[number]) => [
  c.title,
  c.summary,
  c.whatItIs,
  c.howYouSayIt,
  c.costsThem ?? "",
  c.stageReason ?? "",
  ...c.whatWeDeliver,
];

for (const cap of CAPABILITIES) {
  for (const layer of ["title", "summary", "whatItIs", "howYouSayIt"] as const) {
    assert.ok(cap[layer] && String(cap[layer]).trim().length > 0, `${cap.id}.${layer} must not be empty`);
  }
  assert.ok(cap.whatWeDeliver.length > 0, `${cap.id}.whatWeDeliver must list something`);
  for (const line of cap.whatWeDeliver) {
    assert.ok(line.trim().length > 0, `${cap.id}.whatWeDeliver must not carry an empty line`);
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

  // Rule 3: we have no revenue data for these businesses, so no money appears
  // anywhere in copy. A competitor price would be allowed, but only with a
  // `source` on the capability that cites it.
  for (const s of repFacing(cap)) {
    if (MONEY.test(s)) {
      assert.ok(
        cap.source && cap.source.trim().length > 0,
        `${cap.id}: a figure in copy needs a source on the capability: ${s.slice(0, 60)}`,
      );
    }
  }

  // The two registers must actually differ.
  assert.notEqual(
    cap.howYouSayIt.trim().toLowerCase(),
    cap.whatItIs.trim().toLowerCase(),
    `${cap.id}: the spoken line and the owner explanation must be different writing`,
  );
}

console.log("web-leads-automations copy rules: OK");
