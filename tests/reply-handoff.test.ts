/**
 * tests/reply-handoff.test.ts — the drip must get out of the way when a real
 * person answers, and must not page anyone when nobody did.
 *
 * Adon, 2026-08-17: "this drip is just meant for the first point of contact.
 * Once we have them answering, it should delegate it to our agent."
 *
 * Nothing cancelled a drip on a reply before this. A merchant who answered
 * would still get the day-2, day-4, day-7 and day-11 texts while a human was
 * mid-conversation on the same number.
 */

import assert from "node:assert/strict";
import { decideHandoff, handoffSummary } from "../lib/drips/reply-handoff-core";

const base = { inbound: true, optedOut: false, alreadyHandedOff: false };

// ── A real reply hands off ────────────────────────────────────────────────
for (const body of [
  "yes",
  "Yes still looking",
  "how much can I get",
  "whats the rate",
  "call me tomorrow after 2",
  "who is this?",
  "not right now but maybe next quarter",
  "no thanks",           // still a human, still ends the drip
  "stop calling me so much", // NOT an opt-out keyword match; a human, and a human should see it
]) {
  const d = decideHandoff({ ...base, body });
  assert.equal(d.action, "handoff", `"${body}" is a person talking`);
}

// ── Opt-out suppresses; only the AMBIGUOUS kind pages ─────────────────────
// detectOptOut separates an explicit regulatory keyword from one inferred from
// natural language, and its own contract says the second is honoured AND routed
// to human review. Paging on every "STOP" is how a lane gets muted; never
// paging on an inferred one means a wrongly-suppressed merchant is invisible.
{
  const explicit = decideHandoff({ ...base, body: "STOP", optedOut: true });
  assert.equal(explicit.action, "opt_out");
  assert.equal(explicit.notifyAgent, false, "an explicit STOP needs no human");

  const inferred = decideHandoff({
    ...base, body: "please take me off your list", optedOut: true, optOutAmbiguous: true,
  });
  assert.equal(inferred.action, "opt_out", "still suppressed");
  assert.equal(inferred.notifyAgent, true, "but a human confirms the inference");
  assert.match(inferred.reason, /natural language/);
}
// A real reply always pages; an ignore never does.
assert.equal(decideHandoff({ ...base, body: "yes" }).notifyAgent, true);
assert.equal(decideHandoff({ ...base, body: "out of the office" }).notifyAgent, false);
assert.equal(decideHandoff({ ...base, body: "yes", inbound: false }).notifyAgent, false);
// Opt-out beats the already-handed-off short circuit: warm on Monday, STOP on
// Friday must still suppress on Friday.
{
  const d = decideHandoff({ ...base, body: "STOP", optedOut: true, alreadyHandedOff: true });
  assert.equal(d.action, "opt_out", "a later opt-out must never be swallowed by an earlier handoff");
}
// But that bypass must not re-announce the SAME opt-out every scan. Once it is
// stamped, this one is done — while a genuinely later STOP still lands, because
// the caller compares timestamps rather than setting a boolean.
{
  const again = decideHandoff({
    ...base, body: "STOP", optedOut: true, optOutAlreadyRecorded: true,
  });
  assert.equal(again.action, "ignore", "one announcement per opt-out, not one per 30-minute scan");
  assert.equal(again.notifyAgent, false);
}

// ── Our own outbound is not a reply ───────────────────────────────────────
assert.equal(decideHandoff({ ...base, body: "Hi, it's Matt", inbound: false }).action, "ignore");

// ── Duplicate delivery must not page twice ────────────────────────────────
// The provider resends and the sync is re-runnable by design.
{
  const d = decideHandoff({ ...base, body: "yes interested", alreadyHandedOff: true });
  assert.equal(d.action, "ignore");
  assert.match(d.reason, /already handed/);
}

// ── Machines don't get a human ────────────────────────────────────────────
for (const body of [
  "Auto-Reply: I am currently away",
  "automatic reply: on leave",
  "I am out of the office until Monday",
  "This number does not accept text messages",
  "Free Msg: Your plan has been updated",
  "Message blocking is active",
]) {
  assert.equal(decideHandoff({ ...base, body }).action, "ignore", `"${body}" is a machine`);
}
assert.equal(decideHandoff({ ...base, body: "   " }).action, "ignore", "empty inbound has nothing to show");

// ── The screen is NARROW on purpose ───────────────────────────────────────
// A false "ignore" is a merchant who answered, got ignored by a human AND kept
// getting drips. A false "handoff" is one extra notification. Not symmetric,
// so anything ambiguous is a real reply.
for (const body of [
  "I'm out of town this week, call me Monday",  // mentions being out, but is clearly a person
  "office is closed friday but text me",
  "auto shop needs 50k",                        // contains "auto"
  "stopped by the bank today",                  // contains "stop"
]) {
  assert.equal(decideHandoff({ ...base, body }).action, "handoff", `"${body}" is a person, not a machine`);
}

// ── The agent-facing line ─────────────────────────────────────────────────
{
  const s = handoffSummary({
    contactName: "Chris",
    businessName: "Westside Auto",
    phone: "+13055550147",
    body: "yes  still\n looking for about 50k",
  });
  assert.match(s, /Chris at Westside Auto/);
  assert.match(s, /\+13055550147/);
  assert.match(s, /yes still looking for about 50k/, "whitespace collapses so it reads on a phone");
}
// Missing names must not produce a dangling "at" or an empty subject.
{
  const s = handoffSummary({ contactName: null, businessName: null, phone: "+13055550147", body: "hi" });
  assert.match(s, /^A Live Sub \(/);
  assert.ok(!s.includes(" at ("), "no dangling 'at' when a name is missing");
}
// A long reply is truncated rather than paging a wall of text.
{
  const s = handoffSummary({ contactName: "A", businessName: "B", phone: "+1", body: "x".repeat(500) });
  assert.ok(s.length < 260, `summary should stay short, got ${s.length}`);
}

console.log("reply-handoff.test.ts — all assertions passed");
