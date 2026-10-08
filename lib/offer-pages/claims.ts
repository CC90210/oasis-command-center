/**
 * lib/offer-pages/claims.ts - the claims gate (design section 3.5).
 *
 * A sales page makes claims, and a claim nobody can back is a legal problem
 * (Canada's Competition Act and its testimonial rules; the FTC's if the US is
 * targeted). So Publish answers 409 with a plain list of what blocks it until:
 *
 *   1. every result has evidence, the client's permission and an owner's
 *      confirmation (the parser refuses one without; checked again here);
 *   2. every bonus value or price was confirmed by an owner;
 *   3. the guarantee, if it has words, was confirmed by an owner;
 *   4. every sentence the linter flags carries an owner's tick, "true, and we
 *      can back it". Ticks are stored by the sentence's sha256, so editing the
 *      sentence clears its tick;
 *   5. every video carries its rights confirmation;
 *   6. the page has a headline, and the form (the Book section) is switched on.
 *
 * THE LINTER flags a sentence that carries money, a number (digits or a number
 * word), a percentage, a multiplier ("3x"), or the words clients, results,
 * guarantee(d), proven, revenue or booked. It over-flags on purpose: an extra
 * tick costs a click, a missed claim costs the business.
 *
 * Server side only (node:crypto). Unpublish never runs the gate.
 */
import { createHash } from "node:crypto";
import type { BodyKey, Confirmation, OfferPageDoc, VideoRef } from "./types";
import { isConfirmed } from "./visibility";
import { videoRefs } from "./providers";

// ---------------------------------------------------------------------------
// Who confirmed it: stamped by the server, never by the browser
// ---------------------------------------------------------------------------

/** JSON with keys sorted, so the same content always gives the same string. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

type Confirmable = { kind: string; thing: unknown; get(): Confirmation | undefined; set(c: Confirmation): void };

function withoutKey<T extends object>(o: T, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(o as Record<string, unknown>) };
  delete copy[key];
  return copy;
}

/** Every owner confirmation a document holds, with the thing it vouches for. */
function confirmables(doc: OfferPageDoc): Confirmable[] {
  const out: Confirmable[] = [];
  const video = (v: VideoRef | undefined | null) => {
    if (!v) return;
    out.push({ kind: "rights", thing: withoutKey(v, "rights"), get: () => v.rights, set: (c) => (v.rights = c) });
  };
  video(doc.hero.video);
  for (const s of doc.sections) {
    if (s.key === "what_you_get" || s.key === "work") s.items.forEach((it) => video(it.video));
    if (s.key === "results") {
      for (const it of s.items) {
        const ev = it.evidence;
        out.push({
          kind: "evidence",
          thing: { ...withoutKey(it, "evidence"), evidence: withoutKey(ev, "confirmed") },
          get: () => ev.confirmed,
          set: (c) => (ev.confirmed = c),
        });
        if (it.kind === "video") video(it.video);
      }
    }
    if (s.key === "bonuses") {
      for (const it of s.items) {
        const value = it.value;
        if (!value) continue;
        out.push({
          kind: "money",
          thing: { cents: value.cents, currency: value.currency },
          get: () => value.confirmed,
          set: (c) => (value.confirmed = c),
        });
      }
    }
    if (s.key === "guarantee" && s.confirmed) {
      const g = s;
      out.push({
        kind: "guarantee",
        thing: { body: g.body ?? "", terms_url: g.terms_url ?? "" },
        get: () => g.confirmed,
        set: (c) => (g.confirmed = c),
      });
    }
  }
  return out;
}

/**
 * The document as it will be stored: every confirmation that is not already on
 * record FOR THE SAME CONTENT is re-stamped with the saving owner and the time.
 * A browser can therefore never put another person's name on a claim, and
 * editing what was confirmed (the quote, the amount, the video, the terms)
 * makes the person who saved the edit the one vouching for it.
 */
export function stampConfirmations(
  next: OfferPageDoc,
  previous: Array<OfferPageDoc | null | undefined>,
  actor: string,
  now: string,
): OfferPageDoc {
  const doc = JSON.parse(JSON.stringify(next)) as OfferPageDoc;
  const known = new Set<string>();
  for (const p of previous) {
    if (!p) continue;
    for (const c of confirmables(p)) {
      const conf = c.get();
      if (conf) known.add(`${c.kind}|${stable(c.thing)}|${conf.by}|${conf.at}`);
    }
  }
  for (const c of confirmables(doc)) {
    const conf = c.get();
    if (!conf || !known.has(`${c.kind}|${stable(c.thing)}|${conf.by}|${conf.at}`)) c.set({ by: actor, at: now });
  }
  return doc;
}

export type ClaimSection = "hero" | "nav" | BodyKey | "book" | "seo";

export type ClaimHit = {
  /** Where it was found, e.g. "results.items[2].quote". */
  where: string;
  section: ClaimSection;
  sentence: string;
  hash: string;
  /** Why it was flagged, in words. */
  why: string[];
};

