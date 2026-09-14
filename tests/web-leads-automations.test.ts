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
