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
 *     them (quoteInLines);
 *   - a figure's quote states a figure (a number the client never said is not
 *     a fact);
 *   - the quote carries nothing credential-like.
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

export type KeptFact = { key: string; value: ProfileValue; from: number; to: number; quote: string };
export type DroppedFact = { key: string; reason: string };
export type Contradiction = { key: string; values: Array<{ value: unknown; from: number; to: number; source: "transcript" | "profile" }> };

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
    `Business: ${input.businessName.replace(/[\r\n]+/g, " ").slice(0, 200)}`,
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

const ONES: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Readonly<Record<string, number>> = { hundred: 100, thousand: 1_000, grand: 1_000, million: 1_000_000 };
const SPECIAL: Readonly<Record<string, number>> = { dozen: 12, half: 0.5, quarter: 0.25, couple: 2 };

/**
 * Every figure a quote states: digits ("1,200", "2.5", "$40k", "30%") and
 * number words ("forty five", "two thousand", "a dozen", "half"). A fact's
 * figure must be one of these: "maybe half" cannot carry $2,000.
 */
export function numbersIn(quote: string): number[] {
  const out: number[] = [];
  const text = quote.toLowerCase();
  for (const m of text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(k|m)?\b/g)) {
    let n = Number(`${m[1].replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`);
    if (m[3] === "k") n *= 1_000;
    if (m[3] === "m") n *= 1_000_000;
    if (Number.isFinite(n)) out.push(n);
  }
  const words = text.replace(/-/g, " ").split(/[^a-z]+/).filter(Boolean);
  let current = 0;
  let total = 0;
  let inNumber = false;
  const flush = () => {
    if (inNumber) out.push(total + current);
    current = 0;
    total = 0;
    inNumber = false;
  };
  for (const w of words) {
    if (w in ONES) {
      current += ONES[w];
      inNumber = true;
    } else if (w in TENS) {
      current += TENS[w];
      inNumber = true;
    } else if (w in SCALES) {
      const scale = SCALES[w];
      if (scale === 100) current = (current || 1) * 100;
      else {
        total += (current || 1) * scale;
        current = 0;
      }
      inNumber = true;
    } else if (w in SPECIAL) {
      flush();
      out.push(SPECIAL[w]);
    } else if (w === "and" && inNumber) {
      continue;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** Is `value` a figure the quote states? A percentage may be said as a fraction ("half" is 50%). */
function statedInQuote(value: number, quote: string, unit: string | undefined): boolean {
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);
  return numbersIn(quote).some((n) => near(value, n) || (unit === "%" && n > 0 && n <= 1 && near(value, n * 100)));
}

/** Every number written in a value (a row's cost, a list item's count). */
function numbersInValue(value: unknown): number[] {
  return numbersIn(JSON.stringify(value ?? "").replace(/[{}[\]":]/g, " "));
}

/**
 * Keep the facts that pass every check for one window; list the rest with the
 * reason. `lines` is the whole transcript (quotes are checked on it), `range`
 * the window that was read.
 */
export function checkFacts(answer: ExtractionAnswer, lines: readonly TranscriptLine[], range: { from: number; to: number }): { kept: KeptFact[]; dropped: DroppedFact[] } {
  const kept: KeptFact[] = [];
  const dropped: DroppedFact[] = [];
  const seen = new Set<string>();
  for (const f of answer.facts) {
    const key = f.key.trim();
    const def = profileFieldDef(key);
    if (!def) {
      dropped.push({ key: key || "(no key)", reason: "not a profile field" });
      continue;
    }
    if (def.group === "consent") {
      dropped.push({ key, reason: "consent is recorded by CC, never read from a transcript" });
      continue;
    }
    if (!Number.isInteger(f.from) || !Number.isInteger(f.to) || f.from < range.from || f.to > range.to || f.to < f.from) {
      dropped.push({ key, reason: "its line numbers are not in the part of the call that was read" });
      continue;
    }
    const quote = f.quote.replace(/\s+/g, " ").trim();
    if (quote.length < 3 || quote.length > QUOTE_MAX_CHARS) {
      dropped.push({ key, reason: "no usable quote" });
      continue;
    }
    if (scrubCredentials(quote).hits > 0) {
      dropped.push({ key, reason: "its quote looked like a credential" });
      continue;
    }
    if (!quoteInLines(lines, f.from, f.to, quote)) {
      dropped.push({ key, reason: "its quote is not on the lines it names" });
      continue;
    }
    // A figure anywhere in the value (a number, a cost in a row, a count in a list) must be one the quote states.
    if (def.type === "number" || def.type === "money") {
      const n = typeof f.value === "number" ? f.value : Number(String(f.value ?? "").replace(/[$,\s]/g, ""));
      if (!Number.isFinite(n) || !statedInQuote(n, quote, def.unit)) {
        dropped.push({ key, reason: "a figure the quote does not state" });
        continue;
      }
    } else {
      const unstated = numbersInValue(f.value).filter((n) => !statedInQuote(n, quote, undefined));
      if (unstated.length) {
        dropped.push({ key, reason: "a figure the quote does not state" });
        continue;
      }
    }
    const v = validateProfileField({ field_key: key, value: f.value, label: "client_reported", source_type: "transcript" });
    if (!v.ok) {
      dropped.push({ key, reason: `the value is not ${v.error}` });
      continue;
    }
    if (seen.has(key)) {
      // Two facts for one field in one window: the first, by line, stands; a different second is a contradiction for mergeFacts.
      const first = kept.find((k) => k.key === key);
      if (first && JSON.stringify(first.value) !== JSON.stringify(v.value.value)) kept.push({ key, value: v.value.value, from: f.from, to: f.to, quote });
      continue;
    }
    seen.add(key);
    kept.push({ key, value: v.value.value, from: f.from, to: f.to, quote });
  }
  return { kept, dropped };
}

/**
 * All windows together. One value per field is written; a field with two
 * different values is a contradiction and is not written. `existing` is what
 * the profile already holds (CC's own entries win: a transcript value that
 * differs from one is a contradiction to show, never an overwrite).
 */
export function mergeFacts(
  perWindow: ReadonlyArray<readonly KeptFact[]>,
  existing: ReadonlyMap<string, { value: unknown; source_type: string }>,
): { write: KeptFact[]; contradictions: Contradiction[]; alreadyKnown: string[] } {
  const byKey = new Map<string, KeptFact[]>();
  for (const w of perWindow) for (const f of w) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
  const write: KeptFact[] = [];
  const contradictions: Contradiction[] = [];
  const alreadyKnown: string[] = [];
  for (const [key, facts] of byKey) {
    const distinct = new Map<string, KeptFact>();
    for (const f of facts.sort((a, b) => a.from - b.from)) {
      const k = JSON.stringify(f.value);
      if (!distinct.has(k)) distinct.set(k, f);
    }
    const prior = existing.get(key);
    if (distinct.size > 1) {
      contradictions.push({ key, values: [...distinct.values()].map((f) => ({ value: f.value, from: f.from, to: f.to, source: "transcript" as const })) });
      continue;
    }
    const only = [...distinct.values()][0];
    if (prior) {
      if (JSON.stringify(prior.value) === JSON.stringify(only.value)) {
        alreadyKnown.push(key);
      } else if (prior.source_type === "transcript") {
        // A value an earlier extraction wrote: the newer read of the same call replaces it.
        write.push(only);
      } else {
        contradictions.push({ key, values: [{ value: prior.value, from: 0, to: 0, source: "profile" }, { value: only.value, from: only.from, to: only.to, source: "transcript" }] });
      }
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
