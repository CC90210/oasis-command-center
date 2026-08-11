/**
 * tests/drip-template-pool.test.ts — the approved template pool.
 *
 * Adon, 2026-08-05: "we have to make sure to be rotating similar approved
 * templates... We can add to your rotation if we have a couple that we came up
 * with or that we generated outside of it."
 *
 * Two properties matter and both are easy to get wrong:
 *
 *   1. APPROVAL IS A GATE, not a label. A draft must be unreachable, not merely
 *      deprioritised. Anyone can add a template; nothing reaches a merchant
 *      until a human approves it.
 *   2. SIMILAR means SAME JOB. Templates only substitute for others playing the
 *      same role in the arc — an opener never stands in for a last call. That is
 *      what makes rotation feel like variation rather than incoherence.
 *
 * Selection reuses the executor's existing stableIndex hash, so a given lead
 * gets the same template across retries and reclaims. A redelivery that picked a
 * different template would read to the merchant as a second, different email.
 */

import assert from "node:assert/strict";
import { selectFromPool, poolFor, resolveCopy, type PoolTemplate } from "../lib/drips/template-pool";

const mk = (over: Partial<PoolTemplate> = {}): PoolTemplate => ({
  id: "t1",
  brand: "sunbiz",
  stage: "follow_up",
  role: "opener",
  subject: "s",
  bodyText: "b",
  status: "approved",
  weight: 1,
  ...over,
});

// ---------------------------------------------------------------------------
// Deterministic per (lead, step)
// ---------------------------------------------------------------------------
const pool = [mk({ id: "a" }), mk({ id: "b" }), mk({ id: "c" })];
const first = selectFromPool(pool, "lead-1", 0);
assert.ok(first, "a pool of approved templates must yield one");
assert.equal(selectFromPool(pool, "lead-1", 0)?.id, first?.id, "stable across calls");
assert.equal(selectFromPool(pool, "lead-1", 0)?.id, first?.id, "stable again — retries must not re-roll");

// Different leads spread across the set.
const spread = new Set(
  ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].map((l) => selectFromPool(pool, l, 0)?.id),
);
assert.ok(spread.size > 1, "the pool must spread across different leads");

// Different steps for one lead vary, so a 3-step sequence is not one template
// three times.
assert.notEqual(
  selectFromPool(pool, "lead-1", 0)?.id,
  selectFromPool(pool, "lead-1", 1)?.id,
  "consecutive steps for one lead should differ",
);

// ---------------------------------------------------------------------------
// THE APPROVAL GATE
// ---------------------------------------------------------------------------
assert.equal(selectFromPool([mk({ status: "draft" })], "lead-1", 0), null, "a draft is unreachable");
assert.equal(selectFromPool([mk({ status: "retired" })], "lead-1", 0), null, "a retired template is unreachable");
assert.equal(
  selectFromPool([mk({ id: "d", status: "draft" }), mk({ id: "ok" })], "lead-1", 0)?.id,
  "ok",
  "drafts are filtered out, not merely ranked below",
);
// Every lead, every step: a pool of nothing but drafts NEVER yields one.
for (let i = 0; i < 25; i++) {
  assert.equal(
    selectFromPool([mk({ id: "d1", status: "draft" }), mk({ id: "d2", status: "retired" })], `lead-${i}`, i),
    null,
    "no seed may reach an unapproved template",
  );
}

// weight 0 is a soft retire — present for the record, never sent.
assert.equal(selectFromPool([mk({ weight: 0 })], "lead-1", 0), null, "weight 0 is unreachable");

// Weighting biases selection without becoming exclusive.
{
  const weighted = [mk({ id: "heavy", weight: 9 }), mk({ id: "light", weight: 1 })];
  const picks: Record<string, number> = { heavy: 0, light: 0 };
  for (let i = 0; i < 200; i++) {
    const p = selectFromPool(weighted, `lead-${i}`, 0);
    if (p) picks[p.id] = (picks[p.id] || 0) + 1;
  }
  assert.ok(picks.heavy > picks.light, "a heavier template is chosen more often");
  assert.ok(picks.light > 0, "but a lighter one is not excluded");
}

