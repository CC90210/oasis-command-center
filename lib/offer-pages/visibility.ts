/**
 * lib/offer-pages/visibility.ts - what an offer page actually draws.
 *
 * "HIDDEN WHEN EMPTY" (design sections 2.3 and 3.4). A section is drawn only
 * when it holds real content, and an incomplete item is dropped, never filled
 * with a default:
 *
 *   hero          always; its headline falls back to the form's own headline
 *   what you get  items with a title (an item's video only when it can play)
 *   obstacles     items with a title
 *   our work      items whose video can play
 *   results       items with evidence, the client's permission and an owner's
 *                 confirmation, and their content complete
 *   bonuses       items with a title; a value only when an owner confirmed it;
 *                 the total only when EVERY bonus has a confirmed value in one
 *                 currency; the value footnote only next to a confirmed value
 *   guarantee     a body an owner confirmed
 *   faq           questions with an answer
 *   book          always, last (the form lives there)
 *
 * The top menu lists only sections that are drawn AND pinned.
 *
 * Pure: the public page, the builder's status chips and the tests share it.
 * Whether a video can play or an image can be shown is the caller's answer
 * (`media`), because only the server can check a Library asset.
 */
import type {
  BodyKey,
  BookSection,
  Confirmation,
  Head,
  ImageRef,
  Money,
  OfferPageDoc,
  ResultItem,
  VideoRef,
} from "./types";
import { BODY_ANCHORS } from "./types";
import type { VideoAt } from "./providers";

export type { VideoAt };

/** The caller's answer to "can this be shown?". */
export type MediaCheck = {
  /** Can the video at `ref` play? A link always can; a Library video only when it resolved. */
  video(ref: string, video: VideoRef): boolean;
  /** Can this Library image be shown? */
  image(image: ImageRef): boolean;
};

export type DrawnSection =
  | { key: "what_you_get"; head: Head; items: { index: number; title: string; body?: string; video: VideoAt | null }[] }
  | { key: "obstacles"; head: Head; items: { index: number; title: string; body?: string }[] }
  | { key: "work"; head: Head; items: { index: number; title: string; body?: string; video: VideoAt }[] }
  | { key: "results"; head: Head; items: { index: number; item: ResultItem }[] }
  | {
      key: "bonuses";
      head: Head;
      items: { index: number; title: string; body?: string; value: Money | null }[];
      valueNote: string | null;
      total: { cents: number; currency: Money["currency"] } | null;
    }
  | { key: "guarantee"; head: Head; body: string; termsUrl: string | null }
  | { key: "faq"; head: Head; items: { q: string; a: string }[] };

export type DrawnPage = {
  hero: {
    eyebrow: string | null;
    headline: string;
    subheadline: string | null;
    ctaLabel: string | null;
    video: VideoAt | null;
    transcript: string | null;
  };
  sections: DrawnSection[];
  nav: { key: BodyKey; anchor: string; label: string }[];
  book: BookSection;
};

/** The menu's label for each section: navigation words, never claims. */
export const NAV_LABELS: Readonly<Record<BodyKey, string>> = {
  what_you_get: "What you get",
  obstacles: "Challenges",
  work: "Our work",
  results: "Results",
  bonuses: "Bonuses",
  guarantee: "Guarantee",
  faq: "FAQ",
};

/** An owner's confirmation: who and when, both present. */
export function isConfirmed(c: Confirmation | null | undefined): boolean {
  return !!c && typeof c.by === "string" && c.by.trim().length > 0 && typeof c.at === "string" && !Number.isNaN(Date.parse(c.at));
}

const filled = (s: string | undefined | null): s is string => typeof s === "string" && s.trim().length > 0;

/** Is this result item drawable? Evidence first, always: no evidence, no result. */
export function resultIsDrawable(item: ResultItem, ref: string, media: MediaCheck): boolean {
  if (!item || !item.evidence || item.evidence.permission !== true || !isConfirmed(item.evidence.confirmed)) return false;
  switch (item.kind) {
    case "screenshot":
      return filled(item.alt) && media.image(item.image);
    case "video":
      return media.video(ref, item.video);
    case "quote":
      return filled(item.quote) && filled(item.who);
    case "metric":
      return filled(item.value) && filled(item.label) && filled(item.source);
    default:
      return false;
  }
}

/** A money value is shown only when an owner confirmed it. */
export function shownValue(value: Money | null | undefined): Money | null {
  return value && isConfirmed(value.confirmed) && Number.isInteger(value.cents) && value.cents >= 0 ? value : null;
}

function headOf(s: Head): Head {
  const h: Head = {};
  if (filled(s.eyebrow)) h.eyebrow = s.eyebrow;
  if (filled(s.title)) h.title = s.title;
  if (filled(s.lede)) h.lede = s.lede;
  return h;
}

