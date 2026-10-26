/**
 * lib/ai-audit/evidence.ts — the four evidence labels, enforced in code.
 *
 * Research proposes findings; this decides which label each may carry, from
 * what is actually stored behind it (CC's brief, section 5):
 *   - Verified fact: our own measurement produced it (a site check, a PageSpeed
 *     run), or a stored snapshot of a public page states it, or CC confirmed it
 *     with a note. A page states a claim only when one passage of one of its
 *     sentences does: every figure of the claim, each bound to the same thing
 *     ("120 reviews" is never "120 photos") with the same "over" or "under";
 *     every long word of the claim and most of the rest; the same yes or no
 *     and the same tense ("formerly offered" never proves "offers"); never the
 *     opposite word ("closed" never proves "open"). A claim in another script
 *     is never stated. The page must have answered 2xx. A listing must be the
 *     business's own (its name, and its city, web address or phone when one is
 *     known), and on it the business's name comes before the figures, with no
 *     other business's figures, and no "similar" or "sponsored", in between
 *     (re-review of phase 3, finding 1). A published benchmark counts only from
 *     a named public body or research firm (high or medium reliability, set by
 *     research.ts from the host, never by the model) dated in the last three
 *     years.
 *   - Client-reported: the client said it (a transcript's lines, a form field,
 *     CC's call notes).
 *   - Reasonable estimate: only the impact calculator makes one
 *     (lib/ai-audit/impact.ts); a finding is never an estimate.
 *   - Hypothesis: carries no figure of its own, in any form (digits, words, a
 *     share like "half of"), and says how to test it.
 * A finding that fails is downgraded (a Verified fact with no proof becomes a
 * hypothesis when it has no figure) or dropped (a figure nobody can stand
 * behind), never upgraded; each change is listed with its reason.
 *
 * PURE: no I/O.
 */
import { statesFigure, type DocFinding } from "@/lib/ai-audit/doc";
import { numbersIn } from "@/lib/ai-audit/extract";

/** A source as research stored it: what the evidence rules may rely on. */
export type EvidenceSource = {
  id: string;
  kind: "measurement" | "website" | "listing" | "publication" | "client" | "other";
  /** The stored text a page's claim must appear in: the sentences that state its claims, and the page's start. */
  text?: string;
  reliability?: "high" | "medium" | "low" | "own_measurement" | "client_stated";
  published_at?: string | null;
  /** CC confirmed the fact behind it, with this note. */
  confirmed_note?: string | null;
  /** For a page we read: its HTTP status. Only a page that answered 2xx proves anything. */
  http_status?: number | null;
  /** For a listing of the business (not a competitor's): whether the page is the business's own. False proves nothing. */
  about_business?: boolean | null;
  /** For the business's own listing: its name, which comes before a claim's figures in the passage that states it. */
  subject_name?: string | null;
};

export type EvidenceChange = { finding_id: string; title: string; action: "downgraded" | "dropped"; reason: string };

const BENCHMARK_MAX_AGE_MS = 3 * 365.25 * 86_400_000;

/** The figure appears in the text as written: never 4 because the page says 400. */
function figureIn(value: number, text: string): boolean {
  return numbersIn(text).some((n) => Math.abs(value - n) <= Math.max(1e-9, Math.abs(n) * 1e-6));
}

/** "one" that counts nothing: "each one", "no one", "one of them". Shared with the prose check (lib/ai-audit/prose.ts). */
export const NOT_A_COUNT = /\b(?:each|every|no|any|some|the|this|that|which)\s+one\b|\bone\s+(?:of|another|by one)\b|\bsomeone\b|\banyone\b/gi;
/** A share said in words: "half of", "two thirds of", "one in four", "3 out of 10"; never "half-works" (re-review of phase 3, finding 3). */
const SHARE_PHRASE = /\b(?:half|(?:a|one|two|three|four)\s+(?:quarters?|thirds?|fifths?|tenths?))\s+(?:of|the)\b|\bone\s+in\s+(?:two|three|four|five|six|seven|eight|nine|ten)\b|\b\d+\s+out\s+of\s+\d+\b/i;
/** A multiple said in words: "twice as many", "double the", "tenfold". */
const MULTIPLE_PHRASE = /\btwice\b|\b(?:double|triple|quadruple)[sd]?\s+(?:the|their|its|your|as|what)\b|\b(?:two|three|four|five|ten|hundred)fold\b|\btenfold\b|\bhalf\s+as\s+(?:many|much)\b/i;

/**
 * True when the text states a figure in any form: digits in any script, number
 * words ("forty percent", "a million"), or a share ("half of", "two thirds").
 * A hypothesis may carry none (review of phase 3, F2).
 */
