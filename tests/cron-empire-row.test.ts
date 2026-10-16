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
  attemptKindOf,
  classifyLastResult,
  explainSkippedResult,
  inferEmpireAgentKey,
  normalizeEmpireRow,
  normalizeTenantCronRow,
  type EmpireCronRow,
} from "../lib/cron-empire-row";
import {
  formatRunMoment,
  plainFailureReason,
  previousScheduledRun,
  slotNamedInText,
  summarizeRun,
} from "../lib/automations/run-summary";

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
    last_run_at: null,
    last_result: null,
    next_run_at: null,
    run_count: 0,
    fail_count: 0,
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

// A later scheduler skip must not paint over unresolved failures. The live
// Maven row had exactly this shape: fail_count=2 plus a skipped-stale result.
const unresolvedMaven = normalizeEmpireRow(row({
  name: "Maven — Carousel Post",
  owner_agent_key: "maven",
  fail_count: 2,
  last_result: "skipped-stale: outside publish window",
}));
assert.equal(unresolvedMaven.last_run_status, "error");
assert.equal(unresolvedMaven.unresolved_failures, 2);
assert.equal(unresolvedMaven.last_run_output, null);
assert.match(String(unresolvedMaven.last_run_error), /2 unresolved failures/);
assert.match(String(unresolvedMaven.last_run_error), /skipped-stale/);
const recoveredMaven = normalizeEmpireRow(row({
  name: "Maven — Carousel Post",
  fail_count: 0,
  last_result: "published successfully",
}));
assert.equal(recoveredMaven.last_run_status, "success");
assert.equal(recoveredMaven.unresolved_failures, 0);

// ── A skipped slot is not a success and not a failure (2026-10-15) ─────────
// scripts/scheduler.py writes `skipped-stale: …` into last_result when the PC was
// off at the slot, and leaves last_run_at / run_count alone. The card used to
// read that as a green "Ran 1d ago" with the raw machine string underneath.
const skippedText =
  "skipped-stale: next_run_at was 369 min behind threshold (30 min) — PC was likely off when this slot expired";
const skippedVerdict = classifyLastResult(skippedText);
assert.equal(skippedVerdict.status, "skipped", "a skipped slot is its own verdict");
assert.equal(classifyLastResult("deferred: waiting on the mailbox").status, "skipped");
assert.equal(classifyLastResult("skipped: outside publish window").status, "skipped");
assert.equal(classifyLastResult("skipping nothing, all good").status, "success", "only a leading `skipped…:` / `deferred:` marker counts");
const skippedRow = normalizeEmpireRow(row({ last_result: skippedText, fail_count: 0 }));
assert.equal(skippedRow.last_run_status, "skipped");
assert.equal(skippedRow.last_run_output, skippedText, "the raw scheduler text stays, as evidence");
assert.match(String(skippedRow.last_run_note), /^Skipped: this was due about 6 h before the PC/, "the card gets a plain sentence");
assert.ok(!/skipped-stale|next_run_at|threshold/.test(String(skippedRow.last_run_note)), "no machine words in the sentence");
assert.equal(skippedRow.last_run_error, null, "a skip is not an error");
assert.equal(normalizeEmpireRow(row({ last_result: "ok" })).last_run_note, null, "only a skip carries a note");
assert.equal(explainSkippedResult("skipped-stale: PC was likely off"), "Skipped: the PC that runs this was off when it was due, so it waited for its next slot.");
assert.match(explainSkippedResult("skipped-stale: next_run_at was 2000 min behind threshold (30 min)"), /about 33 h before/, "lateness is humanized, never shown as raw minutes");
assert.match(explainSkippedResult("skipped-stale: next_run_at was 5000 min behind threshold (30 min)"), /about 3 days before/);
assert.match(explainSkippedResult("skipped-stale: next_run_at was 45 min behind threshold (30 min)"), /about 45 min before/);
assert.match(explainSkippedResult("deferred: x"), /^Deferred:/);
assert.match(explainSkippedResult("skipped: x"), /^Skipped this slot/);

// ── Every row says what happened, and when, in plain English (CC 2026-10-16) ──
// A frozen clock and a fixed zone: 15:00Z on Oct 15 is 11:00 AM in Toronto (EDT).
// Formats are the ones scripts/scheduler.py actually writes into last_result.
const NOW = Date.parse("2026-10-15T15:00:00Z");
const TZ = "America/Toronto";
const at = { now: NOW, timeZone: TZ };
const sum = (over: Partial<Record<string, unknown>>) => summarizeRun(normalizeEmpireRow(row(over)), at);
const RAW_WORDS = /skipped-stale|next_run_at|threshold|FAILED|DEFERRED|claude_quota|retry_after|\{|\}/;

