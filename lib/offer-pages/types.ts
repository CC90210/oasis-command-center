/**
 * lib/offer-pages/types.ts - an offer page: the full landing page that sits in
 * front of one form, and the strict parser every write and every render goes
 * through.
 *
 * WHERE IT LIVES. One JSON document per form, in form_offer_pages (migration
 * bravo__203): a draft copy and a published copy side by side. Never in
 * forms.branding (parseFormBranding keeps only its seven known keys, so the next
 * builder save would erase it) and never in a new forms column (a column read
 * before its migration lands makes every public form 500).
 *
 * NAME. "offer page", never a bare "offer": the retired SunBiz lender entity is
 * called offer, and /offers is its 404 route.
 *
 * THE RULES THE PARSER HOLDS (design section 3.3):
 *   - Strict. An unknown key anywhere is refused, and the error names the exact
 *     path, the way parseFormSteps does.
 *   - The whole document is at most 200 KB; every piece of copy has a cap.
 *   - Copy is plain text: trimmed, no markup, no control characters.
 *   - Nothing that would be a claim can exist without an owner behind it: a
 *     result needs evidence, the client's permission and a confirmation; a
 *     money value needs a confirmation; every attached video needs the rights
 *     confirmation. Confirmations are re-stamped by the server with the saving
 *     owner's id and the time (store.ts stampConfirmations), so a browser can
 *     never claim someone else said it.
 *   - Templates and this parser carry structure only. Nothing here invents copy.
 *
 * No `server-only`: the builder, the tests and the seed script parse with it.
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */

export const OFFER_DOC_VERSION = 1 as const;

/** The whole document, as JSON, may not exceed this. */
export const OFFER_DOC_MAX_BYTES = 200 * 1024;

