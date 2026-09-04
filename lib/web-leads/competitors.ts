/**
 * lib/web-leads/competitors.ts — "is this bad, or is this normal?"
 *
 * ═══ WHY THIS EXISTS ════════════════════════════════════════════════════════
 *
 * Every other number this feature produces is absolute: a site scores 34. A
 * rep cannot sell an absolute number, because the prospect has no idea whether
 * 34 is normal for a hair salon. What sells is the comparison, and we already
 * own the only honest one available anywhere: 23,195 Canadian sites scored by
 * the SAME model, on the SAME 49 checks, in the same corpus. Every business in
 * a lead's own industry and city is a competitor, and every one of them is
 * already measured.
 *
 * So this module answers two questions off data we already hold:
 *
 *   1. WHERE DOES THIS LEAD SIT among businesses like it -- a percentile and a
 *      rank, not an adjective.
 *   2. WHO IS BEATING THEM, by name, with a score and a URL the prospect can
 *      open in the next tab while the rep is still on the phone.
 *
 * ═══ THE THREE RULES THIS MODULE DOES NOT GET TO BREAK ══════════════════════
 *
 * 1. NEVER COMPARE AGAINST A SLICE TOO SMALL TO MEAN ANYTHING. "You are the
 *    worst of the three plumbers in Trois-Rivières we happen to have scored" is
 *    arithmetically true and rhetorically worthless, and a rep who says it and
 *    gets pushed back on has nothing left. Below MIN_SLICE peers the comparison
 *    widens: industry+city -> industry+province -> industry nationally -> the
 *    whole corpus.
 *
 * 2. THE SLICE IS ALWAYS NAMED, NEVER IMPLIED. A percentile that silently
 *    switched from "salons in Mississauga" to "every site in Canada" is a rep
 *    saying one thing while the number means another. Every rejected slice is
 *    returned alongside the chosen one so the UI can say what it fell back from
 *    and why. See CompetitorContext.rejected.
 *
 * 3. NOTHING FROM ANOTHER REP'S BOOK CROSSES THIS BOUNDARY. A competitor is
 *    other leads in the same tenant, so this could trivially become a way to
 *    enumerate somebody else's pipeline. It cannot: a Competitor carries a
 *    business name, city, province, the public website URL, and OUR measured
 *    score -- and deliberately NOT the lead id, phone, address, owner, claim
 *    state or stage. Everything returned here is either public (the business
 *    exists on OpenStreetMap with a website) or ours (the score). PR #237's
 *    property -- no caller ever receives a lead that belongs to someone else --
 *    holds because no lead is returned at all, only a measurement of a public
 *    business.
 *
 * ═══ WHY THE SCORE INDEX IS REUSED RATHER THAN RE-QUERIED ═══════════════════
 *
 * The obvious implementation reads leadgen_site_audits here directly. It is
 * also the wrong one: picking the right audit row per business is three
 * queries and one genuinely subtle rule (take the NEWEST row for a business,
 * THEN ask whether it is scored -- filtering `profile is not null` in SQL first
 * silently resurrects a superseded score, see scores.ts's newest-row comment).
 * A second copy of that rule is a second place for it to be wrong, and the two
 * copies disagreeing means the leads table shows 61 for a business while this
 * module ranks it as a 44. fetchScoreIndex() already implements it, already
 * pins the tenant and the model version, already proves its reads complete via
 * assertCompleteRead(), and is already memoised for five minutes -- exactly the
 * cache window this module wants.
 *
 * The ONE query this module owns is the head-to-head profile of a single named
 * competitor, and it deliberately does NOT filter `profile is not null` for the
 * same newest-row reason: candidates come from the score index, which already
 * guarantees the newest row carries a profile, and adding the filter would make
 * a stale profile reachable in the one case the index rules out.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBDEV_TENANT_ID, LEAD_READ_CAP, MODEL_VERSION, assertCompleteRead } from "./tenant";
import { memo, TTL } from "./cache";
import { coerceProfile, safeFilterValue, type DimensionProfile } from "./audit";
import { fetchScoreIndex } from "./scores";

/**
 * The smallest peer group we will quote a percentile against.
 *
 * Eight is a floor on rhetoric, not on statistics: no slice this size supports
 * a confidence interval, and this module never claims one. What eight buys is
 * that "lower than 88% of them" cannot be produced by a group small enough for
 * the prospect to name every member out loud. Below it, widen and say so.
 */