// Which kind of non-run: each leaves the timestamps in a different state.
assert.equal(attemptKindOf(skippedText), "missed", "the scheduler's own boot-blast skip");
assert.equal(attemptKindOf("DEFERRED: claude_quota retry_after=420 no memory files changed"), "deferred");
assert.equal(attemptKindOf("deferred:1/3"), "deferred");
assert.equal(attemptKindOf("SKIPPED: bridge offline"), "skipped", "a skip the job wrote about itself");
assert.equal(attemptKindOf("ok"), null);
assert.equal(attemptKindOf("caught-up: missed 05:30 slot (PC off)"), null, "a catch-up is a real run");
assert.equal(attemptKindOf({ drained: 0 }), null);
assert.equal(normalizeEmpireRow(row({ last_result: skippedText })).last_attempt_kind, "missed");
assert.equal(normalizeEmpireRow(row({ last_result: "ok" })).last_attempt_kind, null);
assert.equal(normalizeEmpireRow(row({ last_result: "skipped-stale: x", fail_count: 2 })).last_attempt_kind, "missed", "set even when the counter keeps the verdict at error");
assert.equal(normalizeEmpireRow(row({ last_result: { errors: 3 } })).last_result_text, '{"errors":3}', "the stored text, verbatim, whatever the verdict");
assert.equal(normalizeEmpireRow(row({ last_result: null })).last_result_text, null);

// 1. A scheduler skip says WHEN: the slot the computer was off at, read off the
//    row's own schedule (next_run_at was advanced past it), in the viewer's zone.
const dailySkip = {
  schedule: "30 5 * * *",
  last_result: skippedText,
  last_run_at: "2026-10-14T09:31:00Z", // its last REAL run, 5:31 AM yesterday
  next_run_at: "2026-10-16T09:30:00Z", // tomorrow 5:30 AM: the skip moved it here
  fail_count: 0,
};
const missed = sum(dailySkip);
assert.equal(missed.result?.text, "Skipped: the computer was off at 5:30 AM, so it waited for its next slot.");
assert.equal(missed.result?.tone, "neutral");
// 2. "Last ran" and "Last attempt" are two lines when they differ.
assert.equal(missed.lastRan?.text, "Last ran 1d ago");
assert.equal(missed.lastRan?.tone, "neutral", "no success tick: the stored result is the skip, not that run's verdict");
assert.equal(missed.lastAttempt, "Last attempt: skipped at 5:30 AM");
// 3. Not red.
assert.equal(missed.failed, false);
// 4. The raw text is under Details, never the message.
assert.equal(missed.details, skippedText);
assert.equal(previousScheduledRun("30 5 * * *", "2026-10-16T09:30:00Z", TZ)?.toISOString(), "2026-10-15T09:30:00.000Z");
assert.equal(previousScheduledRun("0 * * * *", "2026-10-15T16:00:00Z", TZ)?.toISOString(), "2026-10-15T15:00:00.000Z");
assert.equal(
  sum({ ...dailySkip, schedule: "0 * * * *", next_run_at: "2026-10-15T16:00:00Z" }).result?.text,
  "Skipped: the computer was off at 11:00 AM, so it waited for its next slot.",
);
// No time rather than a wrong one: the scheduler reads cron in its own computer's
// zone, so in Paris next_run_at is not a 5:30 run and nothing is derived.
assert.equal(previousScheduledRun("30 5 * * *", "2026-10-16T09:30:00Z", "Europe/Paris"), null);
const elsewhere = summarizeRun(normalizeEmpireRow(row(dailySkip)), { now: NOW, timeZone: "Europe/Paris" });
assert.match(String(elsewhere.result?.text), /^Skipped: this was due about 6 h before/);
assert.equal(elsewhere.lastAttempt, "Last attempt: skipped");
assert.equal(previousScheduledRun("30 5 * * *", "2026-10-16T09:47:00Z", TZ), null, "a next_run_at off the schedule names no slot");
assert.equal(previousScheduledRun("not a cron", "2026-10-16T09:30:00Z", TZ), null);
// A slot the text names WITH its zone wins, with or without a next_run_at.
assert.equal(
  sum({ last_result: "skipped-stale: missed 2026-10-15T09:30:00Z slot (PC off)", next_run_at: null }).result?.text,
  "Skipped: the computer was off at 5:30 AM, so it waited for its next slot.",
);
// A bare wall clock carries no zone and no day: never shown as the viewer's time (Codex review 2026-10-16).
assert.equal(slotNamedInText("skipped-stale: missed 05:30 slot (PC off)", at), null);
assert.equal(
  sum({ last_result: "skipped-stale: missed 05:30 slot (PC off)", next_run_at: null }).result?.text,
  "Skipped: the PC that runs this was off when it was due, so it waited for its next slot.",
);
assert.equal(slotNamedInText("skipped: waiting until 09:00", at), null, "only a time after 'missed' is the slot");

