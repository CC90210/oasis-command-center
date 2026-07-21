import assert from "node:assert";
import { stageChangeRequest } from "../lib/leads/stage-change-request";
import fs from "node:fs";
import path from "node:path";

assert.deepEqual(
  stageChangeRequest("lead", "declined"),
  { endpoint: "decline", body: {} },
  "declining a lead transfers it into Applications at Declined",
);

const declineHelper = fs.readFileSync(
  path.join(process.cwd(), "lib/applications/decline-lead.ts"),
  "utf8",
);
const stagePicker = fs.readFileSync(
  path.join(process.cwd(), "components/leads/StagePicker.tsx"),
  "utf8",
);
assert.match(
  stagePicker,
  /\.\.\.LEAD_PIPELINE_STAGES, DECLINED_STAGE/,
  "the lead drawer visibly offers the cross-board Declined action after Default",
);
assert.match(
  declineHelper,
  /patch: \{ \.\.\.patch, promoted_at: new Date\(\)\.toISOString\(\) \}/,
  "the load-bearing promotion write also commits the requested application status",
);

assert.deepEqual(
  stageChangeRequest("lead", "default"),
  { endpoint: "set-stage", body: { stage: "default", entity: "lead" } },
  "ordinary lead stages remain lead-only changes",
);

assert.deepEqual(
  stageChangeRequest("application", "declined"),
  { endpoint: "set-stage", body: { stage: "declined", entity: "application" } },
  "application stage changes stay on the application",
);

console.log("lead-declined-transfer ok");
