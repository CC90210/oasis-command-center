import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { GOOGLE_CALENDAR_SCOPE, GOOGLE_CALENDAR_SERVICE } from "../lib/integrations/google-calendar";
import {
  describeCalendarSync,
  NEXT_ACTION_EVENT_ID_FIELD,
  type CalendarSyncStatus,
} from "../lib/web-leads/calendar-sync";

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
//
// WHAT THIS FILE CANNOT DO, STATED UP FRONT: none of it exercises the HTTP
// call. It proves the SHAPE of a request; only Google can say whether that
// request is accepted. FIVE consecutive review rounds found five defects in
// this integration, every one of them invisible to a green run of this suite.
// A live connect test on a staging account is owed before any rep relies on a
// phone reminder, and nothing below should be read as a substitute for it.
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. GOOGLE NAMES THE EVENT; WE REMEMBER THE NAME.
//
// This is the fifth design, and the four before it failed the same way. Each
// derived a DETERMINISTIC event id from the lead so nothing had to be stored,
// and each broke because once an event with a caller-supplied id is deleted or
// cancelled, that id is ambiguous forever after: it may name a live event, a
// retained tombstone with deletion semantics, or nothing at all, and Google's
// 409/410/404 answers across those combinations cannot be verified from this
// repo. The chain, for anyone tempted to go back:
//
//   PUT-only                   404 on every first push, feature never worked
//   insert-then-update         410 against a cancelled tombstone
//   fall back to fresh insert  produced an event nothing could address again
//   reinsert with same id      409 against a tombstone still holding it
//   revive via "confirmed"     cancelled single events may not be revivable
//
// Storing the id Google hands back removes the question instead of guessing at
// another arm of it: an id is never reused after its event is removed.
// ---------------------------------------------------------------------------
const calendarSrc = read("lib/integrations/google-calendar.ts");
const calendar = stripComments(calendarSrc);

assert.doesNotMatch(
  calendar,
  /encodeEventId/,
  "deterministic event ids must stay retired -- reusing an id after removal is what produced five consecutive defects",
);
assert.doesNotMatch(
  calendar,
  /idempotencyKey/,
  "a caller-supplied event id must not come back; Google assigns the id and we store it",
);
assert.equal(
  NEXT_ACTION_EVENT_ID_FIELD,
  "next_action_event_id",
  "the stored id needs a stable field name -- renaming it silently orphans every existing reminder",
);

// The write takes the id we stored and hands back the id to store next.
const writeBody = calendarSrc.slice(calendarSrc.indexOf("export async function writeReminderEvent"));
assert.match(writeBody, /existingEventId/, "the write must accept the id we stored last time");
assert.match(writeBody, /eventId: created\.body\.id/, "a fresh insert must return the id Google assigned");
// A 404/410 on the update means that event is gone (the rep deleted it by hand,
// or we removed it). Making a NEW one is correct; reusing the old id is not.
assert.match(
  writeBody,
  /updated\.status !== 404 && updated\.status !== 410/,
  "only a gone event may fall through to a fresh insert -- any other failure must be reported, not papered over with a duplicate",
);
// The fresh insert must carry no id at all, so no tombstone question arises.
assert.match(
  writeBody,
  /await send\(collection, "POST"\)/,
  "the recreate must let Google name the event rather than reusing an id whose state we cannot determine",
);

// Removal is addressed by the STORED id, never a derived one.
const removeBody = calendarSrc.slice(calendarSrc.indexOf("export async function removeReminderEvent"));
assert.match(removeBody, /eventId: string \| null/, "removal must take the stored id");
assert.match(
  removeBody,
  /if \(!eventId\) return \{ ok: true \}/,
  "being asked to remove a reminder that never existed is success, not a failure",
);
assert.match(
  removeBody,
  /r\.status === 404 \|\| r\.status === 410/,
  "an already-absent event satisfies 'no reminder' and must count as success",
);

