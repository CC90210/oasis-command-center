/**
 * lib/playbook/templates - "Draft it". A deterministic skeleton per stored
 * document, filled only from verified constants and tables
 * (templates/context.ts). No AI model: the same facts give the same draft, in
 * well under a second.
 *
 * tests/playbook-docs.test.ts fails when a stored catalog document has no
 * template here (its "Draft it" would dead-end) or a template names a slug the
 * catalog does not have.
 */

import type { CatalogDoc } from "../catalog";
import { BUSINESS_TEMPLATES } from "./business";
import { LEGAL_TEMPLATES } from "./legal";
import type { TemplateContext } from "./context";
import type { DocTemplate } from "./shared";

export const TEMPLATES: Readonly<Record<string, DocTemplate>> = { ...LEGAL_TEMPLATES, ...BUSINESS_TEMPLATES };

export function hasTemplate(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, slug);
}

/** The draft text for `doc`. Throws when the document has no template. */
export function renderTemplate(doc: Pick<CatalogDoc, "slug">, ctx: TemplateContext): string {
  const t = TEMPLATES[doc.slug];
  if (!t) throw new Error(`No template for "${doc.slug}"`);
  return t(ctx);
}

export { loadTemplateContext, legalFacts, confirm, type TemplateContext } from "./context";
