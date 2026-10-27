/**
 * lib/ai-audit/extract.ts — turning a discovery call into draft profile facts,
 * and checking every one of them before it is kept.
 *
 * A model reads ONE window of the numbered transcript (lib/ai-audit/
 * transcript.ts transcriptWindows) and answers with facts: a profile field, a
 * value, the line numbers it came from and a short quote from those lines.
 * The model is a reader, not an authority. Code keeps a fact only when:
 *   - the field exists and is not consent (consent is CC's to record, never
 *     inferred);
 *   - the value has the field's type (lib/ai-audit/profile.ts);
 *   - its lines are inside the window it read, and the quote is really on
 *     them (quoteInLines), and long enough to show who said what;
 *   - the client said it: a quote only the interviewer said, or only asked as
 *     a question, is not the client's fact;
 *   - a figure is read figure by figure: it must sit inside the quote, on a
 *     line the client said, bound to the field's own period word ("10 a week,
 *     so about 40 a month" is 40 a month, never 10), and be one figure the
 *     client was sure of: a range, a limit ("at least 40"), a goal, an "if",
 *     a past figure, a question, someone else's figure, a "maybe" or one of
 *     several goes to the open questions;
 *   - a text, a list or a table says what the quote's own lines say (its
 *     words are there, whole), item by item; a tool is named as a name, and
 *     an item the client said they do not use or do is dropped;
 *   - neither the quote nor the value carries anything credential-like.
 * Everything else is dropped and listed for CC with the reason. Across windows,
 * two different values for one field are a contradiction: neither is written,
 * and CC decides. Every kept fact is Client-reported, from the transcript:
 * verification needs evidence a transcript cannot give.
 *
 * The transcript is wrapped as untrusted data (lib/llm-input-boundary.ts), so
 * "ignore previous instructions" in a call is a line of the call, nothing more.
 *
 * PURE: no I/O.
 */
import { INJECTION_GUARD, safeJsonExtract, wrapUntrusted } from "@/lib/llm-input-boundary";
import { PROFILE_FIELDS, profileFieldDef, validateProfileField, type ProfileFieldDef, type ProfileValue } from "@/lib/ai-audit/profile";
import { quoteInLines, quoteWords, scrubCredentials, type TranscriptLine } from "@/lib/ai-audit/transcript";

export const EXTRACT_SCHEMA = "ai_audit_extract/v1" as const;
/** Fields extraction may fill: every profile field except consent. */
export const EXTRACTABLE_FIELDS: readonly ProfileFieldDef[] = PROFILE_FIELDS.filter((f) => f.group !== "consent");
export const QUOTE_MAX_CHARS = 300;
export const SUMMARY_ITEMS_MAX = 8;
export const MODEL_MAX_TOKENS = 4_000;

export type ExtractedFact = { key: string; value: unknown; from: number; to: number; quote: string };
export type ExtractionSummary = { goals: string[]; problems: string[]; commitments: string[]; open_questions: string[] };
export type ExtractionAnswer = { facts: ExtractedFact[]; summary: ExtractionSummary };

/** `speakers`: who said the quoted lines; `transcript_id`: set by the caller that knows the window. */
export type KeptFact = {
  key: string;
  value: ProfileValue;
  from: number;
  to: number;
  quote: string;
  speakers?: string[];
  transcript_id?: string;
  /** Every transcript and line range a merged list or table drew on, so a delete finds them all (Codex review of phase 2b). */
  sources?: Array<{ transcript_id: string | null; from: number; to: number }>;
};
export type DroppedFact = { key: string; reason: string };
export type Contradiction = {
  key: string;
  values: Array<{ value: unknown; from: number; to: number; source: "transcript" | "profile"; quote?: string | null; transcript_id?: string | null }>;
};
/** What the draft profile already holds for a field, as mergeFacts weighs it. */
export type PriorField = { value: unknown; source_type: string; label?: string; verified_note?: string | null; owner_corrected?: boolean };

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

function fieldLine(f: ProfileFieldDef): string {
  const shape =
    f.type === "rows"
      ? `rows of {${(f.columns ?? []).join(", ")}}`
      : f.type === "list"
        ? "a list of short strings"
        : f.type === "money"
          ? "an amount in dollars, as a number"
          : f.type === "number"
            ? `a number${f.unit ? ` (${f.unit})` : ""}`
            : f.type === "boolean"
              ? "true or false"
              : "a short text";
  return `- ${f.key}: ${f.label}. Value: ${shape}.`;
}

const SYSTEM = [
  "You read one part of a business discovery call and extract facts the CLIENT stated about their business, for a free AI audit.",
  "Rules:",
  "1. Extract only what the client said. A question, a guess or a suggestion from the interviewer is not a fact.",
  "2. For every fact give the line numbers it comes from (from, to) and a quote: ONE unbroken run of the client's words, copied character for character from those lines (at most 25 words). Never skip, join or shorten sentences inside a quote. If a fact needs two sentences, quote the one that states it.",
  "3. Write a text value, and every list item, in the client's own words, as close to the quote as you can. Use only the field keys listed, exactly as written, and for rows the column names exactly as listed, spaces included.",
  "4. A number is a fact only if the client said that number. Turn number words into digits (forty is 40, half is 50 for a share). One number said with about, around or roughly is still the client's number: give it, and the quote keeps their word. If the client was unsure (maybe, I'd guess, probably), gave a range (6,000 to 9,000), or gave different numbers for the same thing or by season, do not give a value: leave the fact out and put the question in open_questions. Never change a figure's period or unit.",
  "5. Never infer, estimate, average or calculate. Never fill a field the call does not answer.",
  "6. Never copy a password, a login, a card number or any other credential, even if one appears.",
  "7. Answer with JSON only, in exactly this shape:",
  '{"facts":[{"key":"<field key>","value":<value>,"from":<first line number>,"to":<last line number>,"quote":"<exact words>"}],"summary":{"goals":["..."],"problems":["..."],"commitments":["..."],"open_questions":["..."]}}',
  "The summary lists, in a few words each, what the client wants, what problems they described, what either side agreed to do, and what is still unclear. At most 8 items each; empty lists are fine.",
  "",
  INJECTION_GUARD,
].join("\n");

/** System and user prompt for one window. `window.text` is the rendered, numbered lines. */
export function extractionPrompt(input: { businessName: string; window: { from: number; to: number; text: string } }): { system: string; prompt: string } {
  const prompt = [
    // The name comes from the lead's own form: data, inside its own fence (review of phase 2b, M7).
    // Scrubbed too: a name is the prospect's own words, and may carry a key or a link with one (Codex review of phase 2b).
    wrapUntrusted(scrubCredentials(input.businessName.replace(/[\r\n]+/g, " ").slice(0, 200)).text, { label: "business name", maxLen: 300 }),
    `This part of the call is lines ${input.window.from} to ${input.window.to}. Each line starts with its number (L12), then the time and the speaker when known.`,
    "",
    "Fields you may fill:",
    ...EXTRACTABLE_FIELDS.map(fieldLine),
    "",
    wrapUntrusted(input.window.text, { label: "call transcript", maxLen: 20_000 }),
  ].join("\n");
  return { system: SYSTEM, prompt };
}

// ---------------------------------------------------------------------------
// Reading the answer
// ---------------------------------------------------------------------------

function strings(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => scrubCredentials(x.replace(/\s+/g, " ").trim()).text.slice(0, 200))
    .filter(Boolean)
    .slice(0, max);
}

