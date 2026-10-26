/**
 * lib/ai-audit/prose.ts — the audit's opening prose, rewritten by a model and
 * checked before any of it replaces the code draft (lib/ai-audit/draft.ts),
 * phase 4b.
 *
 * WHAT THE MODEL DOES. It rewrites the code draft's own paragraphs in the four
 * opening parts (the Executive Overview, the Current Business Assessment, and
 * the introductions to Key Findings and to Estimated Business Impact), one
 * paragraph for one, in plainer words. Each paragraph comes with the facts it
 * cites, fenced as data. It adds nothing: no transcript, no notes, no prices
 * ever reach it, and everything else in the audit stays code.
 *
 * WHAT IT MAY KEEP (review of phase 4, third round). A rewrite may only use
 * what its own paragraph and the facts each sentence cites already hold:
 *   - every word (a tool, a company or a claim that is in neither is held);
 *   - every figure, as the same kind of thing for the same period, and every
 *     figure the paragraph had is still there (nothing is dropped);
 *   - a "not", a comparison ("more than", "up to") and a result verb ("save",
 *     "win back") only where the paragraph or a cited fact has one;
 *   - a sentence citing a likely problem still says "may" or "likely";
 *   - never a promise ("will", "guarantee"), a price or cost, or a general
 *     rule ("most owners", "often").
 * A rewrite stands or falls as a whole paragraph: if any sentence fails, the
 * code paragraph stays, and the held sentences are listed for CC with why.
 *
 * PURE: no I/O.
 */
import { INJECTION_GUARD, safeJsonExtract, wrapUntrusted } from "@/lib/llm-input-boundary";
import { inventsFacts } from "@/lib/offer-pages/write-page-vet";
import { sentencesOf } from "@/lib/offer-pages/claims";
import { numbersIn } from "@/lib/ai-audit/extract";
import { scrubCredentials } from "@/lib/ai-audit/transcript";
import { statesFigure, type AuditDoc, type DocParagraph } from "@/lib/ai-audit/doc";
import { rangeWords } from "@/lib/ai-audit/opportunities";
import { NOT_A_COUNT } from "@/lib/ai-audit/evidence";

export const PROSE_SCHEMA = "ai_audit_prose/v2" as const;
export const PROSE_MAX_TOKENS = 3_000;
const PARAGRAPH_MAX_CHARS = 900;
const SENTENCES_MAX = 8;
/** Twelve short paragraphs fit in far less: a longer answer is not read at all. */
const PROSE_ANSWER_MAX_CHARS = 40_000;

export type ProsePart = "executive_overview" | "current_assessment" | "key_findings_intro" | "impact_intro";
export const PROSE_PARTS: readonly ProsePart[] = ["executive_overview", "current_assessment", "key_findings_intro", "impact_intro"];
/** Per part, one slot per code paragraph: the rewrite that stands, or null where the code paragraph stays. */
export type CheckedProse = { parts: Partial<Record<ProsePart, Array<DocParagraph | null>>>; withheld: Array<{ part: ProsePart; sentence: string; reason: string }> };

const SYSTEM = [
  "You rewrite the opening of a free AI audit for the owner of a small business, so that it reads as a trusted advisor speaking plainly to them, in Canadian English. Short sentences. No jargon, no hype.",
  "You are given the draft's paragraphs, part by part, each with the facts it rests on.",
  "Rules:",
  "1. Rewrite each paragraph: return the same number of paragraphs per part, in the same order.",
  "2. Keep every figure exactly as given, with its unit and period (\"10 calls a week\"). Leave none out. Never round, add up or work out a new figure.",
  "3. Add nothing the paragraph and its facts do not say: no new claim, result, time, comparison, tool, company or name. Use their words where you can.",
  "4. Never promise a result and never write \"will\". Do not mention prices, costs, the proposal or payment, and no general rules about other businesses (\"most owners\", \"often\").",
  "5. A likely problem stays likely: write it with \"may\" or \"likely\".",
  "6. Each sentence lists the ids of the facts it uses, from its paragraph's facts.",
  "7. Answer with JSON only, in exactly this shape:",
  '{"executive_overview":[{"sentences":[{"text":"...","cites":["<id>"]}]}],"current_assessment":[{"sentences":[...]}],"key_findings_intro":[{"sentences":[...]}],"impact_intro":[{"sentences":[...]}]}',
  "",
  INJECTION_GUARD,
].join("\n");

