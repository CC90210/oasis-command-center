import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const lifecycle = read("lib/lifecycle-assignment.ts");
const assignRoute = read("app/api/leads/[id]/assign/route.ts");
const bulkRoute = read("app/api/leads/bulk/route.ts");
const shoppingClient = read("components/shopping-out/ShoppingOutClient.tsx");

assert.match(lifecycle, /collect\("application", "lead_id", input\.record\.id\)/,
  "assigning a lead discovers applications linked back to it");
assert.match(lifecycle, /collectId\("application", input\.record\.data\.application_id\)/,
  "assigning a lead follows its direct application_id link");
assert.match(lifecycle, /collect\("lead", "application_id", input\.record\.id\)/,
  "assigning an application discovers its parent lead");
assert.match(assignRoute, /assignLifecycleOwner\(/,
  "single-record transfers propagate through the linked lifecycle");
assert.match(bulkRoute, /assignLifecycleOwner\(/,
  "bulk transfers propagate through the linked lifecycle");
assert.match(shoppingClient, /SHOPPABLE_STATUSES[\s\S]*?"application_in"/,
  "Application In remains eligible for Shopping Out");

console.log("shopping-out transfer audit tests passed");