/** The model's text as facts and a summary, or why it could not be read. */
export function parseExtraction(text: string): { ok: true; value: ExtractionAnswer } | { ok: false; error: "unreadable" } {
  const raw = safeJsonExtract(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "unreadable" };
  const r = raw as Record<string, unknown>;
  const facts: ExtractedFact[] = [];
  for (const f of Array.isArray(r.facts) ? r.facts.slice(0, 200) : []) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    facts.push({
      key: typeof o.key === "string" ? o.key : "",
      value: o.value,
      from: typeof o.from === "number" ? o.from : Number.NaN,
      to: typeof o.to === "number" ? o.to : Number.NaN,
      quote: typeof o.quote === "string" ? o.quote : "",
    });
  }
  const s = r.summary && typeof r.summary === "object" ? (r.summary as Record<string, unknown>) : {};
  return {
    ok: true,
    value: {
      facts,
      summary: {
        goals: strings(s.goals, SUMMARY_ITEMS_MAX),
        problems: strings(s.problems, SUMMARY_ITEMS_MAX),
        commitments: strings(s.commitments, SUMMARY_ITEMS_MAX),
        open_questions: strings(s.open_questions, SUMMARY_ITEMS_MAX),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Reading figures: one reader, figure by figure (review of phase 2b, round 3).
// A figure stands for a field only when the client said it, inside the quote,
// bound to the field's own period word ("10 a week, so about 40 a month" is 40
// a month), and nothing beside it makes it a range, a limit, a goal, an "if",
// a question, someone else's number or one of several.
// ---------------------------------------------------------------------------

// Maps, never object lookups: "constructor" is not a number (review of phase 2b).
const ONES = new Map<string, number>([["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9]]);
const TEENS = new Map<string, number>([
  ["ten", 10], ["eleven", 11], ["twelve", 12], ["thirteen", 13], ["fourteen", 14], ["fifteen", 15], ["sixteen", 16], ["seventeen", 17], ["eighteen", 18], ["nineteen", 19],
]);
const TENS = new Map<string, number>([["twenty", 20], ["thirty", 30], ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90]]);
const SCALES = new Map<string, number>([["thousand", 1_000], ["grand", 1_000], ["million", 1_000_000]]);
/** Shares said in words ("half of them", "two thirds"): a percentage's evidence, never a count. */
const FRACTION_WORDS = new Map<string, number>([["half", 0.5], ["quarter", 0.25], ["quarters", 0.25], ["third", 1 / 3], ["thirds", 1 / 3]]);
/** "within an hour", "it takes a day": one of the unit, unless a figure was just said ("25 an hour" is a rate). */
const ONE_OF = /^(?:hours?|minutes?|days?)$/;
const UNIT_WORD = /^(?:hours?|minutes?|days?|weeks?|months?|years?)$/;
const RATE_WORDS = new Set(["bucks", "dollars", "dollar", "each", "per", "times", "calls", "leads", "jobs", "customers", "quotes"]);
/** "at that point five people left": after these words "point" is a noun, not a decimal point. */
const POINT_NOUN = new Set(["some", "that", "this", "the", "a", "any", "no", "which", "what", "each", "every", "my", "our", "your", "their", "his", "her", "its"]);

/**
 * A text as the figure reader reads it: accents off, lower case, one kind of
 * apostrophe, full-width digits plain, single spaces. Every place below is a
 * place in this text.
 */
function baseText(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ");
}

/** A figure where it sits (in baseText of the text it was read from). */
export type FigureAt = { value: number; start: number; end: number };
type WordAt = { w: string; start: number; end: number };
type WordKind = "" | "ones" | "teens" | "tens" | "hundred" | "scale";

const FIGURE_TOKENS = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|[a-z]+(?:'[a-z]+)?|\$|[.,;:!?]/g;

/**
 * Every figure a text states, with its place: digits ("1,200", "2.5", "$40k",
 * "$2.5m", "40hrs", "5 million") and number words ("forty five", "twelve
 * hundred", "a dozen", "a couple hundred", "two point five", "two and a half",
 * "within an hour", "half an hour"). Punctuation ends a run of number words,
 * and two words that cannot make one number are two figures: "six. Four" is 6
 * and 4, "forty, fifty" and "forty fifty" are 40 and 50, never 10 or 90.
 * Digits inside a word ("hunter2", "Q3"), ordinals ("3rd") and a scale word
 * alone are not figures.
 */
export function figuresIn(text: string): FigureAt[] {
  const s = baseText(text);
  const toks = [...s.matchAll(FIGURE_TOKENS)].map((m) => ({ t: m[0], at: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const tok = (i: number) => toks[i]?.t ?? "";
  const glued = (i: number) => i > 0 && !!toks[i] && toks[i].at === toks[i - 1].end;
  const out: FigureAt[] = [];
  let chunk = 0;
  let total = 0;
  let last = "" as WordKind;
  let wStart = 0;
  let wEndTok = -1;
  let lastTok = -10;
  const push = (value: number, start: number, endTok: number) => {
    out.push({ value, start, end: toks[endTok].end });
    lastTok = endTok;
  };
  const flush = () => {
    if (last) push(total + chunk, wStart, wEndTok);
    chunk = 0;
    total = 0;
    last = "";
  };
  const word = (i: number, kind: WordKind, from = toks[i].at) => {
    if (!last) wStart = from;
    last = kind;
    wEndTok = i;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].t;
    if (/^[.,;:!?$]$/.test(t)) {
      flush();
      continue;
    }
    if (/^\d/.test(t)) {
      flush();
      const at = toks[i].at;
      if (at > 0 && /[a-z]/.test(s[at - 1])) continue;
      if (glued(i + 1) && /^(?:st|nd|rd|th|s)$/.test(tok(i + 1))) {
        i += 1;
        continue;
      }
      let n = Number(t.replace(/,/g, ""));
      if (!Number.isFinite(n)) continue;
      const money = tok(i - 1) === "$";
      let e = i;
      const next = tok(i + 1);
      if (next === "k" || next === "thousand" || next === "grand") {
        n *= 1_000;
        e = i + 1;
      } else if (next === "million" || next === "mil" || next === "mm" || (next === "m" && money && glued(i + 1))) {
        n *= 1_000_000;
        e = i + 1;
      } else if (next === "hundred") {
        n *= 100;
        e = i + 1;
      }
      if (tok(e + 1) === "and" && tok(e + 2) === "a" && tok(e + 3) === "half") {
        n += 0.5;
        e += 3;
      }
      push(n, money ? toks[i - 1].at : at, e);
      i = e;
      continue;
    }
    // "two and a half", "an hour and a half", "a day and a half".
    if (t === "and" && tok(i + 1) === "a" && tok(i + 2) === "half") {
      if (last) {
        chunk += 0.5;
        wEndTok = i + 2;
        flush();
        i += 2;
        continue;
      }
      if (out.length && lastTok === i - 2 && UNIT_WORD.test(tok(i - 1))) {
        out[out.length - 1].value += 0.5;
        i += 2;
        continue;
      }
    }
    if (t === "half" && (tok(i + 1) === "a" || tok(i + 1) === "an")) {
      if (tok(i + 2) === "dozen") {
        flush();
        push(6, toks[i].at, i + 2);
        i += 2;
        continue;
      }
      // "half an hour": the unit stays after the figure, as it does after "an hour".
      if (ONE_OF.test(tok(i + 2))) {
        flush();
        push(0.5, toks[i].at, i + 1);
        i += 1;
        continue;
      }
    }
    if ((t === "a" || t === "an") && ONE_OF.test(tok(i + 1)) && !last && lastTok < i - 3 && !RATE_WORDS.has(tok(i - 1))) {
      push(1, toks[i].at, i);
      continue;
    }
    if (t === "couple") {
      flush();
      const from = tok(i - 1) === "a" ? toks[i - 1].at : toks[i].at;
      if (tok(i + 1) === "hundred" || tok(i + 1) === "thousand") {
        push(tok(i + 1) === "hundred" ? 200 : 2_000, from, i + 1);
        i += 1;
      } else push(2, from, i);
      continue;
    }
    if (t === "dozen") {
      if (last === "ones" || last === "teens" || last === "tens") {
        chunk *= 12;
        wEndTok = i;
        flush();
      } else {
        flush();
        push(12, tok(i - 1) === "a" ? toks[i - 1].at : toks[i].at, i);
      }
      continue;
    }
    if (t === "point" && ONES.has(tok(i + 1)) && (last || !POINT_NOUN.has(tok(i - 1)))) {
      let digits = "";
      let j = i + 1;
      while (ONES.has(tok(j)) && digits.length < 6) {
        digits += String(ONES.get(tok(j)));
        j += 1;
      }
      const whole = last ? total + chunk : 0;
      const from = last ? wStart : toks[i].at;
      chunk = 0;
      total = 0;
      last = "";
      push(whole + Number(`0.${digits}`), from, j - 1);
      i = j - 1;
      continue;
    }
    if (t === "one" && tok(i - 1) === "no") {
      flush();
      continue;
    }
    const one = ONES.get(t);
    if (one !== undefined) {
      if (!((last === "tens" && one > 0) || last === "hundred" || last === "scale")) flush();
      chunk += one;
      word(i, "ones");
      continue;
    }
    const teen = TEENS.get(t);
    if (teen !== undefined) {
      if (!(last === "hundred" || last === "scale")) flush();
      chunk += teen;
      word(i, "teens");
      continue;
    }
    const ten = TENS.get(t);
    if (ten !== undefined) {
      if (!(last === "hundred" || last === "scale")) flush();
      chunk += ten;
      word(i, "tens");
      continue;
    }
    if (t === "hundred") {
      if (last === "ones" || last === "teens" || last === "tens") {
        chunk *= 100;
        word(i, "hundred");
      } else {
        flush();
        if (tok(i - 1) === "a") {
          chunk = 100;
          word(i, "hundred", toks[i - 1].at);
        }
      }
      continue;
    }
    const scale = SCALES.get(t);
    if (scale !== undefined) {
      if (last && last !== "scale") {
        total += (chunk || 1) * scale;
        chunk = 0;
        word(i, "scale");
      } else {
        flush();
        // "a thousand" is one; "thousands of" or a bare "million" is no figure.
        if (tok(i - 1) === "a") {
          total = scale;
          word(i, "scale", toks[i - 1].at);
        }
      }
      continue;
    }
    if (t === "k" && last && last !== "scale") {
      total += (chunk || 1) * 1_000;
      chunk = 0;
      word(i, "scale");
      continue;
    }
    if (t === "and" && last) continue;
    flush();
  }
  flush();
  return out;
}

/** Every figure a text states (figuresIn without the places). */
export function numbersIn(text: string): number[] {
  return figuresIn(text).map((f) => f.value);
}

const FRACTION_RE = /\b(?:(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|a)\s+)?(half|quarters?|thirds?)\b(?!\s+an?\s+(?:dozen|hours?|days?|minutes?)\b)/g;
const ONE_IN_RE = /\b(\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:out\s+of|in|of\s+every)\s+(\d{1,4}|two|three|four|five|six|seven|eight|nine|ten|a\s+hundred|hundred)\b/g;
const smallNumber = (w: string): number => (/^\d/.test(w) ? Number(w) : w.endsWith("hundred") ? 100 : (ONES.get(w) ?? TEENS.get(w) ?? Number.NaN));

/** Shares a text states as fractions, with their places: "half", "a quarter", "two thirds", "one in four", "3 out of 10". Never a decimal: "$0.50" is money. */
function fractionsAt(text: string): FigureAt[] {
  const s = baseText(text);
  const out: FigureAt[] = [];
  for (const m of s.matchAll(FRACTION_RE)) {
    // "the third job" is an ordinal: a third or a quarter needs its count ("a third", "two thirds").
    if (m[2] !== "half" && !m[1]) continue;
    const k = !m[1] || m[1] === "a" ? 1 : smallNumber(m[1]);
    const at = m.index ?? 0;
    if (Number.isFinite(k)) out.push({ value: m[2] === "half" ? 0.5 : Math.min(1, k * (FRACTION_WORDS.get(m[2]) as number)), start: at, end: at + m[0].length });
  }
  for (const m of s.matchAll(ONE_IN_RE)) {
    const a = smallNumber(m[1]);
    const b = smallNumber(m[2]);
    const at = m.index ?? 0;
    if (b > 0 && a >= 0 && a <= b) out.push({ value: a / b, start: at, end: at + m[0].length });
  }
  return out.sort((x, y) => x.start - y.start);
}

/** Shares a text states as fractions (fractionsAt without the places). */
export function fractionsIn(text: string): number[] {
  return fractionsAt(text).map((f) => f.value);
}

type Period = "minute" | "hour" | "day" | "week" | "month" | "year";
const PERIOD_WORDS: ReadonlyArray<readonly [Period, RegExp]> = [
  ["minute", /^(?:minutes?|mins?)$/],
  ["hour", /^(?:hours?|hrs?|hourly)$/],
  ["day", /^(?:days?|daily|nights?|nightly)$/],
  ["week", /^(?:weeks?|weekly|wks?)$/],
  ["month", /^(?:months?|monthly|mo|mos)$/],
  ["year", /^(?:years?|yearly|annual|annually|annum|yrs?)$/],
];
const periodOfWord = (w: string): Period | null => PERIOD_WORDS.find(([, re]) => re.test(w))?.[0] ?? null;
/** Words that start another phrase: a period word past one belongs to the next figure ("10 and in a month 40"). */
const JOINERS = new Set(["and", "or", "but", "while", "whereas", "then", "plus"]);

/** A clause of a line: where it is, and whether its sentence asked a question. A comma alone does not end one. */
type ClauseAt = { start: number; end: number; question: boolean };
const SENTENCE_END = /[.!;]+(?=\s|$)|\?+/g;
const CLAUSE_BREAK = /,\s*(?:so|but|and|which|though|although|whereas|while)\b|\s(?:but|whereas|although|while)\s|(?<!\bor)\sso\s/g;
/** "So about 40 a month, right": a figure put to the other side to confirm is a question. */
const TAG_QUESTION = /,\s*(?:right|correct|is that right|isn't it|is it|don't you|didn't you|aren't you)\s*$/;

/** A tag the speaker puts on their own statement, and a first-person statement it may end. */
const OWN_TAG = /,\s*(?:right|correct|okay|ok|no|yeah|yes|eh|you know)\s*$/;
const FIRST_PERSON = /\b(?:we|i|our|us|my|we're|i'm|we've|i've|we'd|i'd)\b/;
/** An answer that says yes to what was just asked. */
const AFFIRM = /^\s*(?:yes|yeah|yep|yup|yea|correct|exactly|sure|right|that's right|uh-huh|mm-hm|mhm|we do|we use|i do|of course|definitely)\b/;
function clausesOf(s: string): ClauseAt[] {
  const sentences: ClauseAt[] = [];
  let from = 0;
  for (const m of s.matchAll(SENTENCE_END)) {
    const at = m.index ?? 0;
    sentences.push({ start: from, end: at, question: m[0].includes("?") });
    from = at + m[0].length;
  }
  sentences.push({ start: from, end: s.length, question: false });
  const out: ClauseAt[] = [];
  for (const [k, sen] of sentences.entries()) {
    const text = s.slice(sen.start, sen.end);
    if (!text.trim()) continue;
    let question = sen.question || TAG_QUESTION.test(text.trimEnd());
    if (question && OWN_TAG.test(text.trimEnd()) && FIRST_PERSON.test(text)) question = false;
    const next = sentences[k + 1];
    if (question && next && AFFIRM.test(s.slice(next.start, next.end))) question = false;
    let at = 0;
    for (const m of text.matchAll(CLAUSE_BREAK)) {
      out.push({ start: sen.start + at, end: sen.start + (m.index ?? 0), question });
      at = (m.index ?? 0) + m[0].length;
    }
    out.push({ start: sen.start + at, end: sen.end, question });
  }
  return out.filter((c) => s.slice(c.start, c.end).trim());
}

/** One line of the call, read once: its text, figures, shares, words and clauses. */
type LineRead = { s: string; figures: FigureAt[]; fractions: FigureAt[]; words: WordAt[]; clauses: ClauseAt[]; sentences: Array<{ start: number; end: number }> };
function readLine(text: string): LineRead {
  const s = baseText(text);
  const sentences: Array<{ start: number; end: number }> = [];
  let from = 0;
  for (const m of s.matchAll(SENTENCE_END)) {
    sentences.push({ start: from, end: m.index ?? 0 });
    from = (m.index ?? 0) + m[0].length;
  }
  sentences.push({ start: from, end: s.length });
  return {
    s,
    figures: figuresIn(s),
    fractions: fractionsAt(s),
    words: [...s.matchAll(/[a-z]+(?:'[a-z]+)?/g)].map((m) => ({ w: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length })),
    clauses: clausesOf(s),
    sentences,
  };
}
function clauseAt(r: LineRead, at: number): ClauseAt {
  return r.clauses.find((c) => at >= c.start && at < c.end) ?? { start: 0, end: r.s.length, question: false };
}

/**
 * The period words bound to a figure in its clause: the first after it (before
 * the next figure, and not past "and" or "or"), the one after that ("10 hours
 * a week"), and the nearest before it ("every month we get about 40").
 */
type Bound = { after: Period | null; afterWord: WordAt | null; next: Period | null; nextWord: WordAt | null; before: Period | null; beforeWord: WordAt | null };
function bind(r: LineRead, clause: ClauseAt, f: FigureAt): Bound {
  const others = r.figures.filter((g) => g !== f && g.start >= clause.start && g.start < clause.end);
  const hi = Math.min(clause.end, ...others.filter((g) => g.start >= f.end).map((g) => g.start));
  const lo = Math.max(clause.start, ...others.filter((g) => g.end <= f.start).map((g) => g.end));
  const after = r.words.filter((w) => w.start >= f.end && w.end <= hi).slice(0, 6);
  const before = r.words.filter((w) => w.end <= f.start && w.start >= lo).slice(-6);
  const b: Bound = { after: null, afterWord: null, next: null, nextWord: null, before: null, beforeWord: null };
  for (let i = 0; i < after.length; i++) {
    const w = after[i];
    if (w.w === "or" && after[i + 1]?.w === "so") {
      i += 1;
      continue;
    }
    if (JOINERS.has(w.w)) break;
    const p = periodOfWord(w.w);
    if (!p) continue;
    if (!b.afterWord) {
      b.after = p;
      b.afterWord = w;
      continue;
    }
    b.next = p;
    b.nextWord = w;
    break;
  }
  for (let i = before.length - 1; i >= 0; i--) {
    if (JOINERS.has(before[i].w)) break;
    const p = periodOfWord(before[i].w);
    if (p) {
      b.before = p;
      b.beforeWord = before[i];
      break;
    }
  }
  return b;
}

/** What a field's figure is counted in. `key` names the field, for the checks only it has. */
type Need = { per?: Period; hours?: boolean; duration?: boolean; share?: boolean; perJob?: boolean; key?: string };
function needOf(def: ProfileFieldDef): Need {
  const key = def.key;
  if (key === "finance.staff_hourly_cost") return { per: "hour", key };
  if (key === "sales.avg_job_value") return { perJob: true, key };
  if (def.unit === "leads/month") return { per: "month", key };
  if (def.unit === "calls/week") return { per: "week", key };
  if (def.unit === "hours/week") return { per: "week", hours: true, key };
  if (def.unit === "hours") return { duration: true, key };
  if (def.unit === "%") return { share: true, key };
  return { key };
}
/** Table columns whose figures are counted over a period, as a field's own figures are. */
const COLUMN_NEEDS: Readonly<Record<string, Need>> = { "monthly cost": { per: "month" }, "hours per week": { per: "week", hours: true }, "per month": { per: "month" } };

/**
 * A period word that makes a rate: "40 leads a month", "25 an hour", "$25/hr",
 * "every month", "monthly". `from` is where the figure (or the word before)
 * ends; a word before the figure is read with what comes before it.
 */
function rateWord(r: LineRead, from: number, w: WordAt): boolean {
  if (/^(?:hourly|daily|nightly|weekly|monthly|yearly|annually|annual)$/.test(w.w)) return true;
  const after = w.start >= from;
  const lead = after ? r.s.slice(from, w.start) : r.s.slice(Math.max(0, w.start - 24), w.start);
  if (after && /,|\b(?:twice|once|times)\b/.test(lead)) return false;
  return /(?:^|[\s$])(?:a|an|per|each|every|last|this)\s+(?:(?:typical|normal|average|usual|regular|given|single)\s+)?$/.test(lead) || /\/\s*$/.test(lead);
}
/** A period word that counts: "25 hours", "2 business days", and "an hour" (where "an" is the figure). */
function countWord(r: LineRead, f: FigureAt, w: WordAt): boolean {
  return w.start >= f.end && /^\s*(?:(?:business|working|full|whole)\s+)?$/.test(r.s.slice(f.end, w.start));
}

/** A figure read for a field: its value in the field's unit, why it does not fit, the words it leans on, and whether its period came after it. */
type Reading = { value: number | null; why: string | null; used: Array<{ start: number; end: number }>; explicit: boolean };
function readFigure(need: Need, r: LineRead, f: FigureAt, b: Bound): Reading {
  const used: Array<{ start: number; end: number }> = [];
  const take = (w: WordAt | null) => {
    if (w) used.push(w);
  };
  if (need.share) {
    const m = /^\s*(?:%|percent\b|per\s?cent\b)/.exec(r.s.slice(f.end));
    if (!m) return { value: null, why: "the quote gives no share or percentage", used, explicit: false };
    used.push({ start: f.end, end: f.end + m[0].length });
    return { value: f.value, why: null, used, explicit: true };
  }
  if (need.duration) {
    take(b.afterWord);
    // How long it takes counts its unit ("2 hours", "an hour"); "25 an hour" is a rate.
    if (!b.afterWord || !countWord(r, f, b.afterWord)) {
      return { value: null, why: b.afterWord && rateWord(r, f.end, b.afterWord) ? "the quote gives a rate, not how long it takes" : "the quote does not say how long", used, explicit: false };
    }
    const factor = b.after === "minute" ? 1 / 60 : b.after === "hour" ? 1 : b.after === "day" ? 24 : null;
    if (factor === null) return { value: null, why: `the quote gives it in ${b.after}s, not minutes, hours or days`, used, explicit: false };
    return { value: f.value * factor, why: null, used, explicit: true };
  }
  if (need.hours) {
    if (b.after !== "hour" || !b.afterWord || !countWord(r, f, b.afterWord)) return { value: f.value, why: "the quote does not say hours", used, explicit: false };
    take(b.afterWord);
    const per = b.next ?? b.before;
    const perWord = b.next ? b.nextWord : b.beforeWord;
    take(perWord);
    if (per !== "week") return { value: f.value, why: per ? `the quote gives it per ${per}, not per week` : "the quote does not say per week", used, explicit: false };
    if (perWord && !rateWord(r, b.afterWord.end, perWord)) return { value: f.value, why: "the quote does not say it is every week", used, explicit: false };
    return { value: f.value, why: null, used, explicit: !!b.next };
  }
  if (need.per) {
    const per = b.after ?? b.before;
    const word = b.after ? b.afterWord : b.beforeWord;
    take(word);
    if (!per || !word) return { value: f.value, why: `the quote does not say per ${need.per}`, used, explicit: false };
    if (per !== need.per) return { value: f.value, why: `the quote gives it per ${per}, not per ${need.per}`, used, explicit: false };
    // "40 leads a month" is a rate; "25 hours a week" and "every other month" are not one per period.
    if (!rateWord(r, f.end, word)) return { value: f.value, why: `the quote does not give it as a figure per ${per}`, used, explicit: false };
    return { value: f.value, why: null, used, explicit: !!b.after };
  }
  // A job's value is per job: "$400 a month" is a fee, not a job.
  if (need.perJob && b.after) return { value: f.value, why: `the quote gives it per ${b.after}, not per job`, used, explicit: false };
  return { value: f.value, why: null, used, explicit: false };
}

const NOT_STATED = "a figure the quote does not state";
const RANGE_REASON = "a range, not one figure: it belongs in the open questions";
const LIMIT_REASON = 'the client gave it as a limit, a goal, an "if" or a past figure, not as what is';
const NUMBER_WORD = "(?:\\d|\\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|a hundred|a thousand|a couple)\\b)";
const RANGE_JOIN = "(?:-|\\u2013|\\u2014|,|/|to|through|thru|or|up to)";
const RANGE_AFTER = new RegExp(`^\\s*(?:${RANGE_JOIN}\\s*(?:about|around|maybe)?\\s*\\$?\\s*${NUMBER_WORD}|-?\\s*(?:something|odd)\\b)`);
const RANGE_BEFORE = new RegExp(`${NUMBER_WORD}\\s*(?:k|grand|thousand|hundred|%|percent)?\\s*${RANGE_JOIN}\\s*(?:about|around|maybe)?\\s*\\$?\\s*$`);
const BETWEEN_FIRST = /\bbetween\s+(?:[a-z$]+\s+){0,2}\$?$/;
const BETWEEN_AND = /^\s*(?:[a-z]+\s+){0,2}(?:and|&)\s/;
const BETWEEN_SECOND = /\bbetween\s+\S+(?:\s+\S+){0,4}\s+(?:and|&)\s+(?:[a-z]+\s+)?\$?$/;
/** After a figure's own unit: "an hour or two", "30 minutes to an hour", "an hour, two at the most". */
const RANGE_AFTER_UNIT = new RegExp(`^\\s*(?:,\\s*|(?:or|to|-|\\u2013|\\u2014)\\s*)(?:about\\s+|around\\s+|maybe\\s+)?(?:an?\\s+(?:hour|day|minute|week|couple)|half|${NUMBER_WORD})`);

// Anywhere in a figure's clause, each of these makes it no figure of what is, now, for this business.
const NEGATION =
  /\b(?:not|never|no longer|nowhere near|far from|hardly|barely|don't|doesn't|didn't|haven't|hasn't|hadn't|couldn't|can't|cannot|won't|wouldn't|shouldn't|isn't|aren't|wasn't|weren't|do not|does not|did not|have not|has not|had not|could not|will not|would not|should not|is not|are not|was not|were not)\b/;
const LIMIT =
  /\b(?:at least|at most|at the most|up to|more than|less than|fewer than|over|under|below|above|upwards of|north of|no more than|no less than|beyond|exceeds?|exceeded|max|maximum|minimum|cap|caps|capped|top out|tops out|topped out|tops|max out|maxes out|maxed out|or more|or less|or fewer|and up|plus(?!\s+(?:tax|taxes|hst|gst|pst|vat|fees?|shipping)\b)|peak)\b|\+/;
const GOAL =
  /\b(?:want|wants|wanted|wanting|wish|wishes|hope|hopes|hoping|hoped|would(?!\s+say)|love to|like to|aim|aims|aiming|target|targets|targeting|goal|goals|quota|plan to|plans to|planning|planned|expect|expects|expecting|projected|projection|forecast|forecasting|trying to|try to|looking to|going to|gonna|will|should|could|might|ideally|ideal|if|unless|suppose|supposing|imagine|hypothetically|we need|i need|next (?:year|month|week|season|quarter|spring|summer|fall|winter)|by (?:spring|summer|fall|autumn|winter|next|the end)|once the)\b|\b[a-z]+'d (?:love|like|need)\b|\b[a-z]+'ll\b/;
const PAST =
  /\b(?:last (?:year|summer|winter|spring|fall|autumn|season|quarter)|ago|back (?:in|then|when)|before (?:covid|the pandemic|the lockdown|we)|used to|previously|formerly|originally|once (?:had|got|did|was|were|hit|reached|made)|at (?:one point|our peak|the peak|the start|first)|when we (?:started|opened|began|first)|in (?:the )?first (?:year|month|week|few)|over the (?:last|past)|in (?:19|20)\d{2}|since (?:19|20)\d{2}|until (?:last|recently))\b/;
const THIRD_PARTY =
  /\b(?:competitors?|competition|the industry|industry average|franchise|market average|national average|other (?:shops|companies|businesses|guys|contractors|plumbers|electricians|roofers|landscapers|cleaners|firms|agencies|salons|clinics|people|places)|(?:a|my|our) (?:buddy|friend|neighbou?r|brother|sister|cousin|dad|father|mom|mother|uncle|aunt|brother-in-law|sister-in-law)(?:'s)?|a (?:guy|shop|company|business|contractor|firm) (?:i know|that|who|down)|another (?:shop|company|business|contractor|guy|firm)|someone (?:else|i know)|they say|the average (?:shop|company|business|contractor|plumber)|most (?:shops|companies|businesses|contractors|people))\b/;
const HEDGE = /\b(?:maybe|perhaps|probably|not sure|no idea|i guess|guessing|a guess|had to guess|my guess|i'd guess|i would guess|could be|might be|possibly|i don't know|i do not know|dunno|hard to say|no clue|not certain)\b/;
const VARIES =
  /\b(?:sometimes|some (?:months|weeks|days)|it depends|depends on|depending on|it varies|varies|on a (?:good|bad|busy|slow|quiet) (?:month|week|day)|in (?:the )?(?:summer|winter|spring|fall|autumn|busy season|slow season|peak season|off season)|seasonal(?:ly)?|in (?:january|february|march|april|may|june|july|august|september|october|november|december)|when (?:it's|it is|things are) (?:busy|slow|quiet)|(?:busy|slow|quiet) (?:times|months|weeks|season)|during the (?:day|week)|overnight|weekdays?|weekends?|at night|after hours)\b/;
/** "So you get about 40 a month": a figure put to the client, not said by them. */
const SECOND_PERSON = /\b(?:so you|you (?:get|have|see|do|said|mentioned|told|are|were|guys|folks|all)|you're|your (?:leads|calls|business|team|shop|close|customers|jobs))\b/;
/** A hedge that reaches back to what was just said ("I'm not sure about that"); "not sure about the sales side" is about something else. */
const REFERRING_HEDGE =
  /\b(?:not (?:sure|certain|positive)|no (?:idea|clue)|(?:just |only )?(?:a )?guess(?:ing)?|don'?t quote me|could be wrong|have to check|i don'?t (?:really )?know|dunno|hard to say|i think so)\b(?!\s+(?:(?:about|on|of|with)\s+(?:the|our|their|my|his|her|its|what|how|why|who|when|where|whether|if)|how|why|who|when|where|whether|if|what)\b)/;
const MISSED_PHRASE = /\b(?:can't|cannot|don't|do not|didn't|did not|couldn't|could not)\s+(?:answer|pick up|get to|take)\b/g;

/** Words a field's figure needs nearby (in its clause, or the question it answers), and nouns it may count. */
const FIELD_WORDS: Readonly<Record<string, RegExp>> = {
  "sales.missed_calls_per_week":
    /\b(?:miss|misses|missed|missing|voicemails?|unanswered|(?:can't|cannot|don't|do not|didn't|did not|couldn't|could not) (?:answer|pick up|get to|take)|hang up|hangs up|hung up|lose|lost|ring out|rings out|go to voicemail)\b/,
  "sales.close_rate_pct":
    /\b(?:close|closes|closed|closing|convert|converts|converted|conversion|win|wins|won|book|books|booked|sign|signs|signed|buy|buys|bought|hire|hires|hired|go ahead|goes ahead|say yes|says yes|becom(?:e|es|ing) (?:a |our )?(?:customers?|clients?|jobs?)|turns? into|ends? up|takes? the job|accept|accepts|accepted|land|lands|landed)\b/,
  "sales.response_time_hours":
    /\b(?:reply|replies|replied|respond|responds|responded|response|answer|answers|answered|get back|gets back|got back|call back|calls back|called back|text back|follow up|follows up|followed up|return|returns|returned|hear back|hears back|reach out|reaches out|first contact)\b/,
  "ops.admin_hours_per_week":
    /\b(?:admin|administration|administrative|paperwork|office work|bookkeeping|books|invoic\w*|billing|scheduling|schedule|emails?|data entry|quotes|quoting|estimates|estimating|phones?|calls|follow[- ]ups?|chasing|filing|payroll|reports?|reporting|social media|posting)\b/,
  "finance.staff_hourly_cost": /\b(?:pay|pays|paid|paying|wage|wages|make|makes|made|earn|earns|earned|costs? (?:us|me)|salary|hourly rate)\b/,
  "sales.avg_job_value":
    /\$|\b(?:job|jobs|project|projects|order|orders|ticket|tickets|invoice|invoices|sale|average|typical|typically|each|usually|charge|charges|costs?|price|prices|priced|worth|spend|spends|pay|pays|bill|bills|dollars?|bucks|grand|k)\b/,
};
const FIELD_NOT: Readonly<Record<string, RegExp>> = {
  "finance.staff_hourly_cost": /\b(?:charge|charges|charged|charging|bill|bills|billed|billing|price|prices|our rate|labou?r rate)\b/,
  "sales.avg_job_value":
    /\b(?:retainer|subscription|deposit|rent|payroll|salary|salaries|wages?|ads|advertising|marketing|budget|insurance|loan|revenue|sales|turnover|profit|margin|we pay|costs? (?:us|me)|fees?|small|smallest|smaller|big|biggest|bigger|large|largest|cheapest|cheap|most expensive)\b/,
};
const NOUNS: Readonly<Record<string, ReadonlySet<string>>> = {
  "sales.leads_per_month": new Set("leads lead enquiries enquiry inquiries inquiry requests request calls call quotes quote estimates estimate prospects people messages message emails email submissions contacts opportunities texts referrals".split(" ")),
  "sales.missed_calls_per_week": new Set("calls call phone voicemails voicemail rings people callers".split(" ")),
  "business.team_size": new Set(
    "people person staff employees employee workers worker techs tech technicians technician guys guy folks members member crew hands helpers plumbers electricians roofers installers cleaners admins full-time part-time fulltime parttime full part team us drivers apprentices laborers labourers nurses stylists therapists agents reps salespeople associates partners owners".split(" "),
  ),
};
const COUNT_NOUNS = new Set("jobs job leads lead calls call customers clients people hours hour days day weeks week months month years year minutes trucks vans employees projects".split(" "));
const NOUN_SKIP = new Set("new fresh inbound incoming online qualified real solid good decent web website organic paid warm cold phone more extra or so odd ish about roughly around of them those these the our my total full time".split(" "));
const NOUN_END = new Set("a an per each every that which who come comes coming came in through from for on at by to and".split(" "));
/** The noun a figure counts ("40 leads", "15 jobs"), or null when it names none. */
function headNoun(r: LineRead, clause: ClauseAt, f: FigureAt): string | null {
  for (const w of r.words) {
    if (w.start < f.end || w.start >= clause.end) continue;
    if (NOUN_END.has(w.w)) return null;
    if (NOUN_SKIP.has(w.w)) continue;
    return w.w;
  }
  return null;
}

/** A range or a question is no figure, wherever its period word is. */
function rangeOrQuestion(r: LineRead, clause: ClauseAt, f: FigureAt, b: Bound): string | null {
  const before = r.s.slice(Math.max(0, f.start - 48), f.start);
  const after = r.s.slice(f.end, f.end + 48);
  if (RANGE_AFTER.test(after) || RANGE_BEFORE.test(before) || (BETWEEN_FIRST.test(before) && BETWEEN_AND.test(after)) || BETWEEN_SECOND.test(before)) return RANGE_REASON;
  if (b.afterWord && countWord(r, f, b.afterWord) && RANGE_AFTER_UNIT.test(r.s.slice(b.afterWord.end, b.afterWord.end + 40))) return RANGE_REASON;
  if (clause.question) return "the client asked it as a question";
  return null;
}
/** What the words of a figure's clause say about it: anywhere in the clause, not just beside it. */
function contextWhy(need: Need, r: LineRead, clause: ClauseAt): string | null {
  let whole = r.s.slice(clause.start, clause.end);
  // "We can't answer about 10 calls a week" counts missed calls; the "can't" is the miss, not a denial.
  if (need.key === "sales.missed_calls_per_week") whole = whole.replace(MISSED_PHRASE, " missed ");
  if (SECOND_PERSON.test(whole)) return "the figure is put to the client, not said by them";
  if (NEGATION.test(whole) || LIMIT.test(whole) || GOAL.test(whole) || PAST.test(whole)) return LIMIT_REASON;
  if (THIRD_PARTY.test(whole)) return "the figure is someone else's, not this business's";
  if (HEDGE.test(whole)) return "the client was not sure of it";
  if (VARIES.test(whole)) return "the client said it varies, so it is not one figure";
  return null;
}
/** The checks only one field has: the words it needs (in the clause, or the question it answers) and the nouns it may count. */
function fieldWhy(need: Need, r: LineRead, clause: ClauseAt, f: FigureAt, b: Bound, around: string): string | null {
  const key = need.key;
  if (!key) return null;
  const whole = r.s.slice(clause.start, clause.end);
  const needs = FIELD_WORDS[key];
  if (needs && !needs.test(whole) && !needs.test(around)) return "the quote does not say what the figure is about";
  const not = FIELD_NOT[key];
  if (not && not.test(whole)) return key === "sales.avg_job_value" ? "the figure is not what an average job is worth" : "the figure is a price the business charges, not what staff time costs it";
  const noun = headNoun(r, clause, f);
  const nouns = NOUNS[key];
  if (nouns && noun && !nouns.has(noun)) return `the quote counts ${noun}, not ${key === "business.team_size" ? "people" : key === "sales.missed_calls_per_week" ? "missed calls" : "leads"}`;
  if (key === "business.team_size" && b.afterWord && countWord(r, f, b.afterWord)) return "the quote gives a length of time, not a number of people";
  if (key === "sales.avg_job_value" && noun && COUNT_NOUNS.has(noun)) return `the quote counts ${noun}, not dollars`;
  if (key === "sales.close_rate_pct" && /^\s*(?:%|percent|per\s?cent)\s+(?:deposit|discount|markup|margin|tax|tip|commission|interest|off|down|upfront|up front|growth|increase|decrease|of (?:the )?(?:price|cost|bill|invoice|job|revenue|sales|profit))\b/.test(r.s.slice(f.end))) {
    return "the share is of something else, not of leads won";
  }
  return null;
}
/** Two figures for one field in one clause ("60 a month, 30 a month in winter", "$200 small, $2,000 big") are not one figure. */
function severalFigures(need: Need, r: LineRead, clause: ClauseAt, f: FigureAt, n: number): string | null {
  for (const g of r.figures) {
    if (g === f || g.start < clause.start || g.start >= clause.end || near(g.value, n)) continue;
    if (need.perJob) {
      const money = r.s[g.start] === "$" || /^\s*(?:dollars?|bucks|k|grand)\b/.test(r.s.slice(g.end));
      if (money) return "the client gave more than one figure for it";
      continue;
    }
    if (!need.per && !need.hours && !need.duration && !need.share) return null;
    const other = readFigure(need, r, g, bind(r, clause, g));
    if (other.why === null && other.explicit && other.value !== null && !near(other.value, n)) return "the client gave more than one figure for it";
  }
  return null;
}

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);

/** A line of the quote: who said it, the line read, and the part of it the quote covers. */
type LineCtx = { line: TranscriptLine; host: boolean; read: LineRead; cover: { from: number; to: number } | null };
const inside = (c: LineCtx["cover"], x: { start: number; end: number }) => !!c && x.start >= c.from && x.end <= c.to;
type Fit = { ok: true } | { ok: false; reason: string };

/**
 * Does `n` stand, in the field's unit, as a fact in what the client said? It
 * must be a figure inside the quote, on a line the client said (the
 * interviewer's lines never count), with the words it leans on inside the
 * quote too, and pass every check beside it. `around` is the question it
 * answers (the lines before the quote) and the interviewer's lines in it, for
 * the words a field needs; `guard` is a caller's own check (a table row's).
 */
function figureFits(need: Need, n: number, ctx: readonly LineCtx[], around = "", guard?: (c: LineCtx, f: FigureAt) => string | null): Fit {
  let reason: string | null = null;
  let hostSaid = false;
  for (const c of ctx) {
    const options: Array<{ f: FigureAt; fraction: boolean }> = c.read.figures.map((f) => ({ f, fraction: false }));
    if (need.share) for (const f of c.read.fractions) options.push({ f, fraction: true });
    for (const { f, fraction } of options) {
      const clause = clauseAt(c.read, f.start);
      const b = bind(c.read, clause, f);
      const reading: Reading = fraction ? { value: f.value * 100, why: null, used: [], explicit: true } : readFigure(need, c.read, f, b);
      const valueMatch = reading.value !== null && (fraction ? Math.abs(reading.value - n) <= 0.5 : near(reading.value, n));
      const rawMatch = !fraction && near(f.value, n);
      if ((!valueMatch && !rawMatch) || !inside(c.cover, f)) continue;
      if (c.host) {
        hostSaid = true;
        continue;
      }
      const why = !valueMatch
        ? (reading.why ?? "the quote gives it in other units: it is a different number of hours")
        : (rangeOrQuestion(c.read, clause, f, b) ??
          // What the clause says about the figure comes first: "40 or more" is a limit before it is anything else.
          contextWhy(need, c.read, clause) ??
          reading.why ??
          (reading.used.every((u) => inside(c.cover, u)) ? null : "the quote leaves out the words that say what the figure counts") ??
          fieldWhy(need, c.read, clause, f, b, around) ??
          severalFigures(need, c.read, clause, f, n) ??
          guard?.(c, f) ??
          null);
      if (!why) return { ok: true };
      reason ??= why;
    }
  }
  return { ok: false, reason: reason ?? (hostSaid ? "only the interviewer said that figure" : NOT_STATED) };
}

/** The figures a piece of prose writes, each with the period words the prose binds to it ("Admin 2 hours per week"). */
function proseFigures(text: string): Array<{ value: number; bound: Bound | null; qualifier?: string | null }> {
  const r = readLine(text);
  return r.figures.map((f) => {
    const clause = clauseAt(r, f.start);
    return { value: f.value, bound: bind(r, clause, f), qualifier: contextWhy({}, r, clause) };
  });
}
/**
 * Why a figure written in a text value, a list item or a table cell does not
 * stand, or null: the client must say it, inside the quote, and with the same
 * period the prose gives it ("Admin 2 hours per week" from "2 hours a day" is
 * not what was said).
 */
function proseFigureWhy(fig: { value: number; bound: Bound | null; qualifier?: string | null }, ctx: readonly LineCtx[]): string | null {
  let hostSaid = false;
  let found = false;
  const per = fig.bound ? (fig.bound.after ?? fig.bound.before) : null;
  const second = fig.bound?.next ?? null;
  for (const c of ctx) {
    for (const f of c.read.figures) {
      if (!near(f.value, fig.value) || !inside(c.cover, f)) continue;
      if (c.host) {
        hostSaid = true;
        continue;
      }
      found = true;
      const lineClause = clauseAt(c.read, f.start);
      const b = bind(c.read, lineClause, f);
      if (per && (b.after ?? b.before) !== per) continue;
      if (second && (b.next ?? b.before) !== second) continue;
      // The value's own "more than", "used to" or "maybe" must be the call's, and the call's the value's.
      if (fig.qualifier !== undefined && (fig.qualifier ?? null) !== contextWhy({}, c.read, lineClause)) {
        found = true;
        continue;
      }
      return null;
    }
  }
  if (found) return "the call gives that figure for a different period";
  return hostSaid ? "only the interviewer said that figure" : NOT_STATED;
}
function proseWhy(value: unknown, ctx: readonly LineCtx[]): string | null {
  const figs = typeof value === "string" ? proseFigures(value) : numbersInValue(value).map((n) => ({ value: n, bound: null }));
  for (const fig of figs) {
    const why = proseFigureWhy(fig, ctx);
    if (why) return why;
  }
  return null;
}

/** Every number written in a value (a row's cost, a list item's count). */
function numbersInValue(value: unknown): number[] {
  return numbersIn(JSON.stringify(value ?? "").replace(/[{}[\]":]/g, " "));
}

const STOPWORDS = new Set(
  (
    "the and for with our we they them their that this these those are is was were has have had from into about very just also its you your his her " +
    "she him who what when where which there here then than but not all any some more most much many such only own same other can will would could " +
    "should may might must do does did been being get got make made use used using per each every out over under"
  ).split(" "),
);
/** A word cut back to its stem, lightly and the same way on both sides: "installs" and "install", "scheduling" and "schedule"; never "quickbooks" to "quick". */
function stemOf(w: string): string {
  let s = w;
  if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !/(?:ss|us|is)$/.test(s)) s = s.slice(0, -1);
  for (const suf of ["ing", "ed", "er", "ly"]) {
    if (s.length - suf.length >= 3 && s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  if (s.length > 3 && (s.endsWith("e") || s.endsWith("y"))) s = s.slice(0, -1);
  return s;
}
/** A value's words that carry meaning. */
function contentWords(s: string): string[] {
  return baseText(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}
/** The stems of the quote's own lines (and their speakers), whole words, with each pair of neighbours joined ("quick books" names QuickBooks). */
function stemsOf(said: readonly TranscriptLine[]): Set<string> {
  const out = new Set<string>();
  for (const l of said) {
    const words = baseText(`${l.speaker ?? ""} ${l.text}`).split(/[^a-z0-9]+/).filter(Boolean);
    words.forEach((w, i) => {
      out.add(stemOf(w));
      if (i + 1 < words.length) out.add(stemOf(`${w}${words[i + 1]}`));
    });
  }
  return out;
}
/** The share of a value's words that the quote's lines say, word for word. */
function support(value: string, stems: ReadonlySet<string>): number {
  const words = contentWords(value);
  if (!words.length) return 1;
  return words.filter((w) => stems.has(stemOf(w))).length / words.length;
}
/** A name (a tool, a source) is in the lines as itself: every word of it, whole. */
function namedIn(name: string, stems: ReadonlySet<string>): boolean {
  const words = contentWords(name);
  return words.length > 0 && words.every((w) => stems.has(stemOf(w)));
}
/**
 * A product is named as a name: in a call written with capitals, "square
 * footage" is not Square and "sales team" is not Salesforce (review of phase
 * 2b). A call written all in lower case says nothing by case.
 */
/** Tool names that are everyday words: a capital at the start of a sentence says nothing about them ("Square footage", "Monday is busy"). */
const COMMON_WORD_NAMES = new Set(
  "square monday wave notion teams slack box close front buffer sage gusto harvest copper zoom stripe ramp pilot bonsai clay loom later keep word office outlook excel mail calendar sheets docs drive forms sites meet chat".split(" "),
);
function writtenAsName(name: string, said: readonly TranscriptLine[]): boolean {
  const text = said.map((l) => l.text).join(" ").normalize("NFKD");
  if (!/[A-Z]/.test(text)) return true;
  const first = contentWords(name)[0];
  if (!first) return false;
  const want = stemOf(first);
  const common = COMMON_WORD_NAMES.has(first);
  const toks = [...text.matchAll(/[A-Za-z0-9']+/g)].map((m) => ({ w: m[0], at: m.index ?? 0 }));
  return toks.some((t, i) => {
    if (!/^[A-Z0-9]/.test(t.w)) return false;
    const hit = stemOf(t.w.toLowerCase()) === want || (i + 1 < toks.length && stemOf(`${t.w}${toks[i + 1].w}`.toLowerCase()) === want);
    if (!hit) return false;
    const startOfSentence = /(?:^|[.!?:;])$/.test(text.slice(0, t.at).trimEnd());
    return !(common && startOfSentence);
  });
}
/** The words written with a capital inside a sentence (names, mostly), lower case: what a table row's figure must not be closer to than its own name. */
function capitalisedWords(text: string): Set<string> {
  const t = text.normalize("NFKD").replace(/\p{M}+/gu, "");
  const out = new Set<string>();
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9']*/g)) {
    const at = m.index ?? 0;
    if (!/^[A-Z]/.test(m[0]) || m[0] === "I") continue;
    if (/(?:^|[.!?:;])$/.test(t.slice(0, at).trimEnd())) continue;
    out.add(m[0].toLowerCase());
  }
  return out;
}
/**
 * "We stopped using Jobber", "we do not do roofing", "we replaced Jobber",
 * "we are thinking about getting Jobber": the client does not use it, or no
 * longer, or not yet.
 */
const NOT_USING =
  /\b(?:don't|do not|doesn't|does not|didn't|did not|haven't|have not|hasn't|has not|never|no longer|not|stopped|quit|cancelled|canceled|dropped|got rid of|getting rid of|used to|switched from|switching from|moved off|moved from|moved away from|replaced|replacing|ditched|done with|finished with|gave up on|gave up|tried|tried out|trialled|trialed|demoed|evaluated|considered|considering|thinking about|thinking of|looking at|looked at|looking into|looked into|might try|want to try|wanted to try|going to try|plan to|planning to|hope to|hoping to|want to|wants to|would like to|instead of|rather than|without)\s+((?:[a-z']+\s+){0,3})$/;
/** "Jobber was cancelled last year". */
const NOT_USING_AFTER = /^\s*(?:(?:was|were|got|has been|have been|is|are)\s+)?(?:cancelled|canceled|dropped|discontinued|replaced|retired|gone|turned off|shut off|switched off)\b/;
const NEGATION_RESET = new Set(["to", "and", "but", "now", "then", "so", "also", "with", "about", "of"]);
/** An item is negated when any of its words is mentioned by the client only where they say they do not, or no longer. */
/** A denial or a plan, which a past attempt must not be said with ("never tried", "want to try"). */
const DENIAL_OR_PLAN =
  /\b(?:don't|do not|doesn't|does not|didn't|did not|haven't|have not|hasn't|has not|never|not|might try|want to try|wanted to try|going to try|plan to|planning to|hope to|hoping to|want to|wants to|would like to|thinking about|thinking of|considering|considered|looking at|looked at|looking into|looked into|instead of|rather than|without)\b/;

/**
 * Is every mention of the item's words said as not used? `history` is for what the client tried before: an
 * attempt that stopped ("tried an answering service", "cancelled it") is the fact, so only a denial or a plan
 * counts ("never tried", "want to try"), never a word that dates it (Codex review of #756).
 */
function negatedIn(item: string, ctx: readonly LineCtx[], opts: { history?: boolean } = {}): boolean {
  for (const word of contentWords(item)) {
    const want = stemOf(word);
    let seen = 0;
    let negated = 0;
    for (const c of ctx) {
      if (c.host) continue;
      for (const w of c.read.words) {
        if (stemOf(w.w) !== want) continue;
        seen += 1;
        const clause = clauseAt(c.read, w.start);
        const m = NOT_USING.exec(c.read.s.slice(clause.start, w.start));
        const before = !!m && !m[1].trim().split(/\s+/).some((x) => NEGATION_RESET.has(x)) && (!opts.history || DENIAL_OR_PLAN.test(m[0]));
        const after = !opts.history && NOT_USING_AFTER.test(c.read.s.slice(w.end, clause.end));
        if (before || after) negated += 1;
      }
    }
    if (seen > 0 && negated === seen) return true;
  }
  return false;
}
/** Magnitude words a value may not add: "hundreds of leads" from "a lot of leads". */
const MAGNITUDE = /\b(?:hundreds|thousands|dozens|millions|billions|tons|loads|scores)\b/g;
/**
 * A short item's words are all the client's, said together in one clause
 * ("commercial plumbing ... not roofing" is not "commercial roofing"); a
 * longer one's are mostly theirs. Magnitude words are never added.
 */
function wordsWhy(text: string, ctx: readonly LineCtx[], stems: ReadonlySet<string>): string | null {
  const no = "its words are not what the call said";
  for (const m of baseText(text).matchAll(MAGNITUDE)) if (!stems.has(stemOf(m[0]))) return no;
  const words = contentWords(text);
  if (!words.length) return null;
  if (words.length > 3) return support(text, stems) >= 0.75 ? null : no;
  if (!words.every((w) => stems.has(stemOf(w)))) return no;
  const want = words.map(stemOf);
  const together = ctx.some(
    (c) =>
      !c.host &&
      c.read.clauses.some((cl) => {
        const inClause = c.read.words.filter((w) => w.start >= cl.start && w.end <= cl.end);
        const have = new Set(inClause.flatMap((w, i) => [stemOf(w.w), ...(i + 1 < inClause.length ? [stemOf(`${w.w}${inClause[i + 1].w}`)] : [])]));
        return want.every((x) => have.has(x));
      }),
  );
  return together ? null : no;
}

/** The lines a quote is on, found word for word in one pass over the cited range. */
function quoteSpan(lines: readonly TranscriptLine[], from: number, to: number, quote: string): TranscriptLine[] {
  const range = lines.filter((l) => l.n >= from && l.n <= to);
  const cover = quoteCover(range, quote);
  return cover ? range.filter((l) => cover.has(l.n)) : range;
}

/** Words as the quote check (lib/ai-audit/transcript.ts quoteWords) reads them: "$" and "%" alone, "1,200" and "2.5" whole. */
const QUOTE_WORDS = /\$|%|(?:[a-z0-9']|(?<=\d)[.,](?=\d))+/g;
/** Where on each of its lines the quote sits, as places in baseText of the line; null when it cannot be found word for word. */
function quoteCover(said: readonly TranscriptLine[], quote: string): Map<number, { from: number; to: number }> | null {
  const q = quoteWords(quote).split(" ").filter(Boolean);
  if (!q.length) return null;
  const toks: Array<{ n: number; w: string; start: number; end: number }> = [];
  for (const l of said) for (const m of baseText(l.text).matchAll(QUOTE_WORDS)) toks.push({ n: l.n, w: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  outer: for (let i = 0; i + q.length <= toks.length; i++) {
    for (let j = 0; j < q.length; j++) if (toks[i + j].w !== q[j]) continue outer;
    const cover = new Map<number, { from: number; to: number }>();
    for (let j = 0; j < q.length; j++) {
      const t = toks[i + j];
      const c = cover.get(t.n);
      if (c) c.to = t.end;
      else cover.set(t.n, { from: t.start, to: t.end });
    }
    return cover;
  }
  return null;
}

/** The interviewer's labels when the workspace's owner names are not known. */
export const DEFAULT_HOSTS: ReadonlySet<string> = new Set(["cc", "interviewer", "host", "oasis"]);
const speakerKey = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9' -]+/g, " ")
    .replace(/\s+\d+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
/**
 * The interviewer's labels in this call. The owners' first names count only
 * when no full name and no usual label appears in it, so a client who shares
 * the owner's first name stays the client (review of phase 2b).
 */
function hostsFor(lines: readonly TranscriptLine[], opts: CheckOptions): ReadonlySet<string> {
  const hosts = new Set<string>([...DEFAULT_HOSTS, ...[...(opts.hosts ?? [])].map(speakerKey)]);
  const labels = new Set(lines.map((l) => (l.speaker ? speakerKey(l.speaker) : "")).filter(Boolean));
  if ([...hosts].some((h) => labels.has(h))) return hosts;
  for (const f of opts.firstNames ?? []) hosts.add(speakerKey(f));
  return hosts;
}

/** What lib/llm-input-boundary.ts wraps an instruction-like phrase in; a quote copied from the fenced text is read without it. */
const DEFANGED = /\u00AB\[neutralized: ([^\]]{1,80})\]\u00BB/g;

export type CheckOptions = {
  /** Speaker labels that are the interviewer's: the workspace owners' full names (lower case). The usual labels (DEFAULT_HOSTS) always count. */
  hosts?: ReadonlySet<string>;
  /** The owners' first names: the interviewer's label only in a call where no full name or usual label appears. */
  firstNames?: ReadonlySet<string>;
};

type Checked = { ok: true; fact: KeptFact; note?: string } | { ok: false; reason: string };
type ItemCheck = { ok: true; value: unknown } | { ok: false; reason: string };

/** Table columns that hold a name the call must say as itself. */
const NAME_COLUMNS = new Set(["tool", "source"]);
/** Lead sources that are everyday words, never a brand: no capital is asked of them. */
const GENERIC_SOURCES = new Set(
  "referrals referral word mouth repeat returning customers customer walk ins walkins signs sign flyers flyer mailers mailer door hangers website site events event trade shows show networking partners partner friends family signage truck trucks wraps wrap local ads radio print newspaper magazine billboards billboard yard".split(" "),
);
const looksProper = (text: string) => /^[A-Z]/.test(text.trim()) && !contentWords(text).every((w) => GENERIC_SOURCES.has(w));
/**
 * A row's figure belongs to its own name: in a sentence with the name, and no
 * other name between them ("We use Jobber and pay QuickBooks 30 a month" gives
 * QuickBooks the 30, not Jobber).
 */
function tieGuard(name: string): (c: LineCtx, f: FigureAt) => string | null {
  const want = contentWords(name).map(stemOf);
  return (c, f) => {
    if (!want.length) return null;
    const r = c.read;
    const sentence = r.sentences.find((x) => f.start >= x.start && f.start < x.end) ?? { start: 0, end: r.s.length };
    const hits = r.words.filter((w) => w.start >= sentence.start && w.end <= sentence.end && stemOf(w.w) === want[0]);
    if (!hits.length) return "its figure is said apart from its name";
    const nearest = hits.reduce((a, w) => (Math.abs(w.start - f.start) < Math.abs(a.start - f.start) ? w : a));
    const [lo, hi] = nearest.start < f.start ? [nearest.end, f.start] : [f.end, nearest.start];
    const capped = capitalisedWords(c.line.text);
    const other = r.words.some((w) => w.start >= lo && w.end <= hi && capped.has(w.w) && !want.includes(stemOf(w.w)));
    return other ? "its figure belongs to another name in the call" : null;
  };
}
const columnKey = (k: string) => k.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
/** A table row as the model may give it (an object, an array in column order, or a bare name) as an object with the field's own column names. */
function rowObject(def: ProfileFieldDef, item: unknown): Record<string, string> | null {
  const cols = def.columns ?? [];
  const cell = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
  const out: Record<string, string> = {};
  if (typeof item === "string") {
    if (item.trim() && cols[0]) out[cols[0]] = item.trim();
  } else if (Array.isArray(item)) {
    cols.forEach((c, i) => {
      if (cell(item[i])) out[c] = cell(item[i]);
    });
  } else if (item && typeof item === "object") {
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      const col = cols.find((c) => columnKey(c) === columnKey(k));
      if (col && cell(v)) out[col] = cell(v);
    }
  } else return null;
  return Object.keys(out).length ? out : null;
}

/** Is the person a row names, where the text names them, never in a sentence with the row's task? */
function whoApart(who: string, task: string, ctx: readonly LineCtx[]): boolean {
  const w0 = contentWords(who)[0];
  const t0 = contentWords(task)[0];
  if (!w0 || !t0) return false;
  const [ws, ts] = [stemOf(w0), stemOf(t0)];
  for (const c of ctx) {
    if (c.host) continue;
    const r = c.read;
    if (!r.words.some((w) => stemOf(w.w) === ws)) continue;
    const together = r.sentences.some((x) => {
      const inside2 = r.words.filter((w) => w.start >= x.start && w.end <= x.end).map((w) => stemOf(w.w));
      return inside2.includes(ws) && inside2.includes(ts);
    });
    if (!together) return true;
  }
  return false;
}

/** One table row against its columns: names said as themselves, figures in their column's period, words from the call. */
function checkRow(def: ProfileFieldDef, item: unknown, ctx: readonly LineCtx[], stems: ReadonlySet<string>, said: readonly TranscriptLine[], around: string): ItemCheck {
  const row = rowObject(def, item);
  if (!row) return { ok: false, reason: "not a row of the table" };
  const name = row.tool ?? row.source ?? row.task ?? null;
  const guard = name ? tieGuard(name) : undefined;
  const prose: string[] = [];
  for (const [col, text] of Object.entries(row)) {
    const figures = numbersIn(text);
    const need = COLUMN_NEEDS[col];
    if (need) {
      for (const n of figures) {
        const fit = figureFits(need, n, ctx, around, guard);
        if (!fit.ok) return { ok: false, reason: `its ${col}: ${fit.reason}` };
      }
      if (!figures.length) prose.push(text);
      continue;
    }
    const unstated = proseWhy(text, ctx);
    if (unstated) return { ok: false, reason: `its ${col}: ${unstated}` };
    if (NAME_COLUMNS.has(col)) {
      if (!namedIn(text, stems)) return { ok: false, reason: `its ${col} is a name the call does not say` };
      if ((col === "tool" || looksProper(text)) && !writtenAsName(text, said)) return { ok: false, reason: col === "tool" ? "the call does not name it as a product" : "the call does not name it as a name" };
      if (negatedIn(text, ctx)) return { ok: false, reason: "the call says they do not use it, or no longer do" };
      continue;
    }
    // Who does it may be the speaker ("I do it myself"): the speakers' names count.
    if (col === "who") {
      if (contentWords(text).length && support(text, stems) < 0.5) return { ok: false, reason: "its who is not someone the call names" };
      const task = row.task ?? row.tool ?? null;
      if (task && whoApart(text, task, ctx)) return { ok: false, reason: "its who is named with another task in the call" };
      continue;
    }
    if (!figures.length) prose.push(text);
  }
  const why = prose.length ? wordsWhy(prose.join(" "), ctx, stems) : null;
  if (why) return { ok: false, reason: why };
  return { ok: true, value: row };
}

/** One list item: its figures said by the client, its words from the call, and not something the client said they do not do. */
function checkListItem(item: unknown, ctx: readonly LineCtx[], stems: ReadonlySet<string>): ItemCheck {
  if (typeof item !== "string" || !item.trim()) return { ok: false, reason: "not a line of the list" };
  const unstated = proseWhy(item, ctx);
  if (unstated) return { ok: false, reason: unstated };
  const words = wordsWhy(item, ctx, stems);
  if (words) return { ok: false, reason: words };
  if (negatedIn(item, ctx)) return { ok: false, reason: "the call says they do not, or no longer" };
  return { ok: true, value: item.trim() };
}

/** One fact against every check. Throws nothing the caller does not catch: a value that cannot be read is dropped. */
function checkOne(f: ExtractedFact, key: string, lines: readonly TranscriptLine[], range: { from: number; to: number }, hosts: ReadonlySet<string>): Checked {
  const def = profileFieldDef(key);
  if (!def) return { ok: false, reason: "not a profile field" };
  if (def.group === "consent") return { ok: false, reason: "consent is recorded by CC, never read from a transcript" };
  if (!Number.isInteger(f.from) || !Number.isInteger(f.to) || f.from < range.from || f.to > range.to || f.to < f.from) {
    return { ok: false, reason: "its line numbers are not in the part of the call that was read" };
  }
  const quote = f.quote.replace(DEFANGED, "$1").replace(/\s+/g, " ").trim();
  if (quote.length < 3 || quote.length > QUOTE_MAX_CHARS) return { ok: false, reason: "no usable quote" };
  if (scrubCredentials(quote).hits > 0) return { ok: false, reason: "its quote looked like a credential" };
  const valueText = JSON.stringify(f.value ?? null);
  if (valueText.length > 20_000) return { ok: false, reason: "its value is too long" };
  if (scrubCredentials(valueText).hits > 0) return { ok: false, reason: "its value looked like a credential" };
  if (!quoteInLines(lines, f.from, f.to, quote)) return { ok: false, reason: "its quote is not on the lines it names" };
  if (quote.split(" ").length < 3) return { ok: false, reason: "its quote is too short to show what was said" };

  // Who said it: the interviewer's own words, or a question nobody answered, are not the client's fact.
  const said = quoteSpan(lines, f.from, f.to, quote);
  const isHost = (speaker: string) => hosts.has(speakerKey(speaker));
  const speakers = [...new Set(said.map((l) => l.speaker).filter((x): x is string => !!x))];
  if (speakers.length && speakers.every(isHost)) return { ok: false, reason: "the interviewer said it, not the client" };
  if (!speakers.length && said.every((l) => /\?\s*$/.test(l.text))) return { ok: false, reason: "it was only asked, never answered" };
  const cover = quoteCover(said, quote);
  if (!cover) return { ok: false, reason: "its quote is not on the lines it names" };
  const ctx: LineCtx[] = said.map((l) => ({ line: l, host: !!l.speaker && isHost(l.speaker), read: readLine(l.text), cover: cover.get(l.n) ?? null }));
  // Words are weighed on the client's own lines of the quote, never the interviewer's ("CC: Do you use Jobber? / Dana: No.")
  // and never the whole range the model named (review of phase 2b, F4 and round 3).
  const clientSaid = said.filter((l) => !(l.speaker && isHost(l.speaker)));
  const confirmed = said.filter(
    (l, i) => !!l.speaker && isHost(l.speaker) && /\?\s*$/.test(l.text) && !!said[i + 1] && !(said[i + 1].speaker && isHost(said[i + 1].speaker as string)) && AFFIRM.test(baseText(said[i + 1].text)),
  );
  const theirs = [...clientSaid, ...confirmed];
  const stems = stemsOf(theirs);
  // The question a figure answers, for the words a field needs ("How fast do you get back to a lead? / Within 30 minutes").
  const first = said[0]?.n ?? f.from;
  const last = said[said.length - 1]?.n ?? f.to;
  const around = [...lines.filter((l) => l.n >= first - 2 && l.n < first), ...said.filter((l) => l.speaker && isHost(l.speaker))].map((l) => baseText(l.text)).join(" ");

  let value: unknown = f.value;
  let note: string | undefined;
  if (def.type === "number" || def.type === "money") {
    const n = typeof f.value === "number" ? f.value : Number(String(f.value ?? "").replace(/[$,%\s]/g, ""));
    if (!Number.isFinite(n)) return { ok: false, reason: NOT_STATED };
    // A hedge in the client's lines around the quote reaches back to it: "We get 40 a month. I'm not sure about that."
    const nearby = lines.filter((l) => l.n >= Math.min(f.from, first) && l.n <= Math.max(f.to, last + 1) && !(l.speaker && isHost(l.speaker)));
    if (nearby.some((l) => REFERRING_HEDGE.test(baseText(l.text)))) return { ok: false, reason: "the client was not sure of it" };
    const fit = figureFits(needOf(def), n, ctx, around);
    if (!fit.ok) return { ok: false, reason: fit.reason };
    value = n;
  } else if (def.type === "list" || def.type === "rows") {
    // Item by item: what the cited lines do not say goes, and the rest stays (review of phase 2b, H3).
    const items = Array.isArray(f.value) ? f.value : [];
    const reasons: string[] = [];
    const keptItems: unknown[] = [];
    for (const item of items) {
      const r = def.type === "rows" ? checkRow(def, item, ctx, stems, theirs, around) : checkListItem(item, ctx, stems);
      if (r.ok) keptItems.push(r.value);
      else reasons.push(r.reason);
    }
    if (!keptItems.length) return { ok: false, reason: reasons[0] ?? "none of it is in the call" };
    if (keptItems.length < items.length) note = `${items.length - keptItems.length} of ${items.length} item${items.length === 1 ? "" : "s"} not in the call's words`;
    value = keptItems;
  } else {
    const unstated = proseWhy(f.value, ctx);
    if (unstated) return { ok: false, reason: unstated };
    if (typeof f.value === "string") {
      for (const m of baseText(f.value).matchAll(MAGNITUDE)) if (!stems.has(stemOf(m[0]))) return { ok: false, reason: "its words are not what the call said" };
      if (support(f.value, stems) < 0.6) return { ok: false, reason: "its words are not what the call said" };
      // What they tried before is, by its nature, something they no longer do: "tried an answering service" is the fact,
      // while "never tried" or "want to try" still refuses it.
      if (!NEGATION.test(baseText(f.value)) && negatedIn(f.value, ctx, { history: key === "decision.past_attempts" })) return { ok: false, reason: "the call says they do not, or no longer" };
    }
  }
  const v = validateProfileField({ field_key: key, value, label: "client_reported", source_type: "transcript" });
  if (!v.ok) return { ok: false, reason: `the value is not ${v.error}` };
  return { ok: true, fact: { key, value: v.value.value, from: f.from, to: f.to, quote, speakers }, note };
}

/** A model-made field key as it may be stored with a dropped fact: short, and scrubbed. */
function keyForList(key: string): string {
  return scrubCredentials(key.replace(/\s+/g, " ").slice(0, 80)).text || "(no key)";
}

/**
 * Keep the facts that pass every check for one window; list the rest with the
 * reason. `lines` is the whole transcript (quotes are checked on it), `range`
 * the window that was read.
 */
export function checkFacts(
  answer: ExtractionAnswer,
  lines: readonly TranscriptLine[],
  range: { from: number; to: number },
  opts: CheckOptions = {},
): { kept: KeptFact[]; dropped: DroppedFact[] } {
  const hosts = hostsFor(lines, opts);
  const kept: KeptFact[] = [];
  const dropped: DroppedFact[] = [];
  const seen = new Set<string>();
  for (const f of answer.facts) {
    const key = f.key.trim();
    let r: Checked;
    try {
      r = checkOne(f, key, lines, range, hosts);
    } catch {
      // A value nested past what can be read (a RangeError) is a dropped fact, never a failed run (review of phase 2b, M3).
      r = { ok: false, reason: "its value could not be read" };
    }
    if (!r.ok) {
      // The key is the model's text: capped and scrubbed before it is stored (review of phase 2b).
      dropped.push({ key: keyForList(key), reason: r.reason });
      continue;
    }
    if (r.note) dropped.push({ key, reason: r.note });
    if (seen.has(key)) {
      // Two facts for one field in one window: the first, by line, stands; a different second is for mergeFacts to weigh.
      const first = kept.find((k) => k.key === key);
      if (first && JSON.stringify(first.value) !== JSON.stringify(r.fact.value)) kept.push(r.fact);
      continue;
    }
    seen.add(key);
    kept.push(r.fact);
  }
  return { kept, dropped };
}

/** A prior value a newer read of the call may replace: one an earlier extraction wrote and nobody has touched since. */
function replaceable(prior: PriorField): boolean {
  return prior.source_type === "transcript" && (prior.label ?? "client_reported") === "client_reported" && !prior.verified_note && !prior.owner_corrected;
}

/** Lists and tables read in different parts of the call add up: one union, first mention first, no repeats, within the field's limit. */
function unionOf(def: ProfileFieldDef, values: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const v of values) {
    for (const item of Array.isArray(v) ? v : []) {
      const k = typeof item === "string" ? item.toLowerCase().trim() : JSON.stringify(item).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
  }
  return out.slice(0, def.type === "rows" ? 30 : 30);
}

/**
 * All windows together. One value per field is written; a field with two
 * different values is a contradiction and is not written. Lists and tables
 * add up instead. `existing` is what the profile already holds: only a value
 * an earlier extraction wrote, still Client-reported, unverified and
 * uncorrected, is replaced; anything else that differs is a contradiction to
 * show CC, never an overwrite (review of phase 2b, H2).
 */
export function mergeFacts(
  perWindow: ReadonlyArray<readonly KeptFact[]>,
  existing: ReadonlyMap<string, PriorField>,
): { write: KeptFact[]; contradictions: Contradiction[]; alreadyKnown: string[] } {
  const byKey = new Map<string, KeptFact[]>();
  for (const w of perWindow) for (const f of w) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
  const write: KeptFact[] = [];
  const contradictions: Contradiction[] = [];
  const alreadyKnown: string[] = [];
  const cite = (f: KeptFact) => ({ value: f.value, from: f.from, to: f.to, quote: f.quote, transcript_id: f.transcript_id ?? null, source: "transcript" as const });
  for (const [key, facts] of byKey) {
    const def = profileFieldDef(key);
    const sorted = [...facts].sort((a, b) => a.from - b.from);
    let only: KeptFact;
    if (def && (def.type === "list" || def.type === "rows")) {
      const union = unionOf(def, sorted.map((f) => f.value));
      const v = validateProfileField({ field_key: key, value: union, label: "client_reported", source_type: "transcript" });
      const seen = new Set<string>();
      const sources = sorted
        .map((f) => ({ transcript_id: f.transcript_id ?? null, from: f.from, to: f.to }))
        .filter((x) => {
          const k = `${x.transcript_id}:${x.from}:${x.to}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      only = { ...(v.ok ? { ...sorted[0], value: v.value.value } : sorted[0]), sources };
    } else {
      const distinct = new Map<string, KeptFact>();
      for (const f of sorted) {
        const k = JSON.stringify(f.value);
        if (!distinct.has(k)) distinct.set(k, f);
      }
      if (distinct.size > 1) {
        contradictions.push({ key, values: [...distinct.values()].map(cite) });
        continue;
      }
      only = [...distinct.values()][0];
    }
    const prior = existing.get(key);
    if (prior) {
      if (JSON.stringify(prior.value) === JSON.stringify(only.value)) alreadyKnown.push(key);
      else if (replaceable(prior)) write.push(only);
      else contradictions.push({ key, values: [{ value: prior.value, from: 0, to: 0, quote: null, transcript_id: null, source: "profile" }, cite(only)] });
      continue;
    }
    write.push(only);
  }
  return { write, contradictions, alreadyKnown };
}

/** Several windows' summaries as one, without repeats. */
export function mergeSummaries(parts: readonly ExtractionSummary[]): ExtractionSummary {
  const out: ExtractionSummary = { goals: [], problems: [], commitments: [], open_questions: [] };
  for (const k of Object.keys(out) as Array<keyof ExtractionSummary>) {
    const seen = new Set<string>();
    for (const p of parts) {
      for (const item of p[k]) {
        const norm = item.toLowerCase();
        if (seen.has(norm) || out[k].length >= SUMMARY_ITEMS_MAX * 2) continue;
        seen.add(norm);
        out[k].push(item);
      }
    }
  }
  return out;
}
