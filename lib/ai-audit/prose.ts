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
 * A sentence it writes is kept only when:
 *   - every figure in it is a figure of a finding or estimate it cites (an
 *     id the draft holds), exactly, and per the same period ("10 calls a
 *     week" is not "10 calls a month"); a figure in words, or in a script
 *     the check cannot read, is withheld;
 *   - every other claim in it (a result, a time frame, a superlative, a
 *     name, who else uses something) is stated somewhere in the draft's own
 *     facts (lib/offer-pages/write-page-vet.ts inventsFacts), and it states
 *     no general rule ("most owners", "studies show") the facts do not;
 *   - it promises nothing and quotes no price.
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

export type ProsePart = "executive_overview" | "current_assessment" | "key_findings_intro" | "impact_intro";
export const PROSE_PARTS: readonly ProsePart[] = ["executive_overview", "current_assessment", "key_findings_intro", "impact_intro"];
export type CheckedProse = { parts: Partial<Record<ProsePart, DocParagraph[]>>; withheld: Array<{ part: ProsePart; sentence: string; reason: string }> };

const SYSTEM = [
  "You write the opening of a free AI audit for the owner of a small business: the Executive Overview, the Current Business Assessment, and one short introduction each for Key Findings and for Estimated Business Impact.",
  "Write plainly and specifically, as a trusted advisor speaking to the owner, in Canadian English. Short sentences. No jargon, no hype.",
  "Rules:",
  "1. Use only the facts given. Every sentence that states a figure, an amount, a share, a result or a time must cite the ids of the facts it comes from, and use each figure exactly as that fact states it.",
  "2. Never state a figure, a price, a statistic or a result that no cited fact states. Never round, add up or work out a new figure.",
  "3. Never promise a result. An estimate is a range that depends on the figures behind it: say so.",
  "4. Never name a tool, a platform or a company the facts do not name.",
  "5. A hypothesis is a likely problem to confirm with the owner, never a fact: write it with \"may\" or \"likely\".",
  "6. Do not mention prices, the proposal or payment.",
  `7. At most ${PARAGRAPHS_MAX} paragraphs per section, each at most 90 words. The introductions are one paragraph each.`,
  "8. Answer with JSON only, in exactly this shape:",
  '{"executive_overview":[{"text":"...","cites":["<id>"]}],"current_assessment":[{"text":"...","cites":["<id>"]}],"key_findings_intro":{"text":"...","cites":[]},"impact_intro":{"text":"...","cites":["<id>"]}}',
  "",
  INJECTION_GUARD,
].join("\n");

/** The facts the model may write from: the draft's own, as data. */
function factsOf(doc: AuditDoc) {
  return {
    findings: doc.findings.map((f) => ({ id: f.id, label: f.label, title: f.title, statement: f.statement })),
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

type Period = "hour" | "day" | "week" | "month" | "year";
type Figure = { value: number; start: number; end: number; period: Period | null; periodAt: [number, number] | null };

// Maps, never object lookups (review of phase 2b).
const PERIODS = new Map<string, Period>([
  ["hour", "hour"], ["hr", "hour"], ["hourly", "hour"],
  ["day", "day"], ["daily", "day"],
  ["week", "week"], ["wk", "week"], ["weekly", "week"],
  ["month", "month"], ["mo", "month"], ["monthly", "month"],
  ["year", "year"], ["yr", "year"], ["yearly", "year"], ["annually", "year"], ["annual", "year"],
]);
/** A rate's period: "a week", "per month", "each year", "/week", "monthly". */
const RATE = /\b(?:a|an|per|each|every)\s+(hour|day|week|month|year)\b|\/\s?(hour|hr|day|week|wk|month|mo|year|yr)\b|\b(hourly|daily|weekly|monthly|yearly|annually|annual)\b/i;
/** A figure written in digits: "$1,300", "2.5", "40k", "30%", "$2.5m". */
const FIGURE = /(\$\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(k|thousand|grand|million|mil|m|hundred)\b)?(?:\s?%|\s+percent\b)?/gi;
/** What may stand between a range's two figures: "to", "-", "or", "and", after a unit ("1.5 hours to 3 hours"). */
const RANGE_GAP = /^\s*(?:[a-z%$]+\s+)?(?:to|-|\u2013|\u2014|or|and)\s*\$?\s*$/i;
/** Where a figure's own clause ends. */
const CLAUSE_END = /[,;:.!?]|\b(?:and|but|which|while|so|because|whereas)\b/i;
/** "one" that counts nothing: "each one", "no one", "one of them". */
const NOT_A_COUNT = /\b(?:each|every|no|any|some|the|this|that|which)\s+one\b|\bone\s+(?:of|another|by one)\b|\bsomeone\b|\banyone\b/gi;
/** A share said in words: "half of", "two thirds of", "one in four". */
const SHARE_WORDS = /\b(?:half|(?:a|one|two|three|four)\s+(?:quarters?|thirds?|fifths?|tenths?))\s+(?:of|the)\b|\bone\s+in\s+(?:two|three|four|five|six|seven|eight|nine|ten)\b/i;
/** A general rule about other businesses, which no fact in this audit states. */
const GENERAL = /(?<!how )\b(?:most|many)\s+(?:of\b|[a-z]+s\b)|\b(?:nearly all|almost all|the majority|on average|the average|typically|statistic(?:s|ally)?|studies|surveys?|experts?|benchmarks?|research (?:shows|says|finds|suggests))\b/i;

function periodIn(segment: string): { period: Period; at: [number, number] } | null {
  const m = RATE.exec(segment);
  if (!m || m.index === undefined) return null;
  const period = PERIODS.get((m[1] ?? m[2] ?? m[3] ?? "").toLowerCase());
  return period ? { period, at: [m.index, m.index + m[0].length] } : null;
}

/**
 * Every figure written in digits, with the period it is a rate of. A range's
 * figures ("$1,300 to $3,250 per month") share one period. It is read
 * forward within the figure's own clause ("10 calls a week"), else back to
 * that clause's start ("each month you miss 10"), never past a period
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
    if (Number.isFinite(value)) found.push({ value, start, end: start + m[0].length, period: null, periodAt: null });
  }
  // Ranges: figures joined by "to", "-", "or" or "and" (after a unit word) read as one.
  const groups: Figure[][] = [];
  for (const f of found) {
    const last = groups[groups.length - 1];
    if (last && RANGE_GAP.test(text.slice(last[last.length - 1].end, f.start))) last.push(f);
    else groups.push([f]);
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

/** The figures the cited ids state, each with its period: a finding's statement and figure, an estimate's range. */
function citedFigures(doc: AuditDoc, ids: readonly string[]): Array<{ value: number; period: Period | null }> {
  const out: Array<{ value: number; period: Period | null }> = [];
  for (const id of ids) {
    const f = doc.findings.find((x) => x.id === id);
    if (f) {
      out.push(...figuresOf(f.statement.normalize("NFKC")).map((x) => ({ value: x.value, period: x.period })));
      if (f.metric) out.push({ value: f.metric.value, period: periodIn(f.metric.unit ?? "")?.period ?? null });
    }
    const e = doc.estimates.find((x) => x.id === id);
    if (e) {
      out.push(...figuresOf(rangeWords(e)).map((x) => ({ value: x.value, period: x.period })));
      const period = periodIn(e.period ?? "")?.period ?? null;
      out.push({ value: e.low, period }, { value: e.high, period });
    }
  }
  return out;
}

const PROMISE = /\b(?:guarantee[sd]?|promise[sd]?|will (?:double|triple|increase|grow|boost|save|bring|deliver|generate|recover|win|cut|reduce|eliminate|transform|pay)|pays? (?:for )?itself|pay off|ensures?|definitely|certainly|for sure|no doubt|in no time|overnight)\b/i;
const PRICE = /\b(?:price[sd]?|pricing|invest(?:ment)?|fee[s]?|proposal|payment|pay us)\b/i;

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-6);
const shown = (n: number) => n.toLocaleString("en-CA", { maximumFractionDigits: 2 });

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

/** Why one sentence is withheld, or null when it stands on its citations and the draft's facts. */
function sentenceWhy(sentence: string, cites: readonly string[], doc: AuditDoc, all: string): string | null {
  const text = sentence.normalize("NFKC");
  if (PROMISE.test(text)) return "it promises a result";
  if (PRICE.test(text)) return "it speaks of prices or payment, which only the proposal states";
  const figures = figuresOf(withoutNames(text, namesOf(doc)));
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
  const unnamed = withoutNames(rest, namesOf(doc)).replace(GLUED, " ");
  if (statesFigure(unnamed) || numbersIn(unnamed.replace(NOT_A_COUNT, " ")).length || SHARE_WORDS.test(unnamed)) return "it writes a figure in a form the check cannot match to a source: use the figure as the facts state it";
  if (figures.length) {
    if (!cites.length) return "it states a figure without citing where it comes from";
    const allowed = citedFigures(doc, cites);
    for (const f of figures) {
      const same = allowed.filter((m) => close(m.value, f.value));
      if (!same.length) return `it states ${shown(f.value)}, which nothing it cites states`;
      if (f.period && !same.some((m) => m.period === f.period)) {
        const theirs = same.find((m) => m.period)?.period;
        return `it states ${shown(f.value)} a ${f.period}; what it cites gives ${theirs ? `${shown(f.value)} a ${theirs}` : "no period"}`;
      }
    }
  }
  const general = GENERAL.exec(rest);
  if (general && !new RegExp(`\\b${general[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(all)) return "it states a general rule the audit's facts do not";
  // Every other claim (a result, a time, a superlative, a name) must be one the draft states; figures were checked above.
  if (inventsFacts(rest, all)) return "it claims something the audit's facts do not state";
  return null;
}

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
  const raw = safeJsonExtract(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "unreadable" };
  const r = raw as Record<string, unknown>;
  const ids = new Set([...doc.findings.map((f) => f.id), ...doc.estimates.map((e) => e.id), ...doc.sources.map((s) => s.id)]);
  const all = draftText(doc);
  const out: CheckedProse = { parts: {}, withheld: [] };
  for (const part of PROSE_PARTS) {
    const kept: DocParagraph[] = [];
    for (const p of paragraphsOf(r[part])) {
      const cites = [...new Set(p.cites.filter((c) => ids.has(c)))];
      const sentences = sentencesOf(p.text).filter((sentence) => {
        const why = sentenceWhy(sentence, cites, doc, all);
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
