/**
 * leads-import-home-address.test.ts — the BD/CSV lead-import parser must
 * capture the owner HOME address (street, city, state, zip), which it dropped
 * entirely before (only business_address existed). Locks the header mapping and
 * an end-to-end CSV parse.
 */
import assert from "node:assert";
import { mapLeadImportHeader, parseLeadImportCsv } from "../lib/leads-import-parser";

function run() {
  // --- header mapping: home variants ---
  assert.equal(mapLeadImportHeader("Home Address"), "home_address");
  assert.equal(mapLeadImportHeader("Owner Home Address"), "home_address");
  assert.equal(mapLeadImportHeader("Residential Address"), "home_address");
  assert.equal(mapLeadImportHeader("Home City"), "home_city");
  assert.equal(mapLeadImportHeader("Home State"), "home_state");
  assert.equal(mapLeadImportHeader("Home Zip"), "home_zip");
  assert.equal(mapLeadImportHeader("Home Postal Code"), "home_zip");
  // business address still maps (no regression)
  assert.equal(mapLeadImportHeader("Business Address"), "business_address");

  // --- end-to-end: separate home columns ---
  const csv = [
    "Business Name,Owner,Email,Home Address,Home City,Home State,Home Zip",
    "Acme LLC,Jane Merchant,jane@acme.com,123 Main St,Miami,FL,33101",
  ].join("\n");
  const res = parseLeadImportCsv(csv);
  assert.equal(res.mapped.length, 1, "one row parsed");
  const row = res.mapped[0];
  assert.equal(row.home_address, "123 Main St");
  assert.equal(row.home_city, "Miami");
  assert.equal(row.home_state, "FL");
  assert.equal(row.home_zip, "33101");

  // --- whole home address in a single quoted column is preserved verbatim ---
  const csv2 = [
    "Business Name,Email,Home Address",
    'Beta Inc,b@beta.com,"500 Oak Ave, Austin, TX 78701"',
  ].join("\n");
  const r2 = parseLeadImportCsv(csv2);
  assert.equal(r2.mapped.length, 1, "one row parsed (csv2)");
  assert.equal(r2.mapped[0].home_address, "500 Oak Ave, Austin, TX 78701");

  console.log("leads-import home-address tests passed");
}

run();
