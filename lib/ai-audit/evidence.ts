/**
 * lib/ai-audit/evidence.ts — the four evidence labels, enforced in code.
 *
 * Research proposes findings; this decides which label each may carry, from
 * what is actually stored behind it (CC's brief, section 5):
 *   - Verified fact: our own measurement produced it (a site check, a PageSpeed
 *     run), or a stored snapshot of a public page states it, or CC confirmed it
 *     with a note. A page states a claim only when one passage of one of its
 *     sentences does:
 *       - every figure of the claim, each counting the same thing on the page
 *         ("120 reviews" is never "120 photos", and a figure the page does not
 *         tie to a thing, such as a date or a sub-score, counts nothing), with
 *         the same "over" or "under";
 *       - every long word of the claim and most of the rest;
 *       - the same yes or no, and the same tense ("formerly offered" never
 *         proves "offers"), and never the opposite word ("closed" never proves
 *         "open").
 *     A claim in another script is never stated. The page must have answered
 *     2xx. A listing must be the business's own (its name, and its city, web
 *     address or phone when one is known). On a listing, and on a
 *     competitor's page, the name the claim is about comes just before its
 *     figures, with no other figure counting the same thing, no other
 *     business's name and no "similar", "sponsored" or "featured" in between
 *     (re-review of phase 3, findings 1 and 2). A published benchmark counts
 *     only from a named public body or research firm (high or medium
 *     reliability, set by research.ts from the host, never by the model) dated
 *     in the last three years.
 *   - Client-reported: the client said it (a transcript's lines, a form field,
 *     CC's call notes).
 *   - Reasonable estimate: only the impact calculator makes one
 *     (lib/ai-audit/impact.ts); a finding is never an estimate.
 *   - Hypothesis: carries no figure of its own, in any form (digits, words, a
 *     share like "half of", a multiple like "twice"), and says how to test it.
 * A finding that fails is downgraded (a Verified fact with no proof becomes a
 * hypothesis when it has no figure) or dropped (a figure nobody can stand
 * behind), never upgraded; each change is listed with its reason. A true
 * claim held back is not lost: CC can add the fact himself when he reviews
 * the draft.
 *
 * PURE: no I/O.
 */
import { statesFigure, type DocFinding } from "@/lib/ai-audit/doc";
import { numbersIn } from "@/lib/ai-audit/extract";

/** A source as research stored it: what the evidence rules may rely on. */
export type EvidenceSource = {
  id: string;
  kind: "measurement" | "website" | "listing" | "publication" | "client" | "other";
  /** The stored text a page's claim must appear in: the passages that state its claims, and the page's start. */
  text?: string;
  reliability?: "high" | "medium" | "low" | "own_measurement" | "client_stated";
  published_at?: string | null;
  /** CC confirmed the fact behind it, with this note. */
  confirmed_note?: string | null;
  /** For a page we read: its HTTP status. Only a page that answered 2xx proves anything. */
  http_status?: number | null;
  /** For a listing of the business (not a competitor's): whether the page is the business's own. False proves nothing. */
  about_business?: boolean | null;
  /** For the business's own listing: its name (and city), which the passage stating a claim names just before its figures. */
  subject_name?: string | null;
  subject_city?: string | null;
  /** For a competitor's page: each claim names its own subject (its leading capitalized words), bound the same way. */
  subject_from_claim?: boolean | null;
};

export type EvidenceChange = { finding_id: string; title: string; action: "downgraded" | "dropped"; reason: string };

const BENCHMARK_MAX_AGE_MS = 3 * 365.25 * 86_400_000;

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);

/** The figure appears in the text as written: never 4 because the page says 400. */
function figureIn(value: number, text: string): boolean {
  return numbersIn(text).some((n) => near(value, n));
}

/** "one" that counts nothing: "each one", "no one", "one of them". Shared with the prose check (lib/ai-audit/prose.ts). */
export const NOT_A_COUNT = /\b(?:each|every|no|any|some|the|this|that|which)\s+one\b|\bone\s+(?:of|another|by one)\b|\bsomeone\b|\banyone\b/gi;
/**
 * A share said in words: "half of the calls", "about half go unanswered", "a
 * third", "one in four", "3 out of 10"; never "half-works", "behalf" or "a
 * third party" (re-review of phase 3, findings 3 and 4).
 */
const SHARE_PHRASE = /\b(?:half|halves|thirds?|quarters?|fifths?|tenths?)\b(?!-)(?!\s+part(?:y|ies)\b)|\bone\s+in\s+(?:two|three|four|five|six|seven|eight|nine|ten)\b|\b\d+\s+out\s+of\s+\d+\b/i;
/** A multiple said in words: "twice as many", "calls double", "tenfold"; never "double-booking" or "double check". */
const MULTIPLE_PHRASE = /\btwice\b|\b(?:double|triple|quadruple)[sd]?\b(?!-)(?!\s+(?:check|click|book))|\b(?:two|three|four|five|ten|hundred)fold\b|\btenfold\b/i;

