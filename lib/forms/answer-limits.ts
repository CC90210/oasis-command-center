/**
 * lib/forms/answer-limits.ts - how long a public form's answers may be.
 *
 * Nothing used to hold an answer to a length on the server, so a submitted answer
 * was bounded only by the platform's request limit, and the support form stored
 * whatever object it was sent. The limits, and what happens past them (the
 * submit route and the support-form intake both apply them):
 *
 *   an answer in a text box   a field's own `maxLength` when its definition has
 *                             one (the box's `maxlength` attribute already stops
 *                             a browser at it), else 10,000 characters: twice
 *                             the largest limit any seeded form declares (5,000).
 *                             A `maxLength` above 100,000 is held to 100,000, so
 *                             a definition cannot switch the limit off.
 *   a signature               2 MiB. A signature is a PNG data address: 30 to 41
 *                             thousand characters normally, 370 thousand for a
 *                             heavy one, 1.5 million for a scribble over the
 *                             whole pad (measured), so a flat text limit would
 *                             refuse every e-signature.
 *   a value that is not text  100,000 characters once written as JSON, an inline
 *                             file's bytes (its own rules, in the submit route)
 *                             not counted. Such a value is a file's descriptor or
 *                             a list of choices; nothing real comes near.
 *   a payload                 200 keys (or twice the step's fields, if that is
 *                             more) of 128 characters at most. The largest seeded
 *                             step has 10 fields and the largest form 30; a
 *                             field's name is 63 characters at most.
 *
 * AN ANSWER OVER ITS LIMIT IS CUT, NOT REFUSED. A person who pasted an essay into
 * a box keeps their lead: their contact fields and the first part of the answer
 * go through. An answer cut to the default limit ends with a note saying so,
 * where whoever reads it will see it (a lead, an email and the application PDF
 * all show the answer as stored); an answer cut to its field's own limit is cut
 * the way the browser's `maxlength` would have. The route logs each cut by field
 * and length, never by content.
 *
 * What cannot be cut is refused, naming the field, with nothing written: a
 * signature (half a PNG is nothing), and a value that is not text.
 */
import type { FormField } from "@/lib/forms/types";

export const ANSWER_LIMITS = {
  /** An answer in a text box whose field declares no `maxLength`. */
  textChars: 10_000,
  /** The most a declared `maxLength` is believed. */
  declaredCeilingChars: 100_000,
  /** A signature's PNG data address. */
  signatureChars: 2 * 1024 * 1024,
  /** A value that is not text, written as JSON (an inline file's bytes left out). */
  compoundChars: 100_000,
  /** Keys in one step's payload, or twice the step's fields if that is more. */
  minKeys: 200,
  /** A key's length; a declared field name is 63 at most. */
  keyChars: 128,
} as const;

type FieldDef = Pick<FormField, "name" | "type" | "label" | "maxLength">;

export type AnswerCut = { field: string; chars: number; limit: number };

export type AnswerRefusal =
  | { kind: "invalid_answers"; detail: string }
  | { kind: "answer_too_large"; field: string; label: string; signature: boolean; chars: number; limit: number };

export type BoundedAnswers = { cuts: AnswerCut[]; refusal: AnswerRefusal | null };

/** A field's own limit, if its definition has a believable one. */
function declaredLimit(maxLength: unknown): number | null {
  if (typeof maxLength !== "number" || !Number.isFinite(maxLength)) return null;
  const whole = Math.floor(maxLength);
  return whole >= 1 ? Math.min(whole, ANSWER_LIMITS.declaredCeilingChars) : null;
}

