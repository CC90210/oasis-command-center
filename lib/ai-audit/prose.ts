/**
 * lib/ai-audit/prose.ts — the audit's opening prose, written by a model and
 * checked sentence by sentence before any of it replaces the code draft
 * (lib/ai-audit/draft.ts), phase 4b.
 *
 * The model writes four parts: the Executive Overview, the Current Business
 * Assessment, and the one-paragraph introductions to Key Findings and to
 * Estimated Business Impact. It is given the draft's own findings,
 * estimates, opportunities and gaps, fenced as data, and nothing else: no
 * transcript, no notes, no prices. Everything else in the audit stays code.
 *
 * A sentence it writes is kept only when every word of it comes from the
 * audit itself (review of phase 4: an allowlist, not a list of banned words):
 *   - every figure is a figure of a finding or estimate it cites (an id the
 *     draft holds): the same value, the same kind (money, a share, a count of
 *     the same thing) and the same period ("10 calls a week" is not "10 calls
 *     a month", nor "10 calls"); a figure in words or another script is
 *     withheld unless the draft says it the same way;
 *   - every other word is one the draft's own text uses (a tool, a company, a
 *     claim the facts never make is withheld), and every time frame,
 *     superlative or result is one the draft states
 *     (lib/offer-pages/write-page-vet.ts inventsFacts);
 *   - a sentence that cites nothing says nothing about the business: only the
 *     audit's own framing words ("each finding is labelled");
 *   - a sentence that cites a hypothesis says "may", "likely" or "could";
 *   - it promises nothing ("will", "guarantee"), names no price or cost, and
 *     states no general rule ("most owners", "often").
 * A withheld sentence is listed for CC with the reason; a part left with no
 * sentence keeps the code draft's wording.
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

export const PROSE_SCHEMA = "ai_audit_prose/v1" as const;
export const PROSE_MAX_TOKENS = 3_000;
const PARAGRAPHS_MAX = 3;
const PARAGRAPH_MAX_CHARS = 900;
/** Twelve short paragraphs fit in far less: a longer answer is not read at all. */
const PROSE_ANSWER_MAX_CHARS = 40_000;

export type ProsePart = "executive_overview" | "current_assessment" | "key_findings_intro" | "impact_intro";
export const PROSE_PARTS: readonly ProsePart[] = ["executive_overview", "current_assessment", "key_findings_intro", "impact_intro"];
export type CheckedProse = { parts: Partial<Record<ProsePart, DocParagraph[]>>; withheld: Array<{ part: ProsePart; sentence: string; reason: string }> };

const SYSTEM = [
  "You write the opening of a free AI audit for the owner of a small business: the Executive Overview, the Current Business Assessment, and one short introduction each for Key Findings and for Estimated Business Impact.",
  "Write plainly and specifically, as a trusted advisor speaking to the owner, in Canadian English. Short sentences. No jargon, no hype.",
  "Rules:",
  "1. Use only the facts given. Every sentence that states a figure, an amount, a share, a result or a time must cite the ids of the facts it comes from, and use each figure exactly as that fact states it.",
  "2. Never state a figure, a price, a statistic or a result that no cited fact states. Never round, add up or work out a new figure.",
  "3. Never promise a result, and never write \"will\": describe what a change does in the present tense, and an estimate with \"could\". An estimate is a range that depends on the figures behind it: say so.",
  "4. Never name a tool, a platform or a company the facts do not name.",
  "5. A hypothesis is a likely problem to confirm with the owner, never a fact: write it with \"may\" or \"likely\".",
  "6. Do not mention prices, costs, the proposal or payment, and no general rules about other businesses (\"most owners\", \"often\").",
  "7. Every sentence about this business cites the facts it rests on. Give every figure the unit and period its fact gives it (\"10 calls a week\"). Use the facts' own words where you can.",
  `8. At most ${PARAGRAPHS_MAX} paragraphs per section, each at most 90 words. The introductions are one paragraph each.`,
  "9. Answer with JSON only, in exactly this shape:",
  '{"executive_overview":[{"text":"...","cites":["<id>"]}],"current_assessment":[{"text":"...","cites":["<id>"]}],"key_findings_intro":{"text":"...","cites":[]},"impact_intro":{"text":"...","cites":["<id>"]}}',
  "",
  INJECTION_GUARD,
].join("\n");

