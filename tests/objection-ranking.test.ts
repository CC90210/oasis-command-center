import assert from "node:assert";
import { rankObjections, CONSOLE_OPEN_COUNT, NEPHEW_BUILT_WEBSITE_SLUG } from "../lib/web-leads/objections/ranking";
import { SEEDED_SLUGS } from "../lib/web-leads/objections/seed-slugs";
import type { CatalogObjection, ObjectionFacts } from "../lib/web-leads/objections/types";

// ---------------------------------------------------------------------------
// The ranker is the only thing standing between a rep and a list of twenty-five
// objections in arbitrary order while a stranger is talking. It is pure on
// purpose: every rule below is asserted directly, with no database and no
// fixture audit, because a ranking rule that is only exercised through the UI
// is a rule nobody checks.
//
// FIXTURE SLUGS ARE REAL, not invented (task-7 fix round 1, finding F1). Every
// slug below is one scripts/seed-objection-catalog.ts actually writes to
// objection_catalog, so this fixture and the live database cannot silently
// disagree the way they used to: ranking.ts hardcoded "nephew-built-it", the
// seed wrote "nephew-built-website", and this file's old fixture invented a
// third spelling that agreed with neither, so the builder-platform bonus was
// a no-op against real data and nothing here noticed.
// ---------------------------------------------------------------------------

// The guard itself: ranking.ts's one slug constant must be a real seeded
// slug. Placed first, before any rule-specific assertion, so a future rename
// on either side fails HERE with a message that names the drift, rather than
// failing several rule assertions downstream with no obvious common cause.
assert.ok(
  (SEEDED_SLUGS as readonly string[]).includes(NEPHEW_BUILT_WEBSITE_SLUG),
  `ranking.ts's NEPHEW_BUILT_WEBSITE_SLUG (${JSON.stringify(NEPHEW_BUILT_WEBSITE_SLUG)}) is not in ` +
    `lib/web-leads/objections/seed-slugs.ts's SEEDED_SLUGS -- the seed and the ranker have drifted ` +
    `apart again. Fix the slug in one of the two places, never rename it in a third.`,
);

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

