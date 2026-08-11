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
import { parseDripSteps } from "../lib/drips/types";
import {
  selectableTemplates,
  validateInterchange,
  buildInterchangeAudit,
  effectiveRole,
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

// ── The pin must survive validation ──────────────────────────────────────
// The interchange saves through PATCH /api/sequences/[id], which re-parses every
// step with parseDripSteps. If the parser dropped template_id the swap would be
// stripped on the very save that applied it — silently, and only in production,
// because the UI would still have reported success.
{
  const [parsed] = parseDripSteps([
    { channel: "email", delay_minutes: 0, subject: "s", body: "b", template_id: "tpl-42" },
  ]);
  assert.equal(parsed.template_id, "tpl-42", "the pin must round-trip through step validation");

  // Absent stays absent — an unpinned step must not gain an empty pin that
  // resolveCopy would then try to look up.
  const [plain] = parseDripSteps([{ channel: "email", delay_minutes: 0, subject: "s", body: "b" }]);
  assert.equal(plain.template_id, undefined);
  const [blank] = parseDripSteps([
    { channel: "email", delay_minutes: 0, subject: "s", body: "b", template_id: "" },
  ]);
  assert.equal(blank.template_id, undefined, "an empty string is not a pin");
}

// -- ROLE scoping: only offer what the engine can actually reach ----------
// Codex review round 2. The executor narrows the pool with
// poolFor(brand, stage, role) BEFORE resolveCopy sees the pin, so a template
// playing another role is out of scope at send time. Offering one produced a
// swap that saved cleanly, reported success, and changed nothing -- the exact
// silent no-op the pin was added to fix, one layer along.
{
  const mixed: PoolTemplate[] = [
    tpl({ id: "nudge_a", role: "nudge" }),
    tpl({ id: "opener_a", role: "opener" }),
    tpl({ id: "lastcall_a", role: "last_call" }),
    tpl({ id: "roleless", role: "" }),
  ];

  assert.deepEqual(
    selectableTemplates(mixed, { brand: "sunbiz", stage: "follow_up", role: "opener" }).map((t) => t.id),
    ["opener_a"],
    "an opener step is offered openers and nothing else",
  );
  assert.deepEqual(
    selectableTemplates(mixed, { brand: "sunbiz", stage: "follow_up", role: "last_call" }).map((t) => t.id),
    ["lastcall_a"],
    "an opener must never stand in for a last call",
  );

  // Unset role means "nudge" on BOTH sides, matching executor.ts's
  // `String(step.role || "nudge")`. If these two defaults ever drift, a
  // roleless step silently stops being able to pin anything.
  assert.equal(effectiveRole(undefined), "nudge");
  assert.equal(effectiveRole(""), "nudge");
  assert.equal(effectiveRole("  "), "nudge");
  assert.deepEqual(
    selectableTemplates(mixed, { brand: "sunbiz", stage: "follow_up" }).map((t) => t.id).sort(),
    ["nudge_a", "roleless"],
    "a step with no role gets the nudge bucket, and so does a template with no role",
  );

  // The validator refuses a cross-role pin rather than accepting one the send
  // path would ignore, and names the rule that refused.
  const req = {
    sequenceId: "seq1",
    stepIndex: 0,
    fromTemplateId: null,
    toTemplateId: "opener_a",
    actorUserId: "user-1",
    brand: "sunbiz" as const,
    stage: "follow_up",
    role: "last_call",
  };
  const verdict = validateInterchange(mixed, req);
  assert.equal(verdict.ok, false, "a cross-role pin must be refused, not silently ignored later");
  if (!verdict.ok) {
    assert.match(verdict.reason, /role/, "the refusal must name the rule so an operator can act on it");
    assert.match(verdict.reason, /opener/);
    assert.match(verdict.reason, /last_call/);
  }
  // ...and accepts the same swap once the roles line up.
  assert.equal(validateInterchange(mixed, { ...req, role: "opener" }).ok, true);
}

console.log("template-interchange.test.ts — all assertions passed");