export function statesAnyFigure(text: string): boolean {
  const plain = text.normalize("NFKC").replace(NOT_A_COUNT, " ");
  return statesFigure(plain) || numbersIn(plain).length > 0 || SHARE_PHRASE.test(plain) || MULTIPLE_PHRASE.test(plain);
}

const STOP = new Set("the and for with our you your its are was were has have had from into that this they them their than then also very just more most such only".split(" "));
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
/** A star drawn as a character ("4.7" and five stars) reads as the word. */
const STAR_CHARS = new RegExp(`[${String.fromCharCode(0x2605, 0x2606, 0x2b50)}]`, "g");

// ---------------------------------------------------------------------------
// A text as words and figures, each figure bound to what it counts
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
  /** What a figure counts: the nouns right after it ("120 reviews"; "12 customer reviews" counts both), or "$" and "%". */
  units: Set<string>;
  /** The comparison in front of a figure: "over 10", "under 10", "about 10". */
  cmp: Cmp;
  start: number;
  end: number;
};

const UNIT_OF = new Map<string, string>(
  (
    [
      ["star", "star stars rating ratings"],
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
      ["vehicle", "vehicle vehicles truck trucks van vans"],
      ["lead", "lead leads"],
      ["visit", "visit visits visitor visitors"],
      ["%", "percent"],
      ["$", "dollar dollars"],
    ] as const
  ).flatMap(([unit, words]) => words.split(" ").map((w): [string, string] => [w, unit])),
);
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

/** The text as shown (a drawn star as the word), and its words and figures. */
function read(text: string): { shown: string; toks: Tok[] } {
  const shown = text.normalize("NFKC").replace(STAR_CHARS, " star ");
  // "each one", "no one", "someone" count nothing: blanked, at the same length, before the figures are read.
  const counted = shown.replace(NOT_A_COUNT, (m) => " ".repeat(m.length));
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
        toks.push({ w: part, s: "", v, units: new Set(m[1] ? ["$"] : m[3] === "%" ? ["%"] : []), cmp: m[3] === "+" ? "over" : null, start, end });
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
      } else toks.push({ w, s: "", v: small, units: new Set(), cmp: null, start, end });
      continue;
    }
    const scale = SCALES.get(w);
    if (scale !== undefined && prev && prev.v !== null) {
      prev.v *= scale;
      prev.end = end;
      continue;
    }
    toks.push({ w, s: stem(w), v: null, units: new Set(), cmp: null, start, end });
  }
  toks.forEach((t, i) => {
    if (t.v === null) return;
    for (let k = i + 1; k <= i + 2 && k < toks.length; k++) {
      const unit = toks[k].v === null ? UNIT_OF.get(toks[k].w) : undefined;
      if (!unit) break;
      t.units.add(unit);
    }
    // A rating drawn as stars, not written: "4.5 (95 reviews)".
    if (!t.units.size && t.v > 0 && t.v <= 5 && t.w.includes(".") && toks[i + 1]?.v !== null && toks[i + 2] && UNIT_OF.get(toks[i + 2].w) === "review") t.units.add("star");
    if (t.cmp === null) {
      const one = i > 0 && toks[i - 1].v === null ? toks[i - 1].w : null;
      const two = one !== null && i > 1 && toks[i - 2].v === null ? `${toks[i - 2].w} ${one}` : null;
      t.cmp = (two !== null ? CMP_TWO.get(two) : undefined) ?? (one !== null ? CMP_ONE.get(one) : undefined) ?? null;
    }
  });
  return { shown, toks };
}

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);
/** The same thing counted: either says nothing of what it counts, or both name one thing in common. */
const meets = (a: Set<string>, b: Set<string>) => !a.size || !b.size || [...a].some((u) => b.has(u));
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

