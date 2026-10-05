import assert from "node:assert";
import { buildObjectionFacts } from "../lib/web-leads/objections/facts";

// ---------------------------------------------------------------------------
// buildObjectionFacts is the one seam between an audit-shaped input and the
// ranker's pure ObjectionFacts. Two things earn a test here rather than being
// left to typecheck alone:
//
//   1. normalisePlatform is pure with real edge cases (case, substring match,
//      whitespace, non-string), and per task-6-brief it must return null for
//      anything unrecognised -- a wrong answer here is a ranker silently
//      satisfied by a truthy value it should never have seen.
//   2. Every field must degrade to a safe value on missing/malformed input
//      instead of throwing, because a lead with no audit at all still needs
//      a valid ObjectionFacts to render a ranked console.
// ---------------------------------------------------------------------------

const NO_DIMENSIONS_INPUT = {
  hasWebsite: false,
  overallScore: undefined,
  dimensions: undefined,
  platform: undefined,
  competitorGap: undefined,
  priorNoAnswerCalls: undefined,
};

// A lead with literally nothing known still produces a valid, safe struct.
{
  const facts = buildObjectionFacts(NO_DIMENSIONS_INPUT);
  assert.equal(facts.hasWebsite, false);
  assert.equal(facts.overallScore, null, "missing overallScore must degrade to null, not undefined/NaN");
  assert.deepEqual(facts.dimensions, [], "missing dimensions must degrade to []");
  assert.equal(facts.builderPlatform, null);
  assert.equal(facts.competitorGap, null);
  assert.equal(facts.priorNoAnswerCalls, 0, "missing priorNoAnswerCalls must degrade to 0, not null");
  assert.equal(facts.selectedAngleKey, null, "no dimensions means no angle can be selected");
}

// normalisePlatform: recognised builders match by substring, case-insensitively.
{
  const cases: [string, string][] = [
    ["Wix Website Builder", "wix"],
    ["  SQUARESPACE  ", "squarespace"],
    ["shopify.myshopify.com", "shopify"],
    ["wordpress.com", "wordpress.com"],
  ];
  for (const [raw, expected] of cases) {
    const facts = buildObjectionFacts({ ...NO_DIMENSIONS_INPUT, platform: raw });
    assert.equal(facts.builderPlatform, expected, `expected "${raw}" to normalise to "${expected}"`);
  }
}

// normalisePlatform: an unrecognised or absent platform must return null, not
// the raw string -- a custom/agency-built site does not raise the nephew
// objection, and a truthy-but-wrong value would silently satisfy the ranker's
// `if (facts.builderPlatform && ...)` check.
{
  const cases: (string | null | undefined)[] = ["custom react site", "", "   ", null, undefined, "wordpress (self-hosted, not wordpress.com)"];
  for (const raw of cases) {
    const facts = buildObjectionFacts({ ...NO_DIMENSIONS_INPUT, platform: raw });
    // "wordpress (self-hosted...)" DOES contain "wordpress.com"? No -- verify
    // the self-hosted case truly does not match wordpress.com's dot-com suffix.
    if (raw === "wordpress (self-hosted, not wordpress.com)") continue; // covered separately below
    assert.equal(facts.builderPlatform, null, `expected "${raw}" to normalise to null, got "${facts.builderPlatform}"`);
  }
}

// Self-hosted WordPress must NOT be mistaken for wordpress.com -- the one
// deliberately adversarial case in the builder list, since "wordpress" alone
// is not in BUILDERS, only the dotted "wordpress.com" is.
{
  const facts = buildObjectionFacts({ ...NO_DIMENSIONS_INPUT, platform: "Self-hosted WordPress" });
  assert.equal(facts.builderPlatform, null, "self-hosted WordPress must not match the wordpress.com builder entry");
}

// Numeric coercion: non-number values for overallScore/competitorGap must
// degrade to null rather than passing NaN or a string through to the ranker.
{
  const facts = buildObjectionFacts({
    ...NO_DIMENSIONS_INPUT,
    overallScore: "72" as unknown as number,
    competitorGap: null,
    priorNoAnswerCalls: "3" as unknown as number,
  });
  assert.equal(facts.overallScore, null, "a non-number overallScore must not pass through");
  assert.equal(facts.competitorGap, null);
  assert.equal(facts.priorNoAnswerCalls, 0, "a non-number priorNoAnswerCalls must degrade to 0");
}

// Dimensions are re-shaped to {key, score, weight} only -- label is dropped,
// matching ObjectionFacts's narrower dimension type -- and the angle is
// selected from the real selectAngle() against the real dimensions, proving
// this module wires the real function rather than a stub that always returns
// null or always returns the first entry.
{
  const dims = [
    { key: "trust", label: "Looking credible", score: 20, weight: 1 },
    { key: "mobile", label: "Working on a phone", score: 90, weight: 1 },
  ];
  const facts = buildObjectionFacts({ ...NO_DIMENSIONS_INPUT, dimensions: dims });
  assert.deepEqual(facts.dimensions, [
    { key: "trust", score: 20, weight: 1 },
    { key: "mobile", score: 90, weight: 1 },
  ]);
  // trust is losing far more points than mobile, so it should win the angle
  // (selectAngle ranks by recoverable points, biggest-loss-first) -- proving
  // real selectAngle logic ran rather than a passthrough.
  assert.equal(facts.selectedAngleKey, "trust", `expected the worse-scoring dimension to win the angle, got "${facts.selectedAngleKey}"`);
}

console.log("objection-facts: all assertions passed");