export const MIN_SLICE = 8;

/** How many named competitors a rep gets. Three fits on screen beside the rest
 *  of the card; a longer list is a list, and a rep mid-call reads the top of it
 *  anyway. */
/**
 * How many competitors the card names and lets a rep compare against.
 *
 * Raised 3 -> 5 (2026-09-03) when every listed competitor became a full
 * comparison rather than a name with a number: three was the right number of
 * CARDS to skim, but a rep working a real objection wants a couple more to
 * point at. Each one costs a single profile read, all issued in parallel and
 * bounded by this constant, so the ceiling is deliberate and small.
 */
export const TOP_N = 5;

export type SliceKind = "industry_city" | "industry_province" | "industry_national" | "national";

/** A scored business in the corpus, reduced to what a rep may see. See rule 3
 *  in the module header for what is deliberately absent. */
export type Competitor = {
  name: string;
  city: string | null;
  province: string | null;
  websiteUrl: string | null;
  score: number;
};

type CorpusEntry = Competitor & {
  businessId: string;
  /** Lowercased for grouping only. The rep-facing strings keep their original
   *  case and accents ("Québec", "Restaurants & Bars"). */
  industryKey: string;
  cityKey: string;
  provinceKey: string;
  industry: string | null;
};

export type SliceSummary = {
  kind: SliceKind;
  /** Rep-facing noun phrase naming exactly who this lead is measured against,
   *  e.g. "Restaurants & Bars sites in Toronto". Rendered verbatim. */
  label: string;
  /** Peers only -- this lead is never counted as its own competitor. */
  peerCount: number;
};

export type HeadToHead = {
  competitor: Competitor;
  /**
   * 1-based position of this competitor within the chosen slice, best first.
   *
   * EXISTS SO THE UI CANNOT LIE. buildHeadToHead() falls through to the next
   * candidate when the top-scoring one has no readable profile, and the card
   * used to describe whatever came back as "the best-scoring" site in the
   * slice -- a false claim about a named business, said aloud on a call, in
   * exactly the fallback case the loop was written to handle. Anything other
   * than 1 must be worded differently. (Codex review, 2026-08-24.)
   */
  rankInSlice: number;
  composite: number;
  measuredAt: string;
  /** One row per dimension the LEAD has, in the lead's own order, so the
   *  head-to-head and the radar above it read as the same seven things. */
  dimensions: { key: string; label: string; theirs: number; leader: number; diff: number }[];
};

/**
 * One competitor a rep can actually walk into: the same shape as HeadToHead,
 * but there is one per named competitor rather than one per card.
 *
 * `leader` inside `dimensions` means "this rival's score" — the field name is
 * inherited from the single-benchmark era and kept so the comparison
 * components read one shape, not two.
 */
export type Rival = HeadToHead;

export type CompetitorContext = {
  slice: SliceSummary & { best: number; worst: number; median: number };
  /** Every narrower slice that was tried and rejected for being under
   *  MIN_SLICE, in the order they were tried. The UI says this out loud. */
  rejected: SliceSummary[];
  percentile: {
    /** Share of peers scoring strictly higher than this lead, 0-100. */
    lowerThanPct: number;
    /** 1-based rank of this lead among peers + itself. */
    rank: number;
    outOf: number;
  };
  /** Where this lead sits against the WHOLE corpus, always, regardless of which
   *  slice was chosen -- the second sentence in the spec's percentile strip. */
  national: { peerCount: number; lowerThanPct: number };
  top: Competitor[];
  /** Ten buckets of ten, counted over the chosen slice INCLUDING this lead
   *  (it is one of the measured sites), plus the bucket the lead falls in. */
  distribution: { buckets: number[]; leadBucket: number };
  /**
   * Every listed competitor whose profile we could read, best-first — each
   * one a full area-by-area comparison a rep can open on the call.
   */
  rivals: Rival[];
  /**
   * The first readable rival, kept as its own field because the card's
   * benchmark language ("the best-scoring…") and the radar's gold overlay
   * both mean exactly one competitor. Derived from `rivals` rather than
   * fetched separately, so the two can never disagree.
   */
  headToHead: HeadToHead | null;
};

