/**
 * tests/automation-runs-on-and-off-reason.test.ts — CC, 2026-11-03: the automations list
 * must say where each job runs and why an off job is off.
 *   1. runs_on: the daemon VPS reads "server", a workstation "computer", nobody null.
 *   2. off_reason: an OFF row whose result starts "Retired —" / "Paused —" carries the
 *      reason; an ON row never does, and an off row without a recorded reason has none.
 *   3. The list orders working rows first, then paused, then retired, stable within each.
 *   4. The Empire query selects owner_machine, so the field reaches the page.
 *
 * Run: node --conditions=react-server --import tsx tests/automation-runs-on-and-off-reason.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeEmpireRow, offReasonOf, runsOnOf } from "../lib/cron-empire-row";
import { sortByOffReason } from "../lib/automations/cron-inventory";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${String((error as Error).stack || error).split("\n").slice(0, 5).join("\n        ")}`);
  }
}

const row = (over: Record<string, unknown>) => ({
  id: "j1", name: "Job", description: null, schedule: "0 * * * *", action_type: "script_run", action_config: {},
  is_active: true, last_run_at: null, last_result: "ok", next_run_at: null, run_count: 1, fail_count: 0,
  created_at: "2026-11-03T00:00:00Z", ...over,
}) as never;

console.log("automation runs-on and off-reason:");

check("runs_on: the daemon VPS is the server, any other name is a computer, nothing is nobody", () => {
  assert.equal(runsOnOf("oasis-daemon-1"), "server");
  assert.equal(runsOnOf("vps"), "server");
  assert.equal(runsOnOf("CCPC"), "computer");
  assert.equal(runsOnOf(null), null);
  assert.equal(runsOnOf("  "), null);
  assert.equal(normalizeEmpireRow(row({ owner_machine: "oasis-daemon-1" })).runs_on, "server");
});

check("off_reason: an off row's recorded reason, never an on row's", () => {
  assert.deepEqual(offReasonOf(false, "Paused — Zernio cancelled (CC, 2026-11-03)."), { kind: "paused", text: "Zernio cancelled (CC, 2026-11-03)." });
  assert.deepEqual(offReasonOf(false, "Retired — the Cloudflare job sends these now."), { kind: "retired", text: "the Cloudflare job sends these now." });
  assert.deepEqual(offReasonOf(false, "Retired here — the inbox runs as a worker."), { kind: "retired", text: "the inbox runs as a worker." });
  assert.equal(offReasonOf(true, "Paused — Zernio cancelled"), null, "an ON row is not paused, whatever its text says");
  assert.equal(offReasonOf(false, "skipped-stale: next_run_at was 9890 min behind"), null);
  const normalized = normalizeEmpireRow(row({ is_active: false, last_result: "Paused — ad spend paused (CC, 2026-11-03)." }));
  assert.deepEqual(normalized.off_reason, { kind: "paused", text: "ad spend paused (CC, 2026-11-03)." });
});

check("the list shows working rows first, then paused, then retired, stable within each", () => {
  const jobs = [
    { id: "r1", off_reason: { kind: "retired" as const, text: "x" } },
    { id: "w1", off_reason: null },
    { id: "p1", off_reason: { kind: "paused" as const, text: "y" } },
    { id: "w2" },
    { id: "r2", off_reason: { kind: "retired" as const, text: "z" } },
  ];
  assert.deepEqual(sortByOffReason(jobs).map((j) => j.id), ["w1", "w2", "p1", "r1", "r2"]);
});

check("the Empire query selects owner_machine, so 'Runs on' reaches the page", () => {
  const route = readFileSync("app/api/cron-jobs/route.ts", "utf8");
  assert.match(route, /owner_agent_key, owner_machine, is_active/);
});

console.log(`automation runs-on and off-reason: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