export const TEMPLATE_KEYS = ["book_call", "free_audit", "application"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const BODY_KEYS = ["what_you_get", "obstacles", "work", "results", "bonuses", "guarantee", "faq"] as const;
export type BodyKey = (typeof BODY_KEYS)[number];

/** Section anchors on the public page. */
export const BODY_ANCHORS: Readonly<Record<BodyKey, string>> = {
  what_you_get: "what-you-get",
  obstacles: "obstacles",
  work: "work",
  results: "results",
  bonuses: "bonuses",
  guarantee: "guarantee",
  faq: "faq",
};

/** Character caps per kind of copy (design section 3.3, plus the unnamed ones). */
export const COPY_CAPS = {
  eyebrow: 60,
  headline: 140,
  subheadline: 400,
  cta_label: 40,
  title: 120,
  body: 600,
  lede: 400,
  faq_q: 200,
  faq_a: 1200,
  quote: 600,
  who: 120,
  role: 120,
  label: 120,
  metric_value: 40,
  source: 300,
  alt: 300,
  value_note: 300,
  guarantee_body: 1200,
  video_title: 200,
  vsl_script: 20000,
  seo_title: 70,
  seo_description: 200,
  brief: 2000,
} as const;

/** Items per section (design section 3.3). */
export const ITEM_CAPS: Readonly<Record<Exclude<BodyKey, "guarantee">, number>> = {
  what_you_get: 8,
  obstacles: 10,
  work: 6,
  results: 30,
  bonuses: 8,
  faq: 20,
};

/** The page canvas (ops-void). Accents are checked against it. */
export const OFFER_CANVAS = "#050608";
/** The website's signal cyan: the accent when an offer sets none (D5). */
export const DEFAULT_ACCENT = "#00D4FF";

export type Copy = string;
export type Confirmation = { by: string; at: string };
export type Aspect = "16:9" | "9:16" | "1:1" | "4:5";
export const ASPECTS: readonly Aspect[] = ["16:9", "9:16", "1:1", "4:5"];

export type LibraryVideoRef = {
  source: "library";
  asset_id: string;
  video_media_id: string;
  poster_media_id?: string;
  caption_media_id?: string;
};
export type LinkVideoRef = {
  source: "youtube" | "vimeo" | "loom";
  id: string;
  /** Vimeo unlisted videos only. */
  hash?: string;
  title?: Copy;
  /** Our copy of the provider thumbnail, in the public tenant-assets prefix. */
  thumb_path?: string;
};
export type VideoRef = { rights: Confirmation; aspect: Aspect; duration_s?: number } & (LibraryVideoRef | LinkVideoRef);

/** A Library image (private bucket, signed at render). Uploads arrive in a later version. */
export type ImageRef = { asset_id: string; media_id: string };

export type Money = { cents: number; currency: "CAD" | "USD"; confirmed: Confirmation };
export type Evidence = { permission: true; confirmed: Confirmation; proof?: ImageRef };

export type ResultItem =
  | { kind: "screenshot"; image: ImageRef; alt: Copy; label?: Copy; who?: Copy; evidence: Evidence }
  | { kind: "video"; video: VideoRef; label?: Copy; who?: Copy; evidence: Evidence }
  | { kind: "quote"; quote: Copy; who: Copy; role?: Copy; evidence: Evidence }
  | { kind: "metric"; value: Copy; label: Copy; source: Copy; evidence: Evidence };

export type Head = { eyebrow?: Copy; title?: Copy; lede?: Copy; hidden?: boolean };

export type WhatYouGetSection = { key: "what_you_get"; items: { title: Copy; body?: Copy; video?: VideoRef }[] } & Head;
export type ObstaclesSection = { key: "obstacles"; items: { title: Copy; body?: Copy }[] } & Head;
export type WorkSection = { key: "work"; items: { title: Copy; body?: Copy; video: VideoRef }[] } & Head;
export type ResultsSection = { key: "results"; items: ResultItem[] } & Head;
export type BonusesSection = {
  key: "bonuses";
  items: { title: Copy; body?: Copy; value?: Money | null }[];
  value_note?: Copy;
} & Head;
export type GuaranteeSection = { key: "guarantee"; body?: Copy; terms_url?: string; confirmed?: Confirmation } & Head;
export type FaqSection = { key: "faq"; items: { q: Copy; a: Copy }[] } & Head;

export type BodySection =
  | WhatYouGetSection
  | ObstaclesSection
  | WorkSection
  | ResultsSection
  | BonusesSection
  | GuaranteeSection
  | FaqSection;

export type Hero = {
  eyebrow?: Copy;
  headline?: Copy;
  subheadline?: Copy;
  cta_label?: Copy;
  video?: VideoRef | null;
  vsl_script?: { text: Copy; source: "maven" | "cc"; pack_id?: string } | null;
  show_transcript?: boolean;
  /** Desktop: a booking card beside the hero (the booking widget arrives in PR3). */
  booking_card?: boolean;
};

/**
 * "form": the form, nothing else. "form_then_link": after the contact step the
 * visitor is offered the workspace's booking link (or, with none, told we will
 * reach out). "native" is booking on the page (PR3) and is refused until then.
 */
export type BookMode = "form" | "form_then_link";
export type BookSection = Head & { mode: BookMode; qualify: "before" | "after" };

export type OfferBrief = {
  audience?: string;
  promise?: string;
  included?: string;
  proof_available?: string;
  price?: string;
  bonuses?: string;
  guarantee?: string;
  requested_at?: string;
};

export type OfferPageDoc = {
  v: 1;
  template: TemplateKey;
  theme: { canvas: "dark"; accent?: string; logo?: "workspace" | "none" };
  nav: { pinned: BodyKey[]; cta_label?: Copy };
  hero: Hero;
  sections: BodySection[];
  book: BookSection;
  seo: { title?: Copy; description?: Copy; og_image?: ImageRef | null; indexable: false };
  /** The owner's facts for whoever writes the copy. Never drawn, stripped on publish. */
  brief?: OfferBrief;
};

export class OfferPageError extends Error {
  constructor(
    public path: string,
    public reason: string,
  ) {
    super(`offer page invalid at ${path}: ${reason}`);
    this.name = "OfferPageError";
  }
}

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID_RE = /^[0-9]{1,12}$/;
const VIMEO_HASH_RE = /^[0-9a-f]{6,20}$/;
const LOOM_ID_RE = /^[0-9a-f]{32}$/;
const THUMB_PATH_RE = /^[A-Za-z0-9-]{1,64}\/offer-pages\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
/** Tag-shaped text: "<b", "</", "<!", "<?". A bare "<" in a sentence ("< 2 days") passes. */
const MARKUP_RE = /<\s*[A-Za-z!\/?]/;
/** Control characters other than tab and newline. */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export function isProviderId(source: LinkVideoRef["source"], id: string): boolean {
  if (source === "youtube") return YOUTUBE_ID_RE.test(id);
  if (source === "vimeo") return VIMEO_ID_RE.test(id);
  return LOOM_ID_RE.test(id);
}

export function isVimeoHash(hash: string): boolean {
  return VIMEO_HASH_RE.test(hash);
}

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v);
}