// ───────────────────────────────────────────────────────────────────────────
// Pure arithmetic. Exported so tests can prove the percentile, the ladder and
// the histogram without standing up a database -- these are the numbers a rep
// says out loud, so they are the part that must be provably right.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Where `score` sits among `peerScores`, counting only peers scoring STRICTLY
 * higher.
 *
 * Strictly higher, not "higher or equal", on purpose: it is the claim that
 * understates. Ten peers tied with the lead produce "lower than 0% of them",
 * which is true, rather than "lower than 100%", which a rep would say aloud and
 * could not defend. Every ambiguity in this module resolves toward the smaller
 * accusation.
 */
export function percentileAmong(
  peerScores: number[],
  score: number,
): { lowerThanPct: number; rank: number; outOf: number } {
  const higher = peerScores.filter((s) => s > score).length;
  const lowerThanPct = peerScores.length === 0 ? 0 : Math.round((higher / peerScores.length) * 100);
  return { lowerThanPct, rank: higher + 1, outOf: peerScores.length + 1 };
}

export function median(scores: number[]): number {
  if (scores.length === 0) return 0;
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Best / worst / middle of the group the card actually RANKS the lead inside --
 * the peers AND the lead, which is the same `outOf` the rank is quoted against.
 *
 * WHY NOT PEERS ONLY, which is the obvious reading of "the competition": the
 * card renders "Rank 1 of 219. Best in that group scores 86" off these two
 * numbers side by side. Computed over peers alone, a lead scoring 90 against a
 * best peer of 86 renders exactly that pair -- ranked first in a group whose
 * best is lower than it is. A prospect does not need to know statistics to spot
 * that, and the rep has no answer. One group, one set of extrema. (Codex
 * review, 2026-08-24.)
 */
export function groupStats(
  peerScores: number[],
  leadScore: number,
): { best: number; worst: number; median: number } {
  const all = [...peerScores, leadScore];
  return { best: Math.max(...all), worst: Math.min(...all), median: median(all) };
}

/**
 * Ten buckets of ten. 100 lands in the top bucket rather than an eleventh one
 * of its own -- an eleventh bucket holding only perfect scores renders as a
 * spike that is an artefact of the bucketing, not of the corpus.
 */
export function bucketOf(score: number): number {
  return Math.min(9, Math.max(0, Math.floor(score / 10)));
}

export function distributionOf(peerScores: number[], leadScore: number): { buckets: number[]; leadBucket: number } {
  const buckets = new Array(10).fill(0);
  for (const s of [...peerScores, leadScore]) buckets[bucketOf(s)] += 1;
  return { buckets, leadBucket: bucketOf(leadScore) };
}

/**
 * Walk the fallback ladder and return the first slice with enough peers, plus
 * every narrower one that was rejected.
 *
 * Returns `null` for `chosen` only when even the whole corpus is under
 * MIN_SLICE, which means this tenant has essentially no scored sites. The
 * caller renders a sentence for that; it must never render a percentile
 * against seven sites and hope nobody asks.
 */
export function chooseSlice<T>(
  candidates: { kind: SliceKind; label: string; peers: T[] }[],
): { chosen: { kind: SliceKind; label: string; peers: T[] } | null; rejected: SliceSummary[] } {
  const rejected: SliceSummary[] = [];
  for (const c of candidates) {
    if (c.peers.length >= MIN_SLICE) return { chosen: c, rejected };
    rejected.push({ kind: c.kind, label: c.label, peerCount: c.peers.length });
  }
  return { chosen: null, rejected };
}

/**
 * Rep-facing noun phrase for a slice. Hand-written; never assembled from model
 * output.
 *
 * ALL FOUR ARE PLURAL NOUN PHRASES that read correctly in every sentence the
 * card puts them in -- "lower than 78% of the 17,052 {label} we have measured",
 * "the best-scoring {label} we have measured", "score bands across the {label}
 * we have measured". An earlier draft returned "sites we have measured across
 * Canada" for the national slice, which produced "the 17,052 sites we have
 * measured across Canada we have measured" in two of those three. A label that
 * only reads well in the sentence you happened to test it in is a label that
 * embarrasses a rep in the other one.
 *
 * `industry` is the tenant's own free-text value, rendered as stored
 * ("Restaurants & Bars"), because normalising it is how "Health & Medical"
 * reaches a prospect's screen as "health and medical".
 */
export function labelFor(
  kind: SliceKind,
  facts: { industry: string | null; city: string | null; province: string | null },
): string {
  if (kind === "industry_city") return `${facts.industry} sites in ${facts.city}`;
  if (kind === "industry_province") return `${facts.industry} sites in ${facts.province}`;
  if (kind === "industry_national") return `${facts.industry} sites in Canada`;
  return "Canadian sites";
}

// ───────────────────────────────────────────────────────────────────────────
// The corpus
// ───────────────────────────────────────────────────────────────────────────

const norm = (v: unknown): string =>
  typeof v === "string" ? v.trim().toLowerCase() : "";

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/**
 * Every scored business in the tenant, reduced to the six fields a comparison
 * needs, memoised for five minutes.
 *
 * WHY ITS OWN READ RATHER THAN data.ts's allTenantLeads(): that one is
 * memoised for ten seconds because it backs the leads table, where a rep who
 * just released a lead must see it return to the pool. This read backs a
 * comparison against a corpus that changes only when a scoring RUN writes -- a
 * batch job measured in hours. Sharing the ten-second cache would re-transfer
 * ~31,000 rows every ten seconds to answer a question whose answer changes
 * daily, and sharing a five-minute cache with the table would make a released
 * lead linger on screen for five minutes. Two different questions, two
 * different staleness budgets.
 *
 * Truncation is fatal, not degraded, for the same reason it is in scores.ts: a
 * short read here does not blank the card, it quietly shrinks the peer group,
 * and a percentile computed against a silently-truncated slice is a wrong
 * number a rep reads aloud to a stranger. assertCompleteRead() proves the read
 * against its own match count rather than against our cap, because PostgREST
 * enforces a server-side max-rows of its own that a cap comparison never sees.
 */
async function loadCorpus(): Promise<CorpusEntry[]> {
  const db = getServiceSupabase();

  const [recordsRes, scoreIndex] = await Promise.all([
    db
      .from("tenant_records")
      .select("id,data", { count: "exact" })
      .eq("tenant_id", WEBDEV_TENANT_ID)
      .eq("entity_type", "lead")
      .limit(LEAD_READ_CAP),
    fetchScoreIndex(),
  ]);

  if (recordsRes.error) throw new Error(`corpus_read_failed: ${recordsRes.error.message}`);
  const rows = (recordsRes.data || []) as { id: string; data: Record<string, unknown> }[];
  assertCompleteRead("competitor_corpus", rows, recordsRes.count);

  const seen = new Set<string>();
  const entries: CorpusEntry[] = [];
  for (const r of rows) {
    const d = r.data || {};
    const businessId = str(d.webdev_source_business_id);
    if (!businessId) continue;
    // One business can hold more than one tenant_record (a re-promotion, a
    // duplicate import). Counting it twice inflates the peer group and shifts
    // every percentile computed against it.
    if (seen.has(businessId)) continue;
    // A DOMAIN FOR SALE IS NOT A COMPETITOR.
    //
    // Belt and braces: loadScoreIndex already withholds a score from these, so
    // the `typeof score !== "number"` line below would drop them anyway. This
    // check stays because THIS is the module where the damage happened and the
    // cost of the two disagreeing is not a blank cell -- it is a rep telling a
    // prospect that a domain-broker landing page is their best-performing
    // competitor, at 82, on a live call (2026-08-25).
    //
    // Peer groups take the BEST-scoring sites in a city and industry, and every
    // parking page scores 82, so these were not merely included: they outranked
    // real businesses and were preferentially surfaced.
    if (scoreIndex.parked.has(businessId)) continue;
    const score = scoreIndex.scored.get(businessId);
    // Never invent a competitor. An unscored or unreachable business is not a
    // zero and is not a peer -- it is a business we have not measured, and it
    // must not appear in a denominator a rep quotes.
    if (typeof score !== "number") continue;
    seen.add(businessId);

    const industry = str(d.webdev_industry) || str(d.industry);
    const city = str(d.business_city);
    const province = str(d.state);
    entries.push({
      businessId,
      name: str(d.business_name) || str(d.name) || "Unnamed business",
      city,
      province,
      websiteUrl: str(d.website),
      score,
      industry,
      industryKey: norm(industry),
      cityKey: norm(city),
      provinceKey: norm(province),
    });
  }
  return entries;
}

function fetchCorpus(): Promise<CorpusEntry[]> {
  return memo("web-leads:competitor-corpus", TTL.CORPUS, loadCorpus);
}

/**
 * The newest audit profile for ONE named competitor, for the head-to-head.
 *
 * Reads the newest row and requires ITS profile, rather than filtering
 * `profile is not null` in SQL -- see the module header. `safeFilterValue`
 * charset-allowlists the id before it reaches a PostgREST filter string, the
 * same control audit.ts applies; `encodeURIComponent` alone is not sufficient
 * for a value that becomes part of a filter expression rather than a path.
 */
async function fetchCompetitorProfile(
  businessId: string,
): Promise<{ composite: number; dimensions: DimensionProfile[]; measuredAt: string } | null> {
  const bid = safeFilterValue(businessId);
  if (!bid) return null;
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("leadgen_site_audits")
    .select("fetched_at,profile")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("business_id", bid)
    .eq("audit_version", MODEL_VERSION)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`competitor_profile_read_failed: ${error.message}`);
  if (!data) return null;
  const row = data as { fetched_at: string; profile: unknown };
  // coerceProfile, not JSON.parse: the Turso adapter auto-decodes JSON-looking
  // TEXT columns into objects while supabase-js hands back the raw string, so
  // the same column arrives in two shapes depending on the backend. See
  // audit.ts's coerceProfile doc comment for the outage this caused.
  const profile = coerceProfile(row.profile);
  if (!profile || typeof profile.composite !== "number" || !Array.isArray(profile.dimensions)) return null;
  return { composite: profile.composite, dimensions: profile.dimensions, measuredAt: row.fetched_at };
}

