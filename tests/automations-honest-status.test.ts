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

// Every line about the last run comes from lib/automations/run-summary.ts, whose
// sentences, times and colours are pinned in cron-empire-row.test.ts. This pins
// that the row renders THAT, and nothing raw (CC 2026-10-16).
assert.match(manager, /const run = summarizeRun\(job\);/);
assert.match(manager, /const ranBad = run\.failed;/, "only a real failure is red; a skip or deferral is not");
assert.match(manager, /: ranBad \|\| overdue/, "the card border reads that same verdict");
assert.match(manager, /const ranOk = !ranBad && run\.lastRan\?\.tone === "ok";/, "a skipped slot never gets the success tick");
assert.match(manager, /run\.lastRan\.text/, "the Last ran line is the summary's");
assert.match(manager, /\{run\.lastAttempt && \([\s\S]{0,200}data-testid="cron-last-attempt"[\s\S]{0,200}\{run\.lastAttempt\}/, "Last attempt is its own line, only when it differs");
assert.match(
  manager,
  /data-testid="cron-result-line"[\s\S]{0,600}\{run\.result\.text\}[\s\S]{0,200}<details className=[^>]*>\s*<summary[^>]*>Details<\/summary>[\s\S]{0,200}\{run\.details\}/,
  "one plain sentence per row, the stored text under a closed Details",
);
assert.doesNotMatch(manager, /<details[^>]*\bopen\b/, "Details starts closed");
assert.doesNotMatch(manager, /Last result: |"Error: "/, "raw text is never the main line");
assert.doesNotMatch(manager, /job\.last_run_(?:error|output|note)\b/, "the row never prints a raw stored column itself");
assert.doesNotMatch(manager, /run\.details\.slice\(/, "the evidence is never cut short");
// One result line for every row: the team's rows (admins only) say what their last run did too, in the
// same component, so the two can never word a run differently (re-audit 2026-10-16).
const teamRow = manager.slice(manager.indexOf("function TeamJobRow("), manager.indexOf("function JobRow("));
const ownRow = manager.slice(manager.indexOf("function JobRow("), manager.indexOf("function RunResultLine("));
assert.match(teamRow, /<RunResultLine run=\{summarizeRun\(job\)\} \/>/, "a team row has its result line");
assert.match(ownRow, /<RunResultLine run=\{run\} daemon=\{Boolean\(daemon\)\} \/>/, "your own row uses the same line");
assert.equal((manager.match(/data-testid="cron-result-line"/g) || []).length, 1, "the result line is written once");

// The counts read as two counts of the same thing.
assert.match(manager, /Yours \$\{tenantCount\} · OASIS platform \$\{empireCount\} \(operators only\)/);
assert.doesNotMatch(manager, /for this workspace · \$\{empireCount\}/, "the two-sentence wording is gone");
console.log("  ok - every row has one plain result line with the raw text under Details; a skip is neutral; counts read as counts");

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
assert.match(inventory, /last_attempt_kind\?: "missed" \| "skipped" \| "deferred" \| null;/);
assert.match(inventory, /value\.last_attempt_kind === "missed"/, "the response validator accepts the attempt kind");
assert.match(inventory, /last_result_text\?: string \| null;/);
console.log("  ok - the wire type and validator carry the skipped status and its note");

console.log("automations-honest-status: all passed");
