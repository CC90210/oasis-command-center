/**
 * web-leads-due.test.ts — a rep must be able to see what they already owe.
 *
 * WHY THIS EXISTS
 * `dispositionPatch` REQUIRES a future `next_action_at` for the attempted and
 * voicemail dispositions and refuses the write without one, so the callback a
 * rep promises on a call has always been recorded. Nothing ever read it back.
 * Audited across app/, lib/ and components/ on 2026-09-29: the only match for
 * that column outside the writers was `ai_next_action_at`, an AI suggestion
 * timestamp, not a due-date query. A rep said "call me in two weeks", the date
 * was stored, and no screen in the product mentioned it again.
 *
 * On a cold week deferrals are most of what the week produces, so the largest
 * category of work the board knew about was the one category it could not show.
 *
 * THE SEAM THIS GUARDS, and it is the same one that has already burned this
 * feature once. `fetchLeads` filters over a PROJECTION (FILTER_KEYS), not the
 * whole `data` blob. Three owner fields were left out of that list in August
 * and the owner filters answered "no" for every lead in the tenant for two
 * weeks, with no error raised anywhere. A `due` filter whose column is missing
 * from the projection does not fail loudly either: it reports that nothing is
 * due, forever, which is indistinguishable from a quiet week.
 *
 * So this file asserts the field SURVIVES THE REAL PROJECTION PATH by running
 * `toWebLead` over a raw row, rather than by reading FILTER_KEYS and agreeing
 * with it.
 */
import assert from "node:assert/strict";

import { FILTER_KEYS, toWebLead, isDue, byDueThenName, type WebLeadRow } from "@/lib/web-leads/data";

const NOW = Date.parse("2026-09-29T15:00:00.000Z");
const YESTERDAY = "2026-09-28T15:00:00.000Z";
const LAST_WEEK = "2026-09-22T15:00:00.000Z";
const TOMORROW = "2026-09-30T15:00:00.000Z";

// ── 1. The projection carries it ───────────────────────────────────────────
//
// The contract, and then the behaviour. The second assertion is the one that
// matters: it proves the real narrowing keeps the value, which is what the
// August owner-field outage disproved for three other columns.

assert.ok(
  (FILTER_KEYS as readonly string[]).includes("next_action_at"),
  "next_action_at must be in the projection or the due filter silently sees nothing",
);

/** Replays the real narrowing fetchLeads applies, exactly as the sibling
 *  projection test does: keep only the projected keys, then map. Asserting
 *  against the full blob instead would pass even with the column missing from
 *  FILTER_KEYS, which is the bug shape this is here to catch. */
function project(data: Record<string, unknown>): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  for (const k of FILTER_KEYS) d[k] = data[k];
  return d;
}

const PROMISED = { business_name: "Jay Green Plumbing", next_action_at: YESTERDAY };

const full = toWebLead({ id: "l1", data: PROMISED });
assert.equal(full.nextActionAt, YESTERDAY, "precondition: the mapper reads next_action_at");

// The real path, and the assertion that would have failed silently.
const projected = toWebLead({ id: "l1", data: project(PROMISED) });
assert.equal(
  projected.nextActionAt,
  YESTERDAY,
  "next_action_at was dropped by the projection — the due filter goes blind here and reports an empty queue",
);

const noPromise = toWebLead({ id: "l2", data: project({ business_name: "Thermo Tec Mechanical" }) });
assert.equal(noPromise.nextActionAt, null, "a lead with no promise carries null, not undefined");

// ── 2. Due means the moment arrived or passed ──────────────────────────────

assert.equal(isDue(YESTERDAY, NOW), true, "a promise from yesterday is owed");
assert.equal(isDue(LAST_WEEK, NOW), true, "a promise from last week is still owed, not expired");
assert.equal(
  isDue(new Date(NOW).toISOString(), NOW),
  true,
  "a promise due exactly now is owed; the boundary belongs to the rep, not the clock",
);
assert.equal(isDue(TOMORROW, NOW), false, "a promise for tomorrow is not owed yet");

// ── 3. No date is NOT due, which is the whole point of the screen ──────────
//
// If an unpromised lead showed here, the one screen that says "you said you
// would do this" would just be the board again.

assert.equal(isDue(null, NOW), false, "a lead nobody promised to call back is not owed");
assert.equal(isDue(undefined, NOW), false, "a missing field is not owed");
assert.equal(isDue("", NOW), false, "an empty string is not owed");
assert.equal(isDue("not a date", NOW), false, "an unparseable date is not owed, and never throws");

// ── 4. The oldest broken promise goes first ────────────────────────────────

const row = (name: string, nextActionAt: string | null) =>
  ({ name, nextActionAt } as unknown as WebLeadRow);

const queue = [
  row("Uncle Bill's Hillcrest Plumbing", YESTERDAY),
  row("Francis Plumbing Heating & Cooling", LAST_WEEK),
  row("TCA Electric", TOMORROW),
].sort(byDueThenName);

assert.deepEqual(
  queue.map((l) => l.name),
  ["Francis Plumbing Heating & Cooling", "Uncle Bill's Hillcrest Plumbing", "TCA Electric"],
  "a callback owed since last week outranks one owed yesterday",
);

// Ties break on name so paging is stable, the same rule every other comparator
// in data.ts follows: without a total order two leads can swap between requests
// and a rep sees one business twice while another never appears.
const sameInstant = [
  row("Zebra Roofing", YESTERDAY),
  row("Acme Plumbing", YESTERDAY),
].sort(byDueThenName);
assert.deepEqual(
  sameInstant.map((l) => l.name),
  ["Acme Plumbing", "Zebra Roofing"],
  "two promises owed at the same instant order by name, so paging is stable",
);

// A row with no date sorts LAST. It cannot reach this comparator through the
// filter, which drops it first; this pins the fallback so a later refactor that
// sorts before filtering cannot put unpromised leads at the top of the queue.
const withGap = [
  row("No Promise Co", null),
  row("Owed Since Last Week", LAST_WEEK),
].sort(byDueThenName);
assert.deepEqual(
  withGap.map((l) => l.name),
  ["Owed Since Last Week", "No Promise Co"],
  "an unknown date sorts last, never first",
);

console.log("web-leads-due: OK");
