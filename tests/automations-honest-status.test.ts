/**
 * tests/automations-honest-status.test.ts - what the Automations tab says matches
 * what happened (2026-10-15).
 *
 * CC's screenshot of the live tab showed four things that were each true of the
 * data and wrong on the screen:
 *   - "Daily Automation Register": a green tick and "Ran 1d ago", over the raw
 *     string "skipped-stale: next_run_at was 369 min behind threshold (30 min) -
 *     PC was likely off when this slot expired". The job had NOT run on its latest
 *     slot; "Ran 1d ago" was its last real run.
 *   - "Frontier Radar": "Stored next Sep 28, 7:00 AM EDT (paused)" on Oct 15, a
 *     past date dressed as a schedule.
 *   - "4 for this workspace . 38 OASIS platform (operators only)": two unrelated
 *     sentences for two counts of the same thing.
 *   - "Draft with AI" dimmed with no word on why, over a placeholder chosen with
 *     Math.random() during render (a hydration mismatch).
 *
 * The status logic is pinned in cron-empire-row.test.ts and
 * automation-overdue-schedule.test.ts; this pins the rendering that uses it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

const manager = read("components/automations/CronJobsManager.tsx");

// A skipped slot is its own state: neutral icon, "Last ran", a plain note, the raw text under Details.
assert.match(manager, /const ranSkipped = job\.last_run_status === "skipped";/);
assert.match(manager, /ranSkipped\s*\?\s*"Last ran"/, "last_run_at is the last REAL run, so the line says so");
assert.doesNotMatch(
  manager,
  /ranOk\s*\?\s*\(\s*<Check[\s\S]{0,40}ranSkipped/,
  "a skipped slot never gets the success tick",
);
assert.match(manager, /data-testid="cron-skipped-note"/);
assert.match(manager, /job\.last_run_note[\s\S]{0,400}<summary[^>]*>Details<\/summary>[\s\S]{0,200}job\.last_run_output/, "raw text sits under Details, not in the message");
assert.match(
  manager,
  /!job\.last_run_error && !job\.last_run_note && job\.last_run_output/,
  "the raw 'Last result:' box is only for a result with no plain note",
);

// The counts read as two counts of the same thing.
assert.match(manager, /Yours \$\{tenantCount\} · OASIS platform \$\{empireCount\} \(operators only\)/);
assert.doesNotMatch(manager, /for this workspace · \$\{empireCount\}/, "the two-sentence wording is gone");
console.log("  ok - a skipped slot is neutral, plainly worded, with the raw text under Details; counts read as counts");

const flow = read("components/automations/DescribeAutomationFlow.tsx");

// Hydration-safe placeholder: the first render is deterministic, the shuffle happens after mount.
assert.match(flow, /useState\(EXAMPLES\[0\]\)/);
assert.match(flow, /useEffect\(\(\) => \{\s*setPlaceholder\(EXAMPLES\[Math\.floor\(Math\.random\(\) \* EXAMPLES\.length\)\]\);\s*\}, \[\]\);/);
assert.doesNotMatch(flow, /placeholder=\{EXAMPLES\[Math\.floor\(Math\.random\(\)/, "no Math.random() inside the render");
// The button says why it is off.
assert.match(flow, /const MIN_DESCRIPTION_CHARS = 10;/);
assert.match(flow, /const tooShort = typed\.trim\(\)\.length < MIN_DESCRIPTION_CHARS;/);
assert.match(flow, /disabled=\{tooShort\}/);
assert.match(flow, /data-testid="describe-automation-min-hint"/);
assert.match(flow, /aria-describedby="describe-automation-help"/);
assert.match(flow, /description\.length < MIN_DESCRIPTION_CHARS/, "the guard inside draft() uses the same number");
console.log("  ok - the Draft with AI placeholder is hydration-safe and the disabled button says why");

// Every consumer of the wire type accepts the new status, so a skipped row is never dropped.
const inventory = read("lib/automations/cron-inventory.ts");
assert.match(inventory, /last_run_status: "success" \| "error" \| "unknown" \| "skipped" \| null;/);
assert.match(inventory, /value\.last_run_status === "skipped"/, "the response validator accepts it");
assert.match(inventory, /last_run_note\?: string \| null;/);
console.log("  ok - the wire type and validator carry the skipped status and its note");

console.log("automations-honest-status: all passed");