// 3. A skip after real failures: the health verdict stays "error" for /health
//    (pinned above and in system-health-loader), but the card is not red. The
//    failure is told where it belongs, on the real run, plus the count badge.
const missedAfterFailures = sum({ ...dailySkip, fail_count: 2 });
assert.equal(normalizeEmpireRow(row({ ...dailySkip, fail_count: 2 })).last_run_status, "error");
assert.equal(missedAfterFailures.failed, false, "a skip never paints the card red");
assert.equal(missedAfterFailures.lastRan?.text, "Last ran 1d ago and failed");
assert.equal(missedAfterFailures.lastRan?.tone, "bad");
assert.equal(missedAfterFailures.result?.tone, "neutral");
// The Morning Brief shape from /health: a skip the job wrote, counter at 2.
const heldBriefing = sum({
  last_result: "SKIPPED: bridge offline",
  fail_count: 2,
  last_run_at: "2026-10-15T12:00:00Z",
});
assert.equal(heldBriefing.failed, false);
assert.equal(heldBriefing.result?.text, "Skipped at 8:00 AM; it runs again at its next scheduled time.");
assert.equal(heldBriefing.lastAttempt, "Last attempt 3h ago: skipped");
assert.equal(heldBriefing.lastRan, null, "the job stamped last_run_at at the skip, so the real run before it is unknown");

// Deferred: the attempt's own time (the scheduler stamps last_run_at for it).
const deferred = sum({
  last_result: "DEFERRED: claude_quota retry_after=420 no memory files changed",
  last_run_at: "2026-10-15T12:00:00Z",
});
assert.equal(deferred.result?.text, "Deferred at 8:00 AM: the AI usage limit was reached, so it tries again on its own.");
assert.equal(deferred.lastAttempt, "Last attempt 3h ago: held back");
assert.equal(deferred.lastRan, null);
assert.equal(deferred.failed, false);
assert.equal(
  sum({ last_result: "deferred:1/3", last_run_at: "2026-10-14T12:00:00Z" }).result?.text,
  "Deferred at 8:00 AM yesterday: held back until something it waits on is ready.",
);

// 4. Real runs: one plain line each, the stored text kept under Details.
const fine = sum({ last_result: { drained: 0 }, last_run_at: "2026-10-15T12:00:00Z" });
assert.equal(fine.result?.text, "Ran fine at 8:00 AM.");
assert.equal(fine.result?.tone, "ok");
assert.equal(fine.details, '{"drained":0}');
assert.equal(fine.lastRan?.text, "Last ran 3h ago", "one line when the last attempt WAS the last run");
assert.equal(fine.lastAttempt, null);
assert.equal(fine.failed, false);

const timedOut = "FAILED (timeout after 120s): [full: daily_brief_20261015.txt] partial output";
const failed = sum({ last_result: timedOut, fail_count: 1, last_run_at: "2026-10-15T12:00:00Z" });
assert.equal(failed.result?.text, "Failed at 8:00 AM: it took too long and was stopped.");
assert.equal(failed.result?.tone, "bad");
assert.equal(failed.failed, true, "a real failure is still red");
assert.equal(failed.details, timedOut, "Details holds the stored text itself, not the counter wrapper");

const shapeFail = sum({ last_result: { errors: 3, sent: 0 }, last_run_at: "2026-10-15T12:00:00Z" });
assert.equal(shapeFail.result?.text, "Failed at 8:00 AM: it reported 3 problems.");
assert.equal(shapeFail.details, '{"errors":3,"sent":0}');
assert.equal(
  sum({ last_result: "FAILED (exit 1): [full: x.txt] Traceback (most recent call last)", last_run_at: "2026-10-15T12:00:00Z" }).result?.text,
  "Failed at 8:00 AM: the script stopped with an error.",
);
assert.equal(plainFailureReason("boom"), null, "no reason the text does not state");

const unclear = sum({ last_result: "}", last_run_at: "2026-10-15T12:00:00Z" });
assert.equal(unclear.result?.text, "Result unclear: it ran at 8:00 AM, but what it saved does not say whether it worked.");
assert.equal(unclear.result?.tone, "unclear");
assert.equal(unclear.details, "}");

