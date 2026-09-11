import assert from "node:assert";
import { rankObjections, CONSOLE_OPEN_COUNT, NEPHEW_BUILT_WEBSITE_SLUG } from "../lib/web-leads/objections/ranking";
import { SEEDED_SLUGS } from "../lib/web-leads/objections/seed-slugs";
import type { CatalogObjection, ObjectionFacts, WebsitePremise } from "../lib/web-leads/objections/types";

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

function obj(
  slug: string,
  family: CatalogObjection["family"],
  dimension: string | null = null,
  websitePremise: WebsitePremise | null = null,
): CatalogObjection {
  return {
    id: `id-${slug}`,
    slug,
    says: `says-${slug}`,
    meaning: "m",
    prevent: "p",
    family,
    source: null,
    dimension,
    websitePremise,
    answers: [
      { id: `a-${slug}`, label: "L", body: "b", posture: "agree_and_redirect", isDefault: true },
    ],
  };
}

// Real slugs, real families, real premises (per
// scripts/seed-objection-catalog.ts's UNIVERSAL_META / ANGLE_META, including
// the F2 reclassification of conversion-plenty-of-calls to no_need). No
// no_trust or no_authority slug exists in the real 15-row seed, so those two
// families have no fixture member here -- the frequency tie-break test below
// doesn't need one.
//
// word-of-mouth is in this fixture where it previously was not: the
// no-website block below cannot state the rule that replaced the old +30
// no_need boost without a second `substitute` row to prove the rule is keyed
// on the PREMISE and not on one slug.
const CATALOG: CatalogObjection[] = [
  obj("nephew-built-website", "already_handled", null, "requires_site"),
  obj("facebook-page-is-enough", "already_handled", null, "substitute"),
  obj("word-of-mouth", "already_handled", null, "substitute"),
  obj("trust-reviews-on-google", "already_handled", "trust", null),
  obj("no-budget", "no_money"),
  obj("just-send-email", "brush_off"),
  obj("conversion-plenty-of-calls", "no_need", "conversion", "requires_site"),
  obj("call-back-later", "brush_off"),
  obj("how-much-is-it", "no_money"),
];

// Every fixture slug must be one the seed actually writes, not just the one
// ranking.ts names. The F1 defect was a THREE-way disagreement (ranker,
// seed, fixture), and the guard above only closes two sides of it: a fixture
// slug invented here would still make every ordering assertion below a test
// of a catalog that does not exist.
for (const o of CATALOG) {
  assert.ok(
    (SEEDED_SLUGS as readonly string[]).includes(o.slug),
    `fixture slug ${JSON.stringify(o.slug)} is not in SEEDED_SLUGS -- this fixture is ranking a catalog the seed never writes`,
  );
}

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

