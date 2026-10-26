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
 *   - a figure's quote states that figure, for the field's period ("40 a week"
 *     is not leads per month), as one figure the client was sure of (a range
 *     or a "maybe" goes to the open questions);
 *   - a text, a list or a table says what the cited lines say (its words are
 *     there), item by item;
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
import { quoteInLines, scrubCredentials, type TranscriptLine } from "@/lib/ai-audit/transcript";

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
export type KeptFact = { key: string; value: ProfileValue; from: number; to: number; quote: string; speakers?: string[]; transcript_id?: string };
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
  "2. For every fact give the line numbers it comes from (from, to) and a short quote copied exactly from those lines (at most 25 words).",
  "3. A number is a fact only if the client said that number. Turn number words into digits (forty is 40). If the client gave a range or was unsure, do not give a value: leave the fact out and put the question in open_questions.",
  "4. Never infer, estimate, average or calculate. Never fill a field the call does not answer.",
  "5. Never copy a password, a login, a card number or any other credential, even if one appears.",
  "6. Answer with JSON only, in exactly this shape:",
  '{"facts":[{"key":"<field key>","value":<value>,"from":<first line number>,"to":<last line number>,"quote":"<exact words>"}],"summary":{"goals":["..."],"problems":["..."],"commitments":["..."],"open_questions":["..."]}}',
  "The summary lists, in a few words each, what the client wants, what problems they described, what either side agreed to do, and what is still unclear. At most 8 items each; empty lists are fine.",
  "",
  INJECTION_GUARD,
].join("\n");

