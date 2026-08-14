/**
 * tests/ai-wire.test.ts — the AI Follow-Up wire routes Live Subs, and only
 * Live Subs.
 *
 * Adon, 2026-08-14: "There should be a sub-account called AI Follow-Up Account.
 * That's gonna be the sub-account that we use for the Live Subs follow-ups."
 *
 * WHY THE SCOPE IS THE THING UNDER TEST. On 2026-08-13 he was emphatic in the
 * other direction: "there are three separate wires for three separate
 * TextTorrent accounts... we need to have each of them using their own numbers
 * not all of them using one number. That defeats the entire purpose." So a bug
 * that widens this wire past Live Subs does not look like a bug — it looks like
 * texts going out, from a working number, with replies landing in an inbox the
 * rep cannot see. Exactly the failure the three-wire rule exists to prevent.
 */

import assert from "node:assert/strict";
import {
  usesAiWire, aiWireStages, aiWireNumbers,
  AI_WIRE_ACT_AS, AI_WIRE_REP_KEY, AI_WIRE_SERVICE,
} from "../lib/drips/ai-wire-core";
import { repKeyForOwner, actAsEmailForRep } from "../lib/drips/rep-keys";

const NO_ENV: Record<string, string | undefined> = {};

// ── Live Subs go on the wire; nothing else does ───────────────────────────
for (const stage of ["uw_sheet", "live_sub", "live_subs", "UW_Sheet"]) {
  assert.equal(usesAiWire({ stage }, NO_ENV), true, `${stage} is Live Subs`);
}
for (const stage of ["follow_up", "signed_application", "declined", "viewed_application", "funded", ""]) {
  assert.equal(usesAiWire({ stage }, NO_ENV), false, `${stage} must stay on its rep's wire`);
}
assert.equal(usesAiWire({}, NO_ENV), false, "a lead with no stage is not a Live Sub");

// ── The identity halves must travel together ──────────────────────────────
// The act-as is a sub-account of the LEGACY parent. Sent against the main
// SunBiz SID it 401s (verified live 2026-08-14), so a change that keeps one
// half and drops the other silently kills every Live Sub text.
assert.equal(AI_WIRE_ACT_AS, "submissions@sunbizfunding.com");
assert.equal(AI_WIRE_SERVICE, "texttorrent_followup", "must authenticate against the Legacy parent");
assert.equal(actAsEmailForRep(AI_WIRE_REP_KEY), AI_WIRE_ACT_AS, "rep-keys and the wire must agree");

// ── The sync must not file AI numbers under admin ─────────────────────────
// TextTorrent reports them as purchased_by "AI Follow-Up". Falling through to
// admin would put them in Matt's pool, and Matt's leads would then be texted
// from the Legacy account under an act-as the main SID does not know: 401 on
// every send, from a pool that reads perfectly healthy.
for (const owner of ["AI Follow-Up", "ai follow-up", "AI FOLLOW-UP", "AIFollowUp"]) {
  assert.equal(repKeyForOwner(owner), AI_WIRE_REP_KEY, `"${owner}" must map to the AI wire`);
}
// And it must not steal anyone else's numbers.
assert.equal(repKeyForOwner("Legacy Funding"), "admin");
assert.equal(repKeyForOwner("Alex Johnson"), "alex");
assert.equal(repKeyForOwner("Jordan"), "jordan");
assert.equal(repKeyForOwner("Matt"), "admin");
assert.equal(repKeyForOwner(null), "admin");

// ── Verified defaults ─────────────────────────────────────────────────────
// Both confirmed live 2026-08-14 as user_id 1522 / "AI Follow-Up".
assert.deepEqual(aiWireNumbers(NO_ENV), ["+19703237557", "+16505977482"]);

// ── Env overrides, and their fail-closed behaviour ────────────────────────
// Numbers rotate roughly weekly, so an override exists. A BROKEN override must
// not empty the pool: an empty pool blocks every Live Sub text with
// rep_has_no_line, which turns a fat-fingered env var into a silent outage on
// the one wire the carrier is not refusing.
assert.deepEqual(
  aiWireNumbers({ DRIP_AI_WIRE_NUMBERS: "+15551234567, +15557654321" }),
  ["+15551234567", "+15557654321"],
);
for (const bad of ["", "   ", "not-a-number", "5551234567", ",,,"]) {
  assert.deepEqual(
    aiWireNumbers({ DRIP_AI_WIRE_NUMBERS: bad }),
    ["+19703237557", "+16505977482"],
    `"${bad}" must fall back to the verified pair, never to nothing`,
  );
}

// Same rule for the stage list.
assert.deepEqual(aiWireStages({ DRIP_AI_WIRE_STAGES: "uw_sheet,follow_up" }), ["uw_sheet", "follow_up"]);
assert.deepEqual(aiWireStages({ DRIP_AI_WIRE_STAGES: "  " }), ["uw_sheet", "live_sub", "live_subs"]);
assert.deepEqual(aiWireStages({ DRIP_AI_WIRE_STAGES: ",,," }), ["uw_sheet", "live_sub", "live_subs"]);

// ── The deferred option: widen to everything without a deploy ─────────────
// Adon deferred "all drips on this account" rather than rejecting it, so the
// switch has to exist and has to be exercised — an untested escape hatch is
// not an escape hatch.
{
  const all = { DRIP_AI_WIRE_STAGES: "*" };
  assert.deepEqual(aiWireStages(all), ["*"]);
  for (const stage of ["follow_up", "declined", "uw_sheet", "anything"]) {
    assert.equal(usesAiWire({ stage }, all), true);
  }
  assert.equal(usesAiWire({}, all), true, "even a stageless lead, when the wire is set to everything");
}

// ── A narrowed override really does narrow it ─────────────────────────────
{
  const onlyFollowUp = { DRIP_AI_WIRE_STAGES: "follow_up" };
  assert.equal(usesAiWire({ stage: "follow_up" }, onlyFollowUp), true);
  assert.equal(usesAiWire({ stage: "uw_sheet" }, onlyFollowUp), false, "an override replaces the defaults, not adds to them");
}

console.log("ai-wire.test.ts — all assertions passed");