/** The code draft's paragraphs for one part, in order. */
function codeParagraphs(doc: AuditDoc, part: ProsePart): DocParagraph[] {
  const s = doc.sections;
  if (part === "executive_overview") return s.executive_overview.paragraphs;
  if (part === "current_assessment") return s.current_assessment.paragraphs;
  if (part === "key_findings_intro") return s.key_findings.intro ? [s.key_findings.intro] : [];
  return s.impact.intro ? [s.impact.intro] : [];
}

/** What one cited id says: a finding's title and statement, or an estimate's title, range and assumptions. */
function factText(doc: AuditDoc, id: string): string {
  const f = doc.findings.find((x) => x.id === id);
  if (f) return `${f.title}. ${f.statement} ${f.metric?.unit ?? ""}`;
  const e = doc.estimates.find((x) => x.id === id);
  if (e) return `${e.title}. ${rangeWords(e)} ${e.unit}. ${e.assumptions.join(" ")}`;
  const src = doc.sources.find((x) => x.id === id);
  return src ? src.title : "";
}

/** The prompt: each part's paragraphs with the facts each rests on, fenced as data. */
export function prosePrompt(doc: AuditDoc): { system: string; prompt: string } {
  const name = scrubCredentials(doc.business.name.replace(/[\r\n]+/g, " ").slice(0, 200)).text;
  const parts = Object.fromEntries(
    PROSE_PARTS.map((part) => [
      part,
      codeParagraphs(doc, part).map((p) => ({ paragraph: p.text, facts: p.cites.map((id) => ({ id, says: factText(doc, id) })).filter((x) => x.says) })),
    ]),
  );
  const prompt = [
    wrapUntrusted(name, { label: "business name", maxLen: 300 }),
    "Rewrite each paragraph from its own facts. Cite facts by their id.",
    "",
    wrapUntrusted(JSON.stringify(parts), { label: "audit draft", maxLen: 40_000 }),
  ].join("\n");
  return { system: SYSTEM, prompt };
}

type Period = "hour" | "day" | "week" | "month" | "quarter" | "year" | "total";
type Kind = "money" | "share" | "count";
type Figure = { value: number; start: number; end: number; kind: Kind; period: Period | null; periodAt: [number, number] | null; inRange: boolean };

// Maps, never object lookups (review of phase 2b).
const PERIODS = new Map<string, Period>([
  ["hour", "hour"], ["hr", "hour"], ["hourly", "hour"],
  ["day", "day"], ["daily", "day"],
  ["week", "week"], ["wk", "week"], ["weekly", "week"],
  ["month", "month"], ["mo", "month"], ["monthly", "month"],
  ["quarter", "quarter"], ["quarterly", "quarter"],
  ["year", "year"], ["yr", "year"], ["yearly", "year"], ["annually", "year"], ["annual", "year"], ["annum", "year"],
  ["total", "total"], ["all", "total"], ["altogether", "total"],
]);
/** A rate's period: "a week", "per month", "each year", "last month", "/week", "monthly", "per annum", "in total". */
const RATE =
  /\b(?:a|an|per|each|every|last|this|past|next|previous|coming)\s+(hour|day|week|month|quarter|year|annum)\b|\/\s?(hour|hr|day|week|wk|month|mo|year|yr)\b|\b(hourly|daily|weekly|monthly|quarterly|yearly|annually|annual|altogether)\b|\bin\s+(total|all)\b/i;