// Real slugs, real families (per scripts/seed-objection-catalog.ts's
// UNIVERSAL_META / ANGLE_META, including the F2 reclassification of
// conversion-plenty-of-calls to no_need). No no_trust or no_authority slug
// exists in the real 15-row seed, so those two families have no fixture
// member here -- the frequency tie-break test below doesn't need one.
const CATALOG: CatalogObjection[] = [
  obj("nephew-built-website", "already_handled"),
  obj("facebook-page-is-enough", "already_handled"),
  obj("no-budget", "no_money"),
  obj("just-send-email", "brush_off"),
  obj("conversion-plenty-of-calls", "no_need", "conversion"),
  obj("call-back-later", "brush_off"),
  obj("how-much-is-it", "no_money"),
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

// The no-website rule (task-7 fix round 1, finding F3). It used to drop the
// WHOLE already_handled family by 35 whenever a lead had no website, on the
// premise that already_handled means an incumbent website. That was wrong
// for 5 of the real catalog's 6 already_handled rows: only
// nephew-built-website actually claims a website. The other already_handled
// objections (word of mouth, a Facebook page, off-site reviews, a directory
// listing, local reputation) are website-INDEPENDENT and are, if anything,
// MORE likely from a no-website lead -- they are precisely the reasons that
// lead gives for never having built a site. The rule now applies only to
// NEPHEW_BUILT_WEBSITE_SLUG; the +30 no_need half is unchanged.
{
  const withSite = order({ hasWebsite: true, overallScore: 55 });
  const noSite = order({ hasWebsite: false, overallScore: 55 });

  // The incumbent-website objection (already_handled, base 40) leads
  // no_money (35, untouched by hasWebsite) with a site, and falls behind it
  // once its website-specific -35 penalty fires.
  assert.ok(
    withSite.indexOf("nephew-built-website") < withSite.indexOf("no-budget"),
    `baseline: the incumbent-website objection should lead no_money with a site, got ${withSite.join(",")}`,
  );
  assert.ok(
    noSite.indexOf("no-budget") < noSite.indexOf("nephew-built-website"),
    `no site: no_money should overtake the incumbent-website objection once its penalty fires, got ${noSite.join(",")}`,
  );

  // A website-INDEPENDENT already_handled objection must NOT take that
  // penalty: it leads no_money with a site, and must still lead no_money
  // with no site, because the family-wide version of the rule is gone.
  assert.ok(
    withSite.indexOf("facebook-page-is-enough") < withSite.indexOf("no-budget"),
    `baseline: a website-independent already_handled objection should lead no_money with a site, got ${withSite.join(",")}`,
  );
  assert.ok(
    noSite.indexOf("facebook-page-is-enough") < noSite.indexOf("no-budget"),
    `no site: a website-independent already_handled objection must still lead no_money -- the penalty must not apply family-wide, got ${noSite.join(",")}`,
  );

  // The +30 no_need half is unchanged: brush_off (50, untouched) leads
  // no_need (45) with a site, and falls behind it once the whole-family +30
  // fires.
  assert.ok(
    withSite.indexOf("just-send-email") < withSite.indexOf("conversion-plenty-of-calls"),
    `baseline: brush_off should lead no_need with a site, got ${withSite.join(",")}`,
  );
  assert.ok(
    noSite.indexOf("conversion-plenty-of-calls") < noSite.indexOf("just-send-email"),
    `no site: no_need should overtake brush_off once the +30 half fires, got ${noSite.join(",")}`,
  );
}

// A DIY builder detected on the crawl makes the nephew objection likely.
{
  const ranked = order({ builderPlatform: "wix" });
  assert.ok(ranked.indexOf("nephew-built-website") < 2, `nephew must be top-2 on a builder site, got ${ranked.join(",")}`);
}

// A high-scoring site with one narrow fault gets "we get plenty of calls".
// conversion-plenty-of-calls is no_need (task-7 fix round 1, finding F2: it
// used to be misclassified already_handled -- "my own experience says
// nothing is broken" is no_need, the same shape as mobile-looks-fine and
// performance-loads-fine-for-me, not "an existing asset already covers this").
//
// conversion-plenty-of-calls is already top-2 at baseline, so a top-2 check
// survives deleting the rule. Compare it directly against the family that
// leads at baseline instead, and require the rule to flip that specific pair.
{
  const midScore = order({ overallScore: 55 });
  const highScore = order({ overallScore: 88 });
  assert.ok(
    midScore.indexOf("just-send-email") < midScore.indexOf("conversion-plenty-of-calls"),
    `baseline: brush_off should lead no_need at score 55, got ${midScore.join(",")}`,
  );
  assert.ok(
    highScore.indexOf("conversion-plenty-of-calls") < highScore.indexOf("just-send-email"),
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
    midScore.indexOf("conversion-plenty-of-calls") < midScore.indexOf("no-budget"),
    `baseline: no_need should lead no_money at score 55, got ${midScore.join(",")}`,
  );
  assert.ok(
    poorScore.indexOf("no-budget") < poorScore.indexOf("conversion-plenty-of-calls"),
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
    rested.indexOf("no-budget") < rested.indexOf("just-send-email"),
    `baseline: the boosted no_money objection should lead brush_off before 4 no-answers, got ${rested.join(",")}`,
  );
  assert.ok(
    chased.indexOf("just-send-email") < chased.indexOf("no-budget"),
    `brush_off must overtake the boosted no_money objection once priorNoAnswerCalls >= 3 fires, got ${chased.join(",")}`,
  );
}

// A competitor measurably ahead makes "we already have someone" the reflex.
// No coverage existed at all before this: already_handled (40) trails
// no_need (45) at baseline, and the +10 bump is exactly enough to flip it.
// Uses facebook-page-is-enough, not nephew-built-website, so this stays a
// clean test of the competitorGap rule alone -- nephew also carries the
// no-website penalty, which is not in play here (hasWebsite defaults true).
{
  const noGap = order({ competitorGap: null });
  const bigGap = order({ competitorGap: 20 });
  assert.ok(
    noGap.indexOf("conversion-plenty-of-calls") < noGap.indexOf("facebook-page-is-enough"),
    `baseline: no_need should lead already_handled with no competitor gap, got ${noGap.join(",")}`,
  );
  assert.ok(
    bigGap.indexOf("facebook-page-is-enough") < bigGap.indexOf("conversion-plenty-of-calls"),
    `already_handled must overtake no_need once competitorGap >= 15 fires, got ${bigGap.join(",")}`,
  );
}

// The objection belonging to the SELECTED angle outranks the same family's
// other entries, because that is the push-back this specific opener invites.
{
  const ranked = order({ selectedAngleKey: "conversion", overallScore: 40 });
  assert.equal(ranked[0], "conversion-plenty-of-calls", `selected angle's objection leads, got ${ranked.join(",")}`);
}

// Ties break on tenant-wide frequency, so the list gets better as the database
// fills rather than staying frozen at the hand-written guesses. Which two
// slugs doesn't matter -- at these flat facts only family base + frequency
// decide the order -- so call-back-later and how-much-is-it stand in for
// the retired no_trust/no_authority fixture entries (no real seeded slug
// exists in either family).
{
  const flat: ObjectionFacts = { ...BASE, overallScore: 55, dimensions: [], selectedAngleKey: null };
  const a = rankObjections(CATALOG, flat, { "id-call-back-later": 90 }).map((o) => o.slug);
  const b = rankObjections(CATALOG, flat, { "id-how-much-is-it": 90 }).map((o) => o.slug);
  assert.ok(a.indexOf("call-back-later") < b.indexOf("call-back-later"), "frequency must break ties");
}

// Degenerate inputs return something a UI can render, never a throw. A rep
// mid-call is the worst possible audience for an exception.
assert.deepEqual(rankObjections([], BASE), []);
assert.equal(rankObjections(CATALOG, { ...BASE, overallScore: null, dimensions: [] }).length, CATALOG.length);

console.log("objection-ranking: OK");
