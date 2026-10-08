/**
 * lib/offer-pages/templates.ts - the three ways to start an offer page.
 *
 * STRUCTURE ONLY (design section 2.2). A template decides which sections a
 * page starts with, their order, which ones sit in the top menu, and how the
 * Book section behaves. It holds NO copy: every heading, body, result and
 * value is empty until a person writes it, and an empty section is not drawn.
 * The builder's placeholders are input hints, never saved.
 *
 * The form fields each template starts with are a form's structure (name,
 * email, mobile...), the same neutral labels today's starter uses.
 *
 * Pure and client-safe: the builder's template picker imports it.
 */
import type { FormStep } from "@/lib/forms/types";
import type { BodyKey, BodySection, OfferPageDoc, TemplateKey } from "./types";

export type OfferTemplate = {
  key: TemplateKey;
  /** The picker's name for it. */
  label: string;
  /** One line, in the picker. */
  summary: string;
  sections: BodyKey[];
  pinned: BodyKey[];
  book: OfferPageDoc["book"];
};

export const OFFER_TEMPLATES: readonly OfferTemplate[] = [
  {
    key: "book_call",
    label: "Book a call (VSL)",
    summary: "A video up top, the case for it below, and the booking step at the end.",
    sections: ["what_you_get", "obstacles", "work", "results", "bonuses", "guarantee", "faq"],
    pinned: ["what_you_get", "results", "bonuses"],
    book: { mode: "form_then_link", qualify: "after" },
  },
  {
    key: "free_audit",
    label: "Free audit",
    summary: "A short qualifier people fill in to get something useful back.",
    sections: ["what_you_get", "results", "faq"],
    pinned: ["what_you_get", "results"],
    book: { mode: "form_then_link", qualify: "after" },
  },
  {
    key: "application",
    label: "Application",
    summary: "For an offer people apply to: who it is for, the proof, then the questions.",
    sections: ["obstacles", "results", "faq"],
    pinned: ["obstacles", "results"],
    book: { mode: "form", qualify: "before" },
  },
];

export function templateFor(key: TemplateKey): OfferTemplate {
  const t = OFFER_TEMPLATES.find((x) => x.key === key);
  if (!t) throw new Error(`unknown offer template: ${key}`);
  return t;
}

function emptySection(key: BodyKey): BodySection {
  if (key === "guarantee") return { key: "guarantee" };
  if (key === "bonuses") return { key: "bonuses", items: [] };
  return { key, items: [] } as BodySection;
}

/**
 * A new page for a template. The only words it carries are the ones the form
 * already shows (its headline and subheadline), passed in by the caller, so
 * turning a live form into an offer page invents nothing.
 */
export function emptyDocForTemplate(
  key: TemplateKey,
  existing: { headline?: string | null; subheadline?: string | null } = {},
): OfferPageDoc {
  const t = templateFor(key);
  const hero: OfferPageDoc["hero"] = {};
  if (existing.headline && existing.headline.trim()) hero.headline = existing.headline.trim().slice(0, 140);
  if (existing.subheadline && existing.subheadline.trim()) hero.subheadline = existing.subheadline.trim().slice(0, 400);
  return {
    v: 1,
    template: key,
    theme: { canvas: "dark", logo: "workspace" },
    nav: { pinned: [...t.pinned] },
    hero,
    sections: t.sections.map(emptySection),
    book: { ...t.book },
    seo: { indexable: false },
  };
}

const CONTACT_STEP: FormStep = {
  key: "contact",
  title: "Your details",
  fields: [
    { name: "name", label: "Your name", type: "text", required: true },
    { name: "email", label: "Email", type: "email", required: true },
    { name: "phone", label: "Mobile number", type: "phone", required: true },
    { name: "company", label: "Company", type: "text" },
    { name: "website", label: "Website", type: "text" },
  ],
};

/** The form a new offer starts with: the contact step, plus one open question to edit. */
export function starterStepsForTemplate(key: TemplateKey): FormStep[] {
  if (key === "book_call") return [CONTACT_STEP];
  return [
    CONTACT_STEP,
    {
      key: "details",
      title: key === "application" ? "About you" : "About your situation",
      fields: [{ name: "details", label: "Tell us a little about where you are now", type: "textarea" }],
    },
  ];
}
