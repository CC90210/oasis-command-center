/**
 * web-leads-next-action.test.ts — an open lead always leaves the call with a
 * date on it, and a closed one always leaves without one.
 *
 * WHY THIS EXISTS
 * `dispositionPatch` already refuses the attempted and voicemail dispositions
 * without a future date, and that rule is the only reason the `due` filter has
 * anything to show. The outcomes logged from the board had no such rule, so a
 * lead could be worked, left open, and be invisible the next morning: nobody
 * decided to drop it and nobody scheduled it. That is the quietest way a
 * pipeline leaks, because nothing anywhere reports an error.
 *
 * 🚨 THE CASE THAT MATTERS MOST IS THE CLEARING ONE. A lead marked
 * `do_not_call` that still carries yesterday's callback would keep surfacing in
 * the due queue, and that queue exists to tell a rep who to phone next.
 * Honouring a do-not-call request is a CRTC obligation, not a preference, so a
 * terminal outcome NULLS the date rather than leaving it behind. A test that
 * only checked "required when open" would pass while the product quietly
 * re-queued people who had asked to be left alone.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { validateNextAction } from "@/lib/web-leads/outcome";

const NOW = Date.parse("2026-09-29T15:00:00.000Z");
const FUTURE = "2026-10-06T15:00:00.000Z";
const PAST = "2026-09-22T15:00:00.000Z";

// ── 1. An outcome that leaves the lead alive owes it a date ────────────────

for (const outcome of ["no_answer", "connected", "interested"] as const) {
  assert.deepEqual(
    validateNextAction(outcome, "", NOW),
    { ok: false, error: "next_action_required" },
    `${outcome} leaves the lead open, so it must carry a next step`,
  );
  assert.deepEqual(
    validateNextAction(outcome, undefined, NOW),
    { ok: false, error: "next_action_required" },
    `${outcome} with no field at all is still missing a next step`,
  );

  const ok = validateNextAction(outcome, FUTURE, NOW);
  assert.equal(ok.ok, true, `${outcome} accepts a future date`);
  assert.equal(
    ok.ok && ok.nextActionAt,
    FUTURE,
    `${outcome} normalises to an ISO instant the due filter can parse`,
  );
}

// ── 2. The date has to be in front of you ──────────────────────────────────

assert.deepEqual(
  validateNextAction("no_answer", PAST, NOW),
  { ok: false, error: "next_action_not_future" },
  "a callback in the past is not a plan, and would land in the due queue already overdue",
);
assert.deepEqual(
  validateNextAction("no_answer", new Date(NOW).toISOString(), NOW),
  { ok: false, error: "next_action_not_future" },
  "exactly now is not the future; dispositionPatch draws the same line",
);
assert.deepEqual(
  validateNextAction("connected", "next tuesday", NOW),
  { ok: false, error: "next_action_invalid" },
  "an unparseable date is refused rather than silently dropped, and never throws",
);

// ── 3. A terminal outcome CLEARS it. This is the compliance case. ──────────

assert.deepEqual(
  validateNextAction("do_not_call", FUTURE, NOW),
  { ok: true, nextActionAt: null },
  "a do-not-call clears the callback even when a date was sent, or the person who asked to be left alone returns to the queue",
);
assert.deepEqual(
  validateNextAction("do_not_call", "", NOW),
  { ok: true, nextActionAt: null },
  "a do-not-call never requires a date",
);
assert.deepEqual(
  validateNextAction("not_interested", FUTURE, NOW),
  { ok: true, nextActionAt: null },
  "a lost lead carries no promise; claim.ts recycles it on its own schedule",
);

// ── 4. The write actually emits it ─────────────────────────────────────────
//
// Validation that never reaches the row would satisfy every assertion above
// and change nothing a rep sees. Both sinks are checked: the lead's own field,
// which the due filter reads, and the append-only ledger row.

const src = readFileSync("lib/web-leads/outcome.ts", "utf8");
const contextBlock = src.slice(src.indexOf("const contextPatch"), src.indexOf("const contextPatch") + 400);
assert.match(
  contextBlock,
  /next_action_at: nextActionAt/,
  "the context patch must carry the date, or the due filter never sees it",
);
assert.match(
  src,
  /next_action_at: nextActionAt,\s*\n\s*called_at/,
  "the append-only ledger row must carry it too, so the promise is auditable and not only current-state",
);

console.log("web-leads-next-action: OK");