function channels(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Does this accent clear AA on the offer page? It is drawn two ways: as text
 * and rules on the dark canvas, and as a button fill under dark text. Both are
 * the same pair of colours, so one check covers both.
 */
export function accentPassesAA(hex: string): boolean {
  return isHexColor(hex) && contrastRatio(hex, OFFER_CANVAS) >= 4.5;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (!isRecord(v)) throw new OfferPageError(path, "expected an object");
  return v;
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new OfferPageError(`${path}.${k}`, "unknown key");
  }
}

function copyOf(v: unknown, path: string, cap: number): string {
  if (typeof v !== "string") throw new OfferPageError(path, "expected text");
  const t = v.replace(/\r\n?/g, "\n").trim();
  if (t.length > cap) throw new OfferPageError(path, `longer than ${cap} characters`);
  if (MARKUP_RE.test(t)) throw new OfferPageError(path, "plain text only, no markup");
  if (CONTROL_RE.test(t)) throw new OfferPageError(path, "contains a control character");
  return t;
}

function optCopy(o: Record<string, unknown>, key: string, path: string, cap: number): string | undefined {
  if (o[key] === undefined || o[key] === null) return undefined;
  const t = copyOf(o[key], `${path}.${key}`, cap);
  return t ? t : undefined;
}

/** Present, possibly empty: an item being typed is kept; visibility.ts decides what draws. */
function reqCopy(o: Record<string, unknown>, key: string, path: string, cap: number): string {
  if (o[key] === undefined || o[key] === null) throw new OfferPageError(`${path}.${key}`, "required");
  return copyOf(o[key], `${path}.${key}`, cap);
}

function optBool(o: Record<string, unknown>, key: string, path: string): boolean | undefined {
  if (o[key] === undefined) return undefined;
  if (typeof o[key] !== "boolean") throw new OfferPageError(`${path}.${key}`, "expected true or false");
  return o[key] as boolean;
}

function idOf(v: unknown, path: string): string {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new OfferPageError(path, "expected an id");
  return v;
}

function isoOf(v: unknown, path: string): string {
  if (typeof v !== "string" || !ISO_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new OfferPageError(path, "expected an ISO-8601 UTC time");
  }
  return v;
}

function parseConfirmation(v: unknown, path: string): Confirmation {
  const o = obj(v, path);
  onlyKeys(o, ["by", "at"], path);
  if (typeof o.by !== "string" || !o.by.trim() || o.by.length > 64 || CONTROL_RE.test(o.by)) {
    throw new OfferPageError(`${path}.by`, "expected who confirmed it");
  }
  return { by: o.by.trim(), at: isoOf(o.at, `${path}.at`) };
}

function parseImageRef(v: unknown, path: string): ImageRef {
  const o = obj(v, path);
  if ("upload_path" in o) throw new OfferPageError(`${path}.upload_path`, "uploaded images arrive in a later version");
  onlyKeys(o, ["asset_id", "media_id"], path);
  return { asset_id: idOf(o.asset_id, `${path}.asset_id`), media_id: idOf(o.media_id, `${path}.media_id`) };
}

