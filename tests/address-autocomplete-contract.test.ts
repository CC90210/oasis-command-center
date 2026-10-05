import assert from "node:assert/strict";
import { googleAutocompleteSuggestions, normalizeAddressSuggestions } from "../lib/forms/address-suggestions";
import { isAcceptableCaptureAddress } from "../lib/address/us-address";

const google = googleAutocompleteSuggestions({
  predictions: [{
    description: "1600 Pennsylvania Avenue NW, Washington, DC, USA",
    place_id: "ChIJGVtI4by3t4kRr51d_Qm_x58",
  }],
});
assert.equal(google.length, 1);
assert.equal(google[0].placeId, "ChIJGVtI4by3t4kRr51d_Qm_x58");
assert.equal(isAcceptableCaptureAddress(google[0].value).ok, false,
  "a Google prediction without a ZIP must not masquerade as complete");
assert.equal(isAcceptableCaptureAddress("1600 Pennsylvania Avenue NW, Washington, DC 20500, USA").ok, true,
  "the Place Details formatted address must pass the submit contract");

assert.deepEqual(
  normalizeAddressSuggestions(["911 Magnolia Drive, Chatham, Illinois, 62629"]),
  [{ label: "911 Magnolia Drive, Chatham, Illinois, 62629", value: "911 Magnolia Drive, Chatham, Illinois, 62629" }],
  "legacy/cached Photon responses remain compatible",
);
assert.deepEqual(normalizeAddressSuggestions([null, {}, { label: " ", value: " " }]), []);

console.log("address autocomplete contract tests passed");
