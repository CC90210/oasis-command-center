/**
 * OASIS background-worker inventory contract.
 *
 * Run:
 *   node --conditions=react-server --import tsx tests/background-workers-contract.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveWorkerControlMode,
  selectWorkerInventory,
} from "../lib/automations/worker-status";

const route = readFileSync("app/api/automations/background-workers/route.ts", "utf8");
const panel = readFileSync("components/automations/BackgroundWorkersPanel.tsx", "utf8");
const oasisInventory = route.slice(
  route.indexOf("const OASIS_WORKERS"),
  route.indexOf("\n];", route.indexOf("const OASIS_WORKERS")) + 3,
);

function workerWindow(service: string, width = 900): string {
  const marker = `service: "${service}"`;
  const at = route.indexOf(marker);
  assert.ok(at >= 0, `${service} must be present in the worker inventory`);
  return route.slice(at, at + width);
}

// OASIS owns one local queue consumer and one local queue monitor.
for (const service of [
  "pm2.dashboard-email-consumer",
  "pm2.dashboard-email-queue-monitor",
]) {
  const worker = workerWindow(service);
  assert.match(worker, /runtime:\s*"local"/, `${service} must be classified as local`);
  assert.match(worker, /control_mode:\s*"local_fleet"/, `${service} must use fleet control`);
  assert.match(
    worker,
    /status_source:\s*"integrations_health"/,
    `${service} must read the OASIS bridge health row`,
  );
  assert.doesNotMatch(worker, /Runs on the VPS/, `${service} must not carry the obsolete remote copy`);
}

assert.deepEqual(
  [...oasisInventory.matchAll(/service:\s*"([^"]+)"/g)].map((match) => match[1]),
  [
    "pm2.bravo-scheduler",
    "pm2.bravo-ig-dm",
    "pm2.bravo-telegram",
    "pm2.bravo-coord",
    "pm2.claude-bridge",
    "pm2.claude-bridge-ping",
    "pm2.event-router",
    "pm2.dashboard-email-consumer",
    "pm2.dashboard-email-queue-monitor",
    "pm2.atlas-telegram",
    "pm2.maven-telegram",
    "skool_engine",
  ],
  "the OASIS inventory must stay exact and cannot absorb a remote tenant service",
);
assert.doesNotMatch(oasisInventory, /runtime:\s*"remote"/);

// Control capability is decided server-side per viewer. Internal viewers may
// inspect the system without receiving lifecycle controls.
for (const testCase of [
  {
    name: "true admin",
    input: {
      runtime: "local" as const,
      configuredMode: "local_fleet" as const,
      teamRole: "admin",
      isTrueAdmin: true,
      adminAccess: false,
    },
    expected: "local_fleet",
  },
  {
    name: "admin access grant",
    input: {
      runtime: "local" as const,
      configuredMode: "local_fleet" as const,
      teamRole: "manager",
      isTrueAdmin: false,
      adminAccess: true,
    },
    expected: "local_fleet",
  },
  {
    name: "internal member",
    input: {
      runtime: "local" as const,
      configuredMode: "local_fleet" as const,
      teamRole: "member",
      isTrueAdmin: false,
      adminAccess: false,
    },
    expected: "none",
  },
  {
    name: "read only",
    input: {
      runtime: "local" as const,
      configuredMode: "local_fleet" as const,
      teamRole: "read_only",
      isTrueAdmin: false,
      adminAccess: false,
    },
    expected: "none",
  },
] as const) {
  assert.equal(
    resolveWorkerControlMode(testCase.input),
    testCase.expected,
    `${testCase.name} receives the correct local lifecycle capability`,
  );
}
assert.equal(
  resolveWorkerControlMode({
    runtime: "cloud",
    isTrueAdmin: true,
    adminAccess: true,
  }),
  "none",
  "cloud schedules are never controlled as machine processes",
);
assert.equal(
  resolveWorkerControlMode({
    runtime: "retired",
    isTrueAdmin: true,
    adminAccess: true,
  }),
  "none",
  "retired inventory never receives controls",
);
assert.equal(
  resolveWorkerControlMode({
    runtime: "remote",
    teamRole: "owner",
    isTrueAdmin: true,
    adminAccess: false,
    remoteControlAllowed: true,
  }),
  "remote_bridge",
  "authorized remote control behavior stays unchanged",
);
assert.equal(
  resolveWorkerControlMode({
    runtime: "remote",
    teamRole: "member",
    isTrueAdmin: false,
    adminAccess: false,
    remoteControlAllowed: false,
  }),
  "none",
  "a remote viewer without the existing bridge grant remains view-only",
);

// OASIS slug is authoritative if stale profile metadata sends conflicting
// signals. The resolver is executable so a ternary-order regression cannot
// satisfy this test accidentally.
assert.equal(
  selectWorkerInventory({ isOasisTenant: true, isClientProfile: true }),
  "oasis",
  "an OASIS tenant must receive OASIS inventory even if profile metadata is stale",
);
assert.equal(selectWorkerInventory({ isOasisTenant: true, isClientProfile: false }), "oasis");
assert.equal(selectWorkerInventory({ isOasisTenant: false, isClientProfile: true }), "client");
assert.equal(selectWorkerInventory({ isOasisTenant: false, isClientProfile: false }), "none");

// Scheduled meeting reminders are cloud-managed, while inactive inventory is
// explicitly retired. Neither receives lifecycle controls.
{
  const cloud = workerWindow("cloud.founder-meeting-reminders");
  assert.match(cloud, /runtime:\s*"cloud"/);
  assert.match(cloud, /control_mode:\s*"none"/);
  assert.match(cloud, /status_source:\s*"website_sales_meeting_worker_health"/);

  const retired = workerWindow("skool_engine");
  assert.match(retired, /runtime:\s*"retired"/);
  assert.match(retired, /control_mode:\s*"none"/);
  assert.match(retired, /status_source:\s*"none"/);
}

// The direct JSON route enforces the same system-surface capability as the
// page and refuses to fall back to OASIS inventory for an unrelated tenant.
{
  const capabilityAt = route.indexOf("canSeeSystemSurfaces");
  const healthReadAt = route.indexOf('.from("integrations_health")');
  assert.ok(capabilityAt >= 0, "the worker API must enforce canSeeSystemSurfaces");
  assert.ok(healthReadAt > capabilityAt, "authorization must happen before worker health is read");
  assert.ok(route.includes("selectWorkerInventory("), "the API must use the executable inventory policy");
  assert.ok(route.includes("resolveWorkerControlMode({"), "the API must use the executable control policy");
  assert.ok(route.includes("isTrueAdmin: session.isTrueAdmin"));
  assert.ok(route.includes("adminAccess: session.adminAccess"));
  assert.match(route, /if \(isOasis\)\s*{/, "OASIS cloud health must only be appended on OASIS");

  const localHealthAt = route.indexOf(": profileId");
  const localHealthEnd = route.indexOf(": null;", localHealthAt);
  const localHealthRead = route.slice(localHealthAt, localHealthEnd);
  assert.ok(localHealthAt >= 0 && localHealthEnd > localHealthAt, "local health branch must be identifiable");
  assert.ok(
    localHealthRead.includes('.eq("tenant_id", tenantId)'),
    "OASIS health must be constrained by tenant_id as well as profile_id",
  );
  assert.ok(localHealthRead.includes('.eq("profile_id", profileId)'));

  const pairingErrorAt = route.indexOf("if (pairing.error)");
  const pairingValueAt = route.indexOf("const lastSeenAt");
  assert.ok(
    pairingErrorAt >= 0 && pairingErrorAt < pairingValueAt,
    "a failed bridge-health read must stop before the API invents an offline state",
  );
  const workerHealthErrorAt = route.indexOf("if (healthRows.error)");
  const workerMappingAt = route.indexOf("for (const r of healthRows.data");
  assert.ok(
    workerHealthErrorAt >= 0 && workerHealthErrorAt < workerMappingAt,
    "a failed worker-health read must stop before workers render unconfigured",
  );
  const cloudHealthErrorAt = route.indexOf("if (cloudHealth.error)");
  const cloudValueAt = route.indexOf("const health = cloudHealth.data");
  assert.ok(
    cloudHealthErrorAt >= 0 && cloudHealthErrorAt < cloudValueAt,
    "a failed cloud-health read must stop before the reminder renders as never configured",
  );
}

// The UI groups by execution/runtime, not historical ownership, and never
// paints disabled lifecycle buttons for automatically managed/retired rows.
{
  for (const label of ["This computer", "OASIS cloud", "Inactive / retired"]) {
    assert.ok(panel.includes(label), `panel must render the ${label} group`);
  }
  assert.ok(panel.includes("Managed automatically"), "cloud rows need a plain-English management badge");
  assert.ok(panel.includes("j.message || j.error"), "health failures must show the route's plain-English explanation");
  assert.ok(panel.includes('worker.control_mode !== "none"'), "controls must only render for controllable rows");
  assert.ok(!panel.includes("OWNER_GROUP_LABEL"), "owner-only grouping must not drive the worker layout");
  assert.ok(!panel.includes("Start this worker via pm2"), "Windows fleet controls must not be labelled PM2");
}

console.log("background-workers-contract: all assertions passed");
