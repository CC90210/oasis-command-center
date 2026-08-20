/**
 * The Automations tab crashed for weeks with "b.toUpperCase is not a function".
 *
 * normalizeEmpireRow had NO test. It was written against Postgres, where a text
 * column returns text, and then the data layer changed underneath it: Turso's
 * shim JSON-parses any TEXT starting with `{` or `[`, so last_result arrives as
 * an object. `|| ""` passes truthy non-strings straight through to a String
 * method.
 *
 * Every case below is a real value from the live cron_jobs table.
 */
import assert from "node:assert/strict";
import {
  asBool,
  classifyLastResult,
  inferEmpireAgentKey,
  normalizeEmpireRow,
  type EmpireCronRow,
} from "../lib/cron-empire-row";

function row(over: Partial<Record<string, unknown>> = {}): EmpireCronRow {
  return {
    id: "job-1",
    name: "Inbound Email Sweep",
    description: null,
    schedule: "*/5 * * * *",
    action_type: "script_run",
    action_config: null,
    is_active: true,
    last_run_at: null,
    last_result: null,
    next_run_at: null,
    run_count: 0,
    created_at: "2026-08-20T00:00:00Z",
    ...over,
  } as EmpireCronRow;
}

// ── The exact crash ────────────────────────────────────────────────────────
// Real stored values, as the shim delivers them (parsed, not raw text).
for (const [label, value] of [
  ["object (Inbound Email Sweep)", { status: "checked", unread_count: 0 }],
  ["object (Event Bus Offline Drain)", { replayed: 0, failed: 0, remaining: 0 }],
  ["object (Review Harvest)", { drained: 0 }],
  ["EMPTY ARRAY (Booking Reminders)", []],
  ["nested array", [{ a: 1 }]],
] as Array<[string, unknown]>) {
  assert.doesNotThrow(
    () => normalizeEmpireRow(row({ last_result: value })),
    `normalizeEmpireRow must survive a ${label} in last_result`,
  );
}

// `[]` is the sharpest case: truthy, so `[] || ""` yields `[]`, and
// `[].toUpperCase` is undefined. This single row broke the whole board.
const emptyArray = normalizeEmpireRow(row({ last_result: [] }));
assert.equal(emptyArray.last_run_status, "success");

// A parsed object is serialized back to something a human can read, not "[object Object]".
const parsed = normalizeEmpireRow(row({ last_result: { status: "checked", unread_count: 0 } }));
assert.equal(parsed.last_run_status, "success");
assert.match(String(parsed.last_run_output), /"status":"checked"/);
assert.doesNotMatch(String(parsed.last_run_output), /\[object Object\]/);

// ── Behaviour that must NOT regress ────────────────────────────────────────
assert.equal(classifyLastResult(null).status, null, "no result yet = no status");
assert.equal(classifyLastResult("").status, null);
assert.equal(classifyLastResult("ok").status, "success");
assert.equal(classifyLastResult("stripe sync ok: 3 rows").status, "success");
assert.equal(classifyLastResult("ERROR: boom").status, "error");
assert.equal(classifyLastResult("error: lowercase still counts").status, "error");
assert.equal(classifyLastResult("FAILED (exit 1): stderr").status, "error");
assert.equal(normalizeEmpireRow(row({ last_result: "ERROR: x" })).last_run_error, "ERROR: x");
assert.equal(normalizeEmpireRow(row({ last_result: "ERROR: x" })).last_run_output, null);

// ── Booleans survived the transpiler as INTEGER ────────────────────────────
// cron_jobs.is_active is INTEGER in SQLite and fromSql never restores it, so the
// toggle would be reading a number while its type says boolean.
assert.equal(asBool(1), true);
assert.equal(asBool(0), false);
assert.equal(asBool(true), true);
assert.equal(asBool(false), false);
assert.equal(asBool("1"), true);
assert.equal(asBool("true"), true);
assert.equal(asBool(null), false);
assert.equal(asBool(undefined), false);
assert.equal(normalizeEmpireRow(row({ is_active: 1 as unknown as boolean })).enabled, true);
assert.equal(normalizeEmpireRow(row({ is_active: 0 as unknown as boolean })).enabled, false);
assert.strictEqual(
  typeof normalizeEmpireRow(row({ is_active: 1 as unknown as boolean })).enabled,
  "boolean",
  "enabled must be a real boolean, not the integer the database returned",
);

// ── Grouping must not crash on a non-string name either ────────────────────
assert.equal(inferEmpireAgentKey("Atlas — MRR sync", null), "atlas");
assert.equal(inferEmpireAgentKey("Maven — post", null), "maven");
assert.equal(inferEmpireAgentKey("Morning Pow Wow Call", null), "aura");
assert.equal(inferEmpireAgentKey("Inbound Email Sweep", "script_run"), "bravo");
assert.equal(inferEmpireAgentKey(null, null), "bravo", "a null name must not throw");
assert.equal(inferEmpireAgentKey({ a: 1 }, null), "bravo", "an object name must not throw");

// Maven's content work, by the real empire job names. None of these carry an
// agent prefix, so all four filed under Bravo and the board credited the CEO
// lane with the CMO's automations.
for (const jobName of [
  "Marketing Publish Drain",
  "Post Analytics Sync",
  "Library Post Linker",
  "Training Corpus Ingest",
]) {
  assert.equal(
    inferEmpireAgentKey(jobName, "script_run"),
    "maven",
    `${jobName} is content work and belongs to Maven`,
  );
}

// An explicit agent prefix still wins over a domain keyword, so a finance job
// that merely mentions marketing spend stays with Atlas.
assert.equal(inferEmpireAgentKey("Atlas — marketing spend reconcile", null), "atlas");
assert.equal(inferEmpireAgentKey("Maven — anything", null), "maven");
// And genuinely operational jobs stay with Bravo.
assert.equal(inferEmpireAgentKey("Inbound Email Sweep", "script_run"), "bravo");
assert.equal(inferEmpireAgentKey("Daily State DB Backup", "script_run"), "bravo");
assert.equal(inferEmpireAgentKey("Bravo — Review Harvest", "script_run"), "bravo");

// run_count arrives as INTEGER; a missing one must read 0, never NaN.
assert.equal(normalizeEmpireRow(row({ run_count: null })).run_count, 0);
assert.equal(normalizeEmpireRow(row({ run_count: 42 })).run_count, 42);

console.log("cron-empire-row ok — JSON-valued last_result no longer crashes the board");
