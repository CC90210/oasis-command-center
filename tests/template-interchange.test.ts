/**
 * tests/template-interchange.test.ts — which templates may go behind a live step.
 *
 * This surface writes to merchant mail with no send-time review after it, so
 * these filters ARE the review. The two failures they prevent:
 *
 *   an unapproved or retired template reaching a real merchant, and
 *   a Bluerise step sending SunBiz's wording, which puts two company names in
 *   one conversation and pushes one brand's copy through the other's carrier
 *   registration.
 */

import assert from "node:assert/strict";
import {
  selectableTemplates,
  validateInterchange,
  buildInterchangeAudit,
} from "../lib/drips/template-interchange";
import type { PoolTemplate } from "../lib/drips/template-pool";

const tpl = (over: Partial<PoolTemplate>): PoolTemplate => ({
  id: "t1",
  brand: "sunbiz",
  stage: "follow_up",
  role: "nudge",
  subject: "s",
  bodyText: "b",
  status: "approved",
  weight: 1,
  ...over,
});

const pool: PoolTemplate[] = [
  tpl({ id: "sun_ok_a", weight: 3 }),
  tpl({ id: "sun_ok_b", weight: 1 }),
  tpl({ id: "sun_draft", status: "draft" }),
  tpl({ id: "sun_retired", status: "retired" }),
  tpl({ id: "sun_zero", weight: 0 }),
  tpl({ id: "blue_ok", brand: "bluerise" }),
  tpl({ id: "sun_other_stage", stage: "declined" }),
];

// ── Only approved, in-brand, in-stage, non-retired copy is selectable ─────
{
  const got = selectableTemplates(pool, { brand: "sunbiz", stage: "follow_up" });
  assert.deepEqual(got.map((t) => t.id), ["sun_ok_a", "sun_ok_b"], "heaviest first");
  assert.equal(got.every((t) => t.status === "approved"), true);
}

// Brand isolation, in both directions.
assert.deepEqual(
  selectableTemplates(pool, { brand: "bluerise", stage: "follow_up" }).map((t) => t.id),
  ["blue_ok"],
);
assert.equal(
  selectableTemplates(pool, { brand: "bluerise", stage: "follow_up" }).some((t) => t.brand === "sunbiz"),
  false,
  "a Bluerise step must never be offered SunBiz copy",
);

// Stage matching is case and whitespace tolerant, because operator-entered
// stage strings are not reliably normalised.
assert.equal(selectableTemplates(pool, { brand: "sunbiz", stage: "  Follow_Up " }).length, 2);
// An unknown stage offers NOTHING rather than falling back to some default.
assert.equal(selectableTemplates(pool, { brand: "sunbiz", stage: "made_up" }).length, 0);

// ── Validation fails closed, and says which rule refused ─────────────────
const base = {
  sequenceId: "seq1",
  stepIndex: 0,
  fromTemplateId: "sun_ok_a",
  actorUserId: "user-1",
  brand: "sunbiz" as const,
  stage: "follow_up",
};

assert.equal(validateInterchange(pool, { ...base, toTemplateId: "sun_ok_b" }).ok, true);

for (const [id, pattern] of [
  ["sun_draft", /draft, not approved/],
  ["sun_retired", /retired, not approved/],
  ["sun_zero", /soft-retired/],
  ["blue_ok", /belongs to bluerise/],
  ["sun_other_stage", /stage "declined"/],
  ["does_not_exist", /not found/],
] as const) {
  const v = validateInterchange(pool, { ...base, toTemplateId: id });
  assert.equal(v.ok, false, `${id} must be refused`);
  assert.match(v.ok === false ? v.reason : "", pattern);
}

// An unattributable change to live merchant mail is not acceptable.
assert.equal(validateInterchange(pool, { ...base, toTemplateId: "sun_ok_b", actorUserId: "" }).ok, false);
assert.equal(validateInterchange(pool, { ...base, toTemplateId: "" }).ok, false);
assert.equal(validateInterchange(pool, { ...base, toTemplateId: "sun_ok_b", stepIndex: -1 }).ok, false);

// ── The audit names who changed what ─────────────────────────────────────
assert.deepEqual(
  buildInterchangeAudit({ from: "sun_ok_a", to: "sun_ok_b", actor: "user-1", sequenceId: "seq1", stepIndex: 2 }),
  {
    action: "template_interchange",
    from: "sun_ok_a",
    to: "sun_ok_b",
    actor: "user-1",
    sequence_id: "seq1",
    step_index: 2,
  },
);
// A first assignment has no prior template, and null must survive as null
// rather than becoming an empty string that reads like a real id.
assert.equal(buildInterchangeAudit({ from: null, to: "x", actor: "u" }).from, null);

console.log("template-interchange.test.ts — all assertions passed");
