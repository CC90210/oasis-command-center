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

// ---------------------------------------------------------------------------
// THE OBJECTION-LEVEL STATUS FILTER. The header above calls this the single
// most important rule in the feature, and until the final whole-branch review
// NOTHING PINNED IT: the reviewer deleted `if (o.status !== "approved")
// continue;` from assembleCatalog and the full suite passed 37/37. Only the
// ANSWER-level filter (the block below) was covered, and an approved answer
// hanging off a draft objection is exactly how unapproved wording reaches a
// rep mid-call.
//
// Both non-approved statuses are planted, because they fail differently: a
// `draft` row is copy nobody has read yet, a `retired` row is copy somebody
// deliberately withdrew.
// ---------------------------------------------------------------------------
{
  const draft = { ...OBJ_ROWS[0], id: "o-draft", slug: "draft-objection", status: "draft" };
  const retired = { ...OBJ_ROWS[0], id: "o-retired", slug: "retired-objection", status: "retired" };
  const approvedAnswersFor = (objectionId: string) =>
    RESP_ROWS.filter((r) => r.status === "approved").map((r) => ({ ...r, objection_id: objectionId }));

  const assembled = assembleCatalog(
    [draft, retired, OBJ_ROWS[0]],
    [...approvedAnswersFor("o-draft"), ...approvedAnswersFor("o-retired"), ...RESP_ROWS],
  );
  const slugs = assembled.map((o) => o.slug);
  assert.deepEqual(
    slugs,
    ["no-budget"],
    `only APPROVED objections may render, got ${slugs.join("|")} -- a draft or retired objection with a perfectly approved answer on it is still unapproved copy`,
  );
}

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

// website_premise (database/turso/172) is projected, and an unrecognised value
// degrades to null rather than dropping the card. Unlike family and posture, a
// bad premise must not cost a rep a whole objection: it only nudges rank.
{
  const [neutral] = assembleCatalog(OBJ_ROWS, RESP_ROWS);
  assert.equal(neutral.websitePremise, null, "an absent website_premise projects as premise-neutral");

  const [substitute] = assembleCatalog([{ ...OBJ_ROWS[0], website_premise: "substitute" }], RESP_ROWS);
  assert.equal(substitute.websitePremise, "substitute", "a valid website_premise must reach the ranker");

  const bad = assembleCatalog([{ ...OBJ_ROWS[0], website_premise: "requires_sight" }], RESP_ROWS);
  assert.equal(bad.length, 1, "a bad website_premise must NOT drop the card -- it only affects rank");
  assert.equal(bad[0].websitePremise, null, "a bad website_premise degrades to premise-neutral");
}

console.log("objection-catalog: OK");
