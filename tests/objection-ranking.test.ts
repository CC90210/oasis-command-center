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
{
  const ranked = order({ hasWebsite: false });
  const noNeed = ranked.indexOf("plenty-of-calls");
  const handled = ranked.indexOf("already-have-a-guy");
  assert.ok(noNeed < handled, `no_need must outrank already_handled with no site, got ${ranked.join(",")}`);
}

// A DIY builder detected on the crawl makes the nephew objection likely.
{
  const ranked = order({ builderPlatform: "wix" });
  assert.ok(ranked.indexOf("nephew-built-it") < 2, `nephew must be top-2 on a builder site, got ${ranked.join(",")}`);
}

// A high-scoring site with one narrow fault gets "we get plenty of calls".
{
  const ranked = order({ overallScore: 88 });
  assert.ok(ranked.indexOf("plenty-of-calls") < 2, `plenty-of-calls must be top-2 at score 88, got ${ranked.join(",")}`);
}

// Repeated no-answers mean the rep finally caught someone who wants off the
// phone. Brush-offs rise.
{
  const ranked = order({ priorNoAnswerCalls: 4 });
  assert.ok(ranked.indexOf("send-me-an-email") < 3, `brush_off must rise after 4 no-answers, got ${ranked.join(",")}`);
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