/** The facts the model may write from: the draft's own, as data. */
function factsOf(doc: AuditDoc) {
  return {
    findings: doc.findings.map((f) => ({ id: f.id, label: f.label, title: f.title, statement: f.statement, ...(f.metric ? { figure: f.metric } : {}) })),
    estimates: doc.estimates.map((e) => ({ id: e.id, title: e.title, range: rangeWords(e), assumptions: e.assumptions.slice(0, 2) })),
    opportunities: doc.sections.opportunities.items.map((o) => ({ title: o.title, what_it_does: o.what_it_does, problem: o.problem })),
    gaps: doc.gaps.map((g) => g.topic),
  };
}

/** The prompt for the audit's opening prose. */
export function prosePrompt(doc: AuditDoc): { system: string; prompt: string } {
  const name = scrubCredentials(doc.business.name.replace(/[\r\n]+/g, " ").slice(0, 200)).text;
  const prompt = [
    wrapUntrusted(name, { label: "business name", maxLen: 300 }),
    "Write the four parts from these facts. Cite facts by their id.",
    "",
    wrapUntrusted(JSON.stringify(factsOf(doc)), { label: "audit facts", maxLen: 40_000 }),
  ].join("\n");
  return { system: SYSTEM, prompt };
}

/** Everything the draft states, for claims that need no citation of their own (a result word, a name). */
function draftText(doc: AuditDoc): string {
  const f = factsOf(doc);
  return [
    doc.business.name,
    doc.business.location ?? "",
    doc.business.website ?? "",
    doc.prepared_for.name,
    ...doc.sections.current_assessment.systems.map((x) => `${x.name}. ${x.role}`),
    ...f.findings.map((x) => `${x.title}. ${x.statement}`),
    ...f.estimates.map((x) => `${x.title}. ${x.range}. ${x.assumptions.join(" ")}`),
    ...f.opportunities.map((x) => `${x.title}. ${x.what_it_does} ${x.problem}`),
    ...doc.sections.opportunities.items.map((o) => `${o.how_it_works} ${o.expected_improvement.text} ${(o.workflow?.after ?? []).join(". ")}`),
    ...f.gaps,
  ].join("\n");
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
/** "one" that counts nothing: "each one", "no one", "one of them". */
const NOT_A_COUNT = /\b(?:each|every|no|any|some|the|this|that|which)\s+one\b|\bone\s+(?:of|another|by one)\b|\bsomeone\b|\banyone\b/gi;
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
const PRICE = /\b(?:free|cost|costs|costing|costly|afford\w*|cheap\w*|expensive|quote[sd]?|quotes|price[sd]?|prices|pricing|fees?|payments?|pay|paid|paying|invest\w*|budget\w*|charge[sd]?|charges|discount\w*|proposal|refund\w*)\b/i;
/** A general rule about other businesses, which no fact in this audit states. */
const GENERAL =
  /\b(?:most|many|few|often|usually|rarely|seldom|always|never|typically|generally|commonly|frequently|normally|everyone|everybody|nobody|no\s+one|the\s+majority|on\s+average|the\s+average|statistic\w*|studies|study|surveys?|experts?|benchmarks?|industry)\b|\blike\s+yours\b|\bresearch\s+(?:shows|says|finds|suggests)\b/i;
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
    "one ones today right well much many most"
  ).split(" "),
);
/** The audit's own framing: words a sentence may use without citing anything. */
const FRAMING = new Set(
  (
    "audit audits finding findings estimate estimates estimated figure figures range ranges source sources label labels labelled labeled section sections " +
    "page pages overview summary assessment opportunity opportunities recommendation recommendations roadmap plan plans step steps priority priorities order " +
    "start starts first next quick win wins detail details explain explains following list listed confirm confirmed check checked measure measured verify verified " +
    "fact facts information conversation call discovery told said shared business team owner work change changes improvement improvements question questions " +
    "based built read review reviewed current currently impact business's sized size depends depend rest rests assumption assumptions"
  ).split(" "),
);

