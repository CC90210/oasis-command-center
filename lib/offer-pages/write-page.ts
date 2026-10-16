/**
 * "Write my page" (#592 V1; CC, 2026-10-16: "when we create new ones, it
 * automatically creates new landing pages ... a cool description of the
 * product and the offer and what it does").
 *
 * From an offer's name and a short description, the workspace's own AI account
 * drafts the words of a new offer page: the hero, the problems it solves, what
 * the buyer gets, how it works, an FAQ, the booking section's title and the
 * link preview. app/api/forms/[id]/offer/write/route.ts calls the model and
 * saves the result as the DRAFT; nothing here publishes.
 *
 * WHAT IT NEVER WRITES. Prices, results, testimonials, bonus values,
 * guarantees and any owner confirmation: those are facts an owner supplies and
 * confirms (lib/offer-pages/claims.ts publishGate), so the model is told not to
 * invent them and this file has nowhere to put them. The claims gate still
 * reads every generated sentence before Publish.
 *
 * WHAT IT NEVER OVERWRITES. A field that already holds words keeps them; only
 * empty fields and empty sections are filled, so running it on a page an owner
 * or Maven has written changes nothing they wrote.
 *
 * Pure: no model call, no database. The result always passes
 * parseOfferPageDoc (lib/offer-pages/types.ts) or this throws its
 * OfferPageError. ASCII only (tests/worker-source-one-byte.test.ts).
 */

import { INJECTION_GUARD, safeJsonExtract, wrapUntrusted } from "@/lib/llm-input-boundary";
import { templateFor } from "./templates";
import { COPY_CAPS, ITEM_CAPS, parseOfferPageDoc, type OfferPageDoc, type TemplateKey } from "./types";

export const WRITE_PAGE_LIMITS = { description: 2000, audience: 300 } as const;

type Item = { title: string; body: string };
type Faq = { q: string; a: string };
type WrittenHead = { title?: string; lede?: string };

export type WrittenCopy = {
  hero: { eyebrow?: string; headline?: string; subheadline?: string; cta_label?: string };
  obstacles: WrittenHead & { items: Item[] };
  what_you_get: WrittenHead & { items: Item[] };
  work: WrittenHead & { items: Item[] };
  faq: WrittenHead & { items: Faq[] };
  book: WrittenHead;
  seo: { title?: string; description?: string };
};

export type WritePageInput = {
  offerName: string;
  description: string;
  audience?: string;
  businessName: string;
  template: TemplateKey;
};

// -- Prompts ---------------------------------------------------------------

export function writePageSystemPrompt(): string {
  return [
    "You write the words of a landing page for a business's own offer.",
    "Write plainly and specifically, in the second person, in short sentences. Describe what the offer does, who it is for, the problems it solves and what the buyer gets, using only what the description says.",
    "NEVER invent facts. Do not write any number, percentage, price, money amount, time frame, count of clients or results, testimonial, guarantee, award, ranking or superlative (best, #1, leading) unless the description states it word for word. If it states none, write without them.",
    "No markup, no HTML, no emoji, no em dashes. Plain sentences only.",
    "Answer with ONE JSON object and nothing else, exactly this shape (every field a string; arrays as described):",
    JSON.stringify({
      hero: { eyebrow: "short label", headline: "the promise", subheadline: "one or two sentences", cta_label: "button words" },
      obstacles: { title: "section title", lede: "one sentence", items: [{ title: "a problem", body: "one or two sentences" }] },
      what_you_get: { title: "section title", lede: "one sentence", items: [{ title: "a deliverable", body: "one or two sentences" }] },
      work: { title: "how it works", lede: "one sentence", items: [{ title: "a step", body: "one or two sentences" }] },
      faq: { title: "section title", items: [{ q: "a question a buyer asks", a: "a plain answer" }] },
      book: { title: "the booking section's title", lede: "one sentence" },
      seo: { title: "under 70 characters", description: "under 200 characters" },
    }),
    "Write 3 to 5 obstacles, 3 to 6 deliverables, exactly 3 steps and 3 to 5 FAQ items.",
    INJECTION_GUARD,
  ].join("\n\n");
}