type Claim = { figs: Tok[]; words: string[]; required: string[]; said: Set<string>; negated: boolean; past: boolean };
function claimOf(toks: Tok[]): Claim {
  const words = toks.filter((t) => t.v === null && t.w.length >= 3 && !STOP.has(t.w));
  return {
    figs: toks.filter((t) => t.v !== null),
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
const nameStemsOf = (name: string) => [...new Set(read(name).toks.filter((t) => t.v === null && t.w.length >= 3 && !STOP.has(t.w) && !GENERIC_NAME_WORDS.has(t.w)).map((t) => t.s))];
/** Where the name starts: every telling word of a name of one or two, or 70% of a longer one, close together. */
function namedAt(toks: readonly Tok[], want: readonly string[]): number[] {
  const need = want.length <= 2 ? want.length : Math.ceil(want.length * 0.7);
  const at: number[] = [];
  toks.forEach((t, i) => {
    if (t.v !== null || !want.includes(t.s)) return;
    const here = new Set(toks.slice(i, i + want.length + 2).map((x) => x.s));
    if (want.filter((w) => here.has(w)).length >= need) at.push(i);
  });
  return at;
}
/** Words that open another business's part of a page: "Similar plumbers", "Sponsored", "People also viewed". */
const ELSEWHERE = new Set(["similar", "sponsored", "sponsor", "nearby", "alternative", "alternatives", "competitor", "competitors", "versus", "vs", "ads", "advertisement", "related"]);
const elsewhereAt = (toks: readonly Tok[], k: number) =>
  toks[k].v === null && (ELSEWHERE.has(toks[k].w) || (toks[k].w === "also" && /^(?:viewed|searched|like|liked|considered|visited|bought)$/.test(toks[k + 1]?.w ?? "")));

/** How far apart a claim's figures may sit, and its name before them, in words. */
const REACH = 40;
const NAME_REACH = 40;
type Span = { from: number; to: number };

/** The passage that states a claim with figures: each figure at a place bound like the claim's, close together; on a listing, the business's name first. */
function figureSpan(toks: readonly Tok[], c: Claim, name: readonly string[] | null): Span | null {
  const places = c.figs.map((f) => toks.flatMap((t, j) => (t.v !== null && near(t.v, f.v as number) && meets(f.units, t.units) && sameWay(f.cmp, t.cmp) ? [j] : [])).slice(0, 8));
  if (places.some((p) => !p.length)) return null;
  let combos: number[][] = [[]];
  for (const p of places) combos = combos.flatMap((at) => p.map((j) => [...at, j])).slice(0, 256);
  const names = name ? namedAt(toks, name) : [];
  for (const at of combos) {
    const lo = Math.min(...at);
    const hi = Math.max(...at);
    if (hi - lo > REACH) continue;
    if (!name) {
      const span = { from: Math.max(0, lo - 12), to: Math.min(toks.length - 1, hi + 12) };
      if (covers(toks.slice(span.from, span.to + 1), c)) return span;
      continue;
    }
    for (const i of names) {
      if (i >= lo || lo - i > NAME_REACH) continue;
      // Between the name and the figures: no "similar" or "sponsored", and no other figure counting the same thing.
      let clear = true;
      for (let k = Math.max(0, i - 6); k <= hi && clear; k++) if (elsewhereAt(toks, k)) clear = false;
      c.figs.forEach((f, n) => {
        for (let k = i + 1; k < at[n] && clear; k++) {
          const t = toks[k];
          if (t.v !== null && f.units.size && t.units.size && meets(f.units, t.units) && !near(t.v, f.v as number)) clear = false;
        }
      });
      if (!clear) continue;
      const span = { from: Math.max(0, i - 10), to: Math.min(toks.length - 1, hi + 12) };
      if (covers(toks.slice(span.from, span.to + 1), c)) return span;
    }
  }
  return null;
}

/** The passage that states a claim without figures: on a listing, from the business's name to the claim's words after it. */
function wordSpan(toks: readonly Tok[], c: Claim, name: readonly string[] | null): Span | null {
  if (name) {
    const content = new Set(c.words.filter((x) => !name.includes(x)));
    for (const i of namedAt(toks, name)) {
      let clear = true;
      for (let k = Math.max(0, i - 6); k < i && clear; k++) if (elsewhereAt(toks, k)) clear = false;
      let j = i;
      for (let k = i + 1; k < toks.length && k <= i + REACH && clear; k++) {
        if (elsewhereAt(toks, k)) clear = false;
        else if (toks[k].v === null && content.has(toks[k].s)) {
          j = k;
          break;
        }
      }
      if (!clear) continue;
      const span = { from: Math.max(0, i - 10), to: Math.min(toks.length - 1, j + 20) };
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

/**
 * The passage of `text` that states `statement`, or null when none does (see
 * the Verified rules above). `subject` is the business's name when the page is
 * its own listing: the name must come before the figures, with no other
 * business's figures, and no "similar" or "sponsored", in between.
 */
export function sentenceStating(statement: string, text: string, subject: string | null = null): string | null {
  const claimText = statement.normalize("NFKC");
  if (OTHER_DIGIT.test(claimText.replace(/[0-9]/g, "")) || NON_LATIN_LETTER.test(claimText)) return null;
  const c = claimOf(read(claimText).toks);
  if (!c.words.length) return null;
  const name = subject === null ? null : nameStemsOf(subject);
  if (name && !name.length) return null;
  const figures = numbersIn(counted(claimText));
  for (const segment of segmentsOf(text.normalize("NFKC"))) {
    if (figures.some((n) => !figureIn(n, counted(segment)))) continue;
    const { shown, toks } = read(segment);
    const span = c.figs.length ? figureSpan(toks, c, name) : wordSpan(toks, c, name);
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
    return sentenceStating(finding.statement, text, source.subject_name ?? null) !== null;
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