export function parseVideoRef(v: unknown, path: string): VideoRef {
  const o = obj(v, path);
  const rights = parseConfirmation(o.rights, `${path}.rights`);
  if (typeof o.aspect !== "string" || !ASPECTS.includes(o.aspect as Aspect)) {
    throw new OfferPageError(`${path}.aspect`, "expected 16:9, 9:16, 1:1 or 4:5");
  }
  const aspect = o.aspect as Aspect;
  let duration_s: number | undefined;
  if (o.duration_s !== undefined && o.duration_s !== null) {
    if (typeof o.duration_s !== "number" || !Number.isFinite(o.duration_s) || o.duration_s < 0 || o.duration_s > 36000) {
      throw new OfferPageError(`${path}.duration_s`, "expected seconds between 0 and 36000");
    }
    duration_s = Math.round(o.duration_s);
  }
  const base = { rights, aspect, ...(duration_s !== undefined ? { duration_s } : {}) };
  if (o.source === "library") {
    onlyKeys(o, ["source", "asset_id", "video_media_id", "poster_media_id", "caption_media_id", "rights", "aspect", "duration_s"], path);
    return {
      ...base,
      source: "library",
      asset_id: idOf(o.asset_id, `${path}.asset_id`),
      video_media_id: idOf(o.video_media_id, `${path}.video_media_id`),
      ...(o.poster_media_id != null ? { poster_media_id: idOf(o.poster_media_id, `${path}.poster_media_id`) } : {}),
      ...(o.caption_media_id != null ? { caption_media_id: idOf(o.caption_media_id, `${path}.caption_media_id`) } : {}),
    };
  }
  if (o.source === "youtube" || o.source === "vimeo" || o.source === "loom") {
    const source = o.source;
    onlyKeys(o, ["source", "id", "hash", "title", "thumb_path", "rights", "aspect", "duration_s"], path);
    if (typeof o.id !== "string" || !isProviderId(source, o.id)) {
      throw new OfferPageError(`${path}.id`, `not a ${source} video id`);
    }
    const out: VideoRef = { ...base, source, id: o.id };
    if (o.hash !== undefined && o.hash !== null) {
      if (source !== "vimeo" || typeof o.hash !== "string" || !isVimeoHash(o.hash)) {
        throw new OfferPageError(`${path}.hash`, "only an unlisted Vimeo video has a hash");
      }
      out.hash = o.hash;
    }
    const title = optCopy(o, "title", path, COPY_CAPS.video_title);
    if (title) out.title = title;
    if (o.thumb_path !== undefined && o.thumb_path !== null) {
      if (typeof o.thumb_path !== "string" || !THUMB_PATH_RE.test(o.thumb_path) || o.thumb_path.includes("..")) {
        throw new OfferPageError(`${path}.thumb_path`, "not a thumbnail this workspace stored");
      }
      out.thumb_path = o.thumb_path;
    }
    return out;
  }
  throw new OfferPageError(`${path}.source`, "expected library, youtube, vimeo or loom");
}

function parseEvidence(v: unknown, path: string): Evidence {
  const o = obj(v, path);
  onlyKeys(o, ["permission", "confirmed", "proof"], path);
  if (o.permission !== true) {
    throw new OfferPageError(`${path}.permission`, "a result needs the client's permission to be shown");
  }
  const out: Evidence = { permission: true, confirmed: parseConfirmation(o.confirmed, `${path}.confirmed`) };
  if (o.proof !== undefined && o.proof !== null) out.proof = parseImageRef(o.proof, `${path}.proof`);
  return out;
}

function parseMoney(v: unknown, path: string): Money {
  const o = obj(v, path);
  onlyKeys(o, ["cents", "currency", "confirmed"], path);
  if (typeof o.cents !== "number" || !Number.isInteger(o.cents) || o.cents < 0 || o.cents > 10_000_000_00) {
    throw new OfferPageError(`${path}.cents`, "expected a whole number of cents");
  }
  if (o.currency !== "CAD" && o.currency !== "USD") throw new OfferPageError(`${path}.currency`, "expected CAD or USD");
  if (o.confirmed === undefined || o.confirmed === null) {
    throw new OfferPageError(`${path}.confirmed`, "a value needs an owner's confirmation");
  }
  return { cents: o.cents, currency: o.currency, confirmed: parseConfirmation(o.confirmed, `${path}.confirmed`) };
}

function parseHead(o: Record<string, unknown>, path: string): Head {
  const head: Head = {};
  const eyebrow = optCopy(o, "eyebrow", path, COPY_CAPS.eyebrow);
  const title = optCopy(o, "title", path, COPY_CAPS.title);
  const lede = optCopy(o, "lede", path, COPY_CAPS.lede);
  const hidden = optBool(o, "hidden", path);
  if (eyebrow) head.eyebrow = eyebrow;
  if (title) head.title = title;
  if (lede) head.lede = lede;
  if (hidden !== undefined) head.hidden = hidden;
  return head;
}