export function writePageUserPrompt(input: WritePageInput): string {
  const template = templateFor(input.template);
  return [
    `Business: ${input.businessName.slice(0, 120)}`,
    `Offer name: ${input.offerName.slice(0, 120)}`,
    `Page type: ${template.label} (${template.summary})`,
    "What the owner says the offer is and does:",
    wrapUntrusted(input.description, { label: "offer description", maxLen: WRITE_PAGE_LIMITS.description }),
    input.audience
      ? `Who it is for:\n${wrapUntrusted(input.audience, { label: "audience", maxLen: WRITE_PAGE_LIMITS.audience })}`
      : "",
    "Write the page now. JSON only.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// -- Reading the model's answer -------------------------------------------

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function head(value: unknown): WrittenHead {
  const o = obj(value);
  return { title: str(o.title), lede: str(o.lede) };
}

/** The model's JSON as WrittenCopy, or null when it is not an object with at least a hero. */
export function parseWrittenCopy(text: string): WrittenCopy | null {
  const root = obj(safeJsonExtract(text));
  const hero = obj(root.hero);
  if (!Object.keys(hero).length) return null;
  const items = (v: unknown): Item[] =>
    arr(obj(v).items).map((it) => ({ title: str(obj(it).title), body: str(obj(it).body) }));
  return {
    hero: { eyebrow: str(hero.eyebrow), headline: str(hero.headline), subheadline: str(hero.subheadline), cta_label: str(hero.cta_label) },
    obstacles: { ...head(root.obstacles), items: items(root.obstacles) },
    what_you_get: { ...head(root.what_you_get), items: items(root.what_you_get) },
    work: { ...head(root.work), items: items(root.work) },
    faq: { ...head(root.faq), items: arr(obj(root.faq).items).map((it) => ({ q: str(obj(it).q), a: str(obj(it).a) })) },
    book: head(root.book),
    seo: { title: str(obj(root.seo).title), description: str(obj(root.seo).description) },
  };
}

/**
 * One generated string made safe for the page document, which REFUSES rather
 * than trims: no control characters, nothing tag-like ("<" before a letter),
 * no em or en dashes, collapsed whitespace, cut at a word inside `cap`.
 */
export function cleanCopy(value: string | undefined, cap: number): string {
  let text = String(value ?? "")
    // Control characters (keep none: copy is single-line prose).
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    // Em and en dashes become a plain comma pause.
    .replace(/\s*[\u2013\u2014]\s*/g, ", ")
    // Anything the parser reads as markup.
    .replace(/<(?=\s*[A-Za-z!/?])/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > cap) {
    const cut = text.slice(0, cap);
    const lastSpace = cut.lastIndexOf(" ");
    text = (lastSpace > cap * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:]+$/, "").trim();
  }
  return text;
}

// -- Filling the draft ------------------------------------------------------

/** Fill an empty Head title and lede; true when either was filled. */
function fillHead(target: { title?: string; lede?: string }, source: WrittenHead): boolean {
  let touched = false;
  if (!(target.title || "").trim()) {
    const title = cleanCopy(source.title, COPY_CAPS.title);
    if (title) {
      target.title = title;
      touched = true;
    }
  }
  if (!(target.lede || "").trim()) {
    const lede = cleanCopy(source.lede, COPY_CAPS.lede);
    if (lede) {
      target.lede = lede;
      touched = true;
    }
  }
  return touched;
}

/** A section's cards from the model, cleaned and capped; titles required, bodies optional. */
function cardsFrom(source: Item[], cap: number): Array<{ title: string; body?: string }> {
  return source
    .map((it) => {
      const title = cleanCopy(it.title, COPY_CAPS.title);
      const body = cleanCopy(it.body, COPY_CAPS.body);
      return body ? { title, body } : { title };
    })
    .filter((it) => it.title)
    .slice(0, cap);
}

/**
 * The draft with every EMPTY field the template has filled from the model's
 * copy, plus the owner's description kept in the page brief (never published).
 * Returns the parsed document and the list of parts it filled; throws
 * OfferPageError (from parseOfferPageDoc) if the result could not be stored.
 */
export function applyWrittenCopy(
  base: OfferPageDoc,
  written: WrittenCopy,
  brief: { description?: string; audience?: string } = {},
): { doc: OfferPageDoc; filled: string[] } {
  const doc = structuredClone(base) as OfferPageDoc;
  const filled = new Set<string>();

  const heroCaps = { eyebrow: COPY_CAPS.eyebrow, headline: COPY_CAPS.headline, subheadline: COPY_CAPS.subheadline, cta_label: COPY_CAPS.cta_label } as const;
  for (const field of Object.keys(heroCaps) as Array<keyof typeof heroCaps>) {
    if ((doc.hero[field] || "").trim()) continue;
    const text = cleanCopy(written.hero[field], heroCaps[field]);
    if (text) {
      doc.hero[field] = text;
      filled.add("hero");
    }
  }

  // Only the four sections this writer owns, and only those the template has:
  // results, bonuses, pricing and guarantee are owner facts (header).
  for (const section of doc.sections) {
    switch (section.key) {
      case "obstacles":
      case "what_you_get":
      case "work": {
        const source = written[section.key];
        let touched = fillHead(section, source);
        if (section.items.length === 0) {
          const items = cardsFrom(source.items, ITEM_CAPS[section.key]);
          if (items.length) {
            section.items = items;
            touched = true;
          }
        }
        if (touched) filled.add(section.key);
        break;
      }
      case "faq": {
        let touched = fillHead(section, written.faq);
        if (section.items.length === 0) {
          const items = written.faq.items
            .map((it) => ({ q: cleanCopy(it.q, COPY_CAPS.faq_q), a: cleanCopy(it.a, COPY_CAPS.faq_a) }))
            .filter((it) => it.q && it.a)
            .slice(0, ITEM_CAPS.faq);
          if (items.length) {
            section.items = items;
            touched = true;
          }
        }
        if (touched) filled.add("faq");
        break;
      }
      default:
        break;
    }
  }

  if (fillHead(doc.book, written.book)) filled.add("book");

  const seoTitle = cleanCopy(written.seo.title, COPY_CAPS.seo_title);
  if (!(doc.seo.title || "").trim() && seoTitle) {
    doc.seo.title = seoTitle;
    filled.add("seo");
  }
  const seoDescription = cleanCopy(written.seo.description, COPY_CAPS.seo_description);
  if (!(doc.seo.description || "").trim() && seoDescription) {
    doc.seo.description = seoDescription;
    filled.add("seo");
  }

  // The owner's own words about the offer, kept for the next writer (Maven or
  // a re-run). The brief is never published (lib/offer-pages/types.ts).
  const promise = cleanCopy(brief.description, COPY_CAPS.brief);
  const audience = cleanCopy(brief.audience, COPY_CAPS.brief);
  if (promise && !(doc.brief?.promise || "").trim()) doc.brief = { ...(doc.brief ?? {}), promise };
  if (audience && !(doc.brief?.audience || "").trim()) doc.brief = { ...(doc.brief ?? {}), audience };

  return { doc: parseOfferPageDoc(doc), filled: [...filled] };
}
