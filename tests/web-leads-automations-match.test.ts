import assert from "node:assert";
import { CAPABILITIES } from "../lib/web-leads/automations";
import { matchCapabilities } from "../lib/web-leads/automations-match";
import { recoverablePoints } from "../lib/web-leads/angles";
import type { DimensionProfile } from "../lib/web-leads/audit";

// ---------------------------------------------------------------------------
// A rep opens the battle card mid-call. This module decides, from the audit
// already on screen, which of the 15 reviewed capabilities to lead with,
// which to leave behind the "show all" affordance, and which belong to the
// offer ladder that is never ranked against a defect at all. It is pure: no
// I/O, no model call, so it is testable one rule at a time and safe to call
// on every render.
//
// TODAY_IDS / LADDER_IDS are derived from CAPABILITIES itself, not typed in,
// for the same reason web-leads-automations.test.ts never hardcodes a count:
// a number typed into a test drifts the moment the catalogue changes and
// then fails for the wrong reason.
// ---------------------------------------------------------------------------

const TODAY_IDS = CAPABILITIES.filter((c) => c.stage === "today").map((c) => c.id);
const LADDER_IDS = CAPABILITIES.filter((c) => c.stage !== "today").map((c) => c.id);

function check(code: string, points: number, has: boolean) {
  return { code, label: code, points, has };
}

/** The score `quality-model.js`'s `scoreDimension` would actually STORE for
 *  these checks: `Math.round((earned / total) * 100)`. Written out here so
 *  every fixture in this file is self-consistent with production, and so no
 *  fixture can pin a score production cannot produce. Fix round 2's
 *  cross-dimension fixture used `81.25`, which would have been stored as
 *  `81`; the assertion passed while testing a shape the model never emits.
 *  (Fix round 3, 2026-09-14.) */
function storedScore(checks: ReturnType<typeof check>[]): number {
  const total = checks.reduce((n, c) => n + c.points, 0);
  if (total === 0) return 0;
  const earned = checks.reduce((n, c) => (c.has ? n + c.points : n), 0);
  return Math.round((earned / total) * 100);
}

function dims(checks: ReturnType<typeof check>[]): DimensionProfile[] {
  return [{ key: "fixture", label: "fixture", score: storedScore(checks), weight: 1, checks, missing: [] }];
}

/** The recoverable key is a weighted float now (fix round 2), so equality
 *  on it is an epsilon, matching the 1e-9 the module's own comparator and
 *  `selectAngle` both use. */
function closeTo(actual: number | null, expected: number, message: string) {
  assert.ok(typeof actual === "number", `${message}: expected a number, got ${actual}`);
  assert.ok(
    Math.abs((actual as number) - expected) < 1e-9,
    `${message}: expected ${expected}, got ${actual}`,
  );
}

// A fixture grounded in real bundle codes (automations.ts is reviewed and
// final; this file only reads it): tel_link fails inside "easy-to-call",
// booking fails inside "book-themselves-in", cta_present fails inside
// "tell-them-what-to-do-next", fast_ttfb fails inside
// "load-fast-enough-to-stay". phone_in_header, lean_html and few_blocking
// pass, so they must not count toward any recoverable total. credentials
// (part of "look-established") also passes, on its own with none of
// look-established's other seven codes observed, so look-established lands
// in rest with a REAL 0 (audited, confirmed clean) -- deliberately distinct
// from the other five rest entries below, which have NONE of their codes
// represented at all and must come out `null` (never observed, the
// realistic "unscored for this lead" case, not a fabricated one).
const MIXED = dims([
  check("tel_link", 10, false),
  check("phone_in_header", 8, true),
  check("booking", 25, false),
  check("cta_present", 5, false),
  check("fast_ttfb", 5, false),
  check("lean_html", 12, true),
  check("few_blocking", 7, true),
  check("credentials", 6, true),
]);

function allIds(m: ReturnType<typeof matchCapabilities>): string[] {
  return [...m.relevant, ...m.rest, ...m.ladder].map((x) => x.capability.id);
}