/**
 * Build the area-by-area comparison for EVERY named competitor whose profile
 * we can actually read -- not just the top one.
 *
 * WHY IT CHANGED (Adon, 2026-09-03): "you should be clicking into every
 * single one of their competitors in comparison to them." The card fetched
 * exactly one profile and drew one benchmark while listing several competitor
 * names above it, so all but one were a name and a number a rep could not
 * open. Now every listed competitor is a comparison a rep can walk into.
 *
 * A competitor whose profile row is missing or malformed is a gap in OUR
 * data: it is dropped from the comparison rather than rendered as zeros, and
 * `rankInSlice` records where it really sat so the UI can never call a
 * fall-through "the best-scoring". Fetches run in parallel and are bounded to
 * the candidate list already chosen for display, so this can never fan out
 * into a scan.
 */
async function buildRivals(
  candidates: CorpusEntry[],
  leadDimensions: DimensionProfile[],
): Promise<Rival[]> {
  const settled = await Promise.all(
    candidates.map(async (c, i) => {
      // One unreadable profile must not fail the whole comparison.
      const profile = await fetchCompetitorProfile(c.businessId).catch(() => null);
      if (!profile) return null;
      const byKey = new Map(profile.dimensions.map((d) => [d.key, d.score]));
      const rival: Rival = {
        competitor: { name: c.name, city: c.city, province: c.province, websiteUrl: c.websiteUrl, score: c.score },
        // `candidates` is the slice ranked best-first, so the index IS the
        // rank within the slice. Anything but 1 means a higher-scoring
        // business was skipped because its profile could not be read.
        rankInSlice: i + 1,
        composite: profile.composite,
        measuredAt: profile.measuredAt,
        // Driven off the LEAD's dimension list, not the competitor's, so
        // every rival's rows line up with each other and with the radar even
        // if a future model version adds a dimension one audit predates.
        dimensions: leadDimensions.map((d) => {
          const leader = byKey.get(d.key) ?? 0;
          return { key: d.key, label: d.label, theirs: d.score, leader, diff: d.score - leader };
        }),
      };
      return rival;
    }),
  );
  return settled.filter((r): r is Rival => r !== null);
}

