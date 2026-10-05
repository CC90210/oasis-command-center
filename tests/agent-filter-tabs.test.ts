import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "app/t/[slug]/[...path]/page.tsx"), "utf8");
assert.match(source, /const filterScopeEnabled = leadFiltersEnabled\(viewer, scopingOn\)/,
  "admin filter availability is independent of the rollout switch");
assert.match(source, /resolveAssignedScope\([\s\S]*?filterScopeEnabled/,
  "selected agent tabs apply their assigned scope");
assert.match(source, /chip\(base, "All leads", activeAll\)/, "All leads tab is rendered");
// 2026-09-24: a tab is a live control, so it offers ACTIVE teammates only; a
// deactivated rep's ?agent= link still filters, it just gets no tab.
assert.match(
  source,
  /const \{ names, activeIds \} = await buildMemberDirectory\(dataTenantId\);\s*adminRoster = \[\.\.\.names\]\s*\.filter\(\(\[id\]\) => activeIds\.has\(id\)\)/,
  "agent tabs come from the tenant directory, active teammates only",
);

console.log("agent filter tabs tests passed");