// ---------------------------------------------------------------------------
// THE NO-WEBSITE RULE. Rewritten by the final whole-branch review, 2026-09-10,
// because the block that used to stand here PINNED THE DEFECT.
//
// History, both halves, because this rule has now been wrong twice for the
// same reason and the third author needs to see the pattern:
//
//   * It once dropped the WHOLE already_handled family by 35, on the premise
//     that already_handled means an incumbent website. Wrong for 5 of the
//     real catalog's 6 already_handled rows (task-7 fix round 1, finding F3).
//   * It then still raised the WHOLE no_need family by 30, on the premise
//     that no_need means "nothing is broken" generically. Wrong for ALL FOUR
//     real no_need rows: every one is a denial about an EXISTING site ("It
//     loads fine for me.", "It looks fine on my phone.", "Our customers do
//     not care what it looks like.", "We get plenty of calls."). Against the
//     real 15-row catalog that boost put four of them in the open five for a
//     lead with no website at all, while "We get all our work by word of
//     mouth." sat at #12 and "We have a Facebook page, that does the job."
//     at #10 -- both behind the "Show all 15" click, and both exactly what
//     such a business says. THIS BLOCK ASSERTED THAT ORDERING AS CORRECT.
//
// FAMILY IS THE WRONG CARRIER, in either direction. Whether an objection
// survives the absence of a website is a property of its wording, and it cuts
// across families. It is now a column on the catalog row
// (objection_catalog.website_premise, database/turso/172), written beside the
// copy in scripts/seed-objection-catalog.ts, and the ranker reads only that.
// Deliberately NOT a slug list in ranking.ts: finding F1 in this same branch
// was a ranking rule keyed on a slug literal that did not exist, silently a
// no-op forever.
//
// What the rule must now produce, stated as an outcome rather than an
// arithmetic: for a lead with no website, the OPEN cards must be objections
// that lead could actually raise.
// ---------------------------------------------------------------------------
{
  const withSite = order({ hasWebsite: true, overallScore: 55 });
  const noSite = order({ hasWebsite: false, overallScore: 55 });

  // 1. THE OUTCOME. Both substitute-channel objections -- the reasons a
  //    business gives for never having built a site -- must be reachable
  //    without a click. This is the finding in one assertion.
  for (const slug of ["word-of-mouth", "facebook-page-is-enough"]) {
    assert.ok(
      noSite.indexOf(slug) < CONSOLE_OPEN_COUNT,
      `no site: ${slug} must be among the ${CONSOLE_OPEN_COUNT} OPEN cards, not behind the expand control, got ${noSite.join(",")}`,
    );
  }

  // 2. And the website-condition denials must not lead. A rep cold-calling a
  //    business with no website must not be handed a card asking whether "it"
  //    loads fine.
  for (const slug of ["conversion-plenty-of-calls", "nephew-built-website"]) {
    assert.ok(
      noSite.indexOf(slug) >= CONSOLE_OPEN_COUNT,
      `no site: ${slug} presupposes a website and must not be an open card, got ${noSite.join(",")}`,
    );
  }

  // 3. requires_site is not a family rule. It moves an already_handled row
  //    (nephew) and a no_need row (conversion) the same way, and both fall
  //    behind premise-neutral no_money, which hasWebsite never touches.
  for (const slug of ["nephew-built-website", "conversion-plenty-of-calls"]) {
    assert.ok(
      withSite.indexOf(slug) < withSite.indexOf("no-budget"),
      `baseline: ${slug} should lead no_money with a site, got ${withSite.join(",")}`,
    );
    assert.ok(
      noSite.indexOf("no-budget") < noSite.indexOf(slug),
      `no site: no_money must overtake ${slug} once the requires_site penalty fires, got ${noSite.join(",")}`,
    );
  }

  // 4. substitute is not a family rule either, and this is the assertion that
  //    would have caught the ORIGINAL family-wide version: two of the three
  //    already_handled rows rise past brush_off (base 50, untouched), and the
  //    premise-NEUTRAL third (trust-reviews-on-google) does not move at all.
  //    A no-website lead can say "our reviews are all on Google", so it is
  //    neither penalised nor promoted -- it ranks on family base, immediately
  //    behind the open five.
  for (const slug of ["word-of-mouth", "facebook-page-is-enough"]) {
    assert.ok(
      withSite.indexOf("just-send-email") < withSite.indexOf(slug),
      `baseline: brush_off should lead ${slug} with a site, got ${withSite.join(",")}`,
    );
    assert.ok(
      noSite.indexOf(slug) < noSite.indexOf("just-send-email"),
      `no site: ${slug} must overtake brush_off once the substitute bonus fires, got ${noSite.join(",")}`,
    );
  }
  assert.ok(
    noSite.indexOf("just-send-email") < noSite.indexOf("trust-reviews-on-google"),
    `no site: a premise-NEUTRAL already_handled row must not be promoted with its family, got ${noSite.join(",")}`,
  );
  assert.ok(
    noSite.indexOf("trust-reviews-on-google") < noSite.indexOf("no-budget"),
    `no site: a premise-NEUTRAL already_handled row must not be penalised with its family either, got ${noSite.join(",")}`,
  );

  // 5. THE DEFAULT, stated as an invariant rather than a flip (it holds
  //    whether or not the rule exists, on purpose -- it is the safe-default
  //    property, not the rule): a catalog of nothing but unclassified rows
  //    ranks IDENTICALLY with and without a website. A Phase 2 author who
  //    adds a row and forgets website_premise gets "no opinion", never a
  //    wrong opinion, which is the failure mode both previous versions of
  //    this rule had.
  const neutralOnly = CATALOG.filter((o) => o.websitePremise === null);
  assert.ok(neutralOnly.length >= 3, "the neutral-default check needs premise-neutral fixture rows");
  assert.deepEqual(
    rankObjections(neutralOnly, { ...BASE, hasWebsite: false }).map((o) => o.slug),
    rankObjections(neutralOnly, { ...BASE, hasWebsite: true }).map((o) => o.slug),
    "an unclassified row must be untouched by hasWebsite, in either direction",
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
