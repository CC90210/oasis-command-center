/**
 * cron-descriptions-render.test.ts — operator copy that no job will ever match
 * is copy nobody reads.
 *
 * THE DEFECT (measured against the live registry, 2026-09-08): 21 of 25
 * FRIENDLY_DESCRIPTIONS keys matched no job on the Automations tab. Somebody
 * wrote plain-English copy for those jobs and every one of them silently
 * rendered the engineer-written DB text instead.
 *
 * Nothing broke, which is the problem. friendlyDescription() falls back to the
 * DB description when a key misses, so a rename anywhere in cron_engine.py's
 * SEED_JOBS quietly orphans the override and the tab still looks fine. Six of
 * them were pure renames: "Booking Reminder" vs "Booking Reminders", "Funnel
 * Fast Poll" vs "Funnel Fast-Poll", "Sync MRR" vs "Daily MRR Auto-Sync".
 *
 * This test pins the KEYS to the job names. It cannot reach the database, so it
 * reads SEED_JOBS out of cron_engine.py — the same source the live rows are
 * seeded from, and the file where a rename actually happens.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FRIENDLY_DESCRIPTIONS, friendlyDescription } from "../lib/cron-descriptions";

function run(name: string, fn: () => void) {
  fn();
  console.log(`  ok  ${name}`);
}

console.log("cron-descriptions-render:");

/** Job names as SEED_JOBS declares them, read from the Python source. */
function seedJobNames(): Set<string> {
  const src = readFileSync(
    "C:/Users/User/Business-Empire-Agent/scripts/core/cron_engine.py",
    "utf8",
  );
  const names = new Set<string>();
  // `"name": "Some Job",` inside a SEED_JOBS entry.
  for (const m of src.matchAll(/^\s*"name":\s*"([^"]+)"/gm)) names.add(m[1]);
  return names;
}

/**
 * Overrides for jobs that are NOT in this registry, and are not expected to be.
 *
 * Every entry is a deliberate exclusion with a reason, not a snooze button. A
 * new dead key must fail the test rather than be waved through by a wildcard.
 */
const KNOWN_ABSENT = new Set<string>([
  // SunBiz portal jobs. Seeded from that portal's own registry, not this one,
  // and deliberately out of scope for this repo's SEED_JOBS.
  "SunBiz Follow-up Generator",
  "SunBiz Daily Plan Generator",
  "SunBiz Renewal Reminder",
  "SunBiz Underwriting Orchestrator",
  "SunBiz Shop-Out Sender",
  "SunBiz Cold Outreach Runner",
  "SunBiz Health Check",
]);

run("every override key matches a real job name", () => {
  const names = seedJobNames();
  assert.ok(names.size > 20, `only found ${names.size} job names — the parser missed the file`);

  const orphaned = Object.keys(FRIENDLY_DESCRIPTIONS).filter(
    (k) => !names.has(k) && !KNOWN_ABSENT.has(k),
  );
  assert.deepEqual(
    orphaned,
    [],
    "these overrides will never render; the job was renamed or removed. " +
      "Re-key them onto the current name, or delete the copy — do NOT leave it, " +
      "because the tab silently falls back to engineer text and looks fine.",
  );
});

run("the renames that were found stay fixed", () => {
  // Regression pins for the six that had rotted. If a job is renamed again,
  // the test above catches it; these make the specific history explicit.
  for (const name of [
    "Booking Reminders",
    "Daily MRR Auto-Sync",
    "Nurture Sequence Check",
    "Funnel Fast-Poll",
    "Daily State DB Backup",
    "Bravo — Sleep Agent (Memory Consolidation)",
  ]) {
    assert.ok(FRIENDLY_DESCRIPTIONS[name], `${name} lost its operator copy again`);
  }
});

run("the brief's copy does not report revenue or a hardcoded target", () => {
  // Bravo does not report revenue — Atlas owns it — and the copy named a $5K
  // goal that was passed in June, so the tab quoted a stale number as the thing
  // to beat.
  const brief = FRIENDLY_DESCRIPTIONS["Daily Bravo Brief"] || "";
  assert.ok(brief, "the brief lost its operator copy");
  assert.ok(!/\brevenue\b/i.test(brief), "the brief claims to report revenue");
  assert.ok(!/\$\s?\d/.test(brief), "a hardcoded money target will go stale silently");
  assert.ok(!/\bMRR\b/.test(brief), "MRR belongs to Atlas, not this brief");
});

run("a job with no override still renders something", () => {
  // The fallback is correct behaviour and must stay — it is only a problem when
  // it hides an orphaned key, which the first test now catches.
  assert.equal(
    friendlyDescription("Some Job With No Override", "raw db text"),
    "raw db text",
  );
  assert.equal(
    friendlyDescription("Daily Bravo Brief", "raw db text"),
    FRIENDLY_DESCRIPTIONS["Daily Bravo Brief"],
    "an override that exists must win over the DB text",
  );
});
