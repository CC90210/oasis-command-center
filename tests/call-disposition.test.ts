/**
 * call-disposition.test.ts — the board and the pipeline must say the same word
 * for the same event.
 *
 * WHY THIS EXISTS
 * Two paths record calls and each invented its own vocabulary. Both write
 * `tenant_records.data.last_disposition`, so which words a lead ended up
 * carrying depended on which screen the rep happened to use:
 *
 *   the board     no_answer  connected  interested  not_interested  do_not_call
 *   the pipeline  attempted  voicemail  connected   lost
 *
 * components/today/RepToday.tsx renders that field, so one lead read "attempted"
 * and another read "no answer" for the same real event. It also made counting
 * across the two impossible, which is what blocked stage-conversion reporting.
 *
 * Measured on 2026-09-29: 78 call_disposition rows from the pipeline against 2
 * from the board's ledger. Any metric over either one alone is wrong, and wrong
 * quietly.
 *
 * THE CANONICAL SET IS NOT NEW. It is the CHECK constraint that has always been
 * on leadgen_call_outcomes.outcome. The schema anticipated one vocabulary; the
 * code implemented two subsets of it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CANONICAL_DISPOSITIONS,
  CANONICAL_FROM_CALL_OUTCOME,
  CANONICAL_FROM_REP_DISPOSITION,
  canonicalFromCallOutcome,
  canonicalFromRepDisposition,
  dispositionLabel,
} from "@/lib/call-disposition";

// ── 1. The same event gets the same word from either path ──────────────────
//
// This is the whole point of the module. Everything else is bookkeeping.

assert.equal(
  canonicalFromRepDisposition("attempted"),
  canonicalFromCallOutcome("no_answer"),
  "a dial that reached nobody is one event, whichever screen recorded it",
);
assert.equal(
  canonicalFromRepDisposition("connected"),
  canonicalFromCallOutcome("connected"),
  "reaching a human is one event, whichever screen recorded it",
);
assert.equal(
  canonicalFromRepDisposition("lost"),
  canonicalFromCallOutcome("not_interested"),
  "closing a lead out is one event; the pipeline keeps its reason in loss_reason",
);

// ── 2. Every mapped value is one the database already accepts ──────────────
//
// The canonical set is the CHECK constraint. A mapper that emitted anything
// outside it would be rejected at the ledger write and accepted silently in
// last_disposition, which is the worst of both.

const canonical = new Set<string>(CANONICAL_DISPOSITIONS);
for (const [src, out] of Object.entries(CANONICAL_FROM_CALL_OUTCOME)) {
  assert.ok(canonical.has(out), `board value ${src} maps to ${out}, which the CHECK constraint does not permit`);
}
for (const [src, out] of Object.entries(CANONICAL_FROM_REP_DISPOSITION)) {
  assert.ok(canonical.has(out), `pipeline value ${src} maps to ${out}, which the CHECK constraint does not permit`);
}

// Both mappers are total. TypeScript enforces this at compile time via Record<>,
// but the map is data and a later edit can delete a key without a type error if
// the source union is widened in the same change.
assert.equal(Object.keys(CANONICAL_FROM_CALL_OUTCOME).length, 5, "every board outcome maps");
assert.equal(Object.keys(CANONICAL_FROM_REP_DISPOSITION).length, 4, "every pipeline disposition maps");

// ── 3. Legacy rows read correctly, which is why no backfill is needed ──────
//
// Rewriting history in a store the product treats as a ledger is a decision for
// a human, not a side effect of a refactor. So the read side understands the old
// words, and the inconsistency a rep can see is gone for existing rows too.

assert.equal(dispositionLabel("attempted"), "No answer", "a legacy pipeline value reads correctly");
assert.equal(dispositionLabel("no_answer"), "No answer", "and matches what the board wrote for the same event");
assert.equal(
  dispositionLabel("attempted"),
  dispositionLabel("no_answer"),
  "old and new rows must be indistinguishable to a rep, or the fix is only half done",
);
assert.equal(dispositionLabel("lost"), "Not interested", "a legacy loss reads correctly");
assert.equal(dispositionLabel("connected"), "Connected", "connected appears in both vocabularies and means one thing");
assert.equal(dispositionLabel("reached"), "Connected", "the canonical form of it reads the same");

// An unknown value comes back as it came. A label that invents meaning for a
// value it does not know is worse than one that admits it.
assert.equal(dispositionLabel("something_else"), "something_else", "an unrecognised value is not replaced with a guess");
assert.equal(dispositionLabel(null), null, "no disposition renders nothing, not a blank label");
assert.equal(dispositionLabel(""), null, "an empty string renders nothing");
assert.equal(dispositionLabel("   "), null, "whitespace renders nothing");

// ── 4. Both write sites actually use it ────────────────────────────────────
//
// A mapper nothing calls satisfies every assertion above and changes nothing a
// rep sees.

const pipeline = readFileSync("lib/website-sales-workflow.ts", "utf8");
assert.match(
  pipeline,
  /last_disposition: canonicalFromRepDisposition\(disposition\)/,
  "the pipeline must store the canonical value, not the raw RepDisposition",
);

const board = readFileSync("lib/web-leads/outcome.ts", "utf8");
assert.match(
  board,
  /last_disposition: DB_OUTCOME\[outcome\]/,
  "the board must store the canonical value here too — this field was the one place it disagreed with its own ledger and interaction writes",
);

console.log("call-disposition: OK");
