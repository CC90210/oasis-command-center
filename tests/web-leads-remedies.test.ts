import assert from "node:assert";
import { REMEDIES, remedyFor } from "../lib/web-leads/remedies";

const codes = Object.keys(REMEDIES);

// A gap with no remedy is a complaint. The whole point of this copy is that a
// rep reads a script rather than a defect list.
assert.ok(codes.length >= 49, `expected at least 49 remedies, got ${codes.length}`);

for (const c of codes) {
  assert.ok(REMEDIES[c].costs.length >= 25, `${c}: costs is a stub`);
  assert.ok(REMEDIES[c].fix.length >= 20, `${c}: fix is a stub`);
}

// House rule for anything read aloud to a customer.
const emDash = codes.filter((c) => `${REMEDIES[c].costs}${REMEDIES[c].fix}`.includes("—"));
assert.deepEqual(emDash, [], `em dashes in: ${emDash.join(", ")}`);

// A rep says these to a plumber, not to an engineer.
const jargon = /viewport|CTA\b|semantic|schema\.org|DOM|render-block|LCP|TTFB/i;
const bad = codes.filter((c) => jargon.test(`${REMEDIES[c].costs} ${REMEDIES[c].fix}`));
assert.deepEqual(bad, [], `jargon in: ${bad.join(", ")}`);

// An unknown code must return null, not throw — the panel renders many codes
// and one unrecognised check must not blank the whole section.
assert.equal(remedyFor("not_a_real_check"), null);

console.log("web-leads-remedies ok");
