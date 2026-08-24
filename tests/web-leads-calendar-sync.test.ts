import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { encodeEventId, GOOGLE_CALENDAR_SCOPE, GOOGLE_CALENDAR_SERVICE } from "../lib/integrations/google-calendar";
import { describeCalendarSync, nextActionEventKey, type CalendarSyncStatus } from "../lib/web-leads/calendar-sync";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ===========================================================================
// Callbacks on the rep's phone (operator decision, Adon 2026-08-23):
// "I just want everyone to be able to have it on their phone so I can send
// them calls."
//
// The rule this whole file defends: the QUEUE is the source of truth and the
// calendar is a MIRROR. A calendar problem must degrade the feature to "it is
// in your queue but not on your phone" and must never lose a callback, fail a
// logged call, or -- worst of all -- be reported as a success it was not.
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. EVENT IDS. Google accepts base32hex only (0-9 and a-v), 5 to 1024 chars.
// A raw UUID contains w/x/y/z and hyphens and is rejected with a 400 that reads
// like a caller bug. Determinism is the load-bearing property: the same lead
// must always map to the same id, because that is what turns a re-push into an
// UPDATE instead of a second reminder on the rep's phone.
// ---------------------------------------------------------------------------
const LEGAL = /^[0-9a-v]+$/;
for (const raw of [
  "weblead-next-3f9a1c22-77bd-4e11-9c02-8a1d5f6e7b30",
  "weblead-next-simple",
  "UPPER-CASE-AND-Symbols!@#$%^&*()",
  "unicode-café-über",
  "x",
]) {
  const id = encodeEventId(raw);
  assert.match(id, LEGAL, `encodeEventId(${raw}) must produce only Google-legal characters, got "${id}"`);
  assert.ok(id.length >= 5, `event id must be at least 5 chars, got ${id.length} for "${raw}"`);
  assert.ok(id.length <= 1024, `event id must be at most 1024 chars, got ${id.length}`);
  assert.equal(encodeEventId(raw), id, "encodeEventId must be deterministic -- a re-push must UPDATE, never duplicate");
}

// Different inputs must not collide, or two leads would fight over one event.
const ids = new Set(["a", "b", "aa", "ab", "lead-1", "lead-2"].map(encodeEventId));
assert.equal(ids.size, 6, "distinct keys must produce distinct event ids");

// The key is derived from the LEAD, not the call: one lead has at most one
// outstanding "call them" reminder, so rescheduling replaces rather than adds.
assert.equal(nextActionEventKey("abc"), nextActionEventKey("abc"), "the event key must be stable for a lead");
assert.notEqual(nextActionEventKey("abc"), nextActionEventKey("abd"), "different leads must get different keys");

// ---------------------------------------------------------------------------
// 2. WHAT THE REP IS TOLD. Success is silent -- a notice on every successful
// call would train reps to ignore notices, which is exactly when the real one
// arrives. Only the two states where the phone will NOT ring say anything, and
// neither claims the callback was lost, because it was not.
// ---------------------------------------------------------------------------
const silent: CalendarSyncStatus[] = [
  { state: "synced", eventId: "e1", htmlLink: null },
  { state: "cleared" },
  { state: "skipped", reason: "no_next_action" },
];
for (const s of silent) {
  assert.equal(describeCalendarSync(s), null, `${s.state} must not interrupt the rep with a notice`);
}

for (const s of [{ state: "not_connected" }, { state: "failed", reason: "api_error" }] as CalendarSyncStatus[]) {
  const msg = describeCalendarSync(s);
  assert.ok(msg, `${s.state} must tell the rep something`);
  // It must confirm the save FIRST. A rep who reads "did not reach your
  // calendar" without "saved to your queue" will log the call again.
  assert.match(msg!, /saved to your queue/i, `${s.state} must confirm the callback IS saved before naming what failed`);
  assert.doesNotMatch(msg!, /error|failed to save|not saved|lost/i, `${s.state} must not read as a lost callback`);
}

// not_connected must be an INVITATION, not an alarm. It is the normal state of
// every rep who has not opened Settings yet, and treating a person's pending
// action as a fault is how alert fatigue starts.
assert.match(
  describeCalendarSync({ state: "not_connected" })!,
  /connect google calendar/i,
  "not_connected must tell the rep exactly what to do",
);

// ---------------------------------------------------------------------------
// 3. THE ORDERING RULE, ENFORCED AT THE SOURCE.
//
// history insert -> lead patch -> calendar push. If the push ever moved ahead
// of the lead write, a calendar failure could abort a call that should have
// been logged. This reads lib/web-leads/outcome.ts and requires the push to
// appear AFTER the updateRecord call in logCallOutcome.
// ---------------------------------------------------------------------------
const outcome = read("lib/web-leads/outcome.ts");
const logFn = outcome.slice(outcome.indexOf("export async function logCallOutcome"));
const insertAt = logFn.indexOf('.from("leadgen_call_outcomes")');
const patchAt = logFn.indexOf("updateRecord({");
const pushAt = logFn.indexOf("pushNextActionToCalendar(");
assert.ok(insertAt > -1, "logCallOutcome must insert the history row");
assert.ok(patchAt > -1, "logCallOutcome must patch the lead");
assert.ok(pushAt > -1, "logCallOutcome must push to the calendar");
assert.ok(insertAt < patchAt, "the history row must be written before the lead patch");
assert.ok(
  patchAt < pushAt,
  "the calendar push must come AFTER the lead write -- the queue is the source of truth and the calendar is a mirror",
);