/** A figure written in digits: "$1,300", "2.5", "40k", "30%", "30 per cent", "$2.5m". */
const FIGURE = /(\$\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(k|thousand|grand|million|mil|m|hundred)\b)?(\s?%|\s+percent\b|\s+per\s+cent\b)?/gi;
/** What may stand between a range's two figures: "to", "-", "or", "and", after a unit ("1.5 hours to 3 hours"). */
const RANGE_GAP = /^\s*(?:[a-z%$]+\s+)?(?:to|-|\u2013|\u2014|or|and)\s*\$?\s*$/i;
/** Where a figure's own clause ends. */
const CLAUSE_END = /[,;:.!?]|\b(?:and|but|which|while|so|because|whereas)\b/i;
/** "Within a minute", "an hour": a time frame (inventsFacts checks those against the draft), not a count. */
const A_TIME = /\b(?:a|an)\s+(?:second|minute|hour|day|week|month|quarter|year)s?\b/gi;
/** A share said in words: "half of", "two thirds of", "one in four". */
const SHARE_WORDS = /\b(?:half|(?:a|one|two|three|four)\s+(?:quarters?|thirds?|fifths?|tenths?))\s+(?:of|the)\b|\bone\s+in\s+(?:two|three|four|five|six|seven|eight|nine|ten)\b/i;
const NUMBER_WORD = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|dozen|couple)\b/gi;

/** A promise of a result, in any tense of "will" or its cousins; "not a promise" is a disclaimer, never one. */
const NOT_A_PROMISE = /\b(?:not|never|no)\s+(?:a\s+)?promises?\b/gi;
const PROMISE = /\b(?:will|won't|wont|shall|going\s+to|guarantee[sd]?|guarantees|promise[sd]?|ensures?|ensured|definitely|certainly|for\s+sure|no\s+doubt|in\s+no\s+time|overnight|pays?\s+(?:for\s+)?itself|pay\s+off)\b/i;
/** Money talk the proposal owns; the audit's own name ("your free AI audit") is not. */
const AUDIT_NAME = /\bfree\s+(?:ai\s+)?audit\b/gi;
/** "Free up time" frees time, not money. */
const FREE_UP = /\bfree\s+(?:up|of)\b/gi;
const PRICE = /\b(?:free|cost|costs|costing|costly|afford\w*|cheap\w*|expensive|quote[sd]?|quotes|price[sd]?|prices|pricing|fees?|payments?|pay|paid|paying|invest\w*|budget\w*|charge[sd]?|charges|discount\w*|proposal|refund\w*)\b/i;
/** A general rule about other businesses, which no fact in this audit states. */
const GENERAL =
  /\b(?:most|many|few|often|usually|rarely|seldom|always|never|typically|generally|commonly|frequently|normally|everyone|everybody|nobody|no\s+one|the\s+majority|on\s+average|statistic\w*|studies|study|surveys?|experts?|benchmarks?|industry)\b|\blike\s+yours\b|\bresearch\s+(?:shows|says|finds|suggests)\b/i;
/** A ranking the roadmap itself makes is not a rule about other businesses. */
const OWN_RANKING = /\bthe\s+most\s+(?:valuable|useful|important|urgent)\b/gi;
const HEDGE = /\b(?:may|might|could|likely|probably|possibly|perhaps|seems?|appears?|suggests?|unclear)\b/i;

/** Words that carry no claim of their own. */
const STOP = new Set(
  (
    "a an the and or but if then than so as at by for from in into of on onto to with without within about above below over under after before between through during per via up down out off " +
    "i we us our ours you your yours it its they them their theirs he she his her this that these those who whom whose which what where when why how " +
    "is are was were be been being am has have had having do does did doing can could may might must shall should would " +
    "not no nor all any each every both either neither some such more less other another own same very just also only even still yet here there now " +
    "get gets got make makes made take takes took use uses used using need needs help helps keep keeps let lets see seen show shows shown find finds found give gives " +
    "come comes came go goes went put set look looks looked way ways thing things part parts lot lots likely probably possibly perhaps seem seems appear appears " +
    "one ones today right well much many most spend spends spent spending"
  ).split(" "),
);
/** The audit's own framing: words a sentence may use without citing anything. */
const FRAMING = new Set(
  (
    "audit audits finding findings estimate estimates estimated figure figures range ranges source sources label labels labelled labeled section sections " +
    "page pages overview summary assessment opportunity opportunities recommendation recommendations roadmap step steps priority priorities order " +
    "detail details explain explains following list listed confirm confirmed check checked measure measured verify verified fact facts information " +
    "conversation call discovery told said shared based built read review reviewed current currently impact depends depend rest rests assumption assumptions"
  ).split(" "),
);

/** The word's plain forms: "missed" is "miss", "replies" is "reply", "booking" is "book". */
function stemsOf(word: string): string[] {
  const w = word.toLowerCase();
  const out = new Set([w]);
  const strip = (suffix: string, add = "") => {
    if (w.length >= suffix.length + 2 && w.endsWith(suffix)) out.add(w.slice(0, -suffix.length) + add);
  };
  strip("'s");
  strip("s");
  strip("es");
  strip("ies", "y");
  strip("ed");
  strip("ed", "e");
  strip("ing");
  strip("ing", "e");
  strip("ly");
  strip("er");
  strip("ers");
  for (const x of [...out]) if (/(.)\1$/.test(x) && x.length > 3) out.add(x.slice(0, -1));
  return [...out];
}
const wordsIn = (text: string): string[] =>
  text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^a-z']+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length >= 2);
function stemSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of wordsIn(text)) for (const x of stemsOf(w)) out.add(x);
  return out;
}
const supported = (word: string, stems: ReadonlySet<string>) => stemsOf(word).some((x) => stems.has(x));