const HEAD_KEYS = ["eyebrow", "title", "lede", "hidden"] as const;

function itemsOf(o: Record<string, unknown>, path: string, cap: number): unknown[] {
  if (!Array.isArray(o.items)) throw new OfferPageError(`${path}.items`, "expected a list");
  if (o.items.length > cap) throw new OfferPageError(`${path}.items`, `at most ${cap} items`);
  return o.items;
}

function parseResult(v: unknown, path: string): ResultItem {
  const o = obj(v, path);
  const evidence = () => {
    if (o.evidence === undefined || o.evidence === null) {
      throw new OfferPageError(`${path}.evidence`, "a result needs evidence, permission and an owner's confirmation");
    }
    return parseEvidence(o.evidence, `${path}.evidence`);
  };
  switch (o.kind) {
    case "screenshot": {
      onlyKeys(o, ["kind", "image", "alt", "label", "who", "evidence"], path);
      const item: ResultItem = {
        kind: "screenshot",
        image: parseImageRef(o.image, `${path}.image`),
        alt: reqCopy(o, "alt", path, COPY_CAPS.alt),
        evidence: evidence(),
      };
      const label = optCopy(o, "label", path, COPY_CAPS.label);
      const who = optCopy(o, "who", path, COPY_CAPS.who);
      if (label) item.label = label;
      if (who) item.who = who;
      return item;
    }
    case "video": {
      onlyKeys(o, ["kind", "video", "label", "who", "evidence"], path);
      const item: ResultItem = { kind: "video", video: parseVideoRef(o.video, `${path}.video`), evidence: evidence() };
      const label = optCopy(o, "label", path, COPY_CAPS.label);
      const who = optCopy(o, "who", path, COPY_CAPS.who);
      if (label) item.label = label;
      if (who) item.who = who;
      return item;
    }
    case "quote": {
      onlyKeys(o, ["kind", "quote", "who", "role", "evidence"], path);
      const item: ResultItem = {
        kind: "quote",
        quote: reqCopy(o, "quote", path, COPY_CAPS.quote),
        who: reqCopy(o, "who", path, COPY_CAPS.who),
        evidence: evidence(),
      };
      const role = optCopy(o, "role", path, COPY_CAPS.role);
      if (role) item.role = role;
      return item;
    }
    case "metric": {
      onlyKeys(o, ["kind", "value", "label", "source", "evidence"], path);
      return {
        kind: "metric",
        value: reqCopy(o, "value", path, COPY_CAPS.metric_value),
        label: reqCopy(o, "label", path, COPY_CAPS.label),
        source: reqCopy(o, "source", path, COPY_CAPS.source),
        evidence: evidence(),
      };
    }
    default:
      throw new OfferPageError(`${path}.kind`, "expected screenshot, video, quote or metric");
  }
}

