/**
 * "Connected" must be able to record what was said and when to call back.
 *
 * WHY THIS EXISTS
 * The rep's outcome panel offers four choices. No answer and Voicemail left
 * each reveal a required next-follow-up date; Close as lost reveals a required
 * loss reason. Connected revealed NOTHING and its readiness gate was a
 * hardcoded `true`, so the single most informative call a rep makes was the one
 * the software refused to learn anything from.
 *
 * The operator's case, verbatim in substance: "connected also could be like we
 * connected but they told us to call back later." There was nowhere to put
 * either half of that.
 *
 * Two defects sat behind the missing fields:
 *
 *   1. Connected ERASED an existing callback. dispositionPatch always emitted
 *      next_action_at, the record store merges shallowly, so recording a
 *      connection blanked a follow-up the rep had already scheduled. A lead
 *      with a promise and a lead with none then render identically.
 *   2. The client hardcoded `undefined` for the date on Connected even though
 *      the SERVER had always accepted one. Half the feature existed and was
 *      unreachable.
 *
 * Connected is the only outcome whose date is OPTIONAL, which is what makes it
 * the only one that must not blank the field.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dispositionPatch, mayRecordDisposition } from "@/lib/website-sales-workflow";

const NOW = "2026-09-03T16:00:00.000Z";
const LATER = "2026-09-10T12:00:00.000Z";
const has = (patch: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(patch, key);

// ── 1. Connected must not blank a callback it was not given ────────────────

const bare = dispositionPatch("connected", null, NOW);
assert.equal(
  has(bare, "next_action_at"),
  false,
  "Connected with no date must OMIT next_action_at — emitting null erases a callback the rep already scheduled",
);

const scheduled = dispositionPatch("connected", LATER, NOW);
assert.equal(
  scheduled.next_action_at,
  LATER,
  "Connected WITH a date must persist it — the server always accepted this and only the client withheld it",
);

// ── 2. the other three outcomes are untouched ──────────────────────────────

assert.equal(
  dispositionPatch("attempted", LATER, NOW).next_action_at,
  LATER,
  "No answer still schedules",
);
assert.equal(
  dispositionPatch("voicemail", LATER, NOW).next_action_at,
  LATER,
  "Voicemail still schedules",
);

const lost = dispositionPatch("lost", null, NOW, "went with a competitor");
assert.equal(
  has(lost, "next_action_at"),
  true,
  "lost must still CLEAR the follow-up — a closed lead has no next action",
);
assert.equal(lost.next_action_at, null);
assert.equal(lost.loss_reason, "went with a competitor");

for (const disposition of ["attempted", "voicemail"] as const) {
  assert.throws(
    () => dispositionPatch(disposition, null, NOW),
    /next_action_required/,
    `${disposition} must still REQUIRE a date — optional is Connected's rule alone`,
  );
}

assert.throws(
  () => dispositionPatch("connected", "2020-01-01T00:00:00.000Z", NOW),
  /next_action_must_be_in_future/,
  "a callback in the past is still refused on Connected",
);

// ── 3. the client actually sends both, and cannot half-send a callback ─────

const lifecycle = readFileSync("app/pipeline/[id]/LeadLifecycleActions.tsx", "utf8");

assert.match(
  lifecycle,
  /callOutcome === "connected"\s*\?\s*connectedFollowUpAt \|\| undefined/,
  "the client must send the callback on Connected; it used to hardcode undefined",
);
assert.match(
  lifecycle,
  /note: callOutcome === "connected" && connectedNote \? connectedNote : undefined/,
  "the note must be sent — the route has always parsed body.note for every action",
);
assert.match(
  lifecycle,
  /callOutcome === "connected" \? \(/,
  "Connected must reveal its own fields, like the other three outcomes do",
);

// A date without a time produces no ISO at all, so a rep who picks "Thursday"
// and no time would sail through Save having recorded nothing. Blank is fine;
// half is not, and the button must say so rather than the save lying.
assert.match(
  lifecycle,
  /connectedFollowUpPartial\s*=\s*\n?\s*Boolean\(connectedFollowUpDate\) !== Boolean\(connectedFollowUpTime\)/,
  "a half-filled callback must block Save",
);
assert.match(
  lifecycle,
  /callOutcome === "connected"\s*\?\s*!connectedFollowUpPartial/,
  "the readiness gate must consult it — it used to be a hardcoded true",
);

// Its own state pair, NOT the shared nextActionDate: that one is pre-filled
// with today, so on a shared field "no callback wanted" and "left the default"
// are the same value.
assert.match(
  lifecycle,
  /const \[connectedFollowUpDate, setConnectedFollowUpDate\] = useState\(""\)/,
  "Connected's date must start EMPTY so 'no callback' is representable",
);

// ── 4. a call note must not overwrite the founder handoff note ─────────────

const route = readFileSync("app/api/website-sales/[leadId]/route.ts", "utf8");
assert.match(
  route,
  /if \(transitionNote && body\.action !== "disposition"\) \{/,
  'a disposition\'s note belongs in the interaction ledger; last_handoff_note is single-valued, renders under the label "Founder handoff note", and pre-fills the handoff composer',
);
assert.match(
  route,
  /transitionNote \? `Note: \$\{transitionNote\}` : ""/,
  "the note must still reach the interaction row, which is where the rep reads it back",
);

// ── 5. the trap this does NOT fix, pinned so it cannot be forgotten ────────
//
// Once a lead is at stage `connected` the outcome panel is gone
// (showCallOutcomes covers assigned + attempting_contact only) AND the server
// refuses attempted/voicemail from there. So the callback this feature now
// schedules cannot itself be dispositioned when it happens. Fixing that means
// either moving a connected lead BACKWARD to attempting_contact or adding a
// log-without-stage-change path — a product decision, not a mechanical one.
// This assertion is here so the next person meets it deliberately.
assert.equal(mayRecordDisposition("connected", "attempted"), false);
assert.equal(mayRecordDisposition("connected", "voicemail"), false);
assert.equal(mayRecordDisposition("connected", "connected"), true);
assert.equal(mayRecordDisposition("connected", "lost"), true);
assert.match(
  lifecycle,
  /const showCallOutcomes = currentStage === "assigned" \|\| currentStage === "attempting_contact";/,
  "if this widens to include `connected`, revisit mayRecordDisposition with it",
);

console.log("connected-outcome: OK");