// ---------------------------------------------------------------------------
// 1. A capability with a failed code lands in relevant; one with none lands
//    in rest. Neither is dropped.
// ---------------------------------------------------------------------------
{
  const m = matchCapabilities(MIXED, { hasWebsite: true });

  const easyToCall = m.relevant.find((x) => x.capability.id === "easy-to-call");
  assert.ok(easyToCall, "easy-to-call failed tel_link for this lead and must be in relevant");
  assert.deepEqual(easyToCall!.failedCodes, ["tel_link"], "only the failing code is named, not phone_in_header");
  // WEIGHTED off the STORED score, not the raw 10 and not an unrounded
  // derivation. MIXED is one dimension of weight 1, raw total 78, earned
  // 33, so the stored score is Math.round(42.307...) = 42 and the whole
  // dimension has (100 - 42) * 1 = 58 recoverable points. 45 raw points
  // are failing, of which tel_link is 10, so tel_link's share is
  // 58 * 10 / 45. The literal is written out rather than recomputed from
  // the formula, so this assertion is independent of the implementation it
  // is checking.
  closeTo(easyToCall!.recoverable, 12.88888888888889, "easy-to-call is weighted off the stored score");

  const reach = m.rest.find((x) => x.capability.id === "reach-without-phoning");
  assert.ok(reach, "reach-without-phoning has no failing code for this lead and must be in rest, not dropped");
  assert.deepEqual(reach!.failedCodes, []);
  assert.equal(reach!.recoverable, null, "none of reach-without-phoning's codes were observed, so it is unscored, not a verified 0");

  assert.ok(!m.relevant.some((x) => x.capability.id === "reach-without-phoning"), "a clean capability is not also in relevant");
  assert.ok(!m.rest.some((x) => x.capability.id === "easy-to-call"), "a failing capability is not also in rest");
}
console.log("web-leads-automations-match: bucketing OK");

// ---------------------------------------------------------------------------
// 2. relevant is ordered by summed WEIGHTED recoverable points, descending,
//    with a deterministic tie-break (capability id, ascending) so two
//    renders agree. MIXED is a single dimension, so every entry is scaled
//    by the same 58/45 and the order is unchanged from the raw one:
//    book-themselves-in (25 raw, 32.22), easy-to-call (10 raw, 12.89), then
//    a genuine tie at 5 raw / 6.44 between load-fast-enough-to-stay and
//    tell-them-what-to-do-next, broken by id:
//    "load-fast-enough-to-stay" < "tell-them-what-to-do-next".
//
//    That the order is unchanged HERE is the point of section 2a below: a
//    one-dimension fixture cannot tell a raw key from a weighted one, which
//    is exactly how the raw key survived Task 3's review.
// ---------------------------------------------------------------------------
{
  const m = matchCapabilities(MIXED, { hasWebsite: true });
  assert.deepEqual(
    m.relevant.map((x) => x.capability.id),
    ["book-themselves-in", "easy-to-call", "load-fast-enough-to-stay", "tell-them-what-to-do-next"],
    "relevant must be recoverable-points descending with an id tie-break",
  );

  // Two renders of the same lead agree, bit for bit.
  const again = matchCapabilities(MIXED, { hasWebsite: true });
  assert.deepEqual(
    again.relevant.map((x) => x.capability.id),
    m.relevant.map((x) => x.capability.id),
    "a second render of the same lead must produce the identical sequence",
  );
}
console.log("web-leads-automations-match: ordering + tie-break OK");

