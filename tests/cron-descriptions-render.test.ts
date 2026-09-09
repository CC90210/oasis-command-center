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
 * WHY THE NAMES ARE SNAPSHOTTED HERE RATHER THAN READ LIVE
 * -------------------------------------------------------
 * The names are declared in Business-Empire-Agent/scripts/core/cron_engine.py —
 * a DIFFERENT repo. The first version of this test read that file at a
 * hardcoded absolute Windows path, which cannot exist where this test actually
 * runs: .github/workflows/ci.yml uses ubuntu-latest with a single
 * actions/checkout, so readFileSync would throw ENOENT at module scope. That
 * fails `npm run test:web-leads` and, because the Tests step is one bash -e
 * block, every suite chained after it — test:sms-agent, test:paged-reads,
 * test:chat-modes, test:watermark. A gate that reds CI for a reason unrelated
 * to the thing it guards gets deleted rather than fixed, and this one would
 * have taken four unrelated suites down with it.
 *
 * So the check runs in two modes, and neither one is silent:
 *
 *   ALWAYS — every override key must be a job name snapshotted below. This is
 *            the assertion that protects the tab, and it needs nothing outside
 *            this repo, so it runs identically on CI and on a laptop.
 *
 *   LOCAL  — when Bravo's repo IS reachable, the snapshot is diffed against the
 *            live SEED_JOBS, which catches a rename at the moment and in the
 *            place it happens. When the repo is absent the test SAYS SO: an
 *            unreachable cross-check is a check that did not run, not a pass.
 *
 * Resolution mirrors lib/agent-inbox-fs.ts (BRAVO_REPO, else
 * ~/Business-Empire-Agent) rather than hardcoding a path — the repo already had
 * that convention, and every other file in tests/ reads repo-relative.
 *
 * Renamed a job in SEED_JOBS? Update SEEDED_JOB_NAMES below; the local diff
 * prints exactly what changed.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { FRIENDLY_DESCRIPTIONS, friendlyDescription } from "../lib/cron-descriptions";

function run(name: string, fn: () => void) {
  fn();
  console.log(`  ok  ${name}`);
}

console.log("cron-descriptions-render:");

/**
 * SEED_JOBS job names, snapshotted 2026-09-08 from
 * Business-Empire-Agent/scripts/core/cron_engine.py.
 */
const SEEDED_JOB_NAMES = new Set<string>([
  "Booking Reminders",
  "Bravo — Cross-Agent Review Scan",
  "Bravo — Hourly Cron Health Check",
  "Bravo — Nightly Harness Eval",
  "Bravo — Review Harvest",
  "Bravo — Sleep Agent (Memory Consolidation)",
  "Break-Glass Drill (quarterly)",
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
  "Funnel Fast-Poll",
  "Inbound Email Sweep",
  "LanceDB Compaction (weekly)",
  "Library Post Linker",
  "Loud Failures Weekly Probe",
  "Marketing Publish Drain",
  "Maven — Carousel Post",
  "Monthly Inventory Sync",
  "Nurture Sequence Check",
  "OASIS Auto-Score Leads",
  "Post Analytics Sync",
  "Training Corpus Ingest",
  "Weekly Eval Suites",
  "Weekly Event Bus Retention",
  "Weekly Full-Truth Health Digest",
  "Weekly Pipeline Review",
  "Weekly Receipts Reconciliation",
  "Weekly tmp/ Hygiene",
]);

/**
 * Overrides for jobs that are NOT in this registry, and are not expected to be.
 *
 * Every entry is a deliberate exclusion with a reason, not a snooze button. A
 * new dead key must fail the test rather than be waved through by a wildcard.
 */
const KNOWN_ABSENT = new Set<string>([
  // SunBiz portal jobs. Seeded from that portal's own registry
  // (tenant_cron_jobs), not this one, and deliberately out of scope for
  // SEED_JOBS.
  "SunBiz Follow-up Generator",
  "SunBiz Daily Plan Generator",
  "SunBiz Renewal Reminder",
  "SunBiz Underwriting Orchestrator",
  "SunBiz Shop-Out Sender",
  "SunBiz Cold Outreach Runner",
  "SunBiz Health Check",
]);

run("every override key matches a real job name", () => {
  const orphaned = Object.keys(FRIENDLY_DESCRIPTIONS).filter(
    (k) => !SEEDED_JOB_NAMES.has(k) && !KNOWN_ABSENT.has(k),
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
  // Regression pins for the six that had rotted. If a job is renamed again, the
  // test above catches it; these make the specific history explicit.
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
  assert.equal(friendlyDescription("Some Job With No Override", "raw db text"), "raw db text");
  assert.equal(
    friendlyDescription("Daily Bravo Brief", "raw db text"),
    FRIENDLY_DESCRIPTIONS["Daily Bravo Brief"],
    "an override that exists must win over the DB text",
  );
});

// ── LOCAL ONLY: is the snapshot still the truth? ────────────────────────────
//
// Necessarily skipped on CI — Bravo's repo is not checked out there — so the
// skip is announced. A cross-check that quietly no-ops reads as coverage.
const BRAVO_REPO = process.env.BRAVO_REPO || path.join(homedir(), "Business-Empire-Agent");
const CRON_ENGINE = path.join(BRAVO_REPO, "scripts", "core", "cron_engine.py");

if (!existsSync(CRON_ENGINE)) {
  console.log(
    `  --  snapshot NOT verified against SEED_JOBS: ${CRON_ENGINE} is absent ` +
      `(expected on CI; set BRAVO_REPO to run this check locally)`,
  );
} else {
  run("the snapshot still matches the live SEED_JOBS", () => {
    const src = readFileSync(CRON_ENGINE, "utf8");
    const live = new Set<string>();
    // `"name": "Some Job",` inside a SEED_JOBS entry.
    for (const m of src.matchAll(/^\s*"name":\s*"([^"]+)"/gm)) live.add(m[1]);
    assert.ok(
      live.size > 20,
      `only parsed ${live.size} job names out of cron_engine.py — the regex missed the file`,
    );

    const added = [...live].filter((n) => !SEEDED_JOB_NAMES.has(n)).sort();
    const removed = [...SEEDED_JOB_NAMES].filter((n) => !live.has(n)).sort();
    assert.deepEqual(
      { added, removed },
      { added: [], removed: [] },
      "SEED_JOBS has drifted from the snapshot above. Update SEEDED_JOB_NAMES, then " +
        "re-key or delete any FRIENDLY_DESCRIPTIONS entry pointing at a renamed job — " +
        "otherwise its copy silently stops rendering.",
    );
  });
}
