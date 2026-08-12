/**
 * tests/live-subs-visibility.test.ts — Live Subs stay on the Leads board even
 * when a legacy transfer marker exists.
 *
 * REWRITTEN 2026-08-11. This file used to assert that the visibility rule
 * appeared as a string literal EXACTLY TWICE inside lib/manifest/data.ts. That
 * assertion pinned the duplication in place: the copies it was guarding are the
 * reason the board and the drip engine drifted apart and 64% of drip mail went
 * to merchants nobody could see. Counting copies of a rule is not the same as
 * checking the rule, and here it actively defended the defect.
 *
 * It now asserts the opposite property — that every surface reads ONE shared
 * module — and checks the behaviour rather than the spelling.
 *
 * It was also in no npm script, so it had never run in CI. It is now in
 * test:sunbiz. (Fifth instance of "the gate exists and never fires" in this
 * repo; Codex caught this one, because the suite could not.)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isLeadListVisible } from "../lib/lead-list-visibility";
import { isOnLeadsBoard } from "../lib/leads/board-visibility";

// The original behavioural assertions, unchanged. These are the point of the file.
assert.equal(isLeadListVisible({ stage: "uw_sheet", transferred_at: "2026-01-01T00:00:00Z" }), true,
  "legacy transferred Live Subs remain visible");
assert.equal(isLeadListVisible({ stage: "uw_sheet", transferred_at: null }), true,
  "normal Live Subs remain visible");
assert.equal(isLeadListVisible({ stage: "hot_lead", transferred_at: "2026-01-01T00:00:00Z" }), false,
  "ordinary transferred leads stay on Applications only");

// The shim and the module are the SAME function, not two implementations that
// happen to agree today.
assert.equal(isLeadListVisible, isOnLeadsBoard,
  "lead-list-visibility must re-export the shared rule, not restate it");

// The client guard inherits the blank-string correction. Its old body was
// `!data.transferred_at || ...`, and `!""` is true — so a blank-stamped lead
// rendered on the board while the server query hid it.
assert.equal(isLeadListVisible({ stage: "hot_lead", transferred_at: "" }), false,
  "a blank transfer stamp is off the board in the UI too");

// ONE COPY. The inverse of what this file used to assert: the literal must NOT
// appear in data.ts, because both queries now call the shared helper.
const source = fs.readFileSync(path.join(process.cwd(), "lib/manifest/data.ts"), "utf8");
assert.equal(
  (source.match(/data->>transferred_at\.is\.null,data->>stage\.eq\.uw_sheet/g) || []).length,
  0,
  "the rule must not be restated in data.ts — it imports applyLeadsBoardFilter",
);
assert.equal(
  (source.match(/applyLeadsBoardFilter\(/g) || []).length,
  2,
  "both the owned/admin and collaborator lead queries must still apply it",
);

console.log("Live Subs visibility tests passed");