// ---------------------------------------------------------------------------
// 2a. THE ORDERING IS WEIGHTED, AND THIS IS THE CASE THAT PROVES IT.
//
//     Raw check points are not comparable across dimensions: each dimension
//     normalises to its own raw total and then carries a different weight
//     into the composite, so one raw point is worth between 0.2708 and
//     0.0800 composite. `angles.ts` carries the standing warning above
//     `selectAngle`: "Ranking on the raw score sends a rep into the smaller
//     conversation and, worse, into the smaller build."
//
//     The real numbers from the scoring model. `local_schema` is worth 36
//     raw inside discoverability (raw total 100, weight 0.08) => 2.88
//     composite. `tel_link` is worth 18 raw inside conversion (raw total
//     96, weight 0.26) => 4.875 composite. So RAW ranks structured data
//     markup FIRST and tap-to-call second; WEIGHTED ranks them the other
//     way round, and weighted is the order `selectAngle` already used to
//     choose the angle printed higher on the same card. Under the raw key
//     the card contradicted itself.
//
//     PROVED TO FIRE: reverting the module to `pointsByCode` (raw) flips
//     this sequence and the first assertion below fails with
//     "expected [ 'easy-to-call', 'findable-and-safe-to-click' ]". Run
//     2026-09-14 before the fix, on this exact fixture.
// ---------------------------------------------------------------------------
{
  // Raw total 96, matching the model's conversion dimension. earned 78, so
  // scoreDimension STORES Math.round(81.25) = 81, and the dimension has
  // (100 - 81) * 0.26 = 4.94 recoverable. NOTE the 81, not 81.25: fix round
  // 2's version of this fixture wrote the unrounded value, which production
  // can never store, so it pinned nothing.
  const CONV_CHECKS = [check("tel_link", 18, false), check("phone_in_header", 78, true)];
  // Raw total 100, matching the model's discoverability dimension. earned
  // 64, stored score 64 exactly, so (100 - 64) * 0.08 = 2.88 recoverable.
  const DISC_CHECKS = [check("local_schema", 36, false), check("https", 64, true)];
  const CROSS: DimensionProfile[] = [
    { key: "conversion", label: "Conversion", score: storedScore(CONV_CHECKS), weight: 0.26, missing: [], checks: CONV_CHECKS },
    { key: "discoverability", label: "Discoverability", score: storedScore(DISC_CHECKS), weight: 0.08, missing: [], checks: DISC_CHECKS },
  ];
  assert.equal(CROSS[0].score, 81, "the fixture must carry the score production would store, not the unrounded one");

  const m = matchCapabilities(CROSS, { hasWebsite: true });

  assert.deepEqual(
    m.relevant.map((x) => x.capability.id),
    ["easy-to-call", "findable-and-safe-to-click"],
    "tap-to-call (18 raw / 4.94 weighted) must outrank structured data markup (36 raw / 2.88 weighted): ranking on raw points sends the rep into the smaller build",
  );

  closeTo(m.relevant[0].recoverable, 4.94, "tel_link weighted off the stored score");
  closeTo(m.relevant[1].recoverable, 2.88, "local_schema weighted off the stored score");

  // And the figure is in the SAME UNIT as the number the rest of the card
  // prints. easy-to-call covers tel_link and phone_in_header, which are ALL
  // of the conversion dimension's checks here, so its bundle sum must
  // recover `recoverablePoints` for that whole dimension. Asserted with
  // `closeTo`, and that is not laziness: the shares are summed in floating
  // point and land within 2 ulp of the total rather than always on it. See
  // §2b for the measurement. (This identity holds per-dimension, not
  // per-bundle in general: a bundle usually covers only part of a dimension.
  // The fixture is built so it does not.)
  closeTo(
    m.relevant[0].recoverable,
    recoverablePoints(CROSS[0]),
    "a bundle covering all of a dimension's failing codes must equal recoverablePoints for that dimension",
  );
  closeTo(
    m.relevant[1].recoverable,
    recoverablePoints(CROSS[1]),
    "same identity on the discoverability side",
  );
}
console.log("web-leads-automations-match: weighted ordering across dimensions OK");

