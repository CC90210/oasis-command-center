import assert from "node:assert/strict";
import { isAcceleratedEligible } from "../lib/drips/accelerated-eligibility";
import fs from "node:fs";
import path from "node:path";

assert.equal(isAcceleratedEligible({ stage: "uw_sheet" }), true, "Live Subs can use accelerated chase");
for (const stage of ["hot_lead", "follow_up", "missing_info", "sent_application", "funded", undefined]) {
  assert.equal(isAcceleratedEligible({ stage }), false, `${String(stage)} cannot use accelerated chase`);
}

const api = fs.readFileSync(path.join(process.cwd(), "app/api/leads/[id]/accelerated/route.ts"), "utf8");
const cron = fs.readFileSync(path.join(process.cwd(), "app/api/cron/enroll-accelerated/route.ts"), "utf8");
const pipeline = fs.readFileSync(path.join(process.cwd(), "components/manifest/LeadPipelineView.tsx"), "utf8");
assert.match(api, /on && !isAcceleratedEligible\(lead\.data\)/, "API rejects non-Live-Subs enrollment");
assert.match(cron, /!isAcceleratedEligible\(d\)/, "cron clears legacy accelerated flags outside Live Subs");
assert.equal((pipeline.match(/isAcceleratedEligible\(row\.data\)/g) || []).length, 2,
  "desktop and mobile only show the accelerated control for Live Subs");

console.log("accelerated Live Subs-only tests passed");