// ---------------------------------------------------------------------------
// 2. WHAT THE REP IS TOLD. Success is silent -- a notice on every successful
// call would train reps to ignore notices, which is exactly when the real one
// arrives. Only the two states where the phone will NOT ring say anything, and
// neither claims the callback was lost, because it was not.
// ---------------------------------------------------------------------------
const silent: CalendarSyncStatus[] = [
  { state: "synced", eventId: "e1", htmlLink: null },
  { state: "cleared" },
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
// been logged.
// ---------------------------------------------------------------------------
const outcome = read("lib/web-leads/outcome.ts");
const logFn = outcome.slice(outcome.indexOf("export async function logCallOutcome"));
const insertAt = logFn.indexOf('.from("leadgen_call_outcomes")');
const patchAt = logFn.indexOf("updateRecord({");
const pushAt = logFn.indexOf("pushNextActionToCalendar(");
assert.ok(insertAt > -1 && patchAt > -1 && pushAt > -1, "logCallOutcome must log, patch, and push");
assert.ok(insertAt < patchAt, "the history row must be written before the lead patch");
assert.ok(
  patchAt < pushAt,
  "the calendar push must come AFTER the lead write -- the queue is the source of truth and the calendar is a mirror",
);

// The push must not be able to fail the call.
assert.doesNotMatch(
  logFn.slice(pushAt - 400, pushAt),
  /throw new ScheduleNotAppliedError/,
  "a calendar failure must never be raised as a queue failure",
);

// The id write-back is bookkeeping and must not surface as a call failure
// either: the call is logged, the queue is right, the reminder is on the phone.
assert.match(
  logFn.slice(pushAt),
  /try \{[\s\S]{0,500}?updateRecord\(\{[\s\S]{0,400}?\}\);[\s\S]{0,200}?\} catch/,
  "persisting the event id must be wrapped so a bookkeeping failure cannot fail a logged call",
);
assert.match(
  logFn,
  /\[NEXT_ACTION_EVENT_ID_FIELD\]: newEventId/,
  "the id Google assigned must be written back to the lead, or the next push creates a duplicate",
);
// Only when it changed. An unconditional write would touch every lead on every
// call for no reason.
assert.match(logFn, /newEventId !== existingEventId/, "the id must be persisted only when it actually changed");

// ---------------------------------------------------------------------------
// 4. THE CALENDAR MODULE NEVER THROWS ITS OWN FAILURES.
//
// Every exported function returns a discriminated result. A throw here would
// propagate into logCallOutcome and take a successfully logged call down with
// it.
// ---------------------------------------------------------------------------
assert.doesNotMatch(calendar, /\bthrow\b/, "lib/integrations/google-calendar.ts must never throw -- it returns results");
const catches = calendar.match(/catch\s*\([^)]*\)\s*\{[\s\S]{0,220}?\}/g) || [];
assert.ok(catches.length >= 3, `expected a catch around each network call, saw ${catches.length}`);
for (const c of catches) {
  assert.match(c, /return\s*\{/, "every catch must return a failure result, never swallow or rethrow");
}

// "not connected" must stay distinguishable from "broken". One is a person's
// job to do and must never be retried in a loop; the other is a real fault.
assert.match(calendar, /reason:\s*"not_connected"/, "a missing connection must have its own reason code");
assert.match(calendar, /reason:\s*"token_refresh_failed"/, "a revoked grant must be distinguishable from never-connected");

// ---------------------------------------------------------------------------
// 5. SCOPE MINIMALISM. The consent screen a rep reads must be small and true.
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
// requested, and a bundle whose scope does not authorize the feature produces a
// connection that looks healthy in Settings and fails on first use.
const cb = read("app/api/auth/google-oauth/callback/route.ts");
assert.match(cb, /calendar:\s*"google_calendar"/, "the callback must map the calendar target");
assert.match(cb, /calendar_scope_not_granted/, "the callback must refuse a calendar grant that lacks the events scope");

// ---------------------------------------------------------------------------
// 6. NO NEXT ACTION MEANS NO REMINDER, FOR EVERY DISPOSITION.
//
// REGRESSION (Codex review, 2026-08-24). This branch used to remove the event
// only for TERMINAL dispositions and merely skip otherwise. But
// callDispositionPatch clears `next_action_at` for ANY disposition logged
// without one, so a lead with a callback already on the rep's phone, later
// logged `connected` or `interested` with no follow-up, kept ringing for a call
// the queue no longer had. The original assertion passed the whole time,
// because it only ever examined the terminal branch.
//
// The rule is now simply: the phone matches the queue.
// ---------------------------------------------------------------------------
const sync = stripComments(read("lib/web-leads/calendar-sync.ts"));
assert.match(sync, /removeReminderEvent/, "clearing a next action must remove the reminder, not merely skip the push");
const guardStart = sync.indexOf("if (!input.nextActionAt) {");
assert.ok(guardStart > -1, "calendar-sync must branch on a bare !input.nextActionAt");
const guard = sync.slice(guardStart, guardStart + 900);
assert.match(
  guard,
  /removeReminderEvent/,
  "the no-next-action branch must clear the reminder for EVERY disposition, not only terminal ones",
);
assert.doesNotMatch(
  sync,
  /if\s*\(\s*isTerminalDisposition\(input\.disposition\)\s*\)\s*\{[\s\S]{0,200}?removeReminderEvent/,
  "clearing must not be gated on the disposition being terminal -- that is the bug this replaced",
);
assert.doesNotMatch(sync, /state:\s*"skipped"/, "no push may end without either writing or clearing the reminder");

// A FAILED removal must KEEP the stored id. Dropping it would orphan a
// reminder nothing could ever clear again -- the same unaddressable-event
// failure round three produced, arriving through a different door.
assert.match(
  guard,
  /eventId: input\.existingEventId/,
  "a failed removal must retain the stored id so the reminder stays clearable",
);

console.log("web-leads-calendar-sync ok");
