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

// Structure alone: the five street/POI features that dropped the merchant's
// house number are gone, and only the three well-formed addresses remain.
const filtered = photonFeaturesToSuggestions(LIVE_PHOTON_FEATURES);
assert.deepEqual(
  filtered.map((s) => s.value),
  [
    "7930 Prairie View Drive, Indianapolis, Indiana, 46256",
    "7930 Eagle View Drive, Chesapeake Beach, Maryland, 20732",
    "7930 Hidden View Drive, Holland, Ohio, 43528",
  ],
  "only genuine housenumber+street+postcode+city features may be offered",
);

/**
 * STRUCTURE IS NOT ENOUGH. Those three survivors are well-formed and they are
 * all the WRONG STREET — the merchant asked for Snow View Drive and would be
 * offered Prairie View, Eagle View and Hidden View. Picking one sends a lender
 * an address the merchant does not occupy: the same silent substitution as the
 * dropped house number, only harder to notice. With the query supplied, as the
 * route supplies it, none may be offered. (Codex P1, 2026-09-10.)
 */
assert.deepEqual(
  photonFeaturesToSuggestions(LIVE_PHOTON_FEATURES, 8, "7930 Snow View Drive").map((s) => s.value),
  [],
  "a well-formed answer to a DIFFERENT question must not be offered",
);

// Relevance must not be so strict that it refuses the right answer. Real
// abbreviation and suffix differences ("Dr" vs "Drive"), a trailing city in the
// query, and directional prefixes all have to survive.
{
  const magnolia = [
    { properties: { countrycode: "US", housenumber: "911", street: "Magnolia Drive", city: "Algonquin", state: "Illinois", postcode: "60102" } },
    { properties: { countrycode: "US", housenumber: "911", street: "Algonquin Drive", city: "Dallas", state: "Texas", postcode: "75217" } },
  ];
  assert.deepEqual(
    photonFeaturesToSuggestions(magnolia, 8, "911 Magnolia Dr Algonquin").map((s) => s.value),
    ["911 Magnolia Drive, Algonquin, Illinois, 60102"],
    '"Dr" must match "Drive", and a different street with the city\'s name must not',
  );

  const fifth = [
    { properties: { countrycode: "US", housenumber: "350", street: "5th Avenue", city: "New York", state: "New York", postcode: "10118" } },
    { properties: { countrycode: "US", housenumber: "350", street: "South 5th Avenue", city: "Mount Vernon", state: "New York", postcode: "10550" } },
  ];
  assert.equal(
    photonFeaturesToSuggestions(fifth, 8, "350 5th Ave New York").length,
    2,
    "genuinely similar streets at the same number remain legitimate alternatives",
  );

  // A different house number on the right street is still the wrong building.
  assert.deepEqual(
    photonFeaturesToSuggestions(
      [{ properties: { countrycode: "US", housenumber: "1000", street: "Main Street", city: "Houston", state: "Texas", postcode: "77002" } }],
      8,
      "100 Main St Houston TX",
    ).map((s) => s.value),
    [],
    "1000 Main is not 100 Main",
  );

  /**
   * COMPOUND HOUSE NUMBERS. "12A Main St" and the Queens-style "123-45 Main St"
   * are both real and common. A bare \d+ reads "12A" as having no house number
   * (no word boundary between "2" and "A") and truncates "123-45" to "123",
   * after which the exact comparison rejects the CORRECT feature and the
   * leftover "45" is mistaken for the distinctive street word — leaving the
   * merchant with an empty dropdown for an address we can actually resolve.
   * (Codex P2, 2026-09-10.)
   */
  for (const [q, hn] of [
    ["12A Main St Brooklyn", "12A"],
    ["123-45 Main St Flushing", "123-45"],
    ["12a Main St Brooklyn", "12A"], // merchant lowercases; OSM stores uppercase
  ] as const) {
    assert.deepEqual(
      photonFeaturesToSuggestions(
        [
          { properties: { countrycode: "US", housenumber: hn, street: "Main Street", city: "New York", state: "New York", postcode: "11354" } },
          { properties: { countrycode: "US", housenumber: "45", street: "Main Street", city: "New York", state: "New York", postcode: "11354" } },
        ],
        8,
        q,
      ).map((s) => s.value),
      [`${hn} Main Street, New York, New York, 11354`],
      `"${q}" must resolve to house number ${hn}, and not to a different building`,
    );
  }

  /**
   * A STREET WHOSE NAME IS ENTIRELY STOPWORDS. "1 E St Washington DC" is a real
   * address. Token extraction must stop at the street TYPE ("St") rather than
   * running on into the city and then demanding "washington" appear in a street
   * called "E Street" — which discarded the one exact answer Photon had.
   * (Codex P2, 2026-09-10.)
   */
  assert.deepEqual(
    photonFeaturesToSuggestions(
      [
        { properties: { countrycode: "US", housenumber: "1", street: "E Street", city: "Washington", state: "District of Columbia", postcode: "20001" } },
        // Same house number, COMPLETELY different street. Skipping the street
        // test whenever no "distinctive" word exists would let this through and
        // reintroduce the silent substitution. It must not.
        { properties: { countrycode: "US", housenumber: "1", street: "Main Street", city: "Washington", state: "District of Columbia", postcode: "20001" } },
      ],
      8,
      "1 E St Washington DC",
    ).map((s) => s.value),
    ["1 E Street, Washington, District of Columbia, 20001"],
    "a street named only with stopwords must resolve, and ONLY to itself",
  );

  // Whole-word matching: "e" must not match the "e" inside "Street".
  assert.deepEqual(
    photonFeaturesToSuggestions(
      [{ properties: { countrycode: "US", housenumber: "1", street: "Peachtree Street", city: "Atlanta", state: "Georgia", postcode: "30303" } }],
      8,
      "1 E St Atlanta",
    ).map((s) => s.value),
    [],
    "substring matching would wave this through; whole-word matching must not",
  );

  // With a suffix present, EVERY word of the street name is required — this is
  // what rejects "Prairie View Drive" for a merchant who typed "Snow View".
  assert.deepEqual(
    photonFeaturesToSuggestions(
      [
        { properties: { countrycode: "US", housenumber: "350", street: "5th Avenue", city: "New York", state: "New York", postcode: "10118" } },
        { properties: { countrycode: "US", housenumber: "350", street: "South 5th Avenue", city: "Mount Vernon", state: "New York", postcode: "10550" } },
      ],
      8,
      "350 South 5th Ave Mount Vernon",
    ).map((s) => s.value),
    ["350 South 5th Avenue, Mount Vernon, New York, 10550"],
    'a merchant who typed "South" means South',
  );

  // A query with no distinctive token at all must not filter everything away.
  assert.equal(
    photonFeaturesToSuggestions(
      [{ properties: { countrycode: "US", housenumber: "8", street: "The Green", city: "Dover", state: "Delaware", postcode: "19901" } }],
      8,
      "8 The Green Dover",
    ).length,
    1,
    '"the" is a stopword; "green" is the token that must match',
  );
}

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

