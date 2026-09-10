import assert from "node:assert";
import { rankObjections, CONSOLE_OPEN_COUNT } from "../lib/web-leads/objections/ranking";
import type { CatalogObjection, ObjectionFacts } from "../lib/web-leads/objections/types";

// ---------------------------------------------------------------------------
// The ranker is the only thing standing between a rep and a list of twenty-five
// objections in arbitrary order while a stranger is talking. It is pure on
// purpose: every rule below is asserted directly, with no database and no
// fixture audit, because a ranking rule that is only exercised through the UI
// is a rule nobody checks.
// ---------------------------------------------------------------------------

function obj(slug: string, family: CatalogObjection["family"], dimension: string | null = null): CatalogObjection {
  return {
    id: `id-${slug}`,
    slug,
    says: `says-${slug}`,
    meaning: "m",
    prevent: "p",
    family,
    source: null,
    dimension,
    answers: [
      { id: `a-${slug}`, label: "L", body: "b", posture: "agree_and_redirect", isDefault: true },
    ],
  };
}

const CATALOG: CatalogObjection[] = [
  obj("already-have-a-guy", "already_handled"),
  obj("nephew-built-it", "already_handled"),
  obj("no-budget", "no_money"),
  obj("send-me-an-email", "brush_off"),
  obj("plenty-of-calls", "no_need", "conversion"),
  obj("who-are-you", "no_trust"),
  obj("not-my-call", "no_authority"),
];

const BASE: ObjectionFacts = {
  hasWebsite: true,
  overallScore: 55,
  dimensions: [{ key: "conversion", score: 40, weight: 1 }],
  builderPlatform: null,
  competitorGap: null,
  priorNoAnswerCalls: 0,
  selectedAngleKey: null,
};

function order(facts: Partial<ObjectionFacts>, frequency?: Record<string, number>): string[] {
  return rankObjections(CATALOG, { ...BASE, ...facts }, frequency).map((o) => o.slug);
}

// The console opens five and hides the rest behind one control. Pinned here
// because the number is a UI promise the ranker's caller relies on.
assert.equal(CONSOLE_OPEN_COUNT, 5);

// Every objection comes back. Ranking reorders; it never filters. A rep who
// needs the twenty-fifth objection must be able to reach it.
assert.equal(rankObjections(CATALOG, BASE).length, CATALOG.length);

// Ranking is a total order with no ties left to chance: two runs over the same
// input produce the same sequence, so a rep's muscle memory survives a reload.
assert.deepEqual(order({}), order({}));

// A lead with NO website cannot have "we already have someone doing it" as a
// top objection, and "nothing is broken" becomes the likely wall.
//
// already_handled (base 40) already trails no_need (base 45) even with the
// !hasWebsite rule deleted, so comparing those two directly proves nothing.
// Instead pick, for each half of the rule, a family the rule does NOT touch
// but that outranks the touched family at baseline -- so the touched family
// can only get ahead of it once its half of the rule actually fires.
{
  const withSite = order({ hasWebsite: true, overallScore: 55 });
  const noSite = order({ hasWebsite: false, overallScore: 55 });

  // already_handled (already-have-a-guy, 40) starts ahead of no_money
  // (no-budget, 35, untouched by hasWebsite) with a site, and falls behind
  // it once the -35 half of the rule fires.
  assert.ok(
    withSite.indexOf("already-have-a-guy") < withSite.indexOf("no-budget"),
    `baseline: already_handled should lead no_money with a site, got ${withSite.join(",")}`,
  );
  assert.ok(
    noSite.indexOf("no-budget") < noSite.indexOf("already-have-a-guy"),
    `no site: no_money should overtake already_handled once the -35 half fires, got ${noSite.join(",")}`,
  );

  // brush_off (send-me-an-email, 50, untouched by hasWebsite) starts ahead
  // of no_need (plenty-of-calls, 45) with a site, and falls behind it once
  // the +30 half of the rule fires.
  assert.ok(
    withSite.indexOf("send-me-an-email") < withSite.indexOf("plenty-of-calls"),
    `baseline: brush_off should lead no_need with a site, got ${withSite.join(",")}`,
  );
  assert.ok(
    noSite.indexOf("plenty-of-calls") < noSite.indexOf("send-me-an-email"),
    `no site: no_need should overtake brush_off once the +30 half fires, got ${noSite.join(",")}`,
  );
}

// A DIY builder detected on the crawl makes the nephew objection likely.
{
  const ranked = order({ builderPlatform: "wix" });
  assert.ok(ranked.indexOf("nephew-built-it") < 2, `nephew must be top-2 on a builder site, got ${ranked.join(",")}`);
}

