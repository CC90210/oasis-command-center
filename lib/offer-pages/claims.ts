/**
 * lib/offer-pages/claims.ts - the claims gate (design section 3.5).
 *
 * A sales page makes claims, and a claim nobody can back is a legal problem
 * (Canada's Competition Act and its testimonial rules; the FTC's if the US is
 * targeted). So Publish answers 409 with a plain list of what blocks it until:
 *
 *   1. every result has evidence, the client's permission and an owner's
 *      confirmation (the parser refuses one without; checked again here);
 *   2. every bonus value or price was confirmed by an owner (a pricing tier's
 *      price is free text shown exactly as written, so its stamped `confirmed`
 *      is what vouches for it, and the linter below does not ask about it again);
 *   3. the guarantee, if it has words, was confirmed by an owner;
 *   4. every sentence the linter flags carries an owner's tick, "true, and we
 *      can back it". Ticks are stored by the sentence's sha256, so editing the
 *      sentence clears its tick;
 *   5. every video carries its rights confirmation;
 *   6. the page has a headline, and the form (the Book section) is switched on.
 *
 * THE LINTER flags a sentence that makes a claim someone could hold the
 * business to: money ("$497", "1200 CAD"), a percentage, a multiplier ("3x"),
 * any digit ("200 clients", "save 20 hours"), a spelled-out count of people,
 * outcomes, time or payments ("twelve businesses", "twenty hours", "two
 * payments"), a quantity word ("thousands", "doubled", "half"), a promised
 * result ("more revenue", "real results"), a superlative ("the best", "#1",
 * "fastest", "the only"), or the words guarantee(d), proven, booked, refund,
 * money back, risk-free, ROI, profit or savings.
 * It does NOT flag a spelled-out number that counts nothing a client could
 * hold us to ("four dashboards", "three steps", "Yes, two."), or the bare
 * words client(s), result(s) and revenue ("Clients" as a section name, "Do I
 * have to share revenue?"): those were most of the ticks, and none was a claim.
 * Where it is unsure it still over-flags: an extra tick costs a click, a
 * missed claim costs the business.
 *
 * WHAT IT DOES NOT READ: the form's own copy that the Book section draws (step
 * titles, field labels, the thank-you message, including the default "A
 * specialist will reach out within one business day."). That copy belongs to
 * the form and is edited in the form editor; docs/OFFER_PAGES.md lists it as a
 * known limit for the owner to decide on.
 *
 * Server side only (node:crypto). Unpublish never runs the gate.
 */