const withCommas = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** `value` cut to `limit` characters in all; with the note, the note is inside the limit. */
function cutText(value: string, limit: number, withNote: boolean): string {
  const note = ` [cut: this answer was longer than ${withCommas(limit)} characters]`;
  // A limit too small for its own note is cut plain, as a browser would.
  const noted = withNote && limit > note.length * 2;
  const kept = noted ? limit - note.length : limit;
  // Never leave half of an emoji (a surrogate pair) at the cut.
  const last = value.charCodeAt(kept - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? kept - 1 : kept;
  return value.slice(0, end) + (noted ? note : "");
}

/** How much of a value counts against its limit: all of it, but an inline file's bytes. */
function weightOf(value: object): number {
  const inline = (value as { inline_base64?: unknown }).inline_base64;
  return JSON.stringify(typeof inline === "string" ? { ...value, inline_base64: "" } : value).length;
}

/**
 * Hold one step's answers to their limits. Answers over a limit are cut IN
 * PLACE (`payload` is the request's own object, and everything after reads it),
 * and listed in `cuts`; a payload or an answer that cannot be cut is `refusal`,
 * and nothing in `payload` is to be used then.
 */
export function boundAnswers(payload: Record<string, unknown>, fields: readonly FieldDef[]): BoundedAnswers {
  const keys = Object.keys(payload);
  const maxKeys = Math.max(ANSWER_LIMITS.minKeys, fields.length * 2);
  if (keys.length > maxKeys) {
    return { cuts: [], refusal: { kind: "invalid_answers", detail: `${keys.length} keys, at most ${maxKeys}` } };
  }
  const longKey = keys.find((k) => k.length > ANSWER_LIMITS.keyChars);
  if (longKey !== undefined) {
    return { cuts: [], refusal: { kind: "invalid_answers", detail: `a key of ${longKey.length} characters, at most ${ANSWER_LIMITS.keyChars}` } };
  }
  // The last of a repeated name is the field, as in the route's own file rules.
  const byName = new Map(fields.map((f) => [f.name, f]));
  const cuts: AnswerCut[] = [];
  const tooLarge = (key: string, def: FieldDef | undefined, chars: number, limit: number): BoundedAnswers => ({
    cuts,
    refusal: { kind: "answer_too_large", field: key, label: def?.label?.trim() || "This answer", signature: def?.type === "signature", chars, limit },
  });
  for (const key of keys) {
    const value = payload[key];
    const def = byName.get(key);
    if (typeof value === "string") {
      if (def?.type === "signature") {
        if (value.length > ANSWER_LIMITS.signatureChars) return tooLarge(key, def, value.length, ANSWER_LIMITS.signatureChars);
        continue;
      }
      const declared = declaredLimit(def?.maxLength);
      const limit = declared ?? ANSWER_LIMITS.textChars;
      if (value.length <= limit) continue;
      payload[key] = cutText(value, limit, declared === null);
      cuts.push({ field: key, chars: value.length, limit });
    } else if (value !== null && typeof value === "object") {
      const weight = weightOf(value);
      if (weight > ANSWER_LIMITS.compoundChars) return tooLarge(key, def, weight, ANSWER_LIMITS.compoundChars);
    }
  }
  return { cuts, refusal: null };
}

/** What the visitor is told about an answer that is too large to send: which one, and what to do. */
function answerTooLargeSentence(refusal: Extract<AnswerRefusal, { kind: "answer_too_large" }>): string {
  return refusal.signature
    ? `${refusal.label}: that signature is too detailed to send. Please clear it and sign again.`
    : `${refusal.label}: that is too large to send. Please shorten it and try again.`;
}

/**
 * What a refusal is answered with, for every route that takes a public form's
 * answers (the submit route and the support-form intake), so the two cannot
 * drift: the status, the stable code, and for one answer its field and a
 * sentence. Both codes have a sentence in components/forms/FormPublicClient.tsx.
 */
export function answerRefusal(refusal: AnswerRefusal): { status: 400 | 413; error: string; extra: Record<string, string> } {
  if (refusal.kind === "invalid_answers") return { status: 400, error: "invalid_answers", extra: {} };
  return { status: 413, error: "answer_too_large", extra: { field: refusal.field, message: answerTooLargeSentence(refusal) } };
}
