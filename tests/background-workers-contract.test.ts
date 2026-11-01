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
import {
  OASIS_WORKERS,
  controllableOasisWorker,
} from "../lib/automations/oasis-workers";

const route = readFileSync("app/api/automations/background-workers/route.ts", "utf8");
const panel = readFileSync("components/automations/BackgroundWorkersPanel.tsx", "utf8");
// The OASIS inventory lives in lib/automations/oasis-workers.ts (2026-09-30),
// shared by this route, the control route's allowlist and System health. The
// route appends the cloud reminder worker itself.
const inventoryFile = readFileSync("lib/automations/oasis-workers.ts", "utf8");
assert.ok(
  route.includes('import { OASIS_WORKERS } from "@/lib/automations/oasis-workers";'),
  "the route must list the shared OASIS inventory",
);
assert.ok(!route.includes("const OASIS_WORKERS"), "no second copy of the inventory in the route");
const oasisInventory = inventoryFile.slice(
  inventoryFile.indexOf("export const OASIS_WORKERS"),
  inventoryFile.indexOf("\n];", inventoryFile.indexOf("export const OASIS_WORKERS")) + 3,
);

function workerWindow(service: string, width = 900): string {
  const marker = `service: "${service}"`;
  const source = inventoryFile.includes(marker) ? inventoryFile : route;
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `${service} must be present in the worker inventory`);
  return source.slice(at, at + width);
}

// Retirement is a lifecycle decision, not a health reading: a row is retired
// once its process is actually off. Every retired row must come from the shared
// inventory and expose no control path even if an old integrations_health row
// still exists.
const retiredByPlan = [
  "pm2.bravo-scheduler",
  "pm2.bravo-ig-dm",
  "pm2.bravo-telegram",
  "pm2.dashboard-email-consumer",
  "pm2.dashboard-email-queue-monitor",
] as const;
for (const service of retiredByPlan) {
  const worker = OASIS_WORKERS.find((candidate) => candidate.service === service);
  assert.ok(worker, `${service} must remain visible in the shared inventory`);
  assert.equal(worker.runtime, "retired", `${service} must be retired by lifecycle policy`);
  assert.equal(worker.control_mode, "none", `${service} must expose no lifecycle controls`);
  assert.equal(worker.status_source, "none", `${service} must not interpret a stale health row`);
  assert.equal(worker.manageable_via_pm2, false, `${service} must never offer a PM2 fallback`);
  assert.match(worker.not_expected_here ?? "", /^Retired by plan\b/);
  assert.equal(controllableOasisWorker(service), null, `${service} must fail closed in the control allowlist`);
}
// Verified 2026-11-01: these five still run on this computer, so the board must count
// them with live status and the existing local control path. Retiring a
// running process on the board is how it showed 2 workers while 8 ran.
for (const service of [
  "pm2.claude-bridge",
  "pm2.claude-bridge-ping",
  "pm2.event-router",
  "pm2.atlas-telegram",
  "pm2.maven-telegram",
] as const) {
  const worker = OASIS_WORKERS.find((candidate) => candidate.service === service);
  assert.ok(worker, `${service} must remain visible as an active local service`);
  assert.notEqual(worker.runtime, "retired", `${service} still runs here and must not be retired`);
  assert.equal(worker.not_expected_here, undefined, `${service} must not carry a retirement reason`);
  assert.notEqual(worker.status_source, "none", `${service} must read its live health row`);
  assert.ok(controllableOasisWorker(service), `${service} must keep its existing local control path`);
}

// OASIS's own daemon-VPS services are listed so nothing that runs is missing,
// and each must wait for its own signed live heartbeat. No machine controls.
const vpsServices = [
  "vps.oasis-telegram-bridge",
  "vps.oasis-inbox-sweep",
  "vps.oasis-scheduler",
  "vps.oasis-headless-bridge",
  "vps.oasis-content-tools-runner",
  "vps.oasis-workspace-scheduler",
  "vps.atlas-telegram",
  "vps.maven-telegram",
] as const;
for (const service of vpsServices) {
  const worker = OASIS_WORKERS.find((candidate) => candidate.service === service);
  assert.ok(worker, `${service} must be visible`);
  assert.equal(worker.runtime, "remote");
  // Live since 2026-10-31: the VPS reporter writes these rows (lib/automations/vps-health.ts).
  assert.equal(worker.status_source, "integrations_health", `${service} reads the VPS reporter's live row`);
  assert.equal(worker.control_mode, "none");
  assert.equal(worker.manageable_via_pm2, false);
  assert.equal(controllableOasisWorker(service), null, `${service} must never be controllable from here`);
}

