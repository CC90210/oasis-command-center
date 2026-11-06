import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OASIS_CRON_PLACEMENTS,
  cronPlacementForName,
  isCronPlacementState,
  type CronPlacementDestination,
} from "../lib/automations/cron-placement";

const EXPECTED_NAMES = [
  "Booking Reminders",
  "Bravo — Cross-Agent Review Scan",
  "Bravo — Hourly Cron Health Check",
  "Bravo — Nightly Harness Eval",
  "Bravo — Review Harvest",
  "Bravo — Sleep Agent (Memory Consolidation)",
  "Break-Glass Drill (quarterly)",
  "Carousel Media Retention",
  "Content Tools Runner",
  "Cross-Agent Self-Improvement Sweep",
  "Daily Automation Register",
  "Daily Bravo Brief",
  "Daily Briefing Snapshot",
  "Daily Client Alerts Snapshot",
  "Daily Log Rotation Audit",
  "Daily MRR Auto-Sync",
  "Daily Memory Index Rebuild",
  "Daily Pulse Mechanical Refresh",
  "Daily State DB Backup",
  "Event Bus Offline Drain",
  "Frontier Radar Weekly Sweep",
  "Funnel Fast-Poll",
  "Inbound Email Sweep",
  "LanceDB Compaction (weekly)",
  "Library Post Linker",
  "Library Reviews Sync",
  "Loud Failures Weekly Probe",
  "Marketing Publish Drain",
  "Maven — Carousel Post",
  "Monthly Inventory Sync",
  "Nurture Sequence Check",
  "OASIS Auto-Score Leads",
  "Post Analytics Sync",
  "Service Checks (Connections)",
  "Training Corpus Ingest",
  "Weekly Eval Suites",
  "Weekly Event Bus Retention",
  "Weekly Full-Truth Health Digest",
  "Weekly Pipeline Review",
  "Weekly Receipts Reconciliation",
  "Weekly tmp/ Hygiene",
].sort();

assert.equal(OASIS_CRON_PLACEMENTS.length, 41);
assert.deepEqual(
  OASIS_CRON_PLACEMENTS.map((entry) => entry.name).sort(),
  EXPECTED_NAMES,
  "the placement ledger must cover the exact 41-row OASIS snapshot",
);

const counts = new Map<CronPlacementDestination, number>();
for (const entry of OASIS_CRON_PLACEMENTS) {
  counts.set(entry.destination, (counts.get(entry.destination) ?? 0) + 1);
  assert.equal(isCronPlacementState(entry), true, `${entry.name} has a valid placement state`);
}
assert.deepEqual(
  Object.fromEntries(counts),
  { cloud: 12, vps: 7, retired: 9, off: 13 },
);
assert.equal(new Set(OASIS_CRON_PLACEMENTS.map((entry) => entry.name)).size, 41);

assert.equal(
  cronPlacementForName("  DAILY   AUTOMATION REGISTER  ")?.destination,
  "cloud",
  "lookup tolerates harmless casing/spacing drift without fuzzy name guessing",
);
assert.equal(cronPlacementForName("Brand new schedule"), null);
assert.equal(
  isCronPlacementState({
    destination: "retired",
    phase: "moving",
    label: "Retired",
    detail: "Wrong phase",
  }),
  false,
  "destination/phase contradictions fail runtime validation",
);

const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");
const route = read("app/api/cron-jobs/route.ts");
const inventory = read("lib/automations/cron-inventory.ts");
const manager = read("components/automations/CronJobsManager.tsx");

assert.match(route, /placement: cronPlacementForName\(normalized\.name\)/);
assert.match(route, /OASIS cron placement is unmapped/);
assert.match(inventory, /value\.source === "empire" && !hasPlacementField/);
assert.match(inventory, /value\.source === "tenant" && hasPlacementField/);
assert.match(manager, /const nextRun = legacyHistory/);
assert.match(manager, /disabled=\{isPending \|\| Boolean\(retired\) \|\| \(isEmpire && !daemon\)\}/);
assert.match(manager, /Destination unassigned/);
assert.match(manager, /<RunResultLine run=\{run\} daemon=\{legacyHistory\} \/>/);

console.log("cron-placement: exact 41-row ledger and UI wire assertions passed");