export type ClaimTick = { hash: string; excerpt: string; by: string; at: string };

const MAX_TICKS = 500;
const EXCERPT_MAX = 160;

const MONEY_RE = /[$\u20AC\u00A3]|\b(?:CAD|USD|EUR|GBP|dollars?|bucks)\b/i;
const PERCENT_RE = /%|\bper ?cent\b/i;
const MULTIPLIER_RE = /\b[0-9]+(?:\.[0-9]+)?\s?x\b/i;
const DIGIT_RE = /[0-9]/;
const NUMBER_WORD_RE =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|hundreds?|thousands?|millions?|billions?|double[ds]?|triple[ds]?|half)\b/i;
const WORD_RE = /\b(clients?|results?|guarantee[ds]?|proven|revenue|booked)\b/i;

/** Why a sentence is a claim, or [] when it is not one. */
export function claimReasons(sentence: string): string[] {
  const why: string[] = [];
  if (MONEY_RE.test(sentence)) why.push("money");
  if (PERCENT_RE.test(sentence)) why.push("a percentage");
  if (MULTIPLIER_RE.test(sentence)) why.push("a multiplier");
  if (DIGIT_RE.test(sentence) || NUMBER_WORD_RE.test(sentence)) why.push("a number");
  const word = WORD_RE.exec(sentence);
  if (word) why.push(`the word "${word[1].toLowerCase()}"`);
  return why;
}

/** One sentence, as stored and hashed: whitespace collapsed, trimmed. */
export function normalizeSentence(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The sentences of a piece of copy: one per line, split after . ! or ? */
export function sentencesOf(text: string): string[] {
  return String(text || "")
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=\S)/))
    .map(normalizeSentence)
    .filter(Boolean);
}

/** The sha256 a tick is stored under. Any edit to the sentence changes it. */
export function sentenceHash(sentence: string): string {
  return createHash("sha256").update(normalizeSentence(sentence), "utf8").digest("hex");
}

type Copy = { where: string; section: ClaimSection; text: string | undefined | null };

/** Every piece of copy the page can draw, with where it sits. */
function drawnCopy(doc: OfferPageDoc, fallbackHeadline: string): Copy[] {
  const out: Copy[] = [];
  const add = (section: ClaimSection, where: string, text: string | undefined | null) => out.push({ section, where, text });
  add("hero", "hero.eyebrow", doc.hero.eyebrow);
  add("hero", "hero.headline", doc.hero.headline || fallbackHeadline);
  add("hero", "hero.subheadline", doc.hero.subheadline);
  add("hero", "hero.cta_label", doc.hero.cta_label);
  if (doc.hero.show_transcript) add("hero", "hero.vsl_script", doc.hero.vsl_script?.text);
  add("nav", "nav.cta_label", doc.nav.cta_label);
  for (const s of doc.sections) {
    if (s.hidden) continue;
    const k = s.key;
    add(k, `${k}.eyebrow`, s.eyebrow);
    add(k, `${k}.title`, s.title);
    add(k, `${k}.lede`, s.lede);
    switch (s.key) {
      case "what_you_get":
      case "obstacles":
      case "work":
        s.items.forEach((it, i) => {
          add(k, `${k}.items[${i}].title`, it.title);
          add(k, `${k}.items[${i}].body`, it.body);
        });
        break;
      case "results":
        s.items.forEach((it, i) => {
          const p = `results.items[${i}]`;
          if (it.kind === "screenshot") {
            add(k, `${p}.label`, it.label);
            add(k, `${p}.who`, it.who);
            add(k, `${p}.alt`, it.alt);
          } else if (it.kind === "video") {
            add(k, `${p}.label`, it.label);
            add(k, `${p}.who`, it.who);
          } else if (it.kind === "quote") {
            add(k, `${p}.quote`, it.quote);
            add(k, `${p}.who`, it.who);
            add(k, `${p}.role`, it.role);
          } else if (it.kind === "metric") {
            add(k, `${p}.value`, it.value);
            add(k, `${p}.label`, it.label);
            add(k, `${p}.source`, it.source);
          }
        });
        break;
      case "bonuses":
        s.items.forEach((it, i) => {
          add(k, `bonuses.items[${i}].title`, it.title);
          add(k, `bonuses.items[${i}].body`, it.body);
        });
        add(k, "bonuses.value_note", s.value_note);
        break;
      case "guarantee":
        add(k, "guarantee.body", s.body);
        break;
      case "faq":
        s.items.forEach((it, i) => {
          add(k, `faq.items[${i}].q`, it.q);
          add(k, `faq.items[${i}].a`, it.a);
        });
        break;
    }
  }
  add("book", "book.eyebrow", doc.book.eyebrow);
  add("book", "book.title", doc.book.title);
  add("book", "book.lede", doc.book.lede);
  add("seo", "seo.title", doc.seo.title);
  add("seo", "seo.description", doc.seo.description);
  return out;
}