// ---------------------------------------------------------------------------
// Empty pool returns null so the caller falls back to the step's own copy.
// This is what keeps every existing sequence working before the pool is filled.
// ---------------------------------------------------------------------------
assert.equal(selectFromPool([], "lead-1", 0), null, "an empty pool falls through to the step copy");

// ---------------------------------------------------------------------------
// Malformed rows must not crash a dispatch run or leak through the gate.
// ---------------------------------------------------------------------------
assert.equal(
  selectFromPool([{ ...mk(), status: "nonsense" as unknown as PoolTemplate["status"] }], "lead-1", 0),
  null,
  "an unrecognised status is not approved",
);
assert.equal(
  selectFromPool([mk({ bodyText: "" })], "lead-1", 0),
  null,
  "a template with no body is unusable however approved it claims to be",
);
assert.equal(
  selectFromPool([mk({ weight: -5 })], "lead-1", 0),
  null,
  "a negative weight cannot resurrect a template",
);

// ---------------------------------------------------------------------------
// poolFor: rotation only ever swaps templates doing the SAME JOB
// ---------------------------------------------------------------------------
{
  const mixed = [
    mk({ id: "sb-fu-open", brand: "sunbiz", stage: "follow_up", role: "opener" }),
    mk({ id: "sb-fu-last", brand: "sunbiz", stage: "follow_up", role: "last_call" }),
    mk({ id: "br-fu-open", brand: "bluerise", stage: "follow_up", role: "opener" }),
    mk({ id: "sb-vw-open", brand: "sunbiz", stage: "viewed_application", role: "opener" }),
  ];
  assert.deepEqual(
    poolFor(mixed, "sunbiz", "follow_up", "opener").map((t) => t.id),
    ["sb-fu-open"],
    "an opener must never be substituted by a last call, another brand, or another stage",
  );
  assert.deepEqual(poolFor(mixed, "bluerise", "follow_up", "opener").map((t) => t.id), ["br-fu-open"]);
  assert.deepEqual(poolFor(mixed, "sunbiz", "follow_up", "revive"), [], "no match yields nothing");
}

// ---------------------------------------------------------------------------
// COPY PRECEDENCE — the property that makes this safe to deploy.
//
// With an empty pool the result must be byte-identical to the pre-pool
// behaviour, because that is what every live sequence relies on today.
// ---------------------------------------------------------------------------
{
  const step = {
    channel: "email" as const,
    delay_minutes: 0,
    subject: "plain subject",
    body: "plain body",
    subject_variants: ["sv0", "sv1", "sv2"],
    body_variants: ["bv0", "bv1", "bv2"],
  };

  // 1. Empty pool -> falls back to the step's variants, exactly as before.
  const noPool = resolveCopy(step, "lead-1", 0, []);
  assert.ok(noPool.body.startsWith("bv"), "empty pool falls back to body_variants");
  assert.equal(noPool.source, "step_variants");
  // And it picks the SAME variant the old code would have.
  const expectedIdx = [0, 1, 2].findIndex((i) => `bv${i}` === noPool.body);
  assert.equal(noPool.subject, `sv${expectedIdx}`, "subject stays paired with body by index");

  // 2. A step with no variants at all -> the plain body.
  const bare = resolveCopy(
    { channel: "email", delay_minutes: 0, subject: "s", body: "b" },
    "lead-1",
    0,
    [],
  );
  assert.equal(bare.body, "b");
  assert.equal(bare.subject, "s");
  assert.equal(bare.source, "step_body");

  // 3. An approved pool WINS over the step's own variants.
  const withPool = resolveCopy(step, "lead-1", 0, [mk({ id: "p1", subject: "pool subj", bodyText: "pool body" })]);
  assert.equal(withPool.body, "pool body", "an approved pool template takes precedence");
  assert.equal(withPool.subject, "pool subj");
  assert.equal(withPool.source, "pool");
  assert.equal(withPool.templateId, "p1", "the chosen template id is reported for the audit trail");

  // 4. A pool of ONLY drafts must fall back, not send a draft.
  const draftsOnly = resolveCopy(step, "lead-1", 0, [mk({ id: "d", status: "draft" })]);
  assert.equal(draftsOnly.source, "step_variants", "unapproved pool falls back to step copy");
  assert.ok(draftsOnly.body.startsWith("bv"));

  // 5. Determinism holds through the pool path too.
  const pool2 = [mk({ id: "a" }), mk({ id: "b" }), mk({ id: "c" })];
  assert.equal(
    resolveCopy(step, "lead-9", 3, pool2).templateId,
    resolveCopy(step, "lead-9", 3, pool2).templateId,
    "same lead + step must yield the same template every time",
  );
}