assert.deepEqual(
  [...oasisInventory.matchAll(/service:\s*"([^"]+)"/g)].map((match) => match[1]),
  [
    // The local chat bridge first (CC 2026-10-31): it is what connects this
    // computer to the Command Center at all.
    "pm2.claude-bridge",
    "pm2.bravo-scheduler",
    "pm2.bravo-ig-dm",
    "pm2.bravo-telegram",
    "pm2.claude-bridge-ping",
    "pm2.event-router",
    "pm2.dashboard-email-consumer",
    "pm2.dashboard-email-queue-monitor",
    "pm2.atlas-telegram",
    "pm2.maven-telegram",
    "vps.oasis-telegram-bridge",
    "vps.oasis-inbox-sweep",
    "vps.oasis-scheduler",
    "vps.oasis-headless-bridge",
    "vps.oasis-content-tools-runner",
    "vps.oasis-workspace-scheduler",
    "vps.atlas-telegram",
    "vps.maven-telegram",
    "skool_engine",
  ],
  "the OASIS inventory must stay exact and cannot absorb a remote tenant service",
);
// Remote rows are only OASIS's own VPS services, never a client tenant's.
assert.deepEqual(
  OASIS_WORKERS.filter((worker) => worker.runtime === "remote").map((worker) => worker.service),
  [...vpsServices],
);

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
  // 2026-10-31: the panel no longer lists the cloud row, so its failed read leaves the row
  // out rather than failing the whole panel (the jobs card carries Lead Meeting Reminders).
  assert.ok(!route.includes('error: "cloud_worker_health_unavailable"'), "a hidden row's read must not fail the panel");
  assert.ok(route.includes("reminder row left out"), "the failed read is still logged");
}

// The UI groups by execution/runtime, not historical ownership, and never
// paints disabled lifecycle buttons for automatically managed/retired rows.
//
// Three categories only (CC 2026-10-31): the 24/7 cloud automations are the
// Cloudflare jobs card (CronFlowCards, with its on/off switches); this panel
// shows the 24/7 cloud workers on OASIS's Hostinger VPS and this computer.
// Retired inventory and the cloud reminder row (a duplicate of the "Lead
// Meeting Reminders" job) are not rendered here.
{
  const cronCard = readFileSync("components/automations/CronFlowCards.tsx", "utf8");
  assert.ok(cronCard.includes('title="24/7 cloud automations (Cloudflare)"'), "category a: the Cloudflare jobs card");
  assert.ok(panel.includes('const PANEL_GROUPS: WorkerRuntime[] = ["remote", "local"];'), "the panel renders the VPS and this computer only");
  assert.ok(panel.includes('const OASIS_REMOTE_LABEL = "24/7 cloud workers (Hostinger VPS)";'), "category b: OASIS's VPS by name");
  assert.ok(
    panel.includes('workerRuntime === "remote" && data.inventory === "oasis"'),
    "the Hostinger name is only ever put on OASIS's own fleet",
  );
  assert.match(route, /^ {4}inventory,\r?$/m, "the route says whose fleet it is");
  assert.ok(panel.includes('label: "This computer (Windows / Mac)"'), "category c: this computer");
  assert.ok(!panel.includes("RUNTIME_GROUP_ORDER"), "no group list beyond PANEL_GROUPS");
  assert.ok(!panel.includes("<details"), "no collapsed retired section");
  assert.ok(
    panel.includes("const shown = data.workers.filter((w) => PANEL_GROUPS.includes(runtimeFor(w, legacyRemoteControl)));"),
    "only listed rows count in the pill",
  );
  assert.ok(panel.includes("const active = shown.filter(countsTowardHealth);"));
  assert.ok(panel.includes("Managed automatically"), "cloud rows need a plain-English management badge");
  assert.ok(panel.includes("j.message || j.error"), "health failures must show the route's plain-English explanation");
  assert.ok(panel.includes('worker.control_mode !== "none"'), "controls must only render for controllable rows");
  assert.ok(!panel.includes("OWNER_GROUP_LABEL"), "owner-only grouping must not drive the worker layout");
  assert.ok(!panel.includes("Start this worker via pm2"), "Windows fleet controls must not be labelled PM2");
  assert.ok(
    panel.includes("Restarting &ldquo;Bridge heartbeat&rdquo; usually clears it."),
    "the heartbeat runs here again: the stale-reporter banner names the restart that clears it",
  );
  assert.ok(!panel.includes("stay off by plan"), "the heartbeat is not retired");
  assert.ok(
    panel.includes("Runs on the daemon VPS · live status isn't reported to this page yet"),
    "an unmeasured VPS row says so instead of 'Waiting for remote status'",
  );
  assert.ok(panel.includes("not reported here"), "the pill names listed-but-unmeasured rows");
  assert.ok(panel.includes('"computer offline"'), "an offline computer reads as one state, not six outages");
  assert.ok(
    panel.includes('reporterBlind={localUnseen && workerRuntime === "local"}'),
    "stale local tiles are unseen (not down) while the computer is offline or the reporter is blind",
  );
}

// A row with no live status source never reads a health row, even if a stale
// one exists under its name.
{
  assert.match(
    route,
    /const h = archived \|\| runtime === "retired" \|\| statusSource === "none" \? undefined : healthMap\.get\(w\.service\);/,
  );
  assert.ok(panel.includes("Retired by plan — preserved for reference"));
}

console.log("background-workers-contract: all assertions passed");