function parseSection(v: unknown, path: string): BodySection {
  const o = obj(v, path);
  const head = parseHead(o, path);
  switch (o.key) {
    case "what_you_get": {
      onlyKeys(o, ["key", "items", ...HEAD_KEYS], path);
      const items = itemsOf(o, path, ITEM_CAPS.what_you_get).map((raw, i) => {
        const p = `${path}.items[${i}]`;
        const it = obj(raw, p);
        onlyKeys(it, ["title", "body", "video"], p);
        const out: WhatYouGetSection["items"][number] = { title: reqCopy(it, "title", p, COPY_CAPS.title) };
        const body = optCopy(it, "body", p, COPY_CAPS.body);
        if (body) out.body = body;
        if (it.video !== undefined && it.video !== null) out.video = parseVideoRef(it.video, `${p}.video`);
        return out;
      });
      return { key: "what_you_get", items, ...head };
    }
    case "obstacles": {
      onlyKeys(o, ["key", "items", ...HEAD_KEYS], path);
      const items = itemsOf(o, path, ITEM_CAPS.obstacles).map((raw, i) => {
        const p = `${path}.items[${i}]`;
        const it = obj(raw, p);
        onlyKeys(it, ["title", "body"], p);
        const out: ObstaclesSection["items"][number] = { title: reqCopy(it, "title", p, COPY_CAPS.title) };
        const body = optCopy(it, "body", p, COPY_CAPS.body);
        if (body) out.body = body;
        return out;
      });
      return { key: "obstacles", items, ...head };
    }
    case "work": {
      onlyKeys(o, ["key", "items", ...HEAD_KEYS], path);
      const items = itemsOf(o, path, ITEM_CAPS.work).map((raw, i) => {
        const p = `${path}.items[${i}]`;
        const it = obj(raw, p);
        onlyKeys(it, ["title", "body", "video"], p);
        if (it.video === undefined || it.video === null) throw new OfferPageError(`${p}.video`, "a work item needs its video");
        const out: WorkSection["items"][number] = {
          title: reqCopy(it, "title", p, COPY_CAPS.title),
          video: parseVideoRef(it.video, `${p}.video`),
        };
        const body = optCopy(it, "body", p, COPY_CAPS.body);
        if (body) out.body = body;
        return out;
      });
      return { key: "work", items, ...head };
    }
    case "results": {
      onlyKeys(o, ["key", "items", ...HEAD_KEYS], path);
      const items = itemsOf(o, path, ITEM_CAPS.results).map((raw, i) => parseResult(raw, `${path}.items[${i}]`));
      return { key: "results", items, ...head };
    }
    case "bonuses": {
      onlyKeys(o, ["key", "items", "value_note", ...HEAD_KEYS], path);
      const items = itemsOf(o, path, ITEM_CAPS.bonuses).map((raw, i) => {
        const p = `${path}.items[${i}]`;
        const it = obj(raw, p);
        onlyKeys(it, ["title", "body", "value"], p);
        const out: BonusesSection["items"][number] = { title: reqCopy(it, "title", p, COPY_CAPS.title) };
        const body = optCopy(it, "body", p, COPY_CAPS.body);
        if (body) out.body = body;
        if (it.value !== undefined && it.value !== null) out.value = parseMoney(it.value, `${p}.value`);
        return out;
      });
      const section: BonusesSection = { key: "bonuses", items, ...head };
      const note = optCopy(o, "value_note", path, COPY_CAPS.value_note);
      if (note) section.value_note = note;
      return section;
    }
    case "guarantee": {
      onlyKeys(o, ["key", "body", "terms_url", "confirmed", ...HEAD_KEYS], path);
      const section: GuaranteeSection = { key: "guarantee", ...head };
      const body = optCopy(o, "body", path, COPY_CAPS.guarantee_body);
      if (body) section.body = body;
      if (o.terms_url !== undefined && o.terms_url !== null && o.terms_url !== "") {
        section.terms_url = httpsUrl(o.terms_url, `${path}.terms_url`);
      }
      if (o.confirmed !== undefined && o.confirmed !== null) {
        section.confirmed = parseConfirmation(o.confirmed, `${path}.confirmed`);
      }
      return section;
    }
    case "faq": {
      onlyKeys(o, ["key", "items", ...HEAD_KEYS], path);
      const items = itemsOf(o, path, ITEM_CAPS.faq).map((raw, i) => {
        const p = `${path}.items[${i}]`;
        const it = obj(raw, p);
        onlyKeys(it, ["q", "a"], p);
        return { q: reqCopy(it, "q", p, COPY_CAPS.faq_q), a: reqCopy(it, "a", p, COPY_CAPS.faq_a) };
      });
      return { key: "faq", items, ...head };
    }
    default:
      throw new OfferPageError(`${path}.key`, `expected one of ${BODY_KEYS.join(", ")}`);
  }
}

function httpsUrl(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length > 500) throw new OfferPageError(path, "expected an https link");
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" || !u.hostname) throw new Error("not https");
    return u.toString();
  } catch {
    throw new OfferPageError(path, "expected an https link");
  }
}

function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Parse an offer page document: from the database (a JSON string) or a request
 * body (an object). Throws OfferPageError naming the exact path that failed.
 */