/**
 * The whole comparison for one lead.
 *
 * `businessId` is excluded from every peer group: a business is not its own
 * competitor, and leaving it in both inflates the denominator and drags its own
 * percentile toward the middle.
 */
export async function fetchCompetitorContext(args: {
  businessId: string;
  industry: string | null;
  city: string | null;
  province: string | null;
  score: number;
  dimensions: DimensionProfile[];
}): Promise<CompetitorContext | null> {
  const corpus = await fetchCorpus();
  const peersAll = corpus.filter((c) => c.businessId !== args.businessId);
  if (peersAll.length === 0) return null;

  const industryKey = norm(args.industry);
  const cityKey = norm(args.city);
  const provinceKey = norm(args.province);

  const byIndustry = industryKey ? peersAll.filter((c) => c.industryKey === industryKey) : [];
  const candidates: { kind: SliceKind; label: string; peers: CorpusEntry[] }[] = [];
  if (industryKey && cityKey) {
    candidates.push({
      kind: "industry_city",
      label: labelFor("industry_city", args),
      peers: byIndustry.filter((c) => c.cityKey === cityKey),
    });
  }
  if (industryKey && provinceKey) {
    candidates.push({
      kind: "industry_province",
      label: labelFor("industry_province", args),
      peers: byIndustry.filter((c) => c.provinceKey === provinceKey),
    });
  }
  if (industryKey) {
    candidates.push({ kind: "industry_national", label: labelFor("industry_national", args), peers: byIndustry });
  }
  candidates.push({ kind: "national", label: labelFor("national", args), peers: peersAll });

  const { chosen, rejected } = chooseSlice(candidates);
  if (!chosen) return null;

  const peerScores = chosen.peers.map((c) => c.score);
  const ranked = [...chosen.peers].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const top = ranked.slice(0, TOP_N);
  const nationalScores = peersAll.map((c) => c.score);

  return {
    slice: {
      kind: chosen.kind,
      label: chosen.label,
      peerCount: chosen.peers.length,
      // Over the peers AND this lead -- the same group the rank is quoted
      // against. See groupStats() for the contradiction that separating them
      // produced.
      ...groupStats(peerScores, args.score),
    },
    rejected,
    percentile: percentileAmong(peerScores, args.score),
    national: {
      peerCount: nationalScores.length,
      lowerThanPct: percentileAmong(nationalScores, args.score).lowerThanPct,
    },
    top: top.map((c) => ({
      name: c.name,
      city: c.city,
      province: c.province,
      websiteUrl: c.websiteUrl,
      score: c.score,
    })),
    distribution: distributionOf(peerScores, args.score),
    ...(await (async () => {
      const rivals = await buildRivals(top, args.dimensions);
      // headToHead is DERIVED, never fetched twice: the benchmark the radar
      // outlines in gold and the first rival in the comparison must be the
      // same business, or the card shows two different "best" competitors.
      return { rivals, headToHead: rivals[0] ?? null };
    })()),
  };
}

const competitorsModule = { fetchCompetitorContext };
export default competitorsModule;
