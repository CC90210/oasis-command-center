/**
 * THE MERCHANT ADDRESS FIELD — the defects that were live in production on
 * 2026-09-10, each pinned so it cannot come back silently.
 *
 * Adon, 2026-09-10: "it is actively not allowing merchants to submit the form
 * properly (which is the most important aspect of this business)."
 *
 * The audit that produced these cases ran against LIVE production
 * (sunbizfunding.com and oasisai.work): 12 real queries, 56 suggestions. What
 * it found was not a validator bug at all — it was that
 * `GOOGLE_PLACES_API_KEY` had never been set on the Vercel project, so every
 * merchant since launch had been served the keyless Photon/OSM fallback while
 * the code, the comments and everyone's mental model said "Google Places".
 * Every suggestion came back with no `placeId`, which is the fingerprint.
 *
 * These tests are deliberately provider-independent: they pin the SHAPE of a
 * usable suggestion and the SHAPE of a recoverable failure, so the guarantee
 * holds whichever provider is answering.
 */

import assert from "node:assert/strict";
import {
  isAcceptableCaptureAddress,
  splitUsAddress,
  composeUsAddress,
  US_STATE_CODES,
} from "../lib/address/us-address";
import {
  normalizeAddressSuggestions,
  photonFeaturesToSuggestions,
  type PhotonProperties,
} from "../lib/forms/address-suggestions";

// ---------------------------------------------------------------------------
// 1. The suggestions that were actually served to merchants, verbatim.
// ---------------------------------------------------------------------------

/** Captured live from https://sunbizfunding.com/api/forms/address-autocomplete
 *  on 2026-09-10, before the fix. Not synthesized. */
const LIVE_PHOTON_SUGGESTIONS_BEFORE_FIX = [
  // Merchant typed "7930 Snow View Drive" — the house number is gone from all
  // five of these, and the fourth carries no ZIP at all.
  "Snow View Drive, Summit, Utah, 84098",
  "Snow View Drive, Kent, Michigan, 49302",
  "Snow View Drive, Anchorage, Alaska, 99507",
  "Snow View Drive, Riverside, California",
  "Snow View Drive, Missoula, Montana, 59826",
  // Merchant typed "8 The Green Dover DE".
  "The Green (First State Heritage Park), Dover, Delaware",
  // Merchant typed "500 Terry Francois Blvd San Francisco".
  "Sloat Blvd bikeway, San Francisco, California, 94166",
];

/**
 * THE CLOSED LOOP. A suggestion offered by our own dropdown that our own gate
 * then refuses, with no way for the merchant to get out: re-opening the
 * dropdown offers the identical entry again.
 *
 * The route now drops these before they are ever offered (no postcode => not a
 * suggestion), and the field reveals a City/State/ZIP completion row if one
 * ever does slip through. This test states the property that made it a bug.
 */
for (const s of ["Snow View Drive, Riverside, California", "The Green (First State Heritage Park), Dover, Delaware"]) {
  assert.equal(
    isAcceptableCaptureAddress(s).ok,
    false,
    `sanity: "${s}" must be refused by the gate — it is why offering it was a dead end`,
  );
  assert.match(
    isAcceptableCaptureAddress(s).message,
    /ZIP code/,
    "the refusal must name the ZIP, which is the part these entries lack",
  );
}

/**
 * The REAL filter, against the REAL feature bags Photon returned for
 * "7930 Snow View Drive" on 2026-09-10 (captured verbatim from
 * photon.komoot.io, not synthesized). Note what the first five actually
 * contain: `name` with no `housenumber`/`street`, and `county` where a city
 * belongs. Summit, Kent, Riverside and Missoula are COUNTIES.
 *
 * This calls `photonFeaturesToSuggestions` — the function the route itself
 * calls — so the test cannot pass while the shipped filter is broken.
 */
