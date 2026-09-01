import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const detail = read("app/pipeline/[id]/page.tsx");
assert.match(
  detail,
  /readableAssigneeIds:\s*readableRepUserIds/,
  "the manager's server-resolved pipeline roster must reach the embedded battle-card gate",
);
assert.match(
  detail,
  /<BattleCard leadId=\{id\} canMutate=\{canMutateLead\} embedded \/>/,
  "manager team access remains read-only because the card receives the ordinary mutation gate",
);

const route = read("app/api/web-leads/[id]/battlecard/route.ts");
assert.match(
  route,
  /getOasisSalesRepRoster\(session\.tenantId\)/,
  "the battle-card API must independently resolve the tenant sales roster",
);
assert.match(
  route,
  /session\.teamRole\.trim\(\)\.toLowerCase\(\) === "manager"/,
  "only a manager may consume the roster read expansion",
);
assert.match(
  route,
  /readableAssigneeIds,/,
  "the API must pass the server roster into the data-layer authorization predicate",
);

console.log("web-leads-manager-battlecard.test.ts: OK");
