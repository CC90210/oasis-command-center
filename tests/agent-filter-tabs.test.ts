import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "app/t/[slug]/[...path]/page.tsx"), "utf8");
assert.match(source, /const filterScopeEnabled = leadFiltersEnabled\(viewer, scopingOn\)/,
  "admin filter availability is independent of the rollout switch");
assert.match(source, /resolveAssignedScope\([\s\S]*?filterScopeEnabled/,
  "selected agent tabs apply their assigned scope");
assert.match(source, /chip\(base, "All leads", activeAll\)/, "All leads tab is rendered");
assert.match(source, /adminRoster[\s\S]*?user_profiles[\s\S]*?auth_user_id, display_name, full_name/,
  "agent tabs come from the full tenant roster");

console.log("agent filter tabs tests passed");