const LIVE_PHOTON_FEATURES: Array<{ properties?: PhotonProperties }> = [
  { properties: { countrycode: "US", name: "Snow View Drive", county: "Summit", state: "Utah", postcode: "84098" } },
  { properties: { countrycode: "US", name: "Snow View Drive", county: "Kent", state: "Michigan", postcode: "49302" } },
  { properties: { countrycode: "US", name: "Snow View Drive", city: "Anchorage", state: "Alaska", postcode: "99507" } },
  { properties: { countrycode: "US", name: "Snow View Drive", county: "Riverside", state: "California" } },
  { properties: { countrycode: "US", name: "Snow View Drive", county: "Missoula", state: "Montana", postcode: "59826" } },
  { properties: { countrycode: "US", housenumber: "7930", street: "Prairie View Drive", city: "Indianapolis", county: "Marion County", state: "Indiana", postcode: "46256" } },
  { properties: { countrycode: "US", housenumber: "7930", street: "Eagle View Drive", city: "Chesapeake Beach", county: "Calvert", state: "Maryland", postcode: "20732" } },
  { properties: { countrycode: "US", housenumber: "7930", street: "Hidden View Drive", city: "Holland", county: "Lucas", state: "Ohio", postcode: "43528" } },
];

const filtered = photonFeaturesToSuggestions(LIVE_PHOTON_FEATURES);

// Exactly the three real addresses survive. The five street/POI features that
// dropped the merchant's house number are gone.
assert.deepEqual(
  filtered.map((s) => s.value),
  [
    "7930 Prairie View Drive, Indianapolis, Indiana, 46256",
    "7930 Eagle View Drive, Chesapeake Beach, Maryland, 20732",
    "7930 Hidden View Drive, Holland, Ohio, 43528",
  ],
  "only genuine housenumber+street+postcode+city features may be offered",
);

// No county may ever appear where a city belongs.
for (const county of ["Summit", "Kent", "Riverside", "Missoula", "Marion County", "Calvert", "Lucas"]) {
  assert.ok(
    !filtered.some((s) => s.value.includes(`, ${county},`)),
    `"${county}" is a county and must never be printed as the city`,
  );
}

// Every surviving suggestion must pass the very gate that will judge it. This
// is the property whose absence created the closed loop.
for (const s of filtered) {
  assert.equal(
    isAcceptableCaptureAddress(s.value).ok,
    true,
    `the dropdown must never offer what our own gate refuses: ${s.value}`,
  );
}

// The filter must not be so strict it empties a working dropdown, and it must
// still honour the US-only and dedupe rules.
assert.equal(
  photonFeaturesToSuggestions([
    { properties: { countrycode: "CA", housenumber: "1", street: "King St W", city: "Toronto", state: "Ontario", postcode: "M5H1A1" } },
    { properties: { countrycode: "US", housenumber: "350", street: "5th Avenue", city: "New York", state: "New York", postcode: "10118" } },
    { properties: { countrycode: "US", housenumber: "350", street: "5th   Avenue", city: "new york", state: "New York", postcode: "10118" } },
  ]).length,
  1,
  "non-US dropped; the duplicate collapses case/whitespace-insensitively",
);
assert.equal(photonFeaturesToSuggestions(undefined).length, 0, "no features is not a crash");

// ---------------------------------------------------------------------------
// 2. Google's autocomplete label has NO ZIP. This is the select→Continue race.
// ---------------------------------------------------------------------------

/**
 * Verified live against the real key on 2026-09-10:
 *   autocomplete  -> "911 Magnolia Dr, Algonquin, IL, USA"      (no ZIP)
 *   place details -> "911 Magnolia Dr, Algonquin, IL 60102, USA" (ZIP)
 *
 * So a merchant who selects and clicks Continue before the second round trip
 * lands is holding a string the gate refuses. The field raises
 * `onResolvingChange` across that window and the public form waits it out;
 * without that hold, this assertion IS the merchant's rejection.
 */
const GOOGLE_LABEL = "911 Magnolia Dr, Algonquin, IL, USA";
const GOOGLE_RESOLVED = "911 Magnolia Dr, Algonquin, IL 60102, USA";