const counterOnly = sum({ last_result: { drained: 0 }, fail_count: 2, last_run_at: "2026-10-15T12:00:00Z" });
assert.equal(counterOnly.result?.text, "Ran at 8:00 AM, but 2 earlier failures have not been cleared by a good run.");
assert.equal(counterOnly.failed, true);

assert.equal(
  sum({ last_result: "caught-up: missed 2026-10-15T09:30:00Z slot (PC off)", last_run_at: "2026-10-15T15:39:00Z" }).result?.text,
  "Ran fine at 11:39 AM, catching up on the 5:30 AM run the computer missed.",
);
assert.equal(
  sum({ last_result: "caught-up: missed 05:30 slot (PC off)", last_run_at: "2026-10-15T15:39:00Z" }).result?.text,
  "Ran fine at 11:39 AM, catching up on a run the computer missed.",
  "a catch-up with only a bare clock still says it was a catch-up, without a time it cannot vouch for",
);

const neverRan = sum({ last_result: null, last_run_at: null });
assert.equal(neverRan.result, null);
assert.equal(neverRan.lastRan, null);
assert.equal(neverRan.lastAttempt, null);

// Tenant rows (the bridge's own columns, no verbatim field) get the same lines.
const tenantJob = (over: Record<string, unknown>) => summarizeRun({
  schedule: "0 8 * * *",
  last_run_at: "2026-10-15T12:00:00Z",
  last_run_status: "success",
  last_run_output: null,
  last_run_error: null,
  ...over,
} as never, at);
assert.equal(tenantJob({ last_run_output: "published 2" }).result?.text, "Ran fine at 8:00 AM.");
assert.equal(tenantJob({ last_run_output: "published 2" }).details, "published 2");
assert.equal(tenantJob({ last_run_status: "error", last_run_error: "boom" }).result?.text, "Failed at 8:00 AM.");
assert.equal(tenantJob({ last_run_status: "error", last_run_error: "boom" }).details, "boom");

// None of the sentences is the stored text.
for (const s of [missed, missedAfterFailures, heldBriefing, deferred, fine, failed, shapeFail, unclear, counterOnly]) {
  assert.doesNotMatch(String(s.result?.text), RAW_WORDS, `raw words in: ${s.result?.text}`);
}

// Times read the way a sentence carries them, in the viewer's zone.
assert.equal(formatRunMoment("2026-10-15T12:00:00Z", at), "8:00 AM");
assert.equal(formatRunMoment("2026-10-14T12:00:00Z", at), "8:00 AM yesterday");
assert.equal(formatRunMoment("2026-10-12T12:00:00Z", at), "8:00 AM on Oct 12");
assert.equal(formatRunMoment("2026-10-15T12:00:00Z", { now: NOW, timeZone: "Europe/Paris" }), "2:00 PM");

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
  "Carousel Media Retention",
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

// Durable ownership wins. Inference remains only for rows written before the
// owner column was installed.
assert.equal(
  normalizeEmpireRow(row({ name: "Inbound Email Sweep", owner_agent_key: "maven" })).agent_key,
  "maven",
);
assert.equal(
  normalizeEmpireRow(row({ name: "Marketing Publish Drain", owner_agent_key: null })).agent_key,
  "maven",
);

// The card promises the scheduler's next fire, so normalization must not drop it.
assert.equal(
  normalizeEmpireRow(row({ next_run_at: "2026-09-17T12:00:00Z" })).next_run_at,
  "2026-09-17T12:00:00Z",
);

// run_count arrives as INTEGER; a missing one must read 0, never NaN.
assert.equal(normalizeEmpireRow(row({ run_count: null })).run_count, 0);
assert.equal(normalizeEmpireRow(row({ run_count: 42 })).run_count, 42);

// SQLite keeps tenant_cron_jobs.enabled as INTEGER; both read and mutation
// responses must honor the UI's boolean contract.
assert.equal(normalizeTenantCronRow({ id: "tenant-on", enabled: 1 }).enabled, true);
assert.equal(normalizeTenantCronRow({ id: "tenant-off", enabled: 0 }).enabled, false);
assert.equal(normalizeTenantCronRow({ id: "tenant", enabled: "1" }).source, "tenant");
assert.equal(
  normalizeTenantCronRow({ enabled: 1, last_run_output: { published: 2 } }).last_run_output,
  '{"published":2}',
);
assert.equal(
  normalizeTenantCronRow({ enabled: 1, last_run_error: ["failed"] }).last_run_error,
  '["failed"]',
);

console.log("cron-empire-row ok — JSON-valued last_result no longer crashes the board");