// ---------------------------------------------------------------------------
// 2b. THE KEY COMES OFF THE STORED, ROUNDED SCORE. Fix round 3, 2026-09-14.
//
//     `scoreDimension` in quality-model.js stores
//     `Math.round((earned / total) * 100)`, and `recoverablePoints` reads
//     that stored value. Deriving the share from `points / rawTotal`
//     instead reconstructs an UNROUNDED score, and the two disagree by up
//     to 0.5 * weight. Across the 1,145 reachable failing-subsets (the sum
//     of 2^n - 1 per dimension; the empty failing set is not a failing
//     subset) that put 504 of them (44%) at a different printed figure from `FixFirst` on
//     the same card, and ordered 1,764 dimension pairs oppositely to
//     `selectAngle`.
//
//     This is the coordinator's worked example, built to production shape.
//     conversion: raw total 96, tel_link 18 failing => earned 78 => stored
//     score 81 => 19 * 0.26 = 4.94. trust: raw total 92, testimonials 25
//     failing => earned 67 => stored score round(72.826) = 73 => 27 * 0.18
//     = 4.86. So conversion outranks trust, which is what
//     `recoverablePoints` says and therefore what the angle at the top of
//     the card says.
//
//     Under the UNROUNDED derivation the same lead gives conversion
//     18 * 0.26 * 100 / 96 = 4.875 and trust 25 * 0.18 * 100 / 92 = 4.8913,
//     so trust would outrank conversion and the card would contradict
//     itself again.
//
//     PROVED TO FIRE: restoring the round-2 expression flips the sequence
//     to ["look-established", "easy-to-call"]. Run 2026-09-14.
// ---------------------------------------------------------------------------
{
  const CONV = [check("tel_link", 18, false), check("phone_in_header", 78, true)];
  const TRUST = [check("testimonials", 25, false), check("credentials", 67, true)];
  const ROUNDED: DimensionProfile[] = [
    { key: "conversion", label: "Conversion", score: storedScore(CONV), weight: 0.26, missing: [], checks: CONV },
    { key: "trust", label: "Trust", score: storedScore(TRUST), weight: 0.18, missing: [], checks: TRUST },
  ];
  assert.equal(ROUNDED[0].score, 81, "conversion stores 81, not 81.25");
  assert.equal(ROUNDED[1].score, 73, "trust stores 73, not 72.826");

  const m = matchCapabilities(ROUNDED, { hasWebsite: true });
  assert.deepEqual(
    m.relevant.map((x) => x.capability.id),
    ["easy-to-call", "look-established"],
    "conversion(18 raw) must outrank trust(25 raw) off the STORED scores, as recoverablePoints and therefore selectAngle do; the unrounded derivation reverses this",
  );
  closeTo(m.relevant[0].recoverable, 4.94, "conversion off the stored 81, not 4.875 off an unrounded 81.25");
  closeTo(m.relevant[1].recoverable, 4.86, "trust off the stored 73, not 4.8913 off an unrounded 72.826");

  // The identity that makes the figure printable: both bundles here own ALL
  // of their dimension's failing codes, so each recovers recoverablePoints
  // for its dimension.
  //
  // HOW EXACT, SAID PROPERLY (corrected in Task 5, 2026-09-14). This comment
  // used to claim the identity holds "bit for bit" on every lead, and the
  // message below said "EQUAL exactly". It does not. The shares are divided
  // out per code and added back up in binary floating point, so the sum
  // recovers the total exactly in most cases and lands within 2 ulp of it in
  // the rest: enumerating the 1,145 reachable failing-subsets (the sum of
  // 2^n - 1 per dimension, because a dimension with nothing failing is not a
  // failing subset) finds exact `===` in 857 and a difference in 288, worst
  // case 2 ulp, and an independent 185,815-case randomised sweep the same. Under
  // 1e-14 across the range this module produces, which is orders of
  // magnitude below the comparator's 1e-9 tie and invisible at one decimal
  // place, so nothing a rep sees moves.
  //
  // The assertions stay STRICT rather than being relaxed to the bound,
  // because these two fixtures are in the exact 857 and a strict check is
  // the stronger pin for them. What changed is the claim in the message: it
  // now says exact ON THIS FIXTURE, not exact everywhere.
  assert.equal(
    m.relevant[0].recoverable,
    recoverablePoints(ROUNDED[0]),
    "a bundle owning all of a dimension's failing codes must recover recoverablePoints for that dimension; on this fixture the float sum lands on it exactly, and in general within 2 ulp of it",
  );
  assert.equal(
    m.relevant[1].recoverable,
    recoverablePoints(ROUNDED[1]),
    "same identity on the trust side, exact on this fixture and within 2 ulp in general",
  );
}
console.log("web-leads-automations-match: key derives from the stored rounded score OK");