function periodIn(segment: string): { period: Period; at: [number, number] } | null {
  const m = RATE.exec(segment);
  if (!m || m.index === undefined) return null;
  const period = PERIODS.get((m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").toLowerCase());
  return period ? { period, at: [m.index, m.index + m[0].length] } : null;
}

/**
 * Every figure written in digits, with its kind and the period it is a rate
 * of. A range's figures ("$1,300 to $3,250 per month") share one period. It is
 * read forward within the figure's own clause ("10 calls a week"), else back
 * to that clause's start ("each month you miss 10"), never past a period
 * another figure already took ("10 calls a week at a 30% close rate").
 */
function figuresOf(text: string): Figure[] {
  const found: Figure[] = [];
  for (const m of text.matchAll(FIGURE)) {
    const start = m.index ?? 0;
    // Digits inside a word ("Q3", "hunter2") are no figure.
    if (start > 0 && /[a-z0-9]/i.test(text[start - 1])) continue;
    const scale = (m[3] ?? "").toLowerCase();
    const times = scale === "k" || scale === "thousand" || scale === "grand" ? 1_000 : scale === "million" || scale === "mil" || (scale === "m" && m[1]) ? 1_000_000 : scale === "hundred" ? 100 : 1;
    const value = Number(m[2].replace(/,/g, "")) * times;
    const end = start + m[0].length;
    const kind: Kind = m[1] || /^\s*dollars?\b/i.test(text.slice(end)) ? "money" : m[4] ? "share" : "count";
    if (Number.isFinite(value)) found.push({ value, start, end, kind, period: null, periodAt: null, inRange: false });
  }
  const groups: Figure[][] = [];
  for (const f of found) {
    const last = groups[groups.length - 1];
    if (last && RANGE_GAP.test(text.slice(last[last.length - 1].end, f.start))) {
      last[last.length - 1].inRange = true;
      last.push(f);
    } else groups.push([f]);
  }
  const set = (g: Figure[], period: Period, at: [number, number]) => {
    for (const f of g) f.period = period;
    g[g.length - 1].periodAt = at;
  };
  groups.forEach((g, i) => {
    const end = g[g.length - 1].end;
    const ahead = periodIn(text.slice(end, groups[i + 1]?.[0].start ?? text.length).split(CLAUSE_END)[0]);
    if (ahead) set(g, ahead.period, [end + ahead.at[0], end + ahead.at[1]]);
  });
  groups.forEach((g, i) => {
    if (g[0].period) return;
    const prev = groups[i - 1];
    const from = prev ? Math.max(prev[prev.length - 1].end, prev[prev.length - 1].periodAt?.[1] ?? 0) : 0;
    const before = text.slice(from, g[0].start).replace(/[\s,]+$/, "");
    const parts = before.split(CLAUSE_END);
    const own = parts[parts.length - 1] ?? "";
    const behind = periodIn(own);
    if (behind) {
      const base = from + before.length - own.length;
      set(g, behind.period, [base + behind.at[0], base + behind.at[1]]);
    }
  });
  return found;
}

type CitedFigure = { value: number; kind: Kind; period: Period | null; text: string };

function kindOfUnit(unit: string | undefined | null): Kind {
  return unit === "$" ? "money" : unit === "%" || unit === "share" ? "share" : "count";
}

/** The figures the cited ids state, each with its kind, period and the words of the fact it belongs to. */
function citedFigures(doc: AuditDoc, ids: readonly string[]): CitedFigure[] {
  const out: CitedFigure[] = [];
  for (const id of ids) {
    const f = doc.findings.find((x) => x.id === id);
    if (f) {
      const words = `${f.title}. ${f.statement} ${f.metric?.unit ?? ""}`;
      out.push(...figuresOf(f.statement.normalize("NFKC")).map((x) => ({ value: x.value, kind: x.kind, period: x.period, text: words })));
      if (f.metric) out.push({ value: f.metric.value, kind: kindOfUnit(f.metric.unit), period: periodIn(f.metric.unit ?? "")?.period ?? null, text: words });
    }
    const e = doc.estimates.find((x) => x.id === id);
    if (e) {
      const words = `${e.title}. ${rangeWords(e)} ${e.unit} ${e.inputs.map((x) => x.name).join(" ")}`;
      const period = periodIn(e.period ?? "")?.period ?? null;
      out.push(...figuresOf(rangeWords(e)).map((x) => ({ value: x.value, kind: x.kind, period: x.period ?? period, text: words })));
      out.push({ value: e.low, kind: kindOfUnit(e.unit), period, text: words }, { value: e.high, kind: kindOfUnit(e.unit), period, text: words });
    }
  }
  return out;
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-6);
const shown = (n: number) => n.toLocaleString("en-CA", { maximumFractionDigits: 2 });
const KIND_WORDS: Readonly<Record<Kind, string>> = { money: "an amount of money", share: "a share", count: "a count" };

/** Digits inside a word or code ("B2B", "Web3"): no figure, as numbersIn reads them. */
const GLUED = /\b[a-z]+\d[a-z\d]*\b/gi;

/** The names the audit itself uses (the business, the client's systems), longest first: never figures ("24 Hour Plumbing"). */
function namesOf(doc: AuditDoc): string[] {
  const name = doc.business.name.trim();
  const all = [name, name.replace(/^\[test\]\s*/i, ""), ...doc.sections.current_assessment.systems.map((x) => x.name.trim())];
  return [...new Set(all.filter((x) => x.length >= 2))].sort((a, b) => b.length - a.length);
}

/** The sentence with each of the audit's own names blanked out, so a digit in a name is no figure; positions are kept. */
function withoutNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const n of names) {
    const re = new RegExp(n.normalize("NFKC").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(re, (m) => " ".repeat(m.length));
  }
  return out;
}

const FRAMING_STEMS: ReadonlySet<string> = new Set([...FRAMING].flatMap((x) => stemsOf(x)));

/** A "not" in any of its forms: a rewrite keeps the facts' yes or no. */
const NEGATOR = /\b(?:not|no|never|none|nothing|nobody|without|cannot|can't|cant|don't|doesn't|isn't|aren't|won't|unable|unavailable|lacks?)\b|n't\b/i;
/** A comparison that turns a figure into a bound. */
const COMPARISON = /\b(?:more|less|fewer|greater|higher|lower|over|under|above|below|beyond|up\s+to|at\s+least|at\s+most|nearly|almost|only|just|twice|double|triple|half)\b/gi;
/** A result: what a change does for the business, which only an estimate sizes. */
const RESULT_VERB = /\b(?:save[sd]?|saving|win|wins|won|winning|recover\w*|gain\w*|grow\w*|increase[sd]?|increasing|boost\w*|cut|cuts|reduce[sd]?|reducing|doubl\w*|tripl\w*|earn\w*|bring\w*|brought|generat\w*)\b/gi;
const CURLY = new RegExp(`[${String.fromCharCode(0x2018, 0x2019)}]`, "g");
const plainApostrophes = (s: string) => s.replace(CURLY, "'");

/** A sentence's own words, less its figures and the names the audit uses. */
function contentWords(text: string, names: readonly string[]): string[] {
  return wordsIn(withoutNames(text, names).replace(NOT_A_PROMISE, " ")).filter((x) => !STOP.has(x) && !/^\d/.test(x));
}
const lowerSet = (text: string, re: RegExp) => new Set((plainApostrophes(text).match(re) ?? []).map((m) => m.toLowerCase().replace(/\s+/g, " ")));

/**
 * Why one sentence of a rewrite is held, or null when everything in it comes
 * from `source` (its code paragraph and the facts the sentence cites).
 */
function sentenceWhy(sentence: string, cites: readonly string[], source: string, doc: AuditDoc, names: readonly string[], hypotheses: ReadonlySet<string>): string | null {
  const text = plainApostrophes(sentence.normalize("NFKC"));
  if (PROMISE.test(text.replace(NOT_A_PROMISE, " "))) return "it promises a result";
  if (PRICE.test(text.replace(AUDIT_NAME, " ").replace(FREE_UP, " "))) return "it speaks of prices, costs or payment, which only the proposal states";
  const general = GENERAL.exec(text.replace(OWN_RANKING, " "));
  if (general && !source.toLowerCase().includes(general[0].toLowerCase())) return "it states a general rule the audit's facts do not";
  const figures = figuresOf(withoutNames(text, names));
  const cuts = figures.flatMap((f) => [[f.start, f.end] as [number, number], ...(f.periodAt ? [f.periodAt] : [])]).sort((a, b) => a[0] - b[0]);
  let rest = "";
  let at = 0;
  for (const [from, to] of cuts) {
    if (from < at) continue;
    rest += `${text.slice(at, from)} `;
    at = to;
  }
  rest += text.slice(at);
  const unnamed = withoutNames(rest, names).replace(GLUED, " ");
  const lowerSource = source.toLowerCase();
  // A number word the source says the same way ("in one tap") is the source's, not a new figure.
  const wordFigures = unnamed.replace(NOT_A_COUNT, " ").replace(A_TIME, " ").replace(NUMBER_WORD, (m: string, i: number, whole: string) => {
    const phrase = whole.slice(i, i + m.length + 12).toLowerCase().match(/^[a-z]+\s+[a-z]+/)?.[0] ?? m.toLowerCase();
    return lowerSource.includes(phrase) ? " " : m;
  });
  if (statesFigure(unnamed) || numbersIn(wordFigures).length || SHARE_WORDS.test(unnamed)) return "it writes a figure in a form the check cannot match to a source: use the figure as the facts state it";
  if (figures.length) {
    if (!cites.length) return "it states a figure without citing where it comes from";
    const allowed = citedFigures(doc, cites);
    for (const f of figures) {
      const same = allowed.filter((m) => close(m.value, f.value));
      if (!same.length) return `it states ${shown(f.value)}, which nothing it cites states`;
      const kinds = same.filter((m) => m.kind === f.kind);
      if (!kinds.length) return `it states ${shown(f.value)} as ${KIND_WORDS[f.kind]}, but what it cites gives ${shown(f.value)} as ${KIND_WORDS[same[0].kind]}`;
      const timed = kinds.filter((m) => m.period === f.period);
      if (!timed.length) {
        const theirs = kinds.find((m) => m.period)?.period;
        return `it states ${shown(f.value)}${f.period ? ` a ${f.period}` : " with no period"}; what it cites gives ${theirs ? `${shown(f.value)} a ${theirs}` : "no period"}`;
      }
      if (f.kind === "count" && !f.inRange) {
        const after = text.slice(f.periodAt && f.periodAt[0] === f.end ? f.periodAt[1] : f.end).match(/^[\s-]*(?:out\s+of\b|([a-z']+))/i);
        const noun = after?.[1]?.toLowerCase();
        if (noun && !STOP.has(noun) && !timed.some((m) => supported(noun, stemSet(m.text)))) return `it counts ${shown(f.value)} ${noun}, but what it cites counts something else`;
      }
    }
  }
  // The yes or no of the source: a "not" only where it has one, and none dropped from a fact that has one.
  const sourceNegated = NEGATOR.test(plainApostrophes(source).replace(NOT_A_PROMISE, " "));
  // "Ranges, not promises" disclaims; it denies nothing.
  const claimed = text.replace(NOT_A_PROMISE, " ");
  if (NEGATOR.test(claimed) && !sourceNegated) return "it says \"not\" where its paragraph and facts do not";
  // A finding's own "not" ("Visitors cannot book online"); an estimate's assumptions disclaim ("not a promise"), they deny nothing.
  const negatedFact = cites.some((c) => {
    const f = doc.findings.find((x) => x.id === c);
    return !!f && NEGATOR.test(plainApostrophes(f.statement).replace(NOT_A_PROMISE, " "));
  });
  if (negatedFact && !NEGATOR.test(claimed)) return "it drops a \"not\" its facts have";
  // A bound, or a result, only where the source has it.
  const sourceComparisons = lowerSet(source, COMPARISON);
  const newComparison = [...lowerSet(text, COMPARISON)].find((c) => !sourceComparisons.has(c));
  if (newComparison) return `it adds a comparison ("${newComparison}") its paragraph and facts do not make`;
  const sourceResults = new Set([...lowerSet(source, RESULT_VERB)].flatMap((x) => stemsOf(x)));
  const newResult = [...lowerSet(text, RESULT_VERB)].find((r) => !stemsOf(r).some((x) => sourceResults.has(x)));
  if (newResult) return `it claims a result ("${newResult}") its paragraph and facts do not`;
  if (cites.some((c) => hypotheses.has(c)) && !HEDGE.test(text)) return "it states a likely problem as a fact: a hypothesis needs \"may\" or \"likely\"";
  // Every word from the source: a tool, a company or a claim that is in neither is held.
  const stems = stemSet(source);
  const loose = contentWords(rest, names).find((x) => !supported(x, stems) && !supported(x, FRAMING_STEMS));
  if (loose) return `it uses a word its paragraph and facts do not ("${loose}")`;
  // The audit's own names (the business, the client's systems) are no new claim.
  if (inventsFacts(withoutNames(rest, names), source)) return "it claims something its paragraph and facts do not state";
  return null;
}

type ModelSentence = { text: string; cites: string[] };

/** The model's paragraphs for one part, each as its sentences (a paragraph given as plain text is split, sharing its cites). */
function modelParagraphs(v: unknown): ModelSentence[][] {
  const list = Array.isArray(v) ? v : v && typeof v === "object" ? [v] : [];
  const cleanText = (t: unknown) => (typeof t === "string" ? scrubCredentials(t.replace(/\s+/g, " ").trim()).text.slice(0, PARAGRAPH_MAX_CHARS) : "");
  const cleanCites = (c: unknown) => (Array.isArray(c) ? c.filter((x): x is string => typeof x === "string").slice(0, 12) : []);
  return list.slice(0, 6).map((raw) => {
    const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (Array.isArray(p.sentences)) {
      return p.sentences
        .slice(0, SENTENCES_MAX)
        .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
        .map((x) => ({ text: cleanText(x.text), cites: cleanCites(x.cites) }))
        .filter((x) => x.text);
    }
    const cites = cleanCites(p.cites);
    return sentencesOf(cleanText(p.text)).slice(0, SENTENCES_MAX).map((text) => ({ text, cites }));
  });
}

/**
 * The model's answer, checked paragraph by paragraph against the code draft.
 * A rewrite replaces its code paragraph only when every sentence in it stands
 * and every figure of the code paragraph is still in it.
 */
export function checkProse(text: string, doc: AuditDoc): { ok: true; value: CheckedProse } | { ok: false; error: "unreadable" } {
  if (text.length > PROSE_ANSWER_MAX_CHARS) return { ok: false, error: "unreadable" };
  const raw = safeJsonExtract(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "unreadable" };
  const r = raw as Record<string, unknown>;
  const names = namesOf(doc);
  const hypotheses = new Set(doc.findings.filter((f) => f.label === "hypothesis").map((f) => f.id));
  const out: CheckedProse = { parts: {}, withheld: [] };
  for (const part of PROSE_PARTS) {
    const code = codeParagraphs(doc, part);
    const rewrites = modelParagraphs(r[part]);
    const slots: Array<DocParagraph | null> = code.map(() => null);
    code.forEach((original, i) => {
      const sentences = rewrites[i] ?? [];
      if (!sentences.length) return;
      const allowed = new Set(original.cites);
      const held = (sentence: string, reason: string) => out.withheld.push({ part, sentence: sentence.slice(0, 300), reason });
      let ok = true;
      for (const s0 of sentences) {
        // A sentence cites only what its paragraph cites.
        const cites = [...new Set(s0.cites.filter((c) => allowed.has(c)))];
        const source = [original.text, ...cites.map((c) => factText(doc, c))].join("\n");
        const why = sentenceWhy(s0.text, cites, source, doc, names, hypotheses);
        if (why) {
          held(s0.text, why);
          ok = false;
        }
        s0.cites = cites;
      }
      if (!ok) return;
      // Nothing dropped: every figure the code paragraph states is still in the rewrite.
      const before = numbersIn(withoutNames(original.text, names));
      const after = numbersIn(withoutNames(sentences.map((x) => x.text).join(" "), names));
      const lost = before.find((n) => !after.some((m) => close(m, n)));
      if (lost !== undefined) {
        held(sentences.map((x) => x.text).join(" "), `it leaves out ${shown(lost)}, which its paragraph states`);
        return;
      }
      slots[i] = { text: sentences.map((x) => x.text).join(" "), cites: [...new Set(sentences.flatMap((x) => x.cites))] };
    });
    if (slots.some((x) => x)) out.parts[part] = slots;
  }
  return { ok: true, value: out };
}

/** The draft with each standing rewrite in its code paragraph's place; every other paragraph is the code's. */
export function applyProse(doc: AuditDoc, prose: CheckedProse): AuditDoc {
  const s = doc.sections;
  const swap = (part: ProsePart, paragraphs: readonly DocParagraph[]) => paragraphs.map((p, i) => prose.parts[part]?.[i] ?? p);
  return {
    ...doc,
    sections: {
      ...s,
      executive_overview: { paragraphs: swap("executive_overview", s.executive_overview.paragraphs) },
      current_assessment: { ...s.current_assessment, paragraphs: swap("current_assessment", s.current_assessment.paragraphs) },
      key_findings: s.key_findings.intro ? { ...s.key_findings, intro: swap("key_findings_intro", [s.key_findings.intro])[0] } : s.key_findings,
      impact: s.impact.intro ? { ...s.impact, intro: swap("impact_intro", [s.impact.intro])[0] } : s.impact,
    },
  };
}