assert.equal(
  isAcceptableCaptureAddress(GOOGLE_LABEL).ok,
  false,
  "the Google autocomplete label alone must NOT pass — this is why the resolve step exists",
);
assert.equal(
  isAcceptableCaptureAddress(GOOGLE_RESOLVED).ok,
  true,
  "the resolved Place Details address must pass",
);

// A Google prediction must carry the placeId that makes resolution possible.
// A suggestion without one cannot be completed and must not be treated as
// though it can.
const normalized = normalizeAddressSuggestions([
  { label: GOOGLE_LABEL, value: GOOGLE_LABEL, placeId: "ChIJoxxgK20MD4gRqvssDxF5U8Q" },
]);
assert.equal(normalized.length, 1);
assert.ok(normalized[0].placeId, "Google suggestions must carry a placeId to be resolvable");

// The Photon shape, for contrast: no placeId, so the field must not sit waiting
// on a resolution that can never come.
const photonShape = normalizeAddressSuggestions([
  { label: "911 Magnolia Drive, Chatham, Illinois, 62629", value: "911 Magnolia Drive, Chatham, Illinois, 62629" },
]);
assert.equal(photonShape[0].placeId, undefined, "Photon suggestions carry no placeId");

// ---------------------------------------------------------------------------
// 3. The escape hatch: City/State/ZIP always composes to something acceptable.
// ---------------------------------------------------------------------------

/**
 * THE GUARANTEE. Whatever the provider did — returned nothing, returned a
 * street with no building, failed its details call — a merchant who fills the
 * completion row must end up with an address the gate accepts. This mirrors
 * exactly what `AddressCompletion.patch` does.
 */
function completeByHand(typed: string, city: string, state: string, zip: string): string {
  const parts = splitUsAddress(typed);
  return composeUsAddress({
    line1: parts.line1 || typed.trim(),
    city: city || parts.city,
    state: state || parts.state,
    zip: zip || parts.zip,
  });
}

for (const typed of [
  "7930 Snow View Drive", // the bare street line that started all of this
  "123 Biscayne Blvd",
  "PO Box 94",
  "Snow View Drive, Riverside, California", // a rejected suggestion, repaired
  "911 Magnolia Dr, Algonquin, IL, USA", // a Google label whose resolve failed
]) {
  const fixed = completeByHand(typed, "Algonquin", "IL", "60102");
  const gate = isAcceptableCaptureAddress(fixed);
  assert.equal(
    gate.ok,
    true,
    `completion row must always produce an acceptable address; "${typed}" -> "${fixed}" (${gate.message})`,
  );
}

// The state picker must only ever offer codes the parser accepts, or the row
// would be a new closed loop of its own.
for (const code of US_STATE_CODES) {
  const composed = composeUsAddress({ line1: "1 Main St", city: "Springfield", state: code, zip: "12345" });
  assert.equal(
    splitUsAddress(composed).state,
    code,
    `state picker offers ${code}; the parser must read it back`,
  );
}
assert.ok(US_STATE_CODES.includes("DC"), "DC funds deals and must be selectable");
assert.equal(new Set(US_STATE_CODES).size, US_STATE_CODES.length, "no duplicate state codes");

// ---------------------------------------------------------------------------
// 4. business_address may take its state from the dropdown; home addresses may not.
// ---------------------------------------------------------------------------
// This mirrors app/api/forms/submit/route.ts and the client validator. If they
// ever diverge, a merchant passes one and is refused by the other.
assert.equal(
  isAcceptableCaptureAddress("123 Biscayne Blvd, Miami, 33101", "FL").ok,
  true,
  "business_address completes its state from the separate dropdown",
);
assert.equal(
  isAcceptableCaptureAddress("123 Biscayne Blvd, Miami, 33101").ok,
  false,
  "an owner/partner home address has no dropdown and must carry its own state",
);

console.log("address-field-turnkey.test.ts: OK");