/** Every section this document draws, in its order, each holding only complete items. */
export function drawnSections(doc: OfferPageDoc, media: MediaCheck): DrawnSection[] {
  const out: DrawnSection[] = [];
  for (const s of doc.sections) {
    if (s.hidden) continue;
    const head = headOf(s);
    switch (s.key) {
      case "what_you_get": {
        const items = s.items
          .map((it, index) => ({ it, index }))
          .filter(({ it }) => filled(it.title))
          .map(({ it, index }) => {
            const ref = `what_you_get:${index}`;
            return {
              index,
              title: it.title,
              ...(filled(it.body) ? { body: it.body } : {}),
              video: it.video && media.video(ref, it.video) ? { ref, video: it.video } : null,
            };
          });
        if (items.length) out.push({ key: "what_you_get", head, items });
        break;
      }
      case "obstacles": {
        const items = s.items
          .map((it, index) => ({ it, index }))
          .filter(({ it }) => filled(it.title))
          .map(({ it, index }) => ({ index, title: it.title, ...(filled(it.body) ? { body: it.body } : {}) }));
        if (items.length) out.push({ key: "obstacles", head, items });
        break;
      }
      case "work": {
        const items = s.items
          .map((it, index) => ({ it, index, ref: `work:${index}` }))
          .filter(({ it, ref }) => !!it.video && media.video(ref, it.video))
          .map(({ it, index, ref }) => ({
            index,
            title: it.title,
            ...(filled(it.body) ? { body: it.body } : {}),
            video: { ref, video: it.video },
          }));
        if (items.length) out.push({ key: "work", head, items });
        break;
      }
      case "results": {
        const items = s.items
          .map((item, index) => ({ item, index }))
          .filter(({ item, index }) => resultIsDrawable(item, `results:${index}`, media));
        if (items.length) out.push({ key: "results", head, items });
        break;
      }
      case "bonuses": {
        const items = s.items
          .map((it, index) => ({ it, index }))
          .filter(({ it }) => filled(it.title))
          .map(({ it, index }) => ({
            index,
            title: it.title,
            ...(filled(it.body) ? { body: it.body } : {}),
            value: shownValue(it.value),
          }));
        if (!items.length) break;
        const values = items.map((i) => i.value);
        const anyValue = values.some(Boolean);
        const allSameCurrency =
          values.every(Boolean) && new Set(values.map((v) => (v as Money).currency)).size === 1;
        const total = allSameCurrency
          ? { cents: values.reduce((n, v) => n + (v as Money).cents, 0), currency: (values[0] as Money).currency }
          : null;
        out.push({
          key: "bonuses",
          head,
          items,
          valueNote: anyValue && filled(s.value_note) ? s.value_note : null,
          total,
        });
        break;
      }
      case "guarantee": {
        if (filled(s.body) && isConfirmed(s.confirmed)) {
          out.push({ key: "guarantee", head, body: s.body, termsUrl: s.terms_url ?? null });
        }
        break;
      }
      case "faq": {
        const items = s.items.filter((it) => filled(it.q) && filled(it.a)).map((it) => ({ q: it.q, a: it.a }));
        if (items.length) out.push({ key: "faq", head, items });
        break;
      }
    }
  }
  return out;
}

/** The menu: drawn and pinned, in the order the page draws them. */
export function navFor(doc: OfferPageDoc, drawn: DrawnSection[]): DrawnPage["nav"] {
  const pinned = new Set(doc.nav.pinned);
  return drawn
    .filter((s) => pinned.has(s.key))
    .map((s) => ({ key: s.key, anchor: BODY_ANCHORS[s.key], label: NAV_LABELS[s.key] }));
}

/** The whole page as it will be drawn. */
export function drawnPage(doc: OfferPageDoc, ctx: { fallbackHeadline: string; media: MediaCheck }): DrawnPage {
  const sections = drawnSections(doc, ctx.media);
  const heroVideo = doc.hero.video && ctx.media.video("hero", doc.hero.video) ? { ref: "hero", video: doc.hero.video } : null;
  const script = doc.hero.vsl_script?.text;
  return {
    hero: {
      eyebrow: filled(doc.hero.eyebrow) ? doc.hero.eyebrow : null,
      headline: filled(doc.hero.headline) ? doc.hero.headline : ctx.fallbackHeadline,
      subheadline: filled(doc.hero.subheadline) ? doc.hero.subheadline : null,
      ctaLabel: filled(doc.hero.cta_label) ? doc.hero.cta_label : null,
      video: heroVideo,
      // Under the video only: a script with nothing to watch reads as a wall of text.
      transcript: heroVideo && doc.hero.show_transcript && filled(script) ? script : null,
    },
    sections,
    nav: navFor(doc, sections),
    book: doc.book,
  };
}

/** "$1,200" / "CA$1,200" in en-CA, whole dollars when the cents are zero. */
export function formatMoney(m: { cents: number; currency: Money["currency"] }): string {
  const dollars = m.cents / 100;
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: m.currency,
    minimumFractionDigits: m.cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}
