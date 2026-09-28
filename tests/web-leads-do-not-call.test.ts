/**
 * A rep must be able to record "never call me again", and it must stick.
 *
 * WHY THIS EXISTS
 * The system already RESPECTS a do-not-call flag. lib/web-leads/claim.ts reads
 * `data.dnc`, refuses to let such a lead be claimed, and its own comment says
 * the flag "never expires". lib/web-leads/assign.ts checks it before assigning.
 * Four places read it.
 *
 * NOTHING WROTE IT. Grepped across app/, lib/ and components/ on 2026-09-28:
 * every `dnc` reference is a read, a type, or a comment. The flag that gates
 * claiming and assignment could only ever be false, so the gate could only ever
 * open. A rep hearing "take me off your list" had nowhere to put it.
 *
 * THIS IS A LEGAL OBLIGATION, NOT A CONVENIENCE. Under the CRTC's Unsolicited
 * Telecommunications Rules, an internal do-not-call list binds a telemarketer
 * even when the calls themselves are exempt from the National DNCL, as
 * business-to-business calls are. A request must be recorded within 14 days and
 * honoured for three years and fourteen days. The database CHECK constraint on
 * leadgen_call_outcomes has always permitted 'do_not_call'; the application
 * simply never sent it, so the ledger could not evidence compliance either.
 *
 * The schema's own comment states where the truth is created: "A do_not_call
 * here must reach the shared suppression list too; the rep saying it out loud is
 * the authoritative moment, not a later batch job."
 *
 * WHY IT LANDS ON "lost" AND SETS dnc IN THE SAME PATCH. A do-not-call is a
 * terminal outcome, so the stage moves like any other loss. But `lost` alone is
 * recyclable: claim.ts returns a lost lead to the pool after 90 days. Only the
 * dnc flag makes it permanent, which is why the two must be written together
 * rather than relying on the stage to carry the meaning.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CALL_OUTCOMES, isCallOutcome, nextStage } from "@/lib/web-leads/outcome";

const src = readFileSync("lib/web-leads/outcome.ts", "utf8");

// ── 1. The outcome exists and validates ────────────────────────────────────

assert.ok(
  isCallOutcome("do_not_call"),
  "a rep must be able to record a do-not-call request",
);
assert.ok(
  (CALL_OUTCOMES as readonly string[]).includes("do_not_call"),
  "do_not_call must be offered, not merely accepted",
);

// ── 2. It maps to the value the database CHECK already allows ──────────────

assert.match(
  src,
  /do_not_call:\s*"do_not_call"/,
  "do_not_call must map to the DB CHECK value of the same name, not be folded into not_interested",
);

// ── 3. It is terminal, and never regresses a lead that moved on ────────────

assert.equal(
  nextStage("researched", "do_not_call"),
  "lost",
  "a do-not-call ends the lead",
);
assert.equal(
  nextStage("assigned", "do_not_call"),
  "lost",
  "a do-not-call ends the lead from any early stage",
);
assert.equal(
  nextStage("connected", "do_not_call"),
  "lost",
  "a prospect who connects and then asks to be removed is still removed",
);

// ── 4. The permanence is written, not implied by the stage ─────────────────
//
// `lost` alone recycles after 90 days. If the patch does not set dnc, the
// request silently expires and the lead returns to the pool, which is the exact
// failure the CRTC rule exists to prevent.

assert.match(
  src,
  /dnc:\s*true/,
  "the do_not_call patch must set dnc, because a lost lead recycles and a dnc lead must not",
);

// It belongs in the CONTEXT patch, not the stage patch. The stage patch only
// runs when nextStage() returns a target, and nextStage deliberately declines to
// move a lead that has passed `connected`, because pricing and commission belong
// to the downstream website-sales lifecycle. A prospect deep in that lifecycle
// who says "never call me again" must still be recorded. The context patch runs
// unconditionally and is ownership- and CAS-guarded, so it is the only place the
// flag is written on every do_not_call rather than merely on the early-funnel
// ones.
const contextBlock = src.slice(src.indexOf("const contextPatch"), src.indexOf("const contextPatch") + 900);
assert.match(
  contextBlock,
  /dnc/,
  "dnc must be written in the unconditional, ownership-guarded context patch, so a late-stage prospect's request is not silently dropped",
);

console.log("web-leads-do-not-call: OK");