/**
 * OVERLAPPING SELECTIONS. A merchant who picks one suggestion, types again and
 * picks another before the first Place Details call returns has TWO lookups in
 * flight for one field. Without a generation counter the first to finish tells
 * the form the field has settled while the other is still running, and either
 * response can paint over the newer selection.
 *
 * This models `select()`'s generation semantics exactly. (Codex P1, 2026-09-10.)
 */
async function overlappingSelections() {
  const painted: string[] = [];
  let holds = 0;
  let gen = 0;
  const select = async (label: string, resolved: string, delayMs: number) => {
    const mine = ++gen;
    painted.push(label);
    holds++;
    await new Promise((r) => setTimeout(r, delayMs));
    if (mine !== gen) return; // superseded: never paint, never release
    painted.push(resolved);
    holds--;
  };

  // The FIRST selection resolves slowly; the second is picked while it is in
  // flight and resolves fast.
  const slow = select("911 Magnolia Dr, Algonquin, IL, USA", "911 Magnolia Dr, Algonquin, IL 60102, USA", 40);
  const fast = select("350 5th Ave, New York, NY, USA", "350 5th Ave, New York, NY 10118, USA", 5);
  await Promise.all([slow, fast]);

  assert.equal(
    painted[painted.length - 1],
    "350 5th Ave, New York, NY 10118, USA",
    "the newest selection must win; a slow earlier lookup must never paint over it",
  );
  assert.ok(
    !painted.includes("911 Magnolia Dr, Algonquin, IL 60102, USA"),
    "a superseded lookup must not paint at all",
  );
  assert.equal(holds, 1, "the superseded lookup must not release the form's hold — only the newest may");
}

