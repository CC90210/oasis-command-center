/**
 * The tab's failure classifier must not be weaker than the watchdog's.
 *
 * Two implementations read the same cron_jobs.last_result column and reach CC by
 * two different routes: scripts/core/cron_health_check.py texts him, this tab
 * shows him. Until now only the Python knew that failure is a SHAPE. Inbound
 * Email Sweep runs every five minutes and writes `{"errors": 3, "sent": 0}` —
 * no "ERROR" anywhere in it — so Python paged CC and the tab drew a green tick
 * and a neutral border on the same row. He opened the tab to confirm the alert
 * and the tab contradicted it. A dashboard that disagrees with a correct page is
 * worse than no dashboard, because it is the one that gets believed.
 *
 * EVERY FIXTURE BELOW IS COPIED FROM THE PYTHON'S OWN TEST,
 * scripts/tests/test_cron_health_shape_detection.py. That is the point: two
 * implementations fed identical inputs, so a change to either that moves a
 * verdict shows up here as a failure rather than as a silent divergence six
 * weeks later. The healthy list in particular is real live values — flagging any
 * of them would page CC hourly about a fine fleet, which is how a watchdog gets
 * muted.
 *
 * Run: node --conditions=react-server --import tsx tests/cron-result-shape-parity.test.ts
 */
import assert from "node:assert/strict";
import { classifyLastResult, normalizeEmpireRow, type EmpireCronRow } from "../lib/cron-empire-row";

function row(over: Partial<Record<string, unknown>> = {}): EmpireCronRow {
  return {
    id: "job-1",
    name: "Inbound Email Sweep",
    description: null,
    schedule: "*/5 * * * *",
    action_type: "script_run",
    action_config: null,
    owner_agent_key: null,
    is_active: true,
    last_run_at: "2026-09-17T12:00:00.000Z",
    last_result: null,
    next_run_at: null,
    run_count: 0,
    fail_count: 0,
    created_at: "2026-08-20T00:00:00Z",
    ...over,
  } as EmpireCronRow;
}

// ── test_legacy_error_prefix_still_flags ───────────────────────────────────
assert.equal(classifyLastResult("ERROR: script_run exit 1: boom").status, "error");
assert.equal(classifyLastResult("FAILED (exit 2): missing file").status, "error");

// ── test_json_summary_with_errors_is_a_failure ─────────────────────────────
// The shape the prefix check was blind to. No "ERROR" anywhere in it.
{
  const verdict = classifyLastResult('{"errors": 3, "sent": 0}');
  assert.equal(verdict.status, "error");
  assert.match(String(verdict.reason), /errors=3/);
}

// ── test_healthy_json_summaries_stay_green ─────────────────────────────────
for (const healthy of [
  '{"drained": 0}',
  '{"replayed": 0, "failed": 0, "remaining": 0}',
  '{"errors":0,"exhausted":1,"replied":1,"calls":1,"scanned":2,"in_scope":2,"live":true}',
  '{"status": "checked", "unread_count": 0, "message": "No unread emails"}',
  "[]",
  "synced: 157  ·  failed: 0",
  "ok: all crons healthy",
  "qualified: 0 / 0",
]) {
  assert.equal(classifyLastResult(healthy).status, "success", `must stay green: ${healthy}`);
}

// ── test_ok_false_and_error_status_are_failures ────────────────────────────
assert.equal(classifyLastResult('{"ok": false}').status, "error");
assert.equal(classifyLastResult('{"status": "error"}').status, "error");
assert.equal(classifyLastResult('{"status": "failed", "n": 0}').status, "error");

// ── test_nested_error_counts_are_found ─────────────────────────────────────
// Handlers wrap their counts; a summary one level down still counts.
assert.equal(classifyLastResult('{"summary": {"errors": 2}, "ok": true}').status, "error");

// ── test_plain_text_counter_is_a_failure ───────────────────────────────────
assert.equal(classifyLastResult("processed 10, failed: 3").status, "error");
assert.equal(classifyLastResult("processed 10, failed: 0").status, "success");

// ── test_a_decoded_dict_is_classified_like_a_json_string ───────────────────
// THE BUG THE PYTHON'S UNIT TESTS MISSED AND A LIVE PROBE CAUGHT, which this
// port inherits by construction: lib/turso-postgrest.ts fromSql JSON-parses any
// TEXT starting with `{` or `[`, so last_result reaches the classifier as a real
// object for exactly the rows it exists to catch. Round-tripping it through a
// string before scanning is what left the detector green in CI and dead in
// production, so the decoded object is scanned directly.
{
  const verdict = classifyLastResult({ errors: 3, processed: 0 });
  assert.equal(verdict.status, "error", "a pre-decoded object must classify like its string form");
  assert.match(String(verdict.reason), /errors=3/);
}
assert.equal(classifyLastResult({ drained: 0 }).status, "success");
assert.equal(classifyLastResult([]).status, "success");
assert.equal(classifyLastResult({ ok: false }).status, "error");
assert.equal(classifyLastResult({ summary: { failures: 2 } }).status, "error");
assert.equal(
  classifyLastResult({ status: "checked", unread_count: 0, message: "No unread emails" }).status,
  "success",
);

// ── test_an_opaque_result_is_not_a_failure ─────────────────────────────────
// Several jobs store the last stdout line of pretty-printed JSON, which is a
// lone "}". The Python reports those in their own bucket — visible, never
// alerting. The tab's equivalent is a third status: not red, and not the green
// tick it used to collect by falling through the else.
for (const opaque of ["}", "]", "})", "}]"]) {
  assert.equal(classifyLastResult(opaque).status, "unknown", `opaque tail: ${opaque}`);
}
assert.equal(classifyLastResult('{"errors": 1}').status, "error", "still parseable, still a failure");

// ── the verdicts as the card actually receives them ────────────────────────
// classifyLastResult being right is not enough; normalizeEmpireRow is what the
// UI reads, and it used to hand every non-prefix result to the success branch.
const sweep = normalizeEmpireRow(row({ last_result: { errors: 3, sent: 0 } }));
assert.equal(sweep.last_run_status, "error", "the five-minute sweep must reach the tab as a failure");
assert.equal(sweep.last_run_output, null, "a failing row must not render its result as output");
assert.match(String(sweep.last_run_error), /errors=3/, "the card must say WHICH shape failed");
assert.match(String(sweep.last_run_error), /"errors":3/, "and still show the stored value");

const opaqueRow = normalizeEmpireRow(row({ last_result: "}" }));
assert.equal(opaqueRow.last_run_status, "unknown", "an unverdictable tail is not a success");
assert.equal(opaqueRow.last_run_error, null, "and not a failure either — it is not evidence");
assert.equal(opaqueRow.last_run_output, "}", "the blind spot stays visible rather than hidden");

// The healthy live rows must still come through green through the full path —
// a classifier that cries wolf on these is a classifier CC turns off.
for (const healthy of [{ drained: 0 }, { replayed: 0, failed: 0, remaining: 0 }, []]) {
  assert.equal(
    normalizeEmpireRow(row({ last_result: healthy })).last_run_status,
    "success",
    `live healthy row must stay green: ${JSON.stringify(healthy)}`,
  );
}

// fail_count still outranks the shape: a scheduler skip that reads clean must
// not paint over failures no later run has cleared.
assert.equal(
  normalizeEmpireRow(row({ fail_count: 2, last_result: { drained: 0 } })).last_run_status,
  "error",
);

console.log("cron-result-shape-parity: the tab classifies failure exactly as the watchdog does");