/**
 * True when the text states a figure in any form: digits in any script, number
 * words ("forty percent", "a million"), a share ("half of", "two thirds") or a
 * multiple ("twice"). A hypothesis may carry none (review of phase 3, F2).
 */
export function statesAnyFigure(text: string): boolean {
  const plain = text.normalize("NFKC").replace(NOT_A_COUNT, " ");
  return statesFigure(plain) || numbersIn(plain).length > 0 || SHARE_PHRASE.test(plain) || MULTIPLE_PHRASE.test(plain);
}

const STOP = new Set("the and for with our you your its are was were has have had from into that this they them their than then also very just more most such only".split(" "));
/** Plain words of a text: what the page-level name check reads (namesBusiness). A passage is read by read() below. */
const wordsOf = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));

/** A digit in another script (Arabic-Indic and the like): a figure the check cannot read. */
const OTHER_DIGIT = /\p{Nd}/u;
/** A letter of another script: words the check cannot read, so a claim written in them is never stated. */
const NON_LATIN_LETTER = /[^\P{L}\p{Script=Latin}]/u;
/** Stars drawn as characters ("4.7" then five stars): each run reads as one word, at the run's own length. */
const STAR_RUN = new RegExp(`[${String.fromCharCode(0x2605, 0x2606, 0x2b50)}]+`, "g");
const GLYPH = String.fromCharCode(0x01c2);

// ---------------------------------------------------------------------------
// A text as words and figures, each figure tied to what it counts
// ---------------------------------------------------------------------------

type Cmp = "over" | "under" | "approx" | null;
/** One word or figure of a text, and where it sits in it. */
type Tok = {
  /** The word as written, lower case and without accents; a figure's digits. */
  w: string;
  /** The word's stem: "reviews" and "reviewed" are "review"; "rated", "rating" and "stars" are all "star". Empty for a figure. */
  s: string;
  /** A figure's value; null for a word. */
  v: number | null;
  /** What a figure counts: the unit words the page ties to it ("120 reviews", "Reviews (95)", "Rating: 4.5"), or "$" and "%". */
  units: Set<string>;
  /** The comparison in front of a figure: "over 10", "under 10", "about 10". */
  cmp: Cmp;
  start: number;
  end: number;
  /** Written with a capital and not as an abbreviation ("Acme", not "AB"): what another business's name is made of. */
  cap: boolean;
  /** A unit word a figure before it took ("4.2 stars"): never also the next figure's label. */
  taken?: boolean;
  /** Part of a date or a time ("01/14/2012", "8:00"): never a count of anything. */
  dateLike?: boolean;
};

const UNIT_OF = new Map<string, string>(
  (
    [
      ["star", `star stars rating ratings ${GLYPH}`],
      ["review", "review reviews testimonial testimonials"],
      ["year", "year years yr yrs"],
      ["hour", "hour hours hr hrs"],
      ["day", "day days"],
      ["week", "week weeks"],
      ["month", "month months"],
      ["minute", "minute minutes min mins"],
      ["second", "second seconds sec secs"],
      ["call", "call calls"],
      ["customer", "customer customers client clients"],
      ["job", "job jobs project projects"],
      ["staff", "employee employees staff people team technicians"],
      ["location", "location locations branch branches office offices store stores"],
      ["complaint", "complaint complaints"],
      ["photo", "photo photos picture pictures"],
      ["follower", "follower followers"],
      ["like", "like likes"],
      ["vehicle", "vehicle vehicles truck trucks van vans"],
      ["lead", "lead leads"],
      ["visit", "visit visits visitor visitors"],
      ["%", "percent"],
      ["$", "dollar dollars"],
    ] as const
  ).flatMap(([unit, words]) => words.split(" ").map((w): [string, string] => [w, unit])),
);
/** Units that count things: only ever a whole number. */
const COUNT_UNITS = new Set(["review", "customer", "job", "staff", "location", "complaint", "photo", "follower", "like", "vehicle", "lead", "visit", "call"]);
/** Whether a value can carry the unit: a count is whole, a rating at most 10, a share at most 100. */
function plausible(unit: string, v: number): boolean {
  if (COUNT_UNITS.has(unit)) return Number.isInteger(v);
  if (unit === "star") return v > 0 && v <= 10;
  if (unit === "%") return v >= 0 && v <= 100;
  return true;
}
const CMP_ONE = new Map<string, Cmp>([
  ...["over", "above", "exceeding", "exceeds", "plus"].map((w): [string, Cmp] => [w, "over"]),
  ...["under", "below", "nearly", "almost", "within"].map((w): [string, Cmp] => [w, "under"]),
  ...["about", "around", "approximately", "roughly", "some", "approx", "est"].map((w): [string, Cmp] => [w, "approx"]),
]);
const CMP_TWO = new Map<string, Cmp>([
  ["more than", "over"],
  ["at least", "over"],
  ["upwards of", "over"],
  ["less than", "under"],
  ["fewer than", "under"],
  ["at most", "under"],
  ["up to", "under"],
]);
const SMALL_NUMBERS = new Map<string, number>("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ").map((w, i): [string, number] => [w, i]));
const TENS = new Map<string, number>("twenty thirty forty fifty sixty seventy eighty ninety".split(" ").map((w, i): [string, number] => [w, (i + 2) * 10]));
const SCALES = new Map<string, number>([
  ["hundred", 100],
  ["thousand", 1_000],
  ["million", 1_000_000],
]);
const FOLD = new Map<string, string>([
  ["stars", "star"],
  ["rating", "star"],
  ["ratings", "star"],
  ["rated", "star"],
  [GLYPH, "star"],
]);