// A high-scoring site with one narrow fault gets "we get plenty of calls".
//
// plenty-of-calls is already top-2 at baseline, so a top-2 check survives
// deleting the rule. Compare it directly against the family that leads at
// baseline instead, and require the rule to flip that specific pair.
{
  const midScore = order({ overallScore: 55 });
  const highScore = order({ overallScore: 88 });
  assert.ok(
    midScore.indexOf("send-me-an-email") < midScore.indexOf("plenty-of-calls"),
    `baseline: brush_off should lead no_need at score 55, got ${midScore.join(",")}`,
  );
  assert.ok(
    highScore.indexOf("plenty-of-calls") < highScore.indexOf("send-me-an-email"),
    `no_need must overtake brush_off once overallScore >= 75 fires, got ${highScore.join(",")}`,
  );
}

// A visibly poor site pushes the argument off "is it broken" (no_need) and
// onto money (no_money). No coverage existed at all before this: prove the
// same flip both ways.
{
  const midScore = order({ overallScore: 55 });
  const poorScore = order({ overallScore: 30 });
  assert.ok(
    midScore.indexOf("plenty-of-calls") < midScore.indexOf("no-budget"),
    `baseline: no_need should lead no_money at score 55, got ${midScore.join(",")}`,
  );
  assert.ok(
    poorScore.indexOf("no-budget") < poorScore.indexOf("plenty-of-calls"),
    `no_money must overtake no_need once overallScore < 40 fires, got ${poorScore.join(",")}`,
  );
}

// Repeated no-answers mean the rep finally caught someone who wants off the
// phone. Brush-offs rise.
//
// brush_off already has the highest family base (50), so nothing can start
// ahead of it without help. Lean on the frequency mechanism (covered and
// proven separately below) purely as a fixture tool: push a no_money
// objection to 55 via its own capped +20 bonus, a value that sits strictly
// between brush_off's base (50) and what brush_off becomes once this rule
// fires (50 + 25 = 75). Only the no-answer rule can close that specific gap.
{
  const freq = { "id-no-budget": 999 };
  const rested = rankObjections(CATALOG, { ...BASE, priorNoAnswerCalls: 0 }, freq).map((o) => o.slug);
  const chased = rankObjections(CATALOG, { ...BASE, priorNoAnswerCalls: 4 }, freq).map((o) => o.slug);
  assert.ok(
    rested.indexOf("no-budget") < rested.indexOf("send-me-an-email"),
    `baseline: the boosted no_money objection should lead brush_off before 4 no-answers, got ${rested.join(",")}`,
  );
  assert.ok(
    chased.indexOf("send-me-an-email") < chased.indexOf("no-budget"),
    `brush_off must overtake the boosted no_money objection once priorNoAnswerCalls >= 3 fires, got ${chased.join(",")}`,
  );
}

// A competitor measurably ahead makes "we already have someone" the reflex.
// No coverage existed at all before this: already_handled (40) trails
// no_need (45) at baseline, and the +10 bump is exactly enough to flip it.
{
  const noGap = order({ competitorGap: null });
  const bigGap = order({ competitorGap: 20 });
  assert.ok(
    noGap.indexOf("plenty-of-calls") < noGap.indexOf("already-have-a-guy"),
    `baseline: no_need should lead already_handled with no competitor gap, got ${noGap.join(",")}`,
  );
  assert.ok(
    bigGap.indexOf("already-have-a-guy") < bigGap.indexOf("plenty-of-calls"),
    `already_handled must overtake no_need once competitorGap >= 15 fires, got ${bigGap.join(",")}`,
  );
}

// The objection belonging to the SELECTED angle outranks the same family's
// other entries, because that is the push-back this specific opener invites.
{
  const ranked = order({ selectedAngleKey: "conversion", overallScore: 40 });
  assert.equal(ranked[0], "plenty-of-calls", `selected angle's objection leads, got ${ranked.join(",")}`);
}

// Ties break on tenant-wide frequency, so the list gets better as the database
// fills rather than staying frozen at the hand-written guesses.
{
  const flat: ObjectionFacts = { ...BASE, overallScore: 55, dimensions: [], selectedAngleKey: null };
  const a = rankObjections(CATALOG, flat, { "id-who-are-you": 90 }).map((o) => o.slug);
  const b = rankObjections(CATALOG, flat, { "id-not-my-call": 90 }).map((o) => o.slug);
  assert.ok(a.indexOf("who-are-you") < b.indexOf("who-are-you"), "frequency must break ties");
}

// Degenerate inputs return something a UI can render, never a throw. A rep
// mid-call is the worst possible audience for an exception.
assert.deepEqual(rankObjections([], BASE), []);
assert.equal(rankObjections(CATALOG, { ...BASE, overallScore: null, dimensions: [] }).length, CATALOG.length);

console.log("objection-ranking: OK");
