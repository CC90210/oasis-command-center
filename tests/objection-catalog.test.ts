import assert from "node:assert";
import { assembleCatalog } from "../lib/web-leads/objections/catalog";

// ---------------------------------------------------------------------------
// assembleCatalog is the projection between the two tables and the shape the
// console renders. It is exported and pure for one reason: the rule that a
// DRAFT never reaches a rep is the single most important rule in this feature,
// and a rule enforced only by a `.eq()` in a query builder is a rule that a
// future refactor deletes without any test noticing.
// ---------------------------------------------------------------------------

const OBJ_ROWS = [
  {
    id: "o1", slug: "no-budget", says: "no budget", meaning: "m", prevent: "p",
    family: "no_money", source: null, dimension: null, status: "approved",
  },
];

const RESP_ROWS = [
  { id: "r1", objection_id: "o1", label: "Agree", body: "approved body", posture: "agree_and_redirect", is_default: 1, status: "approved" },
  { id: "r2", objection_id: "o1", label: "Ask", body: "draft body", posture: "question_back", is_default: 0, status: "draft" },
  { id: "r3", objection_id: "o1", label: "Old", body: "retired body", posture: "take_it_away", is_default: 0, status: "retired" },
];

// A draft answer NEVER reaches a rep. Neither does a retired one.
{
  const [entry] = assembleCatalog(OBJ_ROWS, RESP_ROWS);
  const bodies = entry.answers.map((a) => a.body);
  assert.deepEqual(bodies, ["approved body"], `only approved answers may render, got ${bodies.join("|")}`);
}

// libSQL returns booleans as 0/1. A strict === true comparison anywhere in the
// projection silently produces an objection with no default answer.
{
  const [entry] = assembleCatalog(OBJ_ROWS, RESP_ROWS);
  assert.equal(entry.answers[0].isDefault, true, "is_default 1 must project to true");
}

// An objection whose every answer is draft is DROPPED, not rendered empty. A
// card with a question and no answer on it is worse than no card: a rep opens
// it mid-sentence expecting a line to read.
{
  const onlyDrafts = RESP_ROWS.filter((r) => r.status !== "approved");
  assert.deepEqual(assembleCatalog(OBJ_ROWS, onlyDrafts), []);
}

// An unrecognised family or posture is DROPPED rather than rendered. These
// columns are free text in SQLite, so a bad write must fail closed here.
{
  const badFamily = [{ ...OBJ_ROWS[0], family: "not_a_family" }];
  assert.deepEqual(assembleCatalog(badFamily, RESP_ROWS), []);

  const badPosture = [{ ...RESP_ROWS[0], posture: "not_a_posture" }];
  assert.deepEqual(assembleCatalog(OBJ_ROWS, badPosture), []);
}

// Exactly one default survives even if a bad write produced two, and the
// survivor is deterministic rather than whichever row the driver returned first.
{
  const twoDefaults = [
    { ...RESP_ROWS[0], id: "rB", label: "B" },
    { ...RESP_ROWS[0], id: "rA", label: "A" },
  ];
  const [entry] = assembleCatalog(OBJ_ROWS, twoDefaults);
  assert.equal(entry.answers.filter((a) => a.isDefault).length, 1);
  assert.equal(entry.answers.find((a) => a.isDefault)?.id, "rA");
}

console.log("objection-catalog: OK");