// ---------------------------------------------------------------------------
// A PIN beats sampling — the Drips tab interchange
// ---------------------------------------------------------------------------
// Codex review 2026-08-11 caught this: the tab wrote the chosen template's text
// onto the step, but resolveCopy samples the pool BEFORE it ever reads step
// copy, so with any approved pool present the swap changed nothing while the UI
// reported success. A swap that silently does not swap is worse than no feature.
{
  const step = { subject: "step subj", body: "step body", body_html: "<p>OLD TEMPLATE HTML</p>" };
  const wide = [
    mk({ id: "p1", subject: "one", bodyText: "body one" }),
    mk({ id: "p2", subject: "two", bodyText: "body two" }),
    mk({ id: "p3", subject: "three", bodyText: "body three" }),
  ];

  // For each lead, pin to a template the hash would NOT have chosen, so every
  // case is a genuine override rather than one that agrees by luck. Pinning to
  // whatever sampling already picked would pass against the old broken code.
  for (const lead of ["lead-1", "lead-2", "lead-3", "lead-77"]) {
    const natural = resolveCopy(step, lead, 0, wide).templateId;
    const other = wide.find((t) => t.id !== natural);
    assert.ok(other, "fixture must offer an alternative to sampling");
    const got = resolveCopy({ ...step, template_id: other.id }, lead, 0, wide);
    assert.notEqual(other.id, natural, `${lead} must be pinned AWAY from the sampled pick`);
    assert.equal(got.templateId, other.id, `pin must win for ${lead}`);
    assert.equal(got.body, other.bodyText);
    assert.equal(got.subject, other.subject);
  }

  // Stale HTML from the PREVIOUS template must be dropped. Keeping it sends
  // HTML-capable recipients the old copy while the text part carries the new —
  // the one outcome worse than not swapping at all.
  assert.equal(resolveCopy({ ...step, template_id: "p1" }, "lead-1", 0, wide).bodyHtml, undefined);

  // A pin to something no longer sendable must NOT send it, and must not
  // dead-end either: retiring a template is how copy gets withdrawn.
  const retired = resolveCopy({ ...step, template_id: "gone" }, "lead-1", 0, [
    mk({ id: "gone", status: "retired", bodyText: "withdrawn copy" }),
    mk({ id: "live", bodyText: "live copy" }),
  ]);
  assert.equal(retired.body, "live copy", "a pin to retired copy falls back to sampling");
  assert.notEqual(retired.templateId, "gone");

  // Soft retire (weight 0) is a retire.
  const zeroed = resolveCopy({ ...step, template_id: "z" }, "lead-1", 0, [
    mk({ id: "z", weight: 0, bodyText: "zeroed copy" }),
    mk({ id: "live", bodyText: "live copy" }),
  ]);
  assert.notEqual(zeroed.templateId, "z", "weight 0 is a soft retire; a pin cannot resurrect it");

  // And a pin can never smuggle a draft past the approval gate.
  const drafted = resolveCopy({ ...step, template_id: "d" }, "lead-1", 0, [mk({ id: "d", status: "draft", bodyText: "unreviewed" })]);
  assert.notEqual(drafted.body, "unreviewed", "approval is a gate, pin or no pin");
  assert.equal(drafted.source, "step_body");
}

console.log("drip-template-pool.test.ts — all assertions passed ✓");