// ---------------------------------------------------------------------------
// 2c. THE COMPARATOR'S TIE IS AN EPSILON, AND IT IS REACHABLE.
//
//     Added in fix round 2 and pinned by nothing until now: replacing
//     `Math.abs(diff) > 1e-9` with `diff !== 0` left this file and all 40
//     suite files green. It is reachable, and this is a production-shaped
//     lead that reaches it.
//
//     conversion: raw total 100, tel_link 7 failing => stored score 93 =>
//     7 * 0.26 = 1.82. design: raw total 100, favicon 13 failing => stored
//     score 87 => 13 * 0.14 = 1.8200000000000003. The same number to any
//     decimal anyone would print, 2.22e-16 apart in float.
//
//     "easy-to-call" sorts before "look-current" by id, and carries the
//     SMALLER float. So a strict comparator puts look-current first on
//     2.22e-16 of noise, and the epsilon falls through to the id as the
//     module's docblock says it does.
//
//     PROVED TO FIRE: with `diff !== 0` the sequence below comes back
//     ["look-current", "easy-to-call"]. Run 2026-09-14.
// ---------------------------------------------------------------------------
{
  const CONV = [check("tel_link", 7, false), check("phone_in_header", 93, true)];
  const DESIGN = [check("favicon", 13, false), check("web_fonts", 87, true)];
  const NOISE: DimensionProfile[] = [
    { key: "conversion", label: "Conversion", score: storedScore(CONV), weight: 0.26, missing: [], checks: CONV },
    { key: "design", label: "Design", score: storedScore(DESIGN), weight: 0.14, missing: [], checks: DESIGN },
  ];
  const m = matchCapabilities(NOISE, { hasWebsite: true });

  const easy = m.relevant.find((x) => x.capability.id === "easy-to-call")!;
  const current = m.relevant.find((x) => x.capability.id === "look-current")!;
  assert.notEqual(
    easy.recoverable,
    current.recoverable,
    "the fixture must actually produce two DIFFERENT floats, or this pins nothing",
  );
  assert.ok(
    Math.abs((easy.recoverable as number) - (current.recoverable as number)) < 1e-9,
    "and they must be within the epsilon, or it is an ordinary ordering case",
  );
  assert.ok(
    (easy.recoverable as number) < (current.recoverable as number),
    "easy-to-call must carry the SMALLER float, so a strict comparator would put look-current first",
  );
  assert.deepEqual(
    m.relevant.map((x) => x.capability.id),
    ["easy-to-call", "look-current"],
    "two keys 2.22e-16 apart are a tie and must fall through to the id tie-break; a strict !== ranks on floating-point noise instead",
  );
}
console.log("web-leads-automations-match: epsilon tie is reachable and pinned OK");

// ---------------------------------------------------------------------------
// 3. null sorts after every real number, including a real 0 (fix round 1,
//    2026-09-14). MIXED marks "credentials" (one of look-established's eight
//    codes) as observed and passing, with none of the bundle's other seven
//    codes observed at all -- so look-established is genuinely audited and
//    clean (a real 0), while the other five rest entries have NONE of their
//    codes observed and must be null. This mix is reached through the
//    public matchCapabilities() call, not a synthetic call into the
//    comparator: a real 0 must sort before every null, never after and
//    never merely tied.
// ---------------------------------------------------------------------------
{
  const m = matchCapabilities(MIXED, { hasWebsite: true });

  const established = m.rest.find((x) => x.capability.id === "look-established");
  assert.ok(established, "look-established must land in rest: credentials passed, nothing failed");
  assert.equal(established!.recoverable, 0, "credentials was observed and passed, so this is a real, verified 0");

  assert.deepEqual(
    m.rest.map((x) => x.capability.id),
    [
      "look-established",
      "findable-and-safe-to-click",
      "look-current",
      "reach-without-phoning",
      "say-what-you-do",
      "work-on-a-phone",
    ],
    "a verified real 0 must sort before every null; nulls tie-break by id",
  );
  for (const x of m.rest) {
    if (x.capability.id === "look-established") continue;
    assert.equal(x.recoverable, null, `${x.capability.id}: none of its codes were observed by this audit`);
  }
}
console.log("web-leads-automations-match: null sorts after every real number OK");

// ---------------------------------------------------------------------------
// 4. Ladder entries (stage !== "today") always land in ladder, regardless of
//    dimensions, and never in relevant or rest.
// ---------------------------------------------------------------------------
{
  const m = matchCapabilities(MIXED, { hasWebsite: true });
  assert.deepEqual(
    m.ladder.map((x) => x.capability.id).sort(),
    [...LADDER_IDS].sort(),
    "every ladder entry must be present, and only ladder entries",
  );
  for (const x of m.ladder) {
    assert.equal(x.capability.stage === "today", false, `${x.capability.id} is in ladder but has stage "today"`);
    assert.deepEqual(x.failedCodes, [], `${x.capability.id} is a ladder entry and carries no codes to fail`);
    assert.equal(x.recoverable, 0, `${x.capability.id}: a ladder entry has no codes at all, so this is a real, structural 0, not null`);
  }
  assert.ok(
    !m.relevant.some((x) => LADDER_IDS.includes(x.capability.id)),
    "no ladder entry may appear in relevant",
  );
  assert.ok(
    !m.rest.some((x) => LADDER_IDS.includes(x.capability.id)),
    "no ladder entry may appear in rest",
  );

  // Also true with no audit at all.
  const empty = matchCapabilities([], { hasWebsite: true });
  assert.deepEqual(empty.ladder.map((x) => x.capability.id).sort(), [...LADDER_IDS].sort());
}
console.log("web-leads-automations-match: ladder always present OK");