/** The word's plain forms: "missed" is "miss", "replies" is "reply", "booking" is "book". */
function stemsOf(word: string): string[] {
  const w = word.toLowerCase();
  const out = new Set([w]);
  const strip = (suffix: string, add = "") => {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) out.add(w.slice(0, -suffix.length) + add);
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

/** What the checker reads the draft as: its text, its words, and which of its findings are hypotheses. */
export type DraftWords = { all: string; stems: ReadonlySet<string>; names: string[]; hypotheses: ReadonlySet<string> };
function draftWords(doc: AuditDoc): DraftWords {
  const all = draftText(doc);
  return { all, stems: stemSet(all), names: namesOf(doc), hypotheses: new Set(doc.findings.filter((f) => f.label === "hypothesis").map((f) => f.id)) };
}

/** Why one sentence is withheld, or null when every word of it comes from the audit. */
function sentenceWhy(sentence: string, cites: readonly string[], doc: AuditDoc, w: DraftWords): string | null {
  const text = sentence.normalize("NFKC");
  if (PROMISE.test(text.replace(NOT_A_PROMISE, " "))) return "it promises a result";
  if (PRICE.test(text.replace(AUDIT_NAME, " "))) return "it speaks of prices, costs or payment, which only the proposal states";
  const general = GENERAL.exec(text.replace(OWN_RANKING, " "));
  // A rule the draft itself states, in the same words, may be repeated ("often books").
  if (general && !w.all.toLowerCase().includes(text.slice(general.index, general.index + general[0].length + 12).toLowerCase().replace(/[^a-z ]+.*$/, "").trim())) {
    return "it states a general rule the audit's facts do not";
  }
  const figures = figuresOf(withoutNames(text, w.names));
  // The rest of the sentence: each checked figure, and the period it is a rate of, cut out.
  const cuts = figures.flatMap((f) => [[f.start, f.end] as [number, number], ...(f.periodAt ? [f.periodAt] : [])]).sort((a, b) => a[0] - b[0]);
  let rest = "";
  let at = 0;
  for (const [from, to] of cuts) {
    if (from < at) continue;
    rest += `${text.slice(at, from)} `;
    at = to;
  }
  rest += text.slice(at);
  const unnamed = withoutNames(rest, w.names).replace(GLUED, " ");
  // A number word the draft says the same way ("in one tap") is the draft's, not a new figure.
  const lowerAll = w.all.toLowerCase();
  const wordFigures = unnamed.replace(NOT_A_COUNT, " ").replace(A_TIME, " ").replace(NUMBER_WORD, (m: string, i: number, whole: string) => {
    const phrase = whole.slice(i, i + m.length + 12).toLowerCase().match(/^[a-z]+\s+[a-z]+/)?.[0] ?? m.toLowerCase();
    return lowerAll.includes(phrase) ? " " : m;
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
      // The same period as the fact, or none on both sides: "10 calls" for "10 calls a week" is not the fact.
      const timed = kinds.filter((m) => m.period === f.period);
      if (!timed.length) {
        const theirs = kinds.find((m) => m.period)?.period;
        return `it states ${shown(f.value)}${f.period ? ` a ${f.period}` : " with no period"}; what it cites gives ${theirs ? `${shown(f.value)} a ${theirs}` : "no period"}`;
      }
      // A count is of the thing the fact counts: "500 calls" is not "a $500 job", "10 hours" is not "10 calls".
      if (f.kind === "count" && !f.inRange) {
        const after = text.slice(f.periodAt && f.periodAt[0] === f.end ? f.periodAt[1] : f.end).match(/^[\s-]*(?:out\s+of\b|([a-z']+))/i);
        const noun = after?.[1]?.toLowerCase();
        if (noun && !STOP.has(noun) && !timed.some((m) => supported(noun, stemSet(m.text)))) return `it counts ${shown(f.value)} ${noun}, but what it cites counts something else`;
      }
    }
  }
  if (cites.some((c) => w.hypotheses.has(c)) && !HEDGE.test(text)) return "it states a likely problem as a fact: a hypothesis needs \"may\" or \"likely\"";
  // Every word must be the audit's own: an uncited sentence only frames ("each finding is labelled"); a cited one
  // uses the words the draft uses (a tool, a company or a claim the facts never make is withheld).
  // "Ranges, not promises" disclaims; it claims nothing.
  const words = wordsIn(withoutNames(rest, w.names).replace(NOT_A_PROMISE, " ")).filter((x) => !STOP.has(x) && !/^\d/.test(x));
  if (!cites.length) {
    const loose = words.find((x) => !supported(x, FRAMING_STEMS));
    if (loose) return `it says something about the business ("${loose}") without citing where it comes from`;
  } else {
    const loose = words.find((x) => !supported(x, w.stems) && !supported(x, FRAMING_STEMS));
    if (loose) return `it uses a word the audit's facts do not ("${loose}")`;
  }
  // Every time frame, superlative or result must be one the draft states; figures were checked above.
  if (inventsFacts(rest, w.all)) return "it claims something the audit's facts do not state";
  return null;
}
const FRAMING_STEMS: ReadonlySet<string> = new Set([...FRAMING].flatMap((x) => stemsOf(x)));

function paragraphsOf(v: unknown): Array<{ text: string; cites: string[] }> {
  const list = Array.isArray(v) ? v : v && typeof v === "object" ? [v] : [];
  return list
    .slice(0, PARAGRAPHS_MAX)
    .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>) : {}))
    .map((p) => ({
      text: typeof p.text === "string" ? scrubCredentials(p.text.replace(/\s+/g, " ").trim()).text.slice(0, PARAGRAPH_MAX_CHARS) : "",
      cites: Array.isArray(p.cites) ? p.cites.filter((c): c is string => typeof c === "string").slice(0, 12) : [],
    }))
    .filter((p) => p.text);
}

/**
 * The model's answer, checked sentence by sentence against the draft. Cites
 * are kept only where the draft holds the id; a sentence that fails is
 * withheld with its reason.
 */
export function checkProse(text: string, doc: AuditDoc): { ok: true; value: CheckedProse } | { ok: false; error: "unreadable" } {
  if (text.length > PROSE_ANSWER_MAX_CHARS) return { ok: false, error: "unreadable" };
  const raw = safeJsonExtract(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "unreadable" };
  const r = raw as Record<string, unknown>;
  const ids = new Set([...doc.findings.map((f) => f.id), ...doc.estimates.map((e) => e.id), ...doc.sources.map((s) => s.id)]);
  const words = draftWords(doc);
  const out: CheckedProse = { parts: {}, withheld: [] };
  for (const part of PROSE_PARTS) {
    const kept: DocParagraph[] = [];
    for (const p of paragraphsOf(r[part])) {
      const cites = [...new Set(p.cites.filter((c) => ids.has(c)))];
      const sentences = sentencesOf(p.text).filter((sentence) => {
        const why = sentenceWhy(sentence, cites, doc, words);
        if (why) out.withheld.push({ part, sentence: sentence.slice(0, 300), reason: why });
        return !why;
      });
      if (sentences.length) kept.push({ text: sentences.join(" "), cites });
    }
    if (kept.length) out.parts[part] = part === "key_findings_intro" || part === "impact_intro" ? kept.slice(0, 1) : kept;
  }
  return { ok: true, value: out };
}

/** The draft with the checked prose in place; a part with no kept sentence keeps the code draft's wording. */
export function applyProse(doc: AuditDoc, prose: CheckedProse): AuditDoc {
  const s = doc.sections;
  const p = prose.parts;
  return {
    ...doc,
    sections: {
      ...s,
      executive_overview: p.executive_overview?.length ? { paragraphs: p.executive_overview } : s.executive_overview,
      current_assessment: p.current_assessment?.length ? { ...s.current_assessment, paragraphs: p.current_assessment } : s.current_assessment,
      key_findings: p.key_findings_intro?.[0] ? { ...s.key_findings, intro: p.key_findings_intro[0] } : s.key_findings,
      impact: p.impact_intro?.[0] ? { ...s.impact, intro: p.impact_intro[0] } : s.impact,
    },
  };
}
