/**
 * us-address.test.ts — the contract for the ONE address rule.
 *
 * Three groups:
 *   1. splitter / reconciler  — ported with the module from PR #76, including
 *      the Codex P2 regression where an apartment was swallowed as a city.
 *   2. mergeStateIntoAddress  — pins the EXACT output the old private
 *      `composeAddress` produced, because tests/application-pdf.test.ts asserts
 *      those strings and every business address on every PDF depends on them.
 *   3. addressCompleteness    — the new capability: naming what is missing
 *      instead of quietly printing a bare street line.
 */
import assert from "node:assert";
import {
  isAcceptableCaptureAddress,
  addressCompleteness,
  composeCompleteAddress,
  composeUsAddress,
  describeMissingAddressParts,
  isStateCode,
  mergeStateIntoAddress,
  normalizeState,
  resolveHomeAddress,
  splitUsAddress,
} from "../lib/address/us-address";

function run() {
  /* ---------------------------------------------------------------- splitter */

  let a = splitUsAddress("123 Main St, Miami, FL 33101");
  assert.equal(a.line1, "123 Main St");
  assert.equal(a.city, "Miami");
  assert.equal(a.state, "FL");
  assert.equal(a.zip, "33101");

  a = splitUsAddress("123 Main St, Miami FL 33101");
  assert.equal(a.line1, "123 Main St");
  assert.equal(a.city, "Miami");

  a = splitUsAddress("123 Main St Apt 4, Brooklyn, New York 11201");
  assert.equal(a.line1, "123 Main St Apt 4");
  assert.equal(a.city, "Brooklyn");
  assert.equal(a.state, "NY");
  assert.equal(a.zip, "11201");

  a = splitUsAddress("500 Market St, Dallas, TX 75201-1234");
  assert.equal(a.zip, "75201", "ZIP+4 keeps the 5-digit base");

  a = splitUsAddress("123 Main St");
  assert.equal(a.line1, "123 Main St");
  assert.equal(a.city + a.state + a.zip, "", "street only invents nothing");

  a = splitUsAddress("Miami, FL 33101");
  assert.equal(a.line1, "");
  assert.equal(a.city, "Miami");

  a = splitUsAddress("Miami FL 33101");
  assert.equal(a.city, "Miami", "no-comma city+state+zip still resolves");

  a = splitUsAddress("123 Main St, Miami, FL 33101, USA");
  assert.equal(a.zip, "33101", "trailing country token stripped");

  assert.equal(splitUsAddress("").line1, "");
  assert.equal(splitUsAddress(null).line1, "");

  a = splitUsAddress("123 Main St, Apt 4");
  assert.equal(a.line1, "123 Main St, Apt 4", "unit stays in line1 with no anchor");
  assert.equal(a.city, "", "a comma alone is not a city boundary");

  a = splitUsAddress("123 Main St, Apt 4, Miami, FL 33101");
  assert.equal(a.line1, "123 Main St, Apt 4");
  assert.equal(a.city, "Miami");

  // A two-word state must not be shadowed by the one-word state inside it.
  // Real production record: this resolved to VA and orphaned "West" in line1.
  a = splitUsAddress("Davis Street, Lewisburg, West Virginia, 24901");
  assert.equal(a.state, "WV", "West Virginia must not parse as Virginia");
  assert.equal(a.city, "Lewisburg");
  assert.equal(a.line1, "Davis Street");
  a = splitUsAddress("100 Main St, Norfolk, Virginia, 23510");
  assert.equal(a.state, "VA", "plain Virginia still resolves");

  assert.equal(normalizeState("fl"), "FL");
  assert.equal(normalizeState("Florida"), "FL");
  assert.equal(normalizeState("New York"), "NY");
  assert.equal(normalizeState("Ontario"), "Ontario", "unknown state passes through");
  assert.equal(isStateCode("fl"), true);
  assert.equal(isStateCode("Fla."), false);
  assert.equal(isStateCode("ZZ"), false);

  assert.equal(
    composeUsAddress({ line1: "123 Main St", city: "Miami", state: "FL", zip: "33101" }),
    "123 Main St, Miami, FL 33101",
  );

  let r = resolveHomeAddress({ address: "123 Main St", city: "Miami", state: "fl", zip: "33101" });
  assert.equal(r.data.owner_home_address, "123 Main St, Miami, FL 33101");

  // Codex P2 regression carried over with the module.
  r = resolveHomeAddress({ address: "123 Main St, Apt 4", city: "Miami", state: "FL", zip: "33101" });
  assert.equal(r.data.owner_address_line1, "123 Main St, Apt 4", "apt kept in line1, not swallowed as city");
  assert.equal(r.data.owner_home_address, "123 Main St, Apt 4, Miami, FL 33101");

  r = resolveHomeAddress({ address: null, city: null, state: null, zip: null });
  assert.deepEqual(r.data, {}, "nothing in, no stray keys out");

  /* ------------------------------------------- mergeStateIntoAddress (pinned) */

  // These four strings are asserted verbatim by tests/application-pdf.test.ts.
  // If this block changes, every business address on every PDF changes.
  assert.equal(
    mergeStateIntoAddress("100 Sample Ave, Testville TX 75001", "TX"),
    "100 Sample Ave, Testville TX 75001",
    "idempotent when the state already sits before the ZIP",
  );
  assert.equal(
    mergeStateIntoAddress("123 Biscayne Blvd, Miami, 33101", "fl"),
    "123 Biscayne Blvd, Miami, FL 33101",
    "state merged in before the ZIP",
  );
  assert.equal(
    mergeStateIntoAddress("123 Biscayne Blvd, Miami", "fl"),
    "123 Biscayne Blvd, Miami, FL",
    "state appended when there is no ZIP",
  );
  assert.equal(
    mergeStateIntoAddress("123 Biscayne Blvd, Miami, FL", "FL"),
    "123 Biscayne Blvd, Miami, FL",
    "idempotent when the state already trails",
  );
  // A state already SPELLED OUT must not get a second, abbreviated copy.
  // These six are real production strings; before this, 284 stored addresses
  // rendered "Florida, FL 34104" / "New York, New York, NY 10175".
  for (const [addr, state] of [
    ["521 5th Avenue, New York, New York, 10175", "NY"],
    ["3811 Enterprise Avenue, Naples, Florida, 34104", "FL"],
    ["1111 North Russell Avenue, Minneapolis, Minnesota, 55411", "MN"],
    ["655 West Street, Rockport, Maine, 04856", "ME"],
    ["1401 Highpoint Circle, Gilpin, Colorado, 80422", "CO"],
    ["Phillips Circle, Columbiana, Alabama, 35051", "AL"],
  ] as const) {
    assert.equal(
      mergeStateIntoAddress(addr, state),
      addr,
      `state already spelled out must not be duplicated: ${addr}`,
    );
  }
  assert.equal(
    mergeStateIntoAddress("100 Main St, Portland, Maine", "ME"),
    "100 Main St, Portland, Maine",
    "trailing spelled-out state, no ZIP, also left alone",
  );
  // ...but a street NAMED after a state is not a state. End-anchoring is what
  // keeps this merge working instead of being skipped.
  assert.equal(
    mergeStateIntoAddress("123 Florida Ave, Miami, 33101", "FL"),
    "123 Florida Ave, Miami, FL 33101",
    "a street called Florida Ave must still get the state merged in",
  );

  assert.equal(mergeStateIntoAddress("", "FL"), "", "empty address stays empty");
  assert.equal(
    mergeStateIntoAddress("123 Main St", "Fla."),
    "123 Main St",
    "unusable state token leaves the address untouched rather than corrupting it",
  );
  assert.equal(composeCompleteAddress("123 Biscayne Blvd, Miami, 33101", "fl"),
    "123 Biscayne Blvd, Miami, FL 33101", "composeCompleteAddress is the merge rule");
  assert.equal(composeCompleteAddress("123 Main St"), "123 Main St",
    "no fallback state supplied → unchanged, nothing invented");

  /* ------------------------------------------------------------ completeness */

  let c = addressCompleteness("123 Main St, Miami, FL 33101");
  assert.equal(c.complete, true);
  assert.deepEqual(c.missing, []);

  // The real production shapes that prompted this work.
  c = addressCompleteness("7930 Snow View Drive");
  assert.equal(c.complete, false, "a bare street line is not a complete address");
  assert.deepEqual(c.missing, ["city", "state", "zip"]);

  c = addressCompleteness("79 Lauie Drive");
  assert.equal(c.complete, false);

  c = addressCompleteness("suite c/501 East Broadway");
  assert.equal(c.complete, false);

  // The business address carries its state in a separate dropdown.
  c = addressCompleteness("123 Biscayne Blvd, Miami, 33101", "fl");
  assert.equal(c.complete, true, "fallback state completes the business address");
  assert.deepEqual(c.missing, []);

  c = addressCompleteness("123 Biscayne Blvd, Miami", "fl");
  assert.deepEqual(c.missing, ["zip"], "state satisfied by the dropdown, ZIP still absent");

  c = addressCompleteness("123 Main St, Miami, 33101");
  assert.deepEqual(c.missing, ["state"], "no fallback state → state reported missing");

  c = addressCompleteness("");
  assert.equal(c.complete, false, "empty is never complete");

  c = addressCompleteness("Miami, FL 33101");
  assert.equal(c.complete, false, "city/state/zip with no street is still incomplete");

  // A non-canonical state spelling must not count as a state.
  c = addressCompleteness("123 Main St, Miami, 33101", "Fla.");
  assert.deepEqual(c.missing, ["state"], "'Fla.' is not a usable state code");

  /* ------------------------------------------------------------ capture gate */

  // What the gate REFUSES — the case this whole change exists for.
  assert.equal(isAcceptableCaptureAddress("7930 Snow View Drive").ok, false,
    "a bare street line is refused at capture");
  assert.equal(isAcceptableCaptureAddress("79 Lauie Drive").ok, false);
  assert.equal(isAcceptableCaptureAddress("suite c/501 East Broadway").ok, false);
  assert.equal(isAcceptableCaptureAddress("").ok, false, "empty is refused");
  assert.match(isAcceptableCaptureAddress("7930 Snow View Drive").message, /ZIP code/,
    "the merchant is told exactly what to add");
  assert.match(isAcceptableCaptureAddress("7930 Snow View Drive").message, /911 Magnolia Dr/,
    "and shown a worked example");

  // What the gate MUST ACCEPT. Every false rejection here is a dead funding
  // application, so these are the load-bearing cases.
  for (const good of [
    "911 Magnolia Dr, Algonquin, IL 60102",
    "123 Main St, Miami, FL 33101",
    // No commas at all. The city cannot be parsed out of this, which is exactly
    // why the gate does NOT require a city — it would reject a real address.
    "123 Main Street Miami Florida 33101",
    "PO Box 123, Miami, FL 33101",
    "RR 2 Box 45, Lubbock, TX 79401",
    "500 Market St, Dallas, TX 75201-1234",
    "123 Main St Apt 4, Brooklyn, New York 11201",
  ]) {
    assert.equal(isAcceptableCaptureAddress(good).ok, true, `must accept: ${good}`);
  }

  // The business address may satisfy the state requirement from its dropdown.
  assert.equal(isAcceptableCaptureAddress("123 Biscayne Blvd, Miami, 33101").ok, false,
    "no state anywhere → refused");
  assert.equal(isAcceptableCaptureAddress("123 Biscayne Blvd, Miami, 33101", "FL").ok, true,
    "state supplied by the separate dropdown completes it");
  assert.equal(isAcceptableCaptureAddress("123 Biscayne Blvd, Miami", "FL").ok, false,
    "a dropdown state does not excuse a missing ZIP");

  // An ABSENT or explicitly CLEARED state must never be treated as satisfied.
  // The operator edit route can receive `business_state: null` in the same patch
  // as a stateless address; if a cleared state fell back to the stored one, that
  // patch would validate and then erase the state in the same write, saving the
  // exact incomplete address this gate exists to stop. (Codex P1, round 2.)
  for (const emptyState of [undefined, null, "", "   "]) {
    assert.equal(
      isAcceptableCaptureAddress("123 Biscayne Blvd, Miami, 33101", emptyState).ok,
      false,
      `a stateless address must be refused when the state is ${JSON.stringify(emptyState)}`,
    );
  }

  // The gate is deliberately WEAKER than completeness: it never demands a city,
  // because the city is the one part that cannot be parsed reliably.
  const noCityButAcceptable = "123 Main Street Miami Florida 33101";
  assert.equal(isAcceptableCaptureAddress(noCityButAcceptable).ok, true);
  assert.deepEqual(addressCompleteness(noCityButAcceptable).missing, ["city"],
    "completeness still reports the city, for the operator advisory");

  /* --------------------------------------------------------------- messaging */

  assert.equal(describeMissingAddressParts([]), "");
  assert.equal(describeMissingAddressParts(["zip"]), "Add the ZIP code.");
  assert.equal(describeMissingAddressParts(["city", "state"]), "Add the city and state.");
  assert.equal(
    describeMissingAddressParts(["city", "state", "zip"]),
    "Add the city, state and ZIP code.",
  );

  console.log("us-address tests passed");
}

run();