import { createHash } from "node:crypto";
import type { BodyKey, Confirmation, OfferPageDoc, VideoRef } from "./types";
import { isConfirmed } from "./visibility";
import { videoRefs } from "./providers";
import { FORM_OFF_BLOCKER } from "./gate-words";

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
    if (s.key === "pricing") {
      for (const it of s.tiers) {
        // Only a tier that carries a confirmation: registering an unconfirmed
        // one would have stampConfirmations sign it off on the owner's behalf.
        if (!it.confirmed) continue;
        const tier = it;
        out.push({
          kind: "price",
          // The whole tier, not just the figure: a confirmation vouches for the
          // card as written (name, price, the Canadian price, cadence,
          // summary, what's included),
          // so changing any of it moves the sign-off to whoever saved the edit.
          thing: withoutKey(tier, "confirmed"),
          get: () => tier.confirmed,
          set: (c) => (tier.confirmed = c),
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
 * The document as it will be stored. Who confirmed a thing, and when, is the
 * server's record, never the browser's say-so:
 *   - a confirmation on record for the same content is kept as it is;
 *   - one the browser echoes for content already on record (the builder's
 *     "pending" tick, a stale copy, a forged name) is put back to the record,
 *     so saving the same page again never moves "confirmed at" forward;
 *   - anything else (new content, or confirmed content that was edited) is
 *     stamped with the saving owner and the time.
 * A browser can therefore never put another person's name on a claim, and
 * editing what was confirmed (the quote, the amount, the video, the terms, a
 * price tier) makes the person who saved the edit the one vouching for it.
 */
export function stampConfirmations(
  next: OfferPageDoc,
  previous: Array<OfferPageDoc | null | undefined>,
  actor: string,
  now: string,
): OfferPageDoc {
  const doc = JSON.parse(JSON.stringify(next)) as OfferPageDoc;
  const exact = new Set<string>();
  const onRecord = new Map<string, Confirmation>();
  for (const p of previous) {
    if (!p) continue;
    for (const c of confirmables(p)) {
      const conf = c.get();
      if (!conf) continue;
      const content = `${c.kind}|${stable(c.thing)}`;
      exact.add(`${content}|${conf.by}|${conf.at}`);
      if (!onRecord.has(content)) onRecord.set(content, { by: conf.by, at: conf.at });
    }
  }
  for (const c of confirmables(doc)) {
    const conf = c.get();
    const content = `${c.kind}|${stable(c.thing)}`;
    if (conf && exact.has(`${content}|${conf.by}|${conf.at}`)) continue;
    const recorded = conf ? onRecord.get(content) : undefined;
    c.set(recorded ? { ...recorded } : { by: actor, at: now });
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
/** A quantity on its own: "thousands of owners", "doubled", "half the time". */
const QUANTITY_RE = /\b(?:hundreds?|thousands?|millions?|billions?|double[ds]?|doubling|triple[ds]?|tripling|half|halve[ds]?)\b/i;
/**
 * A spelled-out number counts as a claim only when it counts something a
 * client could hold us to: people, outcomes, time, payments ("twelve
 * businesses", "twenty hours", "two payments", "three times faster"), up to
 * two words apart ("fifty new leads"). "Four dashboards", "three steps" and
 * "Yes, two." count nothing of the kind, and neither does "three steps for
 * clients": a word in between may describe what is counted, never join it to
 * something else (CONNECTOR).
 */
const SMALL_NUMBER =
  "two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen" +
  "|twenty|thirty|forty|fifty|sixty";
const COUNTED =
  "clients?|customers?|businesses|companies|owners|members|users|students|patients|homeowners|founders|agencies|brands|people" +
  "|leads?|calls?|bookings?|appointments?|sales|deals?|jobs?|reviews?|referrals?|orders?|projects?|sign-?ups?" +
  "|conversions?|results?|wins?|replies|responses|messages|inquiries|enquiries|subscribers|followers|views|visitors|visits" +
  "|clicks|downloads|installs|meetings|demos|quotes|estimates|contracts|hires|tickets|conversations|partners|locations" +
  "|stores|employees|transactions|deliveries" +
  "|hours?|minutes?|days?|weeks?|months?|years?|payments?|instal?lments?" +
  "|times\\s+(?:more|faster|better|higher|bigger|larger|as)";
/**
 * Words that join two things rather than describe one. A word between a
 * number (or a gain) and what it counts may be "new" or "qualified", never one
 * of these. A deny list, not an allow list: a describing word nobody listed
 * still flags, so a real claim is never missed for its adjective.
 */
const CONNECTOR =
  "a|an|and|as|at|but|by|for|from|if|in|into|is|are|it|its|nor|of|on|or|per|so|than|that|the|their|then|this|to|via|was|were|when|which|while|who|with|your|our|you|we|they";
const DESCRIBING_WORD = `(?!(?:${CONNECTOR})\\b)[a-z][a-z'-]*`;
const COUNT_RE = new RegExp(`\\b(?:${SMALL_NUMBER})(?:[\\s-]+${DESCRIBING_WORD}){0,2}?[\\s-]+(?:${COUNTED})\\b`, "i");
/** What a client earns or wins, as a result names it after its rise ("revenue increased", "close rates went up"). */
const METRIC =
  "revenue|sales|profits?|income|earnings|margins?|leads|bookings|customers|clients|conversions|results|replies|referrals|reviews" +
  "|sign-?ups|traffic|(?:close|conversion|response|reply|booking)\\s+rates?";
const ROSE =
  "increased|increases|grew|grows|rose|rises|jumped|jumps|climbed|climbs|improved|improves|soared|soars|skyrocketed|skyrockets" +
  "|doubled|tripled|exploded|went\\s+up|goes\\s+up|took\\s+off|(?:is|are|was|were)\\s+(?:up|higher)";
/**
 * A promised result: a gain in what the client earns or wins, either way round
 * ("more revenue", "more qualified leads"; "revenue increased", "results
 * improved"), or results described as good.
 */
const RESULT_RE = new RegExp(
  "\\b(?:more|higher|bigger|extra|increased?|increases|increasing|boost(?:s|ed|ing)?|grow|grows|grew|growing|raise[ds]?)\\s+" +
    `(?:(?:your|our|their|the)\\s+)?(?:${DESCRIBING_WORD}\\s+){0,2}?(?:revenue|sales|profits?|leads|bookings|customers|clients|conversions)\\b` +
    `|\\b(?:${METRIC})(?:\\s+${DESCRIBING_WORD}){0,2}?\\s+(?:${ROSE})\\b` +
    "|\\b(?:real|proven|measurable|guaranteed|massive|incredible|amazing|predictable|consistent|better|faster|bigger)\\s+results?\\b",
  "i",
);
/**
 * "The best", "#1", "fastest", "the only" (not "by application only"), "a
 * leading", "award-winning" (not "leading your team").
 */
const SUPERLATIVE_RE =
  /#\s?1\b|\bnumber[ -]one\b|\b(?:the|our)\s+(?:very\s+)?(?:best|only)\b|\b(?:a|an|the|our)\s+(?:very\s+)?leading\b|\baward[- ]winning\b|\bbest[- ](?:in[- ]class|rated|selling)\b|\b(?:fastest|quickest|cheapest|lowest|highest|biggest|largest|smartest|easiest|simplest|strongest|unbeatable|unmatched|world[- ]class|industry[- ]leading|market[- ]leading|top[- ]rated)\b|\bmost\s+(?:trusted|popular|advanced|powerful|affordable|reliable|complete|effective)\b/i;
/**
 * Who else uses it: "trusted by", "used by", "relied on by", and a spelled-out
 * count after "over", "more than", "serving" or "across" ("serving twenty
 * clinics", "over eighty agencies"), whatever it counts. A count of a noun
 * COUNTED does not list is a claim here because the words around it make it
 * one. "Serving one clinic" counts too ("one" only after "serving": "across
 * one view" claims nothing).
 */
const PROOF_NUMBER = `${SMALL_NUMBER}|seventy|eighty|ninety|a\\s+dozen|dozens`;
const SOCIAL_PROOF_RE = new RegExp(
  "\\b(?:trusted|used|chosen|loved|relied\\s+on|recommended)\\s+by\\b" +
    `|\\b(?:over|more\\s+than|serving|across)\\s+(?:${PROOF_NUMBER})\\b` +
    "|\\bserving\\s+(?:one|a\\s+single)\\b",
  "i",
);
/**
 * A promised time frame: "same-day", "overnight", "in days", "within hours",
 * "in one week", "within a month", each also as business or working days
 * ("within one business day", "same business-day setup"). Digits ("in 7
 * days") already flag as a number. "One day" alone is not one ("one day at a
 * time").
 */
const TIMEFRAME_RE =
  /\b(?:same|next)[- ](?:(?:business|working)[- ])?day\b|\bovernight\b|\b(?:in|within)\s+(?:a\s+few\s+)?(?:(?:business|working)\s+)?(?:minutes|hours|days|weeks)\b|\b(?:in|within)\s+(?:a|one|an)\s+(?:single\s+)?(?:(?:business|working)\s+)?(?:minute|hour|day|week|month)\b/i;
/**
 * Words that are a claim on their own. The bare words client(s), result(s)
 * and revenue are not: they name a section or a form question far more often
 * than they claim anything; COUNT_RE and RESULT_RE catch them in a claim.
 */
const WORD_RE =
  /\b(guarantee[ds]?|proven|booked|refunds?|refunded|money[ -]back|risk[ -]free|roi|profits?|profitable|savings?)\b/i;

/** The family a claim phrase belongs to (claimReasons says the same thing in a sentence). */
export type ClaimKind = "money" | "percentage" | "multiplier" | "number" | "result" | "superlative" | "who else uses it" | "time frame" | "word";

/** One phrase that makes a sentence a claim, as it is written there. */
export type ClaimPhrase = { kind: ClaimKind; phrase: string };

/** A run of digits ("$2,500", "7", "3.5") as one phrase: any digit makes a number. */
const DIGIT_RE = /[0-9](?:[0-9.,:]*[0-9])?/;

/**
 * Every claim family, in the order the reasons are said. THE one list: both
 * claimPhrases and claimReasons read it, so a pattern changed here changes
 * both answers. Global copies, made once (matchAll never moves their
 * lastIndex: it matches on a copy).
 */
const CLAIM_FAMILIES: ReadonlyArray<{ kind: ClaimKind; re: RegExp }> = (
  [
    ["money", MONEY_RE],
    ["percentage", PERCENT_RE],
    ["multiplier", MULTIPLIER_RE],
    ["number", DIGIT_RE],
    ["number", QUANTITY_RE],
    ["number", COUNT_RE],
    ["result", RESULT_RE],
    ["superlative", SUPERLATIVE_RE],
    ["who else uses it", SOCIAL_PROOF_RE],
    ["time frame", TIMEFRAME_RE],
    ["word", WORD_RE],
  ] as const
).map(([kind, re]) => ({ kind, re: new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`) }));

/**
 * Every phrase in a sentence that makes it a claim, each with its family, in
 * family order and then as written. For grounding copy phrase by phrase
 * (#636's write-page vetting), so no second list of claim words has to follow
 * this one.
 */
export function claimPhrases(sentence: string): ClaimPhrase[] {
  const out: ClaimPhrase[] = [];
  for (const { kind, re } of CLAIM_FAMILIES) {
    for (const m of sentence.matchAll(re)) if (m[0]) out.push({ kind, phrase: m[0] });
  }
  return out;
}

/** Each family, as the owner reads it on the tick line: a result and a claim word quote what was written. */
const REASON: Readonly<Record<ClaimKind, (phrase: string) => string>> = {
  money: () => "money",
  percentage: () => "a percentage",
  multiplier: () => "a multiplier",
  number: () => "a number",
  result: (p) => `a promised result ("${p.toLowerCase().replace(/\s+/g, " ")}")`,
  superlative: () => "a superlative",
  "who else uses it": () => "who else uses it",
  "time frame": () => "a time frame",
  word: (p) => `the word "${p.toLowerCase()}"`,
};

/** Why a sentence is a claim, or [] when it is not one: one reason per family, from its first phrase. */
export function claimReasons(sentence: string): string[] {
  const seen = new Set<ClaimKind>();
  const why: string[] = [];
  for (const { kind, phrase } of claimPhrases(sentence)) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    why.push(REASON[kind](phrase));
  }
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
      case "pricing":
        // Every word on a tier except the price itself and its Canadian price
        // (price_cad): both are vouched for by the tier's own owner's tick
        // (publishGate), and a second "is $2,500 true?" tick for the same
        // figure would only teach owners to click through.
        s.tiers.forEach((it, i) => {
          const p = `pricing.tiers[${i}]`;
          add(k, `${p}.name`, it.name);
          add(k, `${p}.cadence`, it.cadence);
          add(k, `${p}.summary`, it.summary);
          (it.includes ?? []).forEach((line, j) => add(k, `${p}.includes[${j}]`, line));
        });
        add(k, "pricing.currency_note", s.currency_note);
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
    blockers.push(FORM_OFF_BLOCKER);
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
    // A hidden section draws nothing, so it vouches for nothing (as drawnCopy skips it).
    if (s.key === "pricing" && !s.hidden) {
      s.tiers.forEach((it, i) => {
        const price = (it.price || "").trim();
        const name = (it.name || "").trim();
        // Never starts with "Confirm ": PublishChecklist keeps those lines for
        // the claim ticks, and this one must show as a plain blocker.
        const which = name ? `"${name}"` : `plan ${i + 1}`;
        if (price && !isConfirmed(it.confirmed)) {
          blockers.push(`The price for ${which} (${price}) needs an owner's confirmation. It is shown exactly as written.`);
        } else if (!price && name) {
          warnings.push(`${which} has no price yet, so it is not shown.`);
        }
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
  if (hero && ((hero.source === "library" && !hero.caption_media_id) || (hero.source === "upload" && !hero.caption_path))) {
    warnings.push("The top video has no captions. People watching without sound will only have the transcript.");
  }
  return { blockers, warnings, claims };
}