export function parseOfferPageDoc(value: unknown): OfferPageDoc {
  let raw = value;
  if (typeof raw === "string") {
    if (utf8Bytes(raw) > OFFER_DOC_MAX_BYTES) throw new OfferPageError("$", `larger than ${OFFER_DOC_MAX_BYTES / 1024} KB`);
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new OfferPageError("$", "not valid JSON");
    }
  } else if (utf8Bytes(JSON.stringify(raw) ?? "") > OFFER_DOC_MAX_BYTES) {
    throw new OfferPageError("$", `larger than ${OFFER_DOC_MAX_BYTES / 1024} KB`);
  }
  const o = obj(raw, "$");
  onlyKeys(o, ["v", "template", "theme", "nav", "hero", "sections", "book", "seo", "brief"], "$");
  if (o.v !== 1) throw new OfferPageError("$.v", "expected version 1");
  if (typeof o.template !== "string" || !TEMPLATE_KEYS.includes(o.template as TemplateKey)) {
    throw new OfferPageError("$.template", `expected one of ${TEMPLATE_KEYS.join(", ")}`);
  }

  const themeIn = obj(o.theme, "$.theme");
  onlyKeys(themeIn, ["canvas", "accent", "logo"], "$.theme");
  if (themeIn.canvas !== "dark") throw new OfferPageError("$.theme.canvas", "only the dark canvas is available");
  const theme: OfferPageDoc["theme"] = { canvas: "dark" };
  if (themeIn.accent !== undefined && themeIn.accent !== null && themeIn.accent !== "") {
    if (!isHexColor(themeIn.accent)) throw new OfferPageError("$.theme.accent", "expected a colour like #00D4FF");
    if (!accentPassesAA(themeIn.accent)) {
      throw new OfferPageError("$.theme.accent", "too dark to read on the page (needs 4.5:1 contrast)");
    }
    theme.accent = themeIn.accent.toUpperCase();
  }
  if (themeIn.logo !== undefined) {
    if (themeIn.logo !== "workspace" && themeIn.logo !== "none") throw new OfferPageError("$.theme.logo", "expected workspace or none");
    theme.logo = themeIn.logo;
  }

  const sectionsIn = o.sections;
  if (!Array.isArray(sectionsIn)) throw new OfferPageError("$.sections", "expected a list");
  if (sectionsIn.length > BODY_KEYS.length) throw new OfferPageError("$.sections", "each section at most once");
  const sections = sectionsIn.map((s, i) => parseSection(s, `$.sections[${i}]`));
  const seen = new Set<string>();
  sections.forEach((s, i) => {
    if (seen.has(s.key)) throw new OfferPageError(`$.sections[${i}].key`, `${s.key} appears twice`);
    seen.add(s.key);
  });

  const navIn = obj(o.nav, "$.nav");
  onlyKeys(navIn, ["pinned", "cta_label"], "$.nav");
  if (!Array.isArray(navIn.pinned)) throw new OfferPageError("$.nav.pinned", "expected a list");
  const pinned: BodyKey[] = [];
  navIn.pinned.forEach((k, i) => {
    if (typeof k !== "string" || !BODY_KEYS.includes(k as BodyKey)) {
      throw new OfferPageError(`$.nav.pinned[${i}]`, "not a section");
    }
    if (!pinned.includes(k as BodyKey)) pinned.push(k as BodyKey);
  });
  const nav: OfferPageDoc["nav"] = { pinned };
  const navCta = optCopy(navIn, "cta_label", "$.nav", COPY_CAPS.cta_label);
  if (navCta) nav.cta_label = navCta;

  const heroIn = obj(o.hero, "$.hero");
  onlyKeys(
    heroIn,
    ["eyebrow", "headline", "subheadline", "cta_label", "video", "vsl_script", "show_transcript", "booking_card"],
    "$.hero",
  );
  const hero: Hero = {};
  for (const [key, cap] of [
    ["eyebrow", COPY_CAPS.eyebrow],
    ["headline", COPY_CAPS.headline],
    ["subheadline", COPY_CAPS.subheadline],
    ["cta_label", COPY_CAPS.cta_label],
  ] as const) {
    const t = optCopy(heroIn, key, "$.hero", cap);
    if (t) hero[key] = t;
  }
  if (heroIn.video !== undefined && heroIn.video !== null) hero.video = parseVideoRef(heroIn.video, "$.hero.video");
  if (heroIn.vsl_script !== undefined && heroIn.vsl_script !== null) {
    const s = obj(heroIn.vsl_script, "$.hero.vsl_script");
    onlyKeys(s, ["text", "source", "pack_id"], "$.hero.vsl_script");
    if (s.source !== "maven" && s.source !== "cc") throw new OfferPageError("$.hero.vsl_script.source", "expected maven or cc");
    const text = reqCopy(s, "text", "$.hero.vsl_script", COPY_CAPS.vsl_script);
    const script: NonNullable<Hero["vsl_script"]> = { text, source: s.source };
    if (s.pack_id !== undefined && s.pack_id !== null) script.pack_id = idOf(s.pack_id, "$.hero.vsl_script.pack_id");
    if (text) hero.vsl_script = script;
  }
  const transcript = optBool(heroIn, "show_transcript", "$.hero");
  if (transcript !== undefined) hero.show_transcript = transcript;
  const card = optBool(heroIn, "booking_card", "$.hero");
  if (card !== undefined) hero.booking_card = card;

  const bookIn = obj(o.book, "$.book");
  onlyKeys(bookIn, ["mode", "qualify", "native", ...HEAD_KEYS], "$.book");
  if (bookIn.mode === "native" || bookIn.native !== undefined) {
    throw new OfferPageError("$.book.mode", "booking on the page is not available yet");
  }
  if (bookIn.mode !== "form" && bookIn.mode !== "form_then_link") {
    throw new OfferPageError("$.book.mode", "expected form or form_then_link");
  }
  if (bookIn.qualify !== "before" && bookIn.qualify !== "after") {
    throw new OfferPageError("$.book.qualify", "expected before or after");
  }
  const book: BookSection = { ...parseHead(bookIn, "$.book"), mode: bookIn.mode, qualify: bookIn.qualify };
  delete book.hidden;

  const seoIn = obj(o.seo, "$.seo");
  onlyKeys(seoIn, ["title", "description", "og_image", "indexable"], "$.seo");
  if (seoIn.indexable !== false) throw new OfferPageError("$.seo.indexable", "offer pages stay out of search results");
  const seo: OfferPageDoc["seo"] = { indexable: false };
  const seoTitle = optCopy(seoIn, "title", "$.seo", COPY_CAPS.seo_title);
  const seoDescription = optCopy(seoIn, "description", "$.seo", COPY_CAPS.seo_description);
  if (seoTitle) seo.title = seoTitle;
  if (seoDescription) seo.description = seoDescription;
  if (seoIn.og_image !== undefined && seoIn.og_image !== null) seo.og_image = parseImageRef(seoIn.og_image, "$.seo.og_image");

  const doc: OfferPageDoc = {
    v: 1,
    template: o.template as TemplateKey,
    theme,
    nav,
    hero,
    sections,
    book,
    seo,
  };

  if (o.brief !== undefined && o.brief !== null) {
    const b = obj(o.brief, "$.brief");
    const keys = ["audience", "promise", "included", "proof_available", "price", "bonuses", "guarantee"] as const;
    onlyKeys(b, [...keys, "requested_at"], "$.brief");
    const brief: OfferBrief = {};
    for (const k of keys) {
      const t = optCopy(b, k, "$.brief", COPY_CAPS.brief);
      if (t) brief[k] = t;
    }
    if (b.requested_at !== undefined && b.requested_at !== null) brief.requested_at = isoOf(b.requested_at, "$.brief.requested_at");
    if (Object.keys(brief).length) doc.brief = brief;
  }
  return doc;
}

/** The published copy never carries the brief: it is the owner's notes, not page content. */
export function withoutBrief(doc: OfferPageDoc): OfferPageDoc {
  const copy: OfferPageDoc = { ...doc };
  delete copy.brief;
  return copy;
}

/** A body section by key, or undefined. */
export function sectionOf<K extends BodyKey>(doc: OfferPageDoc, key: K): Extract<BodySection, { key: K }> | undefined {
  return doc.sections.find((s) => s.key === key) as Extract<BodySection, { key: K }> | undefined;
}
