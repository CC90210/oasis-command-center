/**
 * The assignment-destination rule, exercised for real.
 *
 * CodeRabbit flagged the source-text assertion on PR #382 and asked for a
 * behavioural test of the handler. Its stated reason was wrong -- it claimed
 * the first `target_not_on_sales_roster` occurrence was in a comment, and there
 * is exactly one occurrence, in executable code at route line 88 -- but the
 * underlying point stood: reading source proves a check EXISTS, never that it
 * is CORRECT. On an authorisation gate that is not good enough.
 *
 * Its suggested fix (mock getOasisSalesRepRoster and assignTerritory) has no
 * substrate here: no test in this repo imports a route handler and there is no
 * mocking framework, so taking it literally means introducing one for a single
 * test. Instead the predicate both routes duplicated is now a pure function,
 * and this file runs it against real inputs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isAssignableTarget } from "../lib/web-leads/assign-target";

const ROSTER = [
  { auth_user_id: "8f3a-rep-ariel" },
  { auth_user_id: "2b1c-rep-ethan" },
  { auth_user_id: null }, // a profile with no auth identity
  {}, // a row missing the field entirely
];

test("assignment destination", async (t) => {
  await t.test("accepts a rep who is on the roster", () => {
    assert.equal(isAssignableTarget(ROSTER, "8f3a-rep-ariel"), true);
    assert.equal(isAssignableTarget(ROSTER, "2b1c-rep-ethan"), true);
  });

  await t.test("refuses anyone who is not", () => {
    // The live case this exists for: CC (is_owner) and Adon (team_role "admin")
    // are excluded by getOasisSalesRepRoster, so they never reach this list.
    assert.equal(isAssignableTarget(ROSTER, "cc-founder-id"), false);
    assert.equal(isAssignableTarget(ROSTER, "adon-admin-id"), false);
  });

  await t.test("refuses an id that belongs to nobody", () => {
    // THE DANGEROUS ONE. Before the fix, the sheet route accepted any non-empty
    // string: the write SUCCEEDED and a whole city+industry sheet's leads
    // propagated to an owner who does not exist -- out of the pool, invisible
    // to every rep, and no error anywhere because nothing ever asked.
    assert.equal(isAssignableTarget(ROSTER, "typo-nobody-has-this"), false);
    assert.equal(isAssignableTarget(ROSTER, "'; DROP TABLE leads;--"), false);
  });

  await t.test("an empty or blank target is never a member", () => {
    // Clearing an owner passes null and skips the check entirely, so a blank
    // string arriving here is a malformed request -- not "unassign".
    assert.equal(isAssignableTarget(ROSTER, ""), false);
    assert.equal(isAssignableTarget(ROSTER, "   "), false);
  });

  await t.test("compares trimmed and case-insensitively on BOTH sides", () => {
    // The two sides come from different places: the target arrives in a JSON
    // body, the roster out of user_profiles. A raw compare would refuse a
    // valid rep over a trailing space or a capitalised uuid.
    assert.equal(isAssignableTarget(ROSTER, "  8f3a-rep-ariel  "), true);
    assert.equal(isAssignableTarget(ROSTER, "8F3A-REP-ARIEL"), true);
    assert.equal(isAssignableTarget([{ auth_user_id: " 8f3a-REP-ariel " }], "8f3a-rep-ariel"), true);
  });

  await t.test("a null or absent auth_user_id never matches", () => {
    // Rows without an auth identity cannot own anything. Matching "" against
    // them would make an empty target succeed against a roster full of nulls.
    assert.equal(isAssignableTarget([{ auth_user_id: null }], ""), false);
    assert.equal(isAssignableTarget([{}], ""), false);
    assert.equal(isAssignableTarget([{ auth_user_id: null }], "null"), false);
  });

  await t.test("an empty roster accepts nobody", () => {
    // The failure mode worth naming: if the roster read ever returns [] on
    // error instead of throwing, this must refuse every assignment rather than
    // wave them all through.
    assert.equal(isAssignableTarget([], "8f3a-rep-ariel"), false);
  });

  await t.test("both assignment routes go through this one predicate", () => {
    // Per-lead and whole-sheet assignment are two doors to the same decision.
    // They each had their own copy of these four lines; a copy is how they
    // drift. This is the only assertion here that reads source, and it is
    // checking wiring, not behaviour -- the behaviour is the seven tests above.
    for (const route of [
      "app/api/web-leads/claim/route.ts",
      "app/api/web-leads/territories/[id]/assign/route.ts",
    ]) {
      const src = readFileSync(route, "utf8");
      assert.match(src, /isAssignableTarget\(roster,/, `${route} must use the shared predicate`);
      assert.ok(
        !/roster\.some\(/.test(src),
        `${route} must not carry its own copy of the membership check`,
      );
    }
  });
});
