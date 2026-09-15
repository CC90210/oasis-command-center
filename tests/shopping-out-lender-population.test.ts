import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activeLenderIdsForNetwork, lenderNetworkOf } from "../lib/lenders/lender-network";

assert.equal(lenderNetworkOf({}), "sunbiz");
assert.equal(lenderNetworkOf({ lender_network: "sunbiz" }), "sunbiz");
assert.equal(lenderNetworkOf({ lender_network: "funmate" }), "funmate");
assert.equal(lenderNetworkOf({ lender_network: "FundMate" }), "funmate");
assert.equal(lenderNetworkOf({ network: "fund_mate" }), "funmate");

const fixture = [
  { id: "sun-active", data: { name: "Synthetic SunBiz", active: true } },
  { id: "sun-inactive", data: { lender_network: "sunbiz", active: false } },
  { id: "fundmate-canonical", data: { lender_network: "FundMate", active: true } },
  { id: "fundmate-legacy", data: { lender_network: "funmate" } },
];

assert.deepEqual(activeLenderIdsForNetwork(fixture, "sunbiz"), ["sun-active"]);
assert.deepEqual(activeLenderIdsForNetwork(fixture, "funmate"), ["fundmate-canonical", "fundmate-legacy"]);

const client = readFileSync("components/shopping-out/ShoppingOutClient.tsx", "utf8");
assert.match(client, /const planRes = await planRequest/);
assert.match(client, /Promise\.allSettled\(\[threadsRequest, docsRequest\]\)/);
assert.ok(
  client.indexOf("setPlan(ranked)") < client.indexOf("Promise.allSettled([threadsRequest, docsRequest])"),
  "the lender grid must commit before ancillary thread/document reads settle",
);
assert.match(client, /Lender matching could not load:/);
console.log("shopping-out-lender-population: all assertions passed");