// ---------------------------------------------------------------------------
// 5. No audit at all (empty dimensions): every website capability in rest,
//    none in relevant, the full ladder. Nothing throws, nothing is empty.
//    recoverable is null throughout rest, not 0: no code of any capability
//    was ever observed, so nothing here is a verified anything.
// ---------------------------------------------------------------------------
{
  const m = matchCapabilities([], { hasWebsite: true });
  assert.equal(m.relevant.length, 0, "no audit means no defect is known, so nothing is ranked as relevant");
  assert.deepEqual(
    m.rest.map((x) => x.capability.id).sort(),
    [...TODAY_IDS].sort(),
    "every today capability renders, unranked, rather than a blank panel",
  );
  for (const x of m.rest) {
    assert.equal(x.recoverable, null, `${x.capability.id}: with no audit at all, nothing was observed, so this is unscored not zero`);
  }
  assert.equal(m.ladder.length, LADDER_IDS.length);
  assert.ok(m.rest.length > 0, "rest must not be empty when there is no audit");
  assert.ok(m.ladder.length > 0, "ladder must not be empty when there is no audit");
}
console.log("web-leads-automations-match: no-audit case OK");

// ---------------------------------------------------------------------------
// 6. hasWebsite: false. Decision made here, not left implicit: "we would fix
//    your tap-to-call button" is nonsense when there is no site, so the
//    website group is not defect-ranked at all. Every today capability is
//    treated as one buildable set and placed in relevant, with failedCodes
//    equal to the FULL code list it covers (nothing to point to, because
//    none of it exists yet) and recoverable set to null, because there is no
//    audit and therefore no scored points to sum -- null here, not 0, and a
//    caller must not print it as a score of any kind, including zero.
//
//    This is asserted so it cannot be satisfied by a no-op: a matcher that
//    silently treated hasWebsite:false the same as "no audit at all" would
//    put everything in rest with relevant empty (case 5, above) instead of
//    everything in relevant. The two assertions below are the same shape as
//    case 5 with the buckets swapped, which is exactly what would have to
//    change for an accidental pass-through to slip by.
// ---------------------------------------------------------------------------
{
  const m = matchCapabilities([], { hasWebsite: false });
  assert.deepEqual(
    m.relevant.map((x) => x.capability.id).sort(),
    [...TODAY_IDS].sort(),
    "with no website, every website capability is the single buildable pitch, in relevant",
  );
  assert.equal(m.rest.length, 0, "with no website, nothing is held back behind show-all");
  for (const x of m.relevant) {
    const cap = CAPABILITIES.find((c) => c.id === x.capability.id)!;
    assert.deepEqual(x.failedCodes, cap.codes, `${x.capability.id}: with no website every code it covers is undelivered`);
    assert.equal(x.recoverable, null, `${x.capability.id}: no audit ran, so recoverable is null, never a rendered score`);
  }
  assert.equal(m.ladder.length, LADDER_IDS.length);

  // Even with an audit present (a stale/contradictory input), hasWebsite is
  // authoritative: the caller is asserting there is no site, full stop.
  const withStaleAudit = matchCapabilities(MIXED, { hasWebsite: false });
  assert.deepEqual(
    withStaleAudit.relevant.map((x) => x.capability.id).sort(),
    [...TODAY_IDS].sort(),
    "hasWebsite:false overrides whatever dimensions were passed",
  );
}
console.log("web-leads-automations-match: hasWebsite:false OK");

// ---------------------------------------------------------------------------
// 7. Conservation: every capability appears exactly once across the three
//    buckets, for every scenario above. Nothing is lost, nothing duplicated.
// ---------------------------------------------------------------------------
{
  const allExpected = [...TODAY_IDS, ...LADDER_IDS].sort();
  for (const [label, m] of [
    ["mixed", matchCapabilities(MIXED, { hasWebsite: true })],
    ["no audit", matchCapabilities([], { hasWebsite: true })],
    ["no website", matchCapabilities([], { hasWebsite: false })],
  ] as const) {
    const got = allIds(m).sort();
    assert.deepEqual(got, allExpected, `${label}: every capability must appear exactly once across the buckets`);
    assert.equal(new Set(allIds(m)).size, allIds(m).length, `${label}: no capability may appear twice`);
  }
}
console.log("web-leads-automations-match: conservation OK");

console.log("web-leads-automations-match: ALL OK");
