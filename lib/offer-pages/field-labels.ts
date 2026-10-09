/**
 * lib/offer-pages/field-labels.ts - a refused field, in the builder's words.
 *
 * The parser (types.ts) and the builder routes refuse a save with a path, such
 * as "$.sections[2].items[1].title", "$.hero.headline" or a video ref such as
 * "work:1". The owner sees "Bonus 2 title", "Headline" or "Our work item 2
 * video" instead, never the path itself.
 *
 * Pure and ASCII: the builder imports it.
 */
import type { BodyKey, OfferPageDoc } from "./types";
import { NAV_LABELS } from "./visibility";

/** How one item of each section is named: "Bonus 2", "Question 3". */
const ITEM_NOUN: Readonly<Record<BodyKey, string>> = {
  what_you_get: "What you get item",
  obstacles: "Challenge",
  work: "Our work item",
  results: "Result",
  bonuses: "Bonus",
  guarantee: "Guarantee",
  faq: "Question",
};

/** The last part of a path, in words. */
const FIELD: Readonly<Record<string, string>> = {
  eyebrow: "small label",
  headline: "headline",
  subheadline: "subheadline",
  cta_label: "button label",
  title: "title",
  lede: "intro",
  body: "text",
  quote: "quote",
  who: "name",
  role: "role",
  label: "label",
  value: "value",
  source: "source",
  alt: "image description",
  q: "question",
  a: "answer",
  value_note: "value footnote",
  terms_url: "terms link",
  video: "video",
  image: "image",
  proof: "proof image",
  evidence: "evidence",
  permission: "client's permission",
  confirmed: "owner's confirmation",
  rights: "video rights tick",
  cents: "amount",
  currency: "currency",
  aspect: "video shape",
  duration_s: "video length",
  thumb_path: "video thumbnail",
  vsl_script: "video script",
  show_transcript: "transcript switch",
  hidden: "show or hide switch",
  key: "section",
  items: "items",
};

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "Bonus 2", or "Item 2" when the section is unknown. */
function itemName(key: BodyKey | undefined, index: number): string {
  return `${key ? ITEM_NOUN[key] : "Item"} ${index + 1}`;
}

/**
 * The words for a path the parser or a builder route refused. Anything it
 * does not recognise is "This page", never the raw path.
 */
export function fieldLabel(path: string | undefined | null, doc?: OfferPageDoc | null): string {
  const p = String(path ?? "").trim();
  // A video ref from the Library check: "hero", "work:1".
  const ref = /^(hero|what_you_get|work|results)(?::([0-9]{1,2}))?$/.exec(p);
  if (ref) return ref[1] === "hero" ? "Top video" : `${itemName(ref[1] as BodyKey, Number(ref[2] ?? 0))} video`;
  if (!p.startsWith("$")) return "This page";
  const parts = [...p.slice(1).matchAll(/\.?([a-z_]+)(?:\[([0-9]+)\])?/g)].map((m) => ({ name: m[1], index: m[2] === undefined ? null : Number(m[2]) }));
  if (!parts.length) return "This page";
  const last = parts[parts.length - 1].name;
  const field = FIELD[last] ?? "";
  const [area, ...rest] = parts;
  switch (area.name) {
    case "hero":
      if (rest.some((r) => r.name === "video")) return "Top video";
      if (rest.some((r) => r.name === "vsl_script")) return "Video script";
      return cap(field) || "Top of the page";
    case "nav":
      if (last === "pinned") return "Top menu";
      return last === "cta_label" ? "Header button label" : "Header";
    case "book":
      return `Book section ${field || "settings"}`;
    case "seo":
      if (last === "title") return "Browser tab title";
      if (last === "description") return "Link preview description";
      if (last === "og_image") return "Link preview image";
      return "Link preview";
    case "theme":
      if (last === "accent") return "Accent colour";
      if (last === "logo") return "Logo setting";
      return "Page look";
    case "brief":
      return "Copy brief";
    case "template":
      return "Template";
    case "sections": {
      if (area.index === null) return "Sections";
      const key = doc?.sections?.[area.index]?.key as BodyKey | undefined;
      const items = rest.find((r) => r.name === "items");
      if (items && items.index !== null) {
        const name = itemName(key, items.index);
        return last === "items" ? name : `${name} ${field}`.trim();
      }
      const section = key ? `${NAV_LABELS[key]} section` : `Section ${area.index + 1}`;
      return last === "sections" ? section : `${section} ${field}`.trim();
    }
    default:
      return "This page";
  }
}