// ---------------------------------------------------------------------------
// 3. The escape hatch: City/State/ZIP always composes to something acceptable.
// ---------------------------------------------------------------------------

/**
 * THE GUARANTEE. Whatever the provider did — returned nothing, returned a
 * street with no building, failed its details call — a merchant who fills the
 * completion row must end up with an address the gate accepts. This mirrors
 * exactly what `AddressCompletion.patch` does.
 */
/**
 * Models AddressCompletion exactly: `line1` is anchored ONCE when the row
 * opens, the city/state/zip draft is owned by the row, and every keystroke
 * recomposes outward.
 *
 * The anchoring is the whole point. Re-deriving each box from
 * `splitUsAddress(composedValue)` on every render — the obvious implementation,
 * and the one this file first shipped — is unusable: `splitUsAddress`
 * deliberately refuses to guess a city boundary with no state or ZIP to anchor
 * it, so composing "7930 Snow View Drive, A" parses straight back with city:""
 * and the merchant's keystroke disappears from the box. `typeCityCharByChar`
 * below is the regression test for that. (Codex P1, 2026-09-10.)
 */
/** Mirrors AddressAutocompleteField.seedCompletion. */
const UNIT_WORDS = /^(apt|apartment|ste|suite|unit|fl|floor|rm|room|bldg|building|lot|trlr|#)\b/i;
function seedCompletion(value: string) {
  const p = splitUsAddress(value);
  if (p.city) return { line1: p.line1, city: p.city, state: p.state, zip: p.zip };
  const segments = (p.line1 || value).split(",").map((s) => s.trim()).filter(Boolean);
  const tail = segments[segments.length - 1] || "";
  if (segments.length >= 2 && !UNIT_WORDS.test(tail) && !/^\d/.test(tail)) {
    return { line1: segments.slice(0, -1).join(", "), city: tail, state: p.state, zip: p.zip };
  }
  return { line1: p.line1 || value.trim(), city: "", state: p.state, zip: p.zip };
}

/**
 * A CITY ALREADY TYPED MUST NOT BE ASKED FOR AGAIN. splitUsAddress reports no
 * city for "123 Main St, Miami" (with no state or ZIP a comma is more likely
 * "…, Apt 4"), so an empty City box invited the merchant to type "Miami" — and
 * the row stored "123 Main St, Miami, Miami, FL 33101". (Codex P2, 2026-09-10.)
 */
assert.deepEqual(
  seedCompletion("123 Main St, Miami"),
  { line1: "123 Main St", city: "Miami", state: "", zip: "" },
  "a trailing comma segment is offered as the city, not left blank",
);
// …but a unit designator is not a city, and must stay in the street line.
for (const unit of ["123 Main St, Apt 4", "123 Main St, Suite 200", "123 Main St, Unit B"]) {
  assert.equal(seedCompletion(unit).city, "", `"${unit}" has no city to offer`);
  assert.equal(seedCompletion(unit).line1, unit, "the unit stays in the street line");
}
// A complete address still seeds exactly as the parser reads it.
assert.deepEqual(
  seedCompletion("123 Biscayne Blvd, Miami, FL 33101"),
  { line1: "123 Biscayne Blvd", city: "Miami", state: "FL", zip: "33101" },
);

/** Mirrors AddressAutocompleteField.stripTrailingCity. */
function stripTrailingCity(line1: string, city: string): string {
  const c = city.trim();
  if (!c) return line1;
  const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = line1.replace(new RegExp(`[,\\s]+${escaped}\\s*$`, "i"), "").trim();
  return stripped ? stripped : line1;
}

/**
 * THE ROW MUST NOT ASK FOR A CITY AND THEN DUPLICATE IT. "123 Main Street Miami
 * Florida 33101" has no comma, so the parser correctly refuses to guess where
 * the street ends and leaves "Miami" inside line1 while reporting no city. The
 * merchant types the city they already gave, and without this the address
 * becomes "…Main Street Miami, Miami, FL 33101".
 */
assert.equal(stripTrailingCity("123 Main Street Miami", "Miami"), "123 Main Street");
assert.equal(stripTrailingCity("123 Main Street Miami", "miami"), "123 Main Street", "case-insensitive");
assert.equal(stripTrailingCity("123 Main St, Miami", "Miami"), "123 Main St", "comma form too");
// Never strips a city that is not actually the tail, and never empties the line.
assert.equal(stripTrailingCity("123 Miami Street", "Miami"), "123 Miami Street", "only a TRAILING match");
assert.equal(stripTrailingCity("Miami", "Miami"), "Miami", "refuses to leave an empty street line");
assert.equal(stripTrailingCity("123 Main Street", ""), "123 Main Street", "no city, no change");

function makeCompletionRow(typed: string, fallbackState?: string) {
  const seed = seedCompletion(typed);
  let line1 = seed.line1;
  const draft = { city: seed.city, state: seed.state, zip: seed.zip };
  const stateHandledElsewhere = /^[A-Za-z]{2}$/.test((fallbackState || "").trim());
  let composed = typed;
  let lastComposed: string | null = null;

  /** The row's re-seed effect: an edit from ANYWHERE ELSE re-anchors it. */
  const externalChange = (next: string) => {
    composed = next;
    if (lastComposed === next) return;
    const s = seedCompletion(next);
    line1 = s.line1;
    draft.city = s.city;
    draft.state = s.state;
    draft.zip = s.zip;
  };

  const patch = (next: Partial<typeof draft>) => {
    Object.assign(draft, next);
    composed = composeUsAddress({
      line1: stripTrailingCity(line1, draft.city),
      city: draft.city,
      // Deliberately NOT the fallback dropdown state — see the assertion below.
      state: draft.state,
      zip: draft.zip,
    });
    lastComposed = composed;
    return composed;
  };
  return { patch, externalChange, draft, get value() { return composed; } };
}

function completeByHand(typed: string, city: string, state: string, zip: string): string {
  const row = makeCompletionRow(typed);
  row.patch({ city });
  row.patch({ state });
  row.patch({ zip });
  return row.value;
}

/**
 * THE REGRESSION TEST FOR THE UNTYPEABLE BOX. Type a city one character at a
 * time, exactly as a merchant does, and assert the box still holds every
 * character. Against the first implementation this failed on keystroke one.
 */
function typeCityCharByChar(typed: string, city: string, fallbackState?: string) {
  const row = makeCompletionRow(typed, fallbackState);
  let acc = "";
  for (const ch of city) {
    acc += ch;
    row.patch({ city: acc });
    assert.equal(
      row.draft.city,
      acc,
      `city box lost the merchant's typing at "${acc}" (composed: "${row.value}")`,
    );
    assert.ok(
      row.value.startsWith(splitUsAddress(typed).line1 || typed.trim()),
      `the street line must survive recomposition, got "${row.value}"`,
    );
  }
  return row;
}

// A bare street line — the exact case that started this — must be typeable.
{
  const row = typeCityCharByChar("7930 Snow View Drive", "Algonquin");
  row.patch({ state: "IL" });
  row.patch({ zip: "60102" });
  assert.equal(row.value, "7930 Snow View Drive, Algonquin, IL 60102");
  assert.equal(isAcceptableCaptureAddress(row.value).ok, true);
}

/**
 * With business_state supplying the state, the row hides its own picker and
 * must NOT bake that code into the address string.
 *
 * Copying it in looks harmless and produces contradictory data: the merchant
 * later changes the dropdown, the stale code stays inside the address, and
 * `mergeStateIntoAddress` then trusts the ADDRESS over the dropdown by design
 * ("the address the merchant actually typed is the better evidence of where
 * they are"). The application would go out with business_address and
 * business_state disagreeing.
 *
 * Storing "street, city, ZIP" with the state held separately is exactly the
 * shape lib/address/us-address.ts was written for. (Codex P2, 2026-09-10.)
 */
/**
 * And the picker's visibility must be STRUCTURAL, not "is the dropdown filled
 * in yet". Deriving it from the current fallback value let a merchant who
 * opened the row before answering business_state pick a state here, then pick a
 * different one in the real dropdown: the picker merely vanished while the
 * first state stayed embedded in the address — which mergeStateIntoAddress
 * then trusts over the dropdown. The application would be routed on the wrong
 * state. (Codex P1, 2026-09-10.)
 */
{
  // Mirrors FormRenderer.hasBusinessStateField: REACHABILITY, not the schema at
  // large and not the address field's name. A business_state on a later step or
  // hidden by show_if cannot satisfy the gate that runs on THIS step.
  const showsOwnStatePicker = (
    fieldName: string,
    thisStepFields: string[],
    answer: string,
  ) => {
    const reachable =
      thisStepFields.includes("business_state") || /^[A-Za-z]{2}$/.test(answer.trim());
    return !(fieldName === "business_address" && reachable);
  };
  const SUNBIZ = ["business_address", "business_state", "industry"];

  // The real template: never a second state control, at any point in the form's
  // life, answered or not.
  for (const answer of ["", "IL", "WI"]) {
    assert.equal(
      showsOwnStatePicker("business_address", SUNBIZ, answer),
      false,
      `business_address must never offer a second state control (dropdown = "${answer}")`,
    );
  }
  for (const home of ["owner_home_address", "partner_home_address"]) {
    assert.equal(showsOwnStatePicker(home, SUNBIZ, ""), true, `${home} has no dropdown and must keep its picker`);
  }

  /**
   * A CUSTOM FORM with an address called `business_address` and NO
   * `business_state` field anywhere. Inferring the dropdown from the name alone
   * hid the picker, while the gate still demanded a state — leaving the
   * merchant with no way to supply one. A new dead end inside the fix for the
   * old one. (Codex P2, 2026-09-10.)
   */
  assert.equal(
    showsOwnStatePicker("business_address", ["business_address", "email"], ""),
    true,
    "with no business_state field in the schema, the picker is the only way to give a state",
  );

  /**
   * And a `business_state` that exists but is NOT REACHABLE from this step — on
   * a later step, or hidden by a show_if — cannot satisfy the gate that runs
   * here. Checking the whole schema hid the picker for it and stranded the
   * merchant with a rule they had no way to meet: the same dead end, one step
   * removed. (Codex P2, 2026-09-10.)
   */
  assert.equal(
    showsOwnStatePicker("business_address", ["business_address"], ""),
    true,
    "a state field on a LATER step cannot help; the picker must stay",
  );
  // …but once it has actually been answered on an earlier step, it can.
  assert.equal(
    showsOwnStatePicker("business_address", ["business_address"], "IL"),
    false,
    "an answered state from an earlier step does satisfy the gate",
  );
}

{
  const row = typeCityCharByChar("7930 Snow View Drive", "Algonquin", "IL");
  row.patch({ zip: "60102" });
  assert.equal(row.value, "7930 Snow View Drive, Algonquin, 60102");
  assert.ok(
    !/\bIL\b/.test(row.value),
    "the dropdown's state must not be baked into the address string",
  );
  // It still passes, because the gate merges the dropdown state to judge it…
  assert.equal(isAcceptableCaptureAddress(row.value, "IL").ok, true);
  // …and the merchant may still change the dropdown without the address
  // contradicting them.
  assert.equal(isAcceptableCaptureAddress(row.value, "WI").ok, true);
  assert.equal(splitUsAddress(row.value).state, "", "the address carries no state of its own");
}

/**
 * THE ROW MUST NEVER RESTORE AN ADDRESS THE MERCHANT REPLACED.
 *
 * Anchoring line1 once is what makes the boxes typeable. Anchoring it forever
 * is silent corruption: open the row on one street, go back to the main input
 * and type a different one, and the next City keystroke would recompose the
 * OLD street and submit it. That is the same class of defect as the OSM
 * suggestions that dropped the merchant's house number — this file exists to
 * stop exactly that. (Codex P1, re-review 2026-09-10.)
 */
{
  const row = makeCompletionRow("7930 Snow View Drive");
  row.patch({ city: "Algonquin" });
  // The merchant changes their mind and retypes the street in the main input.
  row.externalChange("911 Magnolia Dr");
  row.patch({ city: "Algonquin" });
  row.patch({ state: "IL" });
  row.patch({ zip: "60102" });
  assert.equal(
    row.value,
    "911 Magnolia Dr, Algonquin, IL 60102",
    "the row must re-anchor to the address the merchant actually typed last",
  );
  assert.ok(
    !row.value.includes("Snow View"),
    "the replaced street must not come back from the row's frozen state",
  );
}

// The same, via a suggestion selected after the row opened.
{
  const row = makeCompletionRow("7930 Snow View Drive");
  row.patch({ city: "Summit" });
  row.externalChange("350 5th Avenue, New York, New York, 10118");
  row.patch({ zip: "10118" });
  assert.ok(row.value.startsWith("350 5th Avenue"), `re-anchored, got "${row.value}"`);
  assert.ok(!row.value.includes("Snow View"), "no resurrection of the prior street");
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

overlappingSelections().then(
  () => console.log("address-field-turnkey.test.ts: OK"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