/** Every flagged sentence on the page, once each (the first place it appears). */
export function lintDoc(doc: OfferPageDoc, ctx: { fallbackHeadline?: string } = {}): ClaimHit[] {
  const seen = new Set<string>();
  const hits: ClaimHit[] = [];
  for (const c of drawnCopy(doc, ctx.fallbackHeadline || "")) {
    if (!c.text) continue;
    for (const sentence of sentencesOf(c.text)) {
      const why = claimReasons(sentence);
      if (!why.length) continue;
      const hash = sentenceHash(sentence);
      if (seen.has(hash)) continue;
      seen.add(hash);
      hits.push({ where: c.where, section: c.section, sentence, hash, why });
    }
  }
  return hits;
}

/** The stored ticks, whatever the column holds; anything malformed is dropped. */
export function parseClaimTicks(raw: unknown): ClaimTick[] {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v.filter(
    (t): t is ClaimTick =>
      !!t &&
      typeof t === "object" &&
      typeof (t as ClaimTick).hash === "string" &&
      /^[0-9a-f]{64}$/.test((t as ClaimTick).hash) &&
      typeof (t as ClaimTick).by === "string" &&
      typeof (t as ClaimTick).at === "string",
  );
}

/**
 * The ticks after an owner's change. A tick is added only for a sentence the
 * draft really flags (with that owner and time), removed on request, and kept
 * only while the draft or the live page still carries its sentence.
 */
export function applyClaimTicks(input: {
  existing: ClaimTick[];
  confirm: string[];
  unconfirm: string[];
  draftHits: ClaimHit[];
  publishedHits: ClaimHit[];
  actor: string;
  now: string;
}): ClaimTick[] {
  const byHash = new Map(input.existing.map((t) => [t.hash, t]));
  const draftByHash = new Map(input.draftHits.map((h) => [h.hash, h]));
  for (const h of input.unconfirm) byHash.delete(h);
  for (const h of input.confirm) {
    const hit = draftByHash.get(h);
    if (!hit || byHash.has(h)) continue;
    byHash.set(h, { hash: h, excerpt: hit.sentence.slice(0, EXCERPT_MAX), by: input.actor, at: input.now });
  }
  const keep = new Set([...input.draftHits, ...input.publishedHits].map((h) => h.hash));
  return [...byHash.values()].filter((t) => keep.has(t.hash)).slice(-MAX_TICKS);
}

export type GateResult = {
  blockers: string[];
  warnings: string[];
  claims: Array<ClaimHit & { confirmed: boolean }>;
};

const quote = (s: string) => `"${s.length > 90 ? `${s.slice(0, 87)}...` : s}"`;

/**
 * What stands between this draft and the public page, in plain sentences.
 * Empty `blockers` means Publish may go ahead.
 */
export function publishGate(
  doc: OfferPageDoc,
  ticks: ClaimTick[],
  ctx: { formEnabled: boolean; fallbackHeadline: string },
): GateResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!ctx.formEnabled) {
    blockers.push("Switch the form on first. The page's Book section is the form, and a switched-off form takes no one's details.");
  }
  if (!(doc.hero.headline || "").trim() && !(ctx.fallbackHeadline || "").trim()) {
    blockers.push("Add a headline to the top of the page.");
  }
  for (const s of doc.sections) {
    if (s.key === "results") {
      s.items.forEach((it, i) => {
        if (!it.evidence || it.evidence.permission !== true || !isConfirmed(it.evidence.confirmed)) {
          blockers.push(`Result ${i + 1} needs the client's permission and an owner's confirmation.`);
        }
      });
    }
    if (s.key === "bonuses") {
      s.items.forEach((it, i) => {
        if (it.value && !isConfirmed(it.value.confirmed)) blockers.push(`Bonus ${i + 1}'s value needs an owner's confirmation.`);
      });
    }
    if (s.key === "guarantee" && (s.body || "").trim() && !isConfirmed(s.confirmed)) {
      blockers.push("The guarantee needs an owner's confirmation of its terms.");
    }
  }
  for (const { ref, video } of videoRefs(doc)) {
    if (!isConfirmed((video as VideoRef).rights)) {
      blockers.push(`The video at ${ref.replace(":", " item ")} needs the "I have the right to show this video publicly" tick.`);
    }
  }
  const confirmed = new Set(ticks.map((t) => t.hash));
  const claims = lintDoc(doc, { fallbackHeadline: ctx.fallbackHeadline }).map((h) => ({ ...h, confirmed: confirmed.has(h.hash) }));
  for (const c of claims) {
    if (!c.confirmed) blockers.push(`Confirm ${quote(c.sentence)} is true and you can back it.`);
  }
  const hero = doc.hero.video;
  if (hero && hero.source === "library" && !hero.caption_media_id) {
    warnings.push("The top video has no captions. People watching without sound will only have the transcript.");
  }
  return { blockers, warnings, claims };
}