// The push must not be able to fail the call. If it were awaited inside the
// same try/catch that raises ScheduleNotAppliedError, a Google outage would be
// reported to the rep as a failed queue write.
const pushSlice = logFn.slice(pushAt - 400, pushAt);
assert.doesNotMatch(
  pushSlice,
  /throw new ScheduleNotAppliedError/,
  "a calendar failure must never be raised as a queue failure",
);

// ---------------------------------------------------------------------------
// 4. THE CALENDAR MODULE NEVER THROWS ITS OWN FAILURES.
//
// Every exported function returns a discriminated result. A throw here would
// propagate into logCallOutcome and take a successfully logged call down with
// it. Asserted structurally: every fetch in the module is inside a try, and the
// catch returns rather than rethrows.
// ---------------------------------------------------------------------------
const calendar = stripComments(read("lib/integrations/google-calendar.ts"));
assert.doesNotMatch(calendar, /\bthrow\b/, "lib/integrations/google-calendar.ts must never throw -- it returns results");
const catches = calendar.match(/catch\s*\([^)]*\)\s*\{[\s\S]{0,220}?\}/g) || [];
assert.ok(catches.length >= 3, `expected a catch around each network call, saw ${catches.length}`);
for (const c of catches) {
  assert.match(c, /return\s*\{/, "every catch must return a failure result, never swallow or rethrow");
}

// "not connected" must stay distinguishable from "broken". One is a person's
// job to do and must never be retried in a loop; the other is a real fault.
// Collapsing them is how a missing credential turns into a 3am alert storm.
assert.match(calendar, /reason:\s*"not_connected"/, "a missing connection must have its own reason code");
assert.match(calendar, /reason:\s*"token_refresh_failed"/, "a revoked grant must be distinguishable from never-connected");

// ---------------------------------------------------------------------------
// 5. SCOPE MINIMALISM. The consent screen a rep reads must be small and true.
// calendar.events can create and update events and nothing else. Asking for a
// Gmail scope here would mean a rep who wants callbacks on their phone has to
// hand over their inbox.
// ---------------------------------------------------------------------------
assert.equal(GOOGLE_CALENDAR_SCOPE, "https://www.googleapis.com/auth/calendar.events", "calendar must request events scope only");
assert.equal(GOOGLE_CALENDAR_SERVICE, "google_calendar", "the calendar bundle must have its own service key, revocable alone");
assert.doesNotMatch(calendar, /gmail\./, "the calendar client must not reference any Gmail scope");

const start = read("app/api/auth/google-oauth/start/route.ts");
assert.match(start, /calendar:\s*"google_calendar"/, "the connect flow must offer a calendar target");
const calendarScopes = start.match(/calendar:\s*\[[^\]]*\]/);
assert.ok(calendarScopes, "the calendar target must declare its own scope list");
assert.doesNotMatch(calendarScopes![0], /gmail/, "the calendar target must not request any Gmail scope");

// The callback must VERIFY the grant. Google can return a subset of what was
// requested, and storing a bundle whose scope does not authorize the feature
// produces a connection that looks healthy in Settings and fails on first use.
const cb = read("app/api/auth/google-oauth/callback/route.ts");
assert.match(cb, /calendar:\s*"google_calendar"/, "the callback must map the calendar target");
assert.match(cb, /calendar_scope_not_granted/, "the callback must refuse a calendar grant that lacks the events scope");

// ---------------------------------------------------------------------------
// 6. A TERMINAL DISPOSITION REMOVES THE REMINDER.
//
// The sharpest rule here. A prospect who said "never call me again" must not
// have a reminder waiting on a rep's phone, and clearing the queue field alone
// would leave the phone alert in place -- the mirror outliving what it mirrors.
// ---------------------------------------------------------------------------
const sync = stripComments(read("lib/web-leads/calendar-sync.ts"));
assert.match(sync, /isTerminalDisposition/, "calendar-sync must branch on terminal dispositions");
assert.match(sync, /deleteCalendarEvent/, "a terminal disposition must DELETE the reminder, not merely skip the push");
const terminalBranch = sync.slice(sync.indexOf("isTerminalDisposition(input.disposition)"));
assert.ok(
  terminalBranch.indexOf("deleteCalendarEvent") < terminalBranch.indexOf("upsertCalendarEvent"),
  "the terminal branch must reach the delete before any upsert path",
);

// An already-absent event is SUCCESS: the desired end state is "no reminder".
// Treating a 404 as a failure would make an ordinary retry look broken.
assert.match(
  read("lib/integrations/google-calendar.ts"),
  /r\.status === 404 \|\| r\.status === 410/,
  "deleting an already-absent event must count as success",
);

console.log("web-leads-calendar-sync ok");