function stem(w: string): string {
  const folded = FOLD.get(w);
  if (folded) return folded;
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && /(?:ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

const TOKEN = /(\$)?(\d+(?:[.,]\d+)*)(%|\+)?|\p{L}[\p{L}\p{M}]*/gu;

/** The text as shown, and its words and figures, each figure tied to what it counts. */
function read(text: string): { shown: string; toks: Tok[] } {
  const shown = text.normalize("NFKC");
  // "each one", "no one", "someone" count nothing, and a run of drawn stars is one word: both kept at their length.
  const counted = shown.replace(NOT_A_COUNT, (m) => " ".repeat(m.length)).replace(STAR_RUN, (m) => GLYPH + " ".repeat(m.length - 1));
  const toks: Tok[] = [];
  for (const m of counted.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const prev = toks[toks.length - 1];
    if (m[2] !== undefined) {
      // "1,200" is one figure; "4,5" (a list, or a decimal comma) is two, never 45.
      for (const part of m[2].replace(/,(?=\d{3}(?!\d))/g, "").split(",")) {
        const v = Number(part);
        if (!Number.isFinite(v)) continue;
        toks.push({ w: part, s: "", v, units: new Set(m[1] ? ["$"] : m[3] === "%" ? ["%"] : []), cmp: m[3] === "+" ? "over" : null, start, end, cap: false });
      }
      continue;
    }
    const w = m[0].normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
    const small = SMALL_NUMBERS.get(w) ?? TENS.get(w);
    if (small !== undefined) {
      if (prev && prev.v !== null && TENS.has(prev.w) && small > 0 && small < 10) {
        // "twenty four" is one figure.
        prev.v += small;
        prev.w = `${prev.w} ${w}`;
        prev.end = end;
      } else toks.push({ w, s: "", v: small, units: new Set(), cmp: null, start, end, cap: false });
      continue;
    }
    const scale = SCALES.get(w);
    if (scale !== undefined && prev && prev.v !== null) {
      prev.v *= scale;
      prev.end = end;
      continue;
    }
    const raw = shown.slice(start, end);
    toks.push({ w, s: stem(w), v: null, units: new Set(), cmp: null, start, end, cap: /^\p{Lu}/u.test(raw) && !/^\p{Lu}{1,4}$/u.test(raw) });
  }
  bindUnits(toks, counted);
  toks.forEach((t, i) => {
    if (t.v === null || t.cmp !== null) return;
    const one = i > 0 && toks[i - 1].v === null ? toks[i - 1].w : null;
    const two = one !== null && i > 1 && toks[i - 2].v === null ? `${toks[i - 2].w} ${one}` : null;
    t.cmp = (two !== null ? CMP_TWO.get(two) : undefined) ?? (one !== null ? CMP_ONE.get(one) : undefined) ?? null;
  });
  return { shown, toks };
}

/**
 * What each figure counts, as the page ties it: "120 reviews" and "(95
 * reviews)" after it, "Reviews (95)" and "Rating: 4.5" before it, a rating
 * next to a star word, "3.8/5", "4.5 (95 reviews)", and the count of reviews
 * after drawn stars ("(212)"). A figure with unit words on both sides that
 * name different things ("Photos 120 Years") is tied to neither, a unit word
 * followed at once by another figure may be that figure's label ("Reviews 95
 * Projects 12"), and dates and times count nothing (re-review of phase 3,
 * finding 1).
 */
function bindUnits(toks: Tok[], text: string): void {
  const gap = (a: number, b: number) => text.slice(toks[a].end, toks[b].start);
  const unit = (k: number) => (k >= 0 && k < toks.length && toks[k].v === null ? UNIT_OF.get(toks[k].w) : undefined);
  const bare = (g: string) => /^\s*$/.test(g);
  const isNumber = (k: number) => k >= 0 && k < toks.length && toks[k].v !== null;
  for (let i = 0; i + 1 < toks.length; i++) {
    if (!isNumber(i) || !isNumber(i + 1)) continue;
    const g = gap(i, i + 1);
    if (/^\s*:\s*$/.test(g)) toks[i].dateLike = toks[i + 1].dateLike = true;
    else if (g === "/" && isNumber(i + 2) && gap(i + 1, i + 2) === "/") toks[i].dateLike = toks[i + 1].dateLike = toks[i + 2].dateLike = true;
  }
  const after = (i: number): { units: Set<string>; to: number } | null => {
    const units = new Set<string>();
    let k = i + 1;
    for (; k < toks.length && k <= i + 2 && unit(k) && bare(gap(k - 1, k)); k++) units.add(unit(k) as string);
    return units.size ? { units, to: k - 1 } : null;
  };
  const before = (i: number, joint: RegExp): Set<string> | null => {
    if (!unit(i - 1) || toks[i - 1].taken || !joint.test(gap(i - 1, i))) return null;
    const units = new Set<string>([unit(i - 1) as string]);
    if (unit(i - 2) && !toks[i - 2].taken && bare(gap(i - 2, i - 1))) units.add(unit(i - 2) as string);
    return units;
  };
  const take = (to: number, from: number) => {
    for (let k = from; k <= to; k++) toks[k].taken = true;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.v === null || t.units.size || t.dateLike) continue;
    const g0 = i > 0 ? gap(i - 1, i) : "";
    const g1 = i + 1 < toks.length ? gap(i, i + 1) : text.slice(t.end);
    let units: Set<string> | null = null;
    let took: { to: number } | null = null;
    if (/\(\s*$/.test(g0) && /^\s*\)/.test(g1)) {
      // "Reviews (95)": the label before the bracket; after drawn stars, "(212)" counts reviews.
      units = i > 0 && toks[i - 1].w === GLYPH ? new Set(["review"]) : before(i, /^\s*\(\s*$/);
    } else if (/\(\s*$/.test(g0)) {
      // "(95 reviews)": the unit inside the bracket.
      const a = after(i);
      if (a) [units, took] = [a.units, a];
    } else {
      const colon = before(i, /^\s*:\s*$/);
      if (colon) units = colon;
      else {
        const a = after(i);
        const b = before(i, /^\s*$/);
        const aLabels = !!a && isNumber(a.to + 1) && bare(gap(a.to, a.to + 1));
        if (a && b) {
          const both = new Set([...a.units].filter((u) => b.has(u)));
          if (both.size) [units, took] = [both, a];
        } else if (a && !aLabels) [units, took] = [a.units, a];
        else if (b) units = b;
      }
    }
    // A rating, whatever else is near: a decimal at most 10 next to a star word ("4.2 stars 95 reviews", stars then "4.5").
    if (!units && !Number.isInteger(t.v) && t.v <= 10) {
      const a = after(i);
      const b = before(i, /^\s*$/);
      if (a?.units.has("star")) [units, took] = [new Set(["star"]), a];
      else if (b?.has("star")) units = new Set(["star"]);
    }
    if (units) for (const u of units) if (plausible(u, t.v)) t.units.add(u);
    if (took && t.units.size) take(took.to, i + 1);
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.v === null || t.dateLike) continue;
    // "3.8/5", "4.5 out of 5": a rating, and its scale.
    const scale = isNumber(i + 1) && /^\s*\/\s*$/.test(gap(i, i + 1)) ? i + 1 : toks[i + 1]?.w === "out" && toks[i + 2]?.w === "of" && isNumber(i + 3) ? i + 3 : -1;
    if (scale > 0 && (toks[scale].v === 5 || toks[scale].v === 10) && t.v > 0 && t.v <= (toks[scale].v as number)) {
      t.units = new Set(["star"]);
      if (!toks[scale].units.size) toks[scale].units.add("star");
    }
    // "4.5 (95 reviews)": the figure before a bracketed count of reviews is the rating.
    if (!t.units.size && !Number.isInteger(t.v) && t.v <= 5 && isNumber(i + 1) && /\(\s*$/.test(gap(i, i + 1)) && toks[i + 1].units.has("review")) t.units.add("star");
  }
}

/** The same thing counted: a claim's figure tied to a unit matches only a page figure tied to it too. */
const meets = (claim: Set<string>, page: Set<string>) => !claim.size || [...claim].some((u) => page.has(u));
/** The same comparison: "over 10" never stands for "under 10"; "about 10" stands for "10". */
const sameWay = (a: Cmp, b: Cmp) => a === b || ((a === null || a === "approx") && (b === null || b === "approx"));

const NEGATORS = new Set(["not", "no", "never", "none", "nothing", "without", "cannot", "unable", "unavailable", "nobody", "neither", "nor"]);
const negatedIn = (toks: readonly Tok[]) => toks.some((t, i) => t.v === null && (NEGATORS.has(t.w) || (t.w === "t" && i > 0 && toks[i - 1].v === null && toks[i - 1].w.endsWith("n"))));
/** What was once so: "formerly offered" never proves "offers". */
const PAST = new Set(["formerly", "previously", "former", "discontinued", "ceased", "defunct"]);
const pastIn = (toks: readonly Tok[]) => toks.some((t, i) => t.v === null && (PAST.has(t.w) || (t.w === "used" && toks[i + 1]?.w === "to")));
/** Words whose opposite on the page means the page says otherwise (by stem). */
const OPPOSITES: ReadonlyArray<readonly [readonly string[], readonly string[]]> = [
  [["open"], ["clos", "close", "shut"]],
  [["over", "more", "above", "exceed"], ["under", "less", "fewer", "below"]],
  [["most", "highest", "best", "largest", "biggest"], ["least", "lowest", "worst", "smallest"]],
  [["increas", "increase", "rise", "ris", "grew", "grow"], ["decreas", "decrease", "drop", "dropp", "fell", "fall", "declin", "decline"]],
  [["accept"], ["refus", "refuse", "reject"]],
  [["fast", "quick"], ["slow"]],
  [["early"], ["late"]],
  [["positive"], ["negative"]],
  [["online"], ["offline"]],
  [["free"], ["paid", "fee"]],
];
/** Long words a claim may leave out of a page's passage: comparisons (bound to the figures instead), joining words, where it was read. */
const FILLER = new Set(
  "about above below under nearly almost within around approximately roughly exceeding upwards based which their there these those where while other being since after before through across according currently overall total listed shows shown states stated displays google facebook profile listing website online page".split(
    " ",
  ),
);
/** The most distinct figures a claim may carry: a claim with more is not a fact a page states (and each costs a search of the page). */
const MAX_CLAIM_FIGURES = 6;

type Claim = { figs: Tok[]; words: string[]; required: string[]; said: Set<string>; negated: boolean; past: boolean };
function claimOf(toks: Tok[]): Claim {
  const words = toks.filter((t) => t.v === null && t.w.length >= 3 && !STOP.has(t.w));
  const figs: Tok[] = [];
  for (const t of toks) if (t.v !== null && !figs.some((f) => near(f.v as number, t.v as number) && [...f.units].join() === [...t.units].join())) figs.push(t);
  return {
    figs,
    words: [...new Set(words.map((t) => t.s))],
    required: [...new Set(words.filter((t) => t.w.length >= 5 && !FILLER.has(t.w)).map((t) => t.s))],
    said: new Set(toks.filter((t) => t.v === null).map((t) => t.s)),
    negated: negatedIn(toks),
    past: pastIn(toks),
  };
}

/** True when this passage says what the claim says: its long words, most of the rest, the same yes or no and tense, no opposite. */
function covers(span: readonly Tok[], c: Claim): boolean {
  if (negatedIn(span) !== c.negated || pastIn(span) !== c.past) return false;
  const have = new Set<string>();
  for (const t of span) {
    if (t.v === null) have.add(t.s);
    else for (const u of t.units) have.add(u);
  }
  if (c.required.some((x) => !have.has(x))) return false;
  if (c.words.filter((x) => have.has(x)).length / c.words.length < 0.7) return false;
  for (const [a, b] of OPPOSITES) {
    for (const [mine, theirs] of [
      [a, b],
      [b, a],
    ] as const) {
      const ours = mine.filter((x) => c.said.has(x));
      if (ours.length && !ours.some((x) => have.has(x)) && theirs.some((x) => have.has(x))) return false;
    }
  }
  return true;
}

/** Words a business name shares with many others: never what tells it apart. */
const GENERIC_NAME_WORDS = new Set(["inc", "ltd", "llc", "corp", "corporation", "company", "group", "services", "service", "test"]);
/** Words a listing shows beside a business's name that are not another business's: its headings, labels and buttons. */
const PAGE_WORDS = new Set(
  "about overview home info details profile page intro photos photo likes followers reviews review rating ratings rated score overall stars star verified claimed accredited licensed insured open closed now hours contact website directions call share save write log sign menu more see all best top".split(
    " ",
  ),
);
/** The telling words of a name, as stems ("[TEST] Fixture Plumbing Inc." is "fixture", "plumb"). */
const nameStemsOf = (name: string) => [...new Set(read(name).toks.filter((t) => t.v === null && t.w.length >= 3 && !STOP.has(t.w) && !GENERIC_NAME_WORDS.has(t.w)).map((t) => t.s))];

/** Where the claim's subject is named: every telling word of a name of one or two, or 70% of a longer one, close together. */
function namedAt(toks: readonly Tok[], want: readonly string[]): Array<{ start: number; end: number }> {
  const need = want.length <= 2 ? want.length : Math.ceil(want.length * 0.7);
  const at: Array<{ start: number; end: number }> = [];
  toks.forEach((t, i) => {
    if (t.v !== null || !want.includes(t.s)) return;
    const seen = new Set<string>();
    let end = i;
    for (let k = i; k < Math.min(toks.length, i + want.length + 2); k++) {
      if (toks[k].v === null && want.includes(toks[k].s)) {
        seen.add(toks[k].s);
        end = k;
      }
    }
    if (seen.size >= need) at.push({ start: i, end });
  });
  return at;
}
/** Words that open another business's part of a page: "Similar plumbers", "Sponsored", "Featured", "People also viewed", "Be the first to review". */
const ELSEWHERE = new Set(["similar", "sponsored", "sponsor", "featured", "promoted", "ad", "ads", "advertisement", "nearby", "alternative", "alternatives", "competitor", "competitors", "versus", "vs", "related"]);
const elsewhereAt = (toks: readonly Tok[], k: number) =>
  toks[k].v === null &&
  (ELSEWHERE.has(toks[k].w) ||
    (toks[k].w === "also" && /^(?:viewed|searched|like|liked|considered|visited|bought)$/.test(toks[k + 1]?.w ?? "")) ||
    (toks[k].w === "first" && toks[k + 1]?.w === "to" && toks[k + 2]?.s === "review"));
/** Two or more capitalized words in a row that are not the subject's, its city's or the page's own: another business's name. */
function foreignBetween(toks: readonly Tok[], from: number, to: number, allow: ReadonlySet<string>): boolean {
  let run = 0;
  for (let k = from + 1; k < to; k++) {
    const t = toks[k];
    const known = t.v === null && (allow.has(t.s) || PAGE_WORDS.has(t.w) || GENERIC_NAME_WORDS.has(t.w) || STOP.has(t.w));
    run = t.v === null && t.cap && !known ? run + 1 : 0;
    if (run >= 2) return true;
  }
  return false;
}

/** How far apart a claim's figures may sit in words; on a listing, how close together, and how close after its subject's name. */
const REACH = 40;
const LISTING_SPAN = 12;
const NAME_GAP = 30;
type Span = { from: number; to: number };
type Subject = { want: string[]; allow: Set<string> };

/** The passage that states a claim with figures: each figure at a place tied like the claim's, close together; on a listing, its subject named first. */
function figureSpan(toks: readonly Tok[], c: Claim, subject: Subject | null): Span | null {
  const places = c.figs.map((f) => toks.flatMap((t, j) => (t.v !== null && near(t.v, f.v as number) && meets(f.units, t.units) && sameWay(f.cmp, t.cmp) ? [j] : [])).slice(0, 8));
  if (places.some((p) => !p.length)) return null;
  let combos: number[][] = [[]];
  for (const p of places) combos = combos.flatMap((at) => p.map((j) => [...at, j])).slice(0, 256);
  const names = subject ? namedAt(toks, subject.want) : [];
  for (const at of combos) {
    const lo = Math.min(...at);
    const hi = Math.max(...at);
    if (!subject) {
      if (hi - lo > REACH) continue;
      const span = { from: Math.max(0, lo - 12), to: Math.min(toks.length - 1, hi + 12) };
      if (covers(toks.slice(span.from, span.to + 1), c)) return span;
      continue;
    }
    if (hi - lo > LISTING_SPAN) continue;
    for (const n of names) {
      if (n.end >= lo || lo - n.end - 1 > NAME_GAP) continue;
      // From the name to the figures: no "similar" or "sponsored", no other business's name, and no other figure counting the same thing.
      let clear = !foreignBetween(toks, n.end, lo, subject.allow);
      for (let k = Math.max(0, n.start - 6); k <= hi && clear; k++) if (elsewhereAt(toks, k)) clear = false;
      c.figs.forEach((f, idx) => {
        for (let k = n.end + 1; k < at[idx] && clear; k++) {
          const t = toks[k];
          // The claim's own figures are not another's: "3.8/5" holds the rating and its scale.
          if (t.v !== null && !at.includes(k) && f.units.size && meets(f.units, t.units) && !near(t.v, f.v as number)) clear = false;
        }
      });
      if (!clear) continue;
      const span = { from: Math.max(0, n.start - 10), to: Math.min(toks.length - 1, hi + 12) };
      if (covers(toks.slice(span.from, span.to + 1), c)) return span;
    }
  }
  return null;
}

/** The passage that states a claim without figures: on a listing, from its subject's name to the claim's words after it. */
function wordSpan(toks: readonly Tok[], c: Claim, subject: Subject | null): Span | null {
  if (subject) {
    const content = new Set(c.words.filter((x) => !subject.want.includes(x)));
    for (const n of namedAt(toks, subject.want)) {
      let clear = true;
      for (let k = Math.max(0, n.start - 6); k < n.start && clear; k++) if (elsewhereAt(toks, k)) clear = false;
      let j = n.end;
      for (let k = n.end + 1; k < toks.length && k <= n.end + REACH && clear; k++) {
        if (elsewhereAt(toks, k)) clear = false;
        else if (toks[k].v === null && content.has(toks[k].s)) {
          j = k;
          break;
        }
      }
      if (!clear || foreignBetween(toks, n.end, j, subject.allow)) continue;
      const span = { from: Math.max(0, n.start - 10), to: Math.min(toks.length - 1, j + 20) };
      if (covers(toks.slice(span.from, span.to + 1), c)) return span;
    }
    return null;
  }
  // A short sentence is read whole; a long run (headings and widgets with no stops) in windows of 40 words.
  const size = toks.length <= 60 ? toks.length : REACH;
  for (let from = 0; from < toks.length; from += 20) {
    const span = { from, to: Math.min(toks.length - 1, from + size - 1) };
    if (covers(toks.slice(span.from, span.to + 1), c)) return span;
    if (span.to === toks.length - 1) break;
  }
  return null;
}

/** The text's sentences; a page of headings and widgets with no stops is one long run, read by where its words sit. */
const segmentsOf = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\s+\.\.\.\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
const counted = (text: string) => text.replace(NOT_A_COUNT, " ");

/** Who a claim is about on a page: the business (its name and city), or a name the claim gives itself. */
export type ClaimSubject = { name: string; city?: string | null };

/**
 * The name a competitor's claim is about, from its own words: its leading run
 * of capitalized words ("Rival Pipes Plumbing is rated ..."). Null when it
 * names nobody ("Rated 4.8 stars ...").
 */
export function claimSubject(statement: string): string | null {
  const { shown, toks } = read(statement);
  let end = -1;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const raw = shown.slice(t.start, t.end);
    const joins = k > 0 && (t.w === "and" || t.w === "of");
    if (t.v !== null || !(t.cap || /^\p{Lu}{1,4}$/u.test(raw) || joins)) break;
    end = k;
  }
  if (end < 0) return null;
  const telling = toks.slice(0, end + 1).filter((t) => t.w.length >= 3 && !STOP.has(t.w) && !GENERIC_NAME_WORDS.has(t.w) && !PAGE_WORDS.has(t.w));
  return telling.length ? shown.slice(toks[0].start, toks[end].end) : null;
}

/**
 * The passage of `text` that states `statement`, or null when none does (see
 * the Verified rules above). `subject` is who the claim is about when the
 * page is a listing (the business's own, or a competitor's): its name must
 * come just before the figures, with nothing of another business between.
 */
export function sentenceStating(statement: string, text: string, subject: string | ClaimSubject | null = null): string | null {
  const claimText = statement.normalize("NFKC");
  if (OTHER_DIGIT.test(claimText.replace(/[0-9]/g, "")) || NON_LATIN_LETTER.test(claimText)) return null;
  const c = claimOf(read(claimText).toks);
  if (!c.words.length) return null;
  const figures = [...new Set(numbersIn(counted(claimText)))];
  if (figures.length > MAX_CLAIM_FIGURES || c.figs.length > MAX_CLAIM_FIGURES) return null;
  const who = typeof subject === "string" ? { name: subject } : subject;
  let named: Subject | null = null;
  if (who) {
    const want = nameStemsOf(who.name);
    if (!want.length) return null;
    named = { want, allow: new Set([...want, ...(who.city ? nameStemsOf(who.city) : [])]) };
  }
  for (const segment of segmentsOf(text.normalize("NFKC"))) {
    const segmentFigures = numbersIn(counted(segment));
    if (figures.some((n) => !segmentFigures.some((m) => near(n, m)))) continue;
    const { shown, toks } = read(segment);
    const span = c.figs.length ? figureSpan(toks, c, named) : wordSpan(toks, c, named);
    if (span) return shown.slice(toks[span.from].start, toks[span.to].end).trim();
  }
  return null;
}

/**
 * True when the page's text names the business: every telling word of a name
 * of one or two such words, or 70% of a longer one. A listing that does not
 * name the business speaks for no one (review of phase 3, F1).
 */
export function namesBusiness(text: string, name: string): boolean {
  const want = wordsOf(name).filter((w) => !GENERIC_NAME_WORDS.has(w));
  if (!want.length) return false;
  const have = new Set(wordsOf(text));
  const n = want.filter((w) => have.has(w)).length;
  return want.length <= 2 ? n === want.length : n / want.length >= 0.7;
}

/**
 * True when a listing's page is the business's own: it names the business and,
 * when the business's city, web address or phone number is known, shows one of
 * them too. A business of the same name in another city is not this one
 * (re-review of phase 3, finding 1).
 */
export function identifiesBusiness(text: string, business: { name: string; city?: string | null; host?: string | null; phone?: string | null }): boolean {
  if (!namesBusiness(text, business.name)) return false;
  const plain = ` ${text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const city = (business.city ?? "").split(",")[0].normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const host = (business.host ?? "").toLowerCase().replace(/^www\./, "");
  const phone = (business.phone ?? "").replace(/\D/g, "").slice(-10);
  const shown = [
    city.length >= 3 ? plain.includes(` ${city} `) : null,
    host.includes(".") ? text.toLowerCase().includes(host) : null,
    phone.length === 10 ? text.replace(/\D/g, "").includes(phone) : null,
  ].filter((x): x is boolean => x !== null);
  return !shown.length || shown.some(Boolean);
}

/** Why `source` proves `finding`, or null when it does not. */
function proves(finding: DocFinding, source: EvidenceSource, now: Date): boolean {
  if (source.confirmed_note && source.confirmed_note.trim()) return true;
  if (source.kind === "measurement") return source.reliability === "own_measurement" || source.reliability === undefined;
  if (source.kind === "website" || source.kind === "listing" || source.kind === "publication") {
    const text = source.text ?? "";
    if (!text) return false;
    // A 404 or 500 page's figures are nobody's facts; a listing that never names the business is not its listing.
    if (typeof source.http_status !== "number" || source.http_status < 200 || source.http_status >= 300) return false;
    if (source.about_business === false) return false;
    if (source.kind === "publication") {
      if (source.reliability !== "high" && source.reliability !== "medium") return false;
      const at = source.published_at ? Date.parse(source.published_at) : NaN;
      if (!Number.isFinite(at) || now.getTime() - at > BENCHMARK_MAX_AGE_MS || at > now.getTime() + 86_400_000) return false;
    }
    // The figure a finding carries is one its own statement states, and the page states both.
    if (finding.metric && (!figureIn(finding.metric.value, finding.statement) || !figureIn(finding.metric.value, text))) return false;
    // On a listing, who the claim is about: the business (its name and city), or, on a competitor's page, the name the
    // claim gives itself; a competitor's claim that names nobody is never stated (re-review of phase 3, finding 2).
    const named = source.subject_from_claim ? claimSubject(finding.statement) : null;
    if (source.subject_from_claim && !named) return false;
    const subject: ClaimSubject | null = named ? { name: named } : source.subject_name ? { name: source.subject_name, city: source.subject_city ?? null } : null;
    return sentenceStating(finding.statement, text, subject) !== null;
  }
  return false;
}

/**
 * Each finding with the label its evidence allows, and what changed. Sources
 * a finding names that do not exist are ignored (never trusted).
 */
export function enforceEvidence(findings: readonly DocFinding[], sources: readonly EvidenceSource[], now: Date): { findings: DocFinding[]; changes: EvidenceChange[] } {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const out: DocFinding[] = [];
  const changes: EvidenceChange[] = [];
  const change = (f: DocFinding, action: EvidenceChange["action"], reason: string) => changes.push({ finding_id: f.id, title: f.title.slice(0, 200), action, reason });
  const downgrade = (f: DocFinding, reason: string) => {
    // Only a finding with no figure of its own can stand as a hypothesis.
    if (f.metric || statesAnyFigure(f.statement)) {
      change(f, "dropped", `${reason}, and a figure cannot stand as a hypothesis`);
      return;
    }
    change(f, "downgraded", reason);
    out.push({ ...f, label: "hypothesis", source_ids: f.source_ids.filter((id) => byId.has(id)), how_to_test: f.how_to_test || "Check it with the client before it is used." });
  };
  for (const f of findings) {
    const cited = f.source_ids.map((id) => byId.get(id)).filter((s): s is EvidenceSource => !!s);
    if (f.label === "verified") {
      if (cited.some((s) => proves(f, s, now))) out.push({ ...f, source_ids: cited.map((s) => s.id) });
      else downgrade(f, "no stored source proves it");
      continue;
    }
    if (f.label === "client_reported") {
      if (cited.some((s) => s.kind === "client")) out.push({ ...f, source_ids: cited.map((s) => s.id) });
      else change(f, "dropped", "it does not say where the client said it");
      continue;
    }
    if (f.label === "estimate") {
      change(f, "dropped", "only the impact calculator makes an estimate");
      continue;
    }
    // A hypothesis: no figure, and how to test it.
    if (f.metric || statesAnyFigure(f.statement)) {
      change(f, "dropped", "a hypothesis carries no figure of its own");
      continue;
    }
    out.push({ ...f, source_ids: cited.map((s) => s.id), how_to_test: f.how_to_test || "Check it with the client before it is used." });
  }
  return { findings: out, changes };
}