/** System and user prompt for one window. `window.text` is the rendered, numbered lines. */
export function extractionPrompt(input: { businessName: string; window: { from: number; to: number; text: string } }): { system: string; prompt: string } {
  const prompt = [
    // The name comes from the lead's own form: data, inside its own fence (review of phase 2b, M7).
    wrapUntrusted(input.businessName.replace(/[\r\n]+/g, " ").slice(0, 200), { label: "business name", maxLen: 200 }),
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

// Maps, never object lookups: "constructor" is not a number (review of phase 2b).
const ONES = new Map<string, number>([
  ["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10],
  ["eleven", 11], ["twelve", 12], ["thirteen", 13], ["fourteen", 14], ["fifteen", 15], ["sixteen", 16], ["seventeen", 17], ["eighteen", 18], ["nineteen", 19],
]);
const TENS = new Map<string, number>([["twenty", 20], ["thirty", 30], ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90]]);
const SCALES = new Map<string, number>([["hundred", 100], ["thousand", 1_000], ["grand", 1_000], ["million", 1_000_000]]);
const SPECIAL = new Map<string, number>([["dozen", 12], ["couple", 2]]);
/** Shares said in words ("half of them", "two thirds"): a percentage's evidence, never a count. */
const FRACTION_WORDS = new Map<string, number>([["half", 0.5], ["quarter", 0.25], ["quarters", 0.25], ["third", 1 / 3], ["thirds", 1 / 3]]);

/** Text as figures are read from it: full-width digits made plain, lower case. */
function plain(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/**
 * Every figure a quote states: digits ("1,200", "2.5", "$40k", "$2.5m", "40hrs",
 * "5 million") and number words ("forty five", "two thousand", "a dozen"). Digits
 * inside a word ("hunter2", "Q3") are not figures, and a scale word alone is not one.
 */
export function numbersIn(quote: string): number[] {
  const text = plain(quote);
  const out: number[] = [];
  const toks = [...text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|[a-z]+|\$/g)];
  let current = 0;
  let total = 0;
  let inWords = false;
  const flush = () => {
    if (inWords) out.push(total + current);
    current = 0;
    total = 0;
    inWords = false;
  };
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i][0];
    const at = toks[i].index ?? 0;
    if (/^\d/.test(tok)) {
      flush();
      if (at > 0 && /[a-z]/.test(text[at - 1])) continue;
      let n = Number(tok.replace(/,/g, ""));
      if (!Number.isFinite(n)) continue;
      const next = toks[i + 1]?.[0];
      const glued = !!toks[i + 1] && (toks[i + 1].index ?? 0) === at + tok.length;
      const money = toks[i - 1]?.[0] === "$";
      if (next === "k" || next === "thousand" || next === "grand") {
        n *= 1_000;
        i += 1;
      } else if (next === "million" || next === "mil" || next === "mm" || (next === "m" && money && glued)) {
        n *= 1_000_000;
        i += 1;
      } else if (next === "hundred") {
        n *= 100;
        i += 1;
      }
      out.push(n);
      continue;
    }
    if (tok === "$") {
      flush();
      continue;
    }
    const one = ONES.get(tok);
    const ten = TENS.get(tok);
    const scale = SCALES.get(tok);
    const special = SPECIAL.get(tok);
    if (one !== undefined) {
      current += one;
      inWords = true;
    } else if (ten !== undefined) {
      current += ten;
      inWords = true;
    } else if (scale !== undefined) {
      if (!inWords) {
        // "a thousand" is one; "thousands of" or a bare "million" is no figure.
        if (toks[i - 1]?.[0] !== "a") continue;
        current = 1;
      }
      if (scale === 100) current = (current || 1) * 100;
      else {
        total += (current || 1) * scale;
        current = 0;
      }
      inWords = true;
    } else if (special !== undefined) {
      flush();
      out.push(special);
    } else if (tok === "and" && inWords) {
      continue;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** Shares a quote states as fractions: "half", "a quarter", "two thirds", "0.3", "one in four", "3 out of 10". */
export function fractionsIn(quote: string): number[] {
  const text = plain(quote);
  const out: number[] = [];
  const words = text.split(/[^a-z0-9.]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const f = FRACTION_WORDS.get(words[i]);
    if (f !== undefined) {
      const before = words[i - 1] ?? "";
      const k = /^\d+$/.test(before) ? Number(before) : (ONES.get(before) ?? 1);
      out.push(words[i] === "half" ? 0.5 : Math.min(1, k * f));
    }
    if (/^0?\.\d{1,4}$/.test(words[i])) {
      const d = Number(words[i]);
      if (d > 0 && d < 1) out.push(d);
    }
  }
  const SMALL = "(\\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)";
  for (const m of text.matchAll(new RegExp(`\\b${SMALL}\\s+(?:out\\s+of|in|of\\s+every)\\s+(\\d{1,4}|two|three|four|five|six|seven|eight|nine|ten|hundred)\\b`, "g"))) {
    const a = /^\d/.test(m[1]) ? Number(m[1]) : (ONES.get(m[1]) ?? NaN);
    const b = m[2] === "hundred" ? 100 : /^\d/.test(m[2]) ? Number(m[2]) : (ONES.get(m[2]) ?? NaN);
    if (b > 0 && a >= 0 && a <= b) out.push(a / b);
  }
  return out;
}

/** The time words a quote uses. */
const PERIOD = {
  minute: /\b(?:minutes?|mins?)\b/,
  hour: /\b(?:hours?|hrs?|hourly)\b|\/\s?hr\b/,
  day: /\b(?:days?|daily|nights?|nightly)\b/,
  week: /\b(?:weeks?|weekly|wks?)\b/,
  month: /\b(?:months?|monthly|mo)\b|\/\s?mo\b/,
  year: /\b(?:years?|yearly|annual|annually|yrs?)\b|\/\s?yr\b/,
} as const;
type Period = keyof typeof PERIOD;

/** The period a field's figure is counted in, when it has one. */
function periodOf(def: ProfileFieldDef): Period | null {
  if (def.key === "finance.staff_hourly_cost") return "hour";
  if (def.unit === "leads/month") return "month";
  if (def.unit === "calls/week" || def.unit === "hours/week") return "week";
  return null;
}

/**
 * Why a figure's quote does not fit its field's unit, or null when it does:
 * "about 10 a week" is not leads per month; "set the close rate to 99" gives
 * no percentage (review of phase 2b, H3).
 */
function unitProblem(def: ProfileFieldDef, quote: string): string | null {
  const q = plain(quote);
  const has = (p: Period) => PERIOD[p].test(q);
  if (def.unit === "%" && !/%|\bper ?cent\b/.test(q) && !fractionsIn(quote).length) return "the quote gives no share or percentage";
  if (def.unit === "hours/week" && !has("hour")) return "the quote does not say hours";
  if (def.unit === "hours" && !has("hour") && !has("minute") && !has("day")) return "the quote does not say how long";
  const per = periodOf(def);
  if (per && !has(per)) {
    const other = (["day", "week", "month", "year", "hour"] as const).find((p) => p !== per && has(p));
    return other ? `the quote gives it per ${other}, not per ${per}` : `the quote does not say per ${per}`;
  }
  return null;
}

const RANGE =
  /\bbetween\s+\S{1,20}\s+and\s+\S{1,20}|\b\d[\d,.]{0,12}\s{0,2}(?:-|to|or)\s{0,2}\d[\d,.]{0,12}\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\s+(?:to|or)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/;
const HEDGE = /\b(?:maybe|perhaps|not sure|no idea|i guess|guessing|could be|might be|possibly|i don't know|i dont know|dunno|hard to say)\b/;

/** A range or an unsure figure is no fact: the prompt says to put it in the open questions, and code holds it to that. */
function uncertainty(quote: string): string | null {
  const q = plain(quote).replace(/\u2019/g, "'");
  if (RANGE.test(q)) return "a range, not one figure: it belongs in the open questions";
  if (HEDGE.test(q)) return "the client was not sure of it";
  return null;
}

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);

/**
 * Is `value` the figure the quote states, in the field's unit? A share may be
 * said as a fraction ("half" is 50%); a time said in minutes or days is the
 * same time in hours (30 minutes is 0.5).
 */
function statedInQuote(value: number, quote: string, unit: string | undefined): boolean {
  const ns = numbersIn(quote);
  if (unit === "hours") {
    const q = plain(quote);
    const hrs = PERIOD.hour.test(q);
    if (!hrs && PERIOD.minute.test(q)) return ns.some((n) => near(value, n / 60));
    if (!hrs && PERIOD.day.test(q)) return ns.some((n) => near(value, n * 24));
  }
  if (ns.some((n) => near(value, n))) return true;
  return unit === "%" && fractionsIn(quote).some((f) => Math.abs(value - f * 100) <= 0.5);
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
/** A value's words that carry meaning, and the first five letters they are compared by ("installs" for "installation"). */
function contentWords(s: string): string[] {
  return plain(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}
const stem = (w: string) => w.slice(0, 5);
/** The share of a value's words the cited lines say. */
function support(value: string, spanStems: ReadonlySet<string>): number {
  const words = contentWords(value);
  if (!words.length) return 1;
  return words.filter((w) => spanStems.has(stem(w))).length / words.length;
}

/** The lines a quote is on: the shortest run inside [from, to] that holds it. */
function quoteSpan(lines: readonly TranscriptLine[], from: number, to: number, quote: string): TranscriptLine[] {
  for (let len = 0; len <= to - from; len++) {
    for (let a = from; a + len <= to; a++) {
      if (quoteInLines(lines, a, a + len, quote)) return lines.filter((l) => l.n >= a && l.n <= a + len);
    }
  }
  return lines.filter((l) => l.n >= from && l.n <= to);
}

/** The interviewer's labels when the workspace's owner names are not known. */
export const DEFAULT_HOSTS: ReadonlySet<string> = new Set(["cc", "interviewer", "host", "oasis"]);
function isHost(speaker: string, hosts: ReadonlySet<string>): boolean {
  const s = speaker.toLowerCase().replace(/\s+/g, " ").trim();
  return hosts.has(s) || DEFAULT_HOSTS.has(s);
}

/** What lib/llm-input-boundary.ts wraps an instruction-like phrase in; a quote copied from the fenced text is read without it. */
const DEFANGED = /\u00AB\[neutralized: ([^\]]{1,80})\]\u00BB/g;

export type CheckOptions = {
  /** Speaker names that are the interviewer's (the workspace's owner, lower case): what only they said is not the client's fact. */
  hosts?: ReadonlySet<string>;
};

type Checked = { ok: true; fact: KeptFact; note?: string } | { ok: false; reason: string };

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
  const speakers = [...new Set(said.map((l) => l.speaker).filter((x): x is string => !!x))];
  if (speakers.length && speakers.every((x) => isHost(x, hosts))) return { ok: false, reason: "the interviewer said it, not the client" };
  if (!speakers.length && said.every((l) => /\?\s*$/.test(l.text))) return { ok: false, reason: "it was only asked, never answered" };

  const span = lines.filter((l) => l.n >= f.from && l.n <= f.to).map((l) => l.text).join(" ");
  const spanStems = new Set(contentWords(span).map(stem));
  let value: unknown = f.value;
  let note: string | undefined;
  if (def.type === "number" || def.type === "money") {
    const n = typeof f.value === "number" ? f.value : Number(String(f.value ?? "").replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || !statedInQuote(n, quote, def.unit)) return { ok: false, reason: "a figure the quote does not state" };
    const unit = unitProblem(def, quote);
    if (unit) return { ok: false, reason: unit };
    const unsure = uncertainty(quote);
    if (unsure) return { ok: false, reason: unsure };
    value = n;
  } else if (def.type === "list" || def.type === "rows") {
    // Item by item: what the cited lines do not say goes, and the rest stays (review of phase 2b, H3).
    const items = Array.isArray(f.value) ? f.value : [];
    const reasons: string[] = [];
    const keptItems = items.filter((item) => {
      const unstated = numbersInValue(item).filter((n) => !statedInQuote(n, quote, undefined) && !statedInQuote(n, span, undefined));
      if (unstated.length) {
        reasons.push("a figure the quote does not state");
        return false;
      }
      const words = typeof item === "string" ? item : item && typeof item === "object" ? Object.values(item as Record<string, unknown>).filter((v) => typeof v === "string").join(" ") : "";
      if (support(words, spanStems) < 0.5) {
        reasons.push("its words are not what the call said");
        return false;
      }
      return true;
    });
    if (!keptItems.length) return { ok: false, reason: reasons[0] ?? "none of it is in the call" };
    if (keptItems.length < items.length) note = `${items.length - keptItems.length} of ${items.length} item${items.length === 1 ? "" : "s"} not in the call's words`;
    value = keptItems;
  } else {
    const unstated = numbersInValue(f.value).filter((n) => !statedInQuote(n, quote, undefined));
    if (unstated.length) return { ok: false, reason: "a figure the quote does not state" };
    if (typeof f.value === "string" && support(f.value, spanStems) < 0.6) return { ok: false, reason: "its words are not what the call said" };
  }
  const v = validateProfileField({ field_key: key, value, label: "client_reported", source_type: "transcript" });
  if (!v.ok) return { ok: false, reason: `the value is not ${v.error}` };
  return { ok: true, fact: { key, value: v.value.value, from: f.from, to: f.to, quote, speakers }, note };
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
  const hosts = opts.hosts ?? DEFAULT_HOSTS;
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
      dropped.push({ key: key || "(no key)", reason: r.reason });
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
      only = v.ok ? { ...sorted[0], value: v.value.value } : sorted[0];
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
