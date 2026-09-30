/**
 * Shared pieces for the document templates. A template is a pure function of
 * TemplateContext: the same facts give the same text, and the only way a fact
 * enters a draft is through the context (templates/context.ts).
 */

import type { TemplateContext } from "./context";

export type DocTemplate = (ctx: TemplateContext) => string;

/** The first lines of every draft: title, provenance, and the rule for placeholders. */
export function header(title: string, ctx: TemplateContext, purpose: string): string {
  return [
    `# ${title}`,
    "",
    `_Draft generated ${ctx.today} by the OASIS Command Center from verified facts only. Every "CC to confirm" placeholder must be answered before this document can be marked current._`,
    "",
    purpose,
    "",
  ].join("\n");
}

export function section(title: string, ...lines: string[]): string {
  return [`## ${title}`, "", ...lines, ""].join("\n");
}

export function doc(...parts: string[]): string {
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** The business, as the legal constants name it. */
export function entityLine(ctx: TemplateContext): string {
  return `${ctx.legal.entity}, ${ctx.legal.principalPlace}`;
}

/** Processors outside Quebec, from the published sub-processor list. */
export function processorsOutsideQuebec(ctx: TemplateContext) {
  return ctx.legal.subprocessors.filter((s) => !/quebec/i.test(s.region));
}
