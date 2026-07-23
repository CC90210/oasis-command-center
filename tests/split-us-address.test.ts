/**
 * split-us-address.test.ts — locks the US address splitter + the home-address
 * reconciler that feeds the split owner_address_* namespace the Lead drawer
 * reads. Faithful parsing: never invents a city/state/zip it can't identify.
 */
import assert from "node:assert";
import {
  splitUsAddress,
  resolveHomeAddress,
  normalizeState,
  composeUsAddress,
} from "../lib/address/split-us-address";

function run() {
  // full "line1, city, ST zip"
  let a = splitUsAddress("123 Main St, Miami, FL 33101");
  assert.equal(a.line1, "123 Main St");
  assert.equal(a.city, "Miami");
  assert.equal(a.state, "FL");
  assert.equal(a.zip, "33101");

  // "line1, city ST zip" (no comma before the state)
  a = splitUsAddress("123 Main St, Miami FL 33101");
  assert.equal(a.line1, "123 Main St");
  assert.equal(a.city, "Miami");
  assert.equal(a.state, "FL");
  assert.equal(a.zip, "33101");

  // apt in line1 + full state name
  a = splitUsAddress("123 Main St Apt 4, Brooklyn, New York 11201");
  assert.equal(a.line1, "123 Main St Apt 4");
  assert.equal(a.city, "Brooklyn");
  assert.equal(a.state, "NY");
  assert.equal(a.zip, "11201");

  // ZIP+4 keeps the 5-digit base
  a = splitUsAddress("500 Market St, Dallas, TX 75201-1234");
  assert.equal(a.zip, "75201");
  assert.equal(a.state, "TX");

  // street only → line1 only, nothing invented
  a = splitUsAddress("123 Main St");
  assert.equal(a.line1, "123 Main St");
  assert.equal(a.city, "");
  assert.equal(a.state, "");
  assert.equal(a.zip, "");

  // city/state/zip only, no street
  a = splitUsAddress("Miami, FL 33101");
  assert.equal(a.line1, "");
  assert.equal(a.city, "Miami");
  assert.equal(a.state, "FL");
  assert.equal(a.zip, "33101");

  // no-comma city+state+zip → city heuristic (leading token has no house number)
  a = splitUsAddress("Miami FL 33101");
  assert.equal(a.line1, "");
  assert.equal(a.city, "Miami");
  assert.equal(a.state, "FL");
  assert.equal(a.zip, "33101");

  // trailing country token stripped
  a = splitUsAddress("123 Main St, Miami, FL 33101, USA");
  assert.equal(a.zip, "33101");
  assert.equal(a.state, "FL");
  assert.equal(a.city, "Miami");

  // empty / null → all blank
  a = splitUsAddress("");
  assert.equal(a.line1 + a.city + a.state + a.zip, "");
  a = splitUsAddress(null);
  assert.equal(a.line1 + a.city + a.state + a.zip, "");

  // normalizeState
  assert.equal(normalizeState("fl"), "FL");
  assert.equal(normalizeState("Florida"), "FL");
  assert.equal(normalizeState("New York"), "NY");
  assert.equal(normalizeState(""), "");
  assert.equal(normalizeState("Ontario"), "Ontario", "unknown state passes through");

  // composeUsAddress
  assert.equal(
    composeUsAddress({ line1: "123 Main St", city: "Miami", state: "FL", zip: "33101" }),
    "123 Main St, Miami, FL 33101",
  );
  assert.equal(
    composeUsAddress({ line1: "", city: "Miami", state: "FL", zip: "33101" }),
    "Miami, FL 33101",
  );

  // resolveHomeAddress — dedicated columns win, parse fills gaps, both namespaces emitted
  let r = resolveHomeAddress({ address: "123 Main St", city: "Miami", state: "fl", zip: "33101" });
  assert.equal(r.data.owner_address_line1, "123 Main St");
  assert.equal(r.data.owner_address_city, "Miami");
  assert.equal(r.data.owner_address_state, "FL");
  assert.equal(r.data.owner_address_zip, "33101");
  assert.equal(r.data.owner_home_address, "123 Main St, Miami, FL 33101");

  // resolveHomeAddress — whole string only, splitter fills city/state/zip
  r = resolveHomeAddress({ address: "123 Main St, Miami, FL 33101", city: null, state: null, zip: null });
  assert.equal(r.data.owner_address_line1, "123 Main St");
  assert.equal(r.data.owner_address_city, "Miami");
  assert.equal(r.data.owner_address_state, "FL");
  assert.equal(r.data.owner_address_zip, "33101");

  // bare street + unit, no state/zip anchor → stays whole in line1 (no city guess)
  a = splitUsAddress("123 Main St, Apt 4");
  assert.equal(a.line1, "123 Main St, Apt 4");
  assert.equal(a.city, "");
  assert.equal(a.state, "");
  assert.equal(a.zip, "");

  // Codex P2 regression: apartment must survive when dedicated city column present
  r = resolveHomeAddress({ address: "123 Main St, Apt 4", city: "Miami", state: "FL", zip: "33101" });
  assert.equal(r.data.owner_address_line1, "123 Main St, Apt 4", "apt kept in line1, not swallowed as city");
  assert.equal(r.data.owner_address_city, "Miami");
  assert.equal(r.data.owner_address_state, "FL");
  assert.equal(r.data.owner_address_zip, "33101");
  assert.equal(r.data.owner_home_address, "123 Main St, Apt 4, Miami, FL 33101");

  // full address with unit AND anchors still splits correctly (apt kept in line1)
  a = splitUsAddress("123 Main St, Apt 4, Miami, FL 33101");
  assert.equal(a.line1, "123 Main St, Apt 4");
  assert.equal(a.city, "Miami");
  assert.equal(a.state, "FL");
  assert.equal(a.zip, "33101");

  // resolveHomeAddress — nothing → empty data (no stray keys)
  r = resolveHomeAddress({ address: null, city: null, state: null, zip: null });
  assert.deepEqual(r.data, {});

  console.log("split-us-address tests passed");
}

run();
