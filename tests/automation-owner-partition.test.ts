import assert from "node:assert/strict";
import {
  AutomationInventoryError,
  buildAutomationInventoryMetadata,
  cronJobKey,
  parseAutomationInventorySuccess,
  partitionCronJobsByOwner,
  type CronInventoryJob,
} from "../lib/automations/cron-inventory";

function job(source: "tenant" | "empire", id: string, owner: string): CronInventoryJob {
  return {
    id,
    source,
    agent_key: owner,
    name: `${owner} job`,
    description: null,
    schedule: "0 6 * * *",
    action_type: "script_run",
    action_payload: { script: "safe.py" },
    enabled: true,
    last_run_at: null,
    last_run_status: null,
    last_run_output: null,
    last_run_error: null,
    run_count: 0,
    created_at: "2026-09-16T00:00:00.000Z",
    updated_at: "2026-09-16T00:00:00.000Z",
  };
}

const jobs = [
  job("tenant", "same-id", "bravo"),
  job("empire", "same-id", "bravo-ops"),
  job("empire", "maven-1", "MAVEN"),
];
const groups = partitionCronJobsByOwner(jobs, ["bravo", "maven", "bravo"]);
assert.deepEqual(groups.map((group) => group.key), ["bravo", "maven", "other"]);
assert.deepEqual(groups[0].jobs.map(cronJobKey), ["tenant:same-id"]);
assert.deepEqual(groups[1].jobs.map(cronJobKey), ["empire:maven-1"]);
assert.deepEqual(groups[2].jobs.map(cronJobKey), ["empire:same-id"]);
assert.deepEqual(
  groups.flatMap((group) => group.jobs).map(cronJobKey).sort(),
  jobs.map(cronJobKey).sort(),
  "every source:id must appear in exactly one owner group",
);

assert.throws(
  () => partitionCronJobsByOwner([jobs[0], { ...jobs[0] }], ["bravo"]),
  /duplicate_automation_key:tenant:same-id/,
);

const inventory = buildAutomationInventoryMetadata({
  tenantJobs: jobs.filter((entry) => entry.source === "tenant"),
  empireJobs: jobs.filter((entry) => entry.source === "empire"),
  empireQueried: true,
  requireEmpireRows: true,
});
assert.deepEqual(inventory, {
  lanes: {
    tenant: { queried: true, count: 1 },
    empire: { queried: true, count: 2 },
  },
  total_count: 3,
  distinct_source_id_count: 3,
});

assert.throws(
  () => buildAutomationInventoryMetadata({
    tenantJobs: [jobs[0]],
    empireJobs: [],
    empireQueried: true,
    requireEmpireRows: true,
  }),
  (error) => error instanceof AutomationInventoryError
    && error.code === "incomplete_automation_inventory"
    && error.status === 503,
);
assert.throws(
  () => buildAutomationInventoryMetadata({
    tenantJobs: [jobs[0], { ...jobs[0] }],
    empireJobs: [],
    empireQueried: false,
    requireEmpireRows: false,
  }),
  (error) => error instanceof AutomationInventoryError
    && error.code === "duplicate_automation_inventory_key"
    && error.status === 500,
);

const valid = parseAutomationInventorySuccess({ ok: true, jobs, inventory });
assert.equal(valid.ok, true);
assert.deepEqual(
  parseAutomationInventorySuccess({ ok: true, jobs }).ok,
  false,
  "a success without the inventory receipt must not render as an empty board",
);
assert.deepEqual(
  parseAutomationInventorySuccess({
    ok: true,
    jobs,
    inventory: { ...inventory, total_count: 2 },
  }).ok,
  false,
  "metadata that disagrees with the rows must fail closed",
);

console.log("automation-owner-partition: all assertions passed");
