import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const detail = read("app/pipeline/[id]/page.tsx");
assert.match(
  detail,
  // The page's HISTORY read set, deactivated reports included (2026-09-24): the
  // card's API resolves the same includeInactive roster in resolveWebLeadViewer,
  // so the ACTIVE set here would hide a card the API serves. Anchored on
  // cardViewer because managerWorksTeamBook passes activeRepUserIds on purpose.
  /const cardViewer =[^;]*readableAssigneeIds:\s*readableRepUserIds\b/,
  "the manager's server-resolved history roster must reach the embedded battle-card gate",
);
assert.match(
  detail,
  /<BattleCard leadId=\{id\} canMutate=\{canMutateLead\} embedded \/>/,
  "manager team access remains read-only because the card receives the ordinary mutation gate",
);

const route = read("app/api/web-leads/[id]/battlecard/route.ts");
assert.match(
  route,
  /resolveWebLeadViewer\(session\)/,
  "the battle-card API must use the canonical manager viewer boundary",
);
assert.doesNotMatch(
  route,
  /getOasisSalesRepRoster|const readableAssigneeIds/,
  "the battle-card route must not drift into a second roster implementation",
);

console.log("web-leads-manager-battlecard.test.ts: OK");
