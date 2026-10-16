/**
 * The browser side of "Write my page": one call every entry point shares (New
 * offer in FormsListClient, Turn into an offer in TurnIntoOffer, Write the
 * empty parts in OfferBuilder), so they ask and report the same way. The route
 * is app/api/forms/[id]/offer/write.
 *
 * The input limits and emptyWritableParts live here, not in write-page.ts, so
 * the browser can use them without bundling the prompts; write-page.ts and the
 * route read them from here, so the screens and the route agree.
 */
import type { OfferPageDoc } from "./types";

export const WRITE_PAGE_INPUT = { minDescription: 20, maxDescription: 2000, maxAudience: 300 } as const;

/** Why this description can't be written from, or null when it can. */
export function writePageInputProblem(description: string): string | null {
  return description.trim().length < WRITE_PAGE_INPUT.minDescription
    ? "Say in a sentence or two what the offer is and does, so the page can be written from it."
    : null;
}

/**
 * The parts of a draft a write would still fill: what the prompt asks the
 * model for (writePageSystemPrompt) that the draft has empty. The route skips
 * the paid model call when this is empty, and the offer editor offers "Write
 * the empty parts" only while it is not. The FAQ has no lede in the prompt, so
 * an FAQ without one is not counted as empty.
 */
export function emptyWritableParts(doc: OfferPageDoc): string[] {
  const blank = (value: string | undefined) => !(value || "").trim();
  const parts: string[] = [];
  if (blank(doc.hero.eyebrow) || blank(doc.hero.headline) || blank(doc.hero.subheadline) || blank(doc.hero.cta_label)) {
    parts.push("hero");
  }
  for (const section of doc.sections) {
    switch (section.key) {
      case "obstacles":
      case "what_you_get":
      case "work":
        if (blank(section.title) || blank(section.lede) || section.items.length === 0) parts.push(section.key);
        break;
      case "faq":
        if (blank(section.title) || section.items.length === 0) parts.push("faq");
        break;
      default:
        break;
    }
  }
  if (blank(doc.book.title) || blank(doc.book.lede)) parts.push("book");
  if (blank(doc.seo.title) || blank(doc.seo.description)) parts.push("seo");
  return parts;
}

/**
 * `offer` is the page as the route left it (the same shape the builder's own
 * save returns), on failures too: the route saves the owner's description
 * before the model call, so a failed write can still have moved the draft on.
 */
export type WritePageOutcome =
  | { ok: true; filled: string[]; offer: unknown }
  | { ok: false; message: string; offer: unknown };

export async function requestWrittenPage(
  formId: string,
  input: { description: string; audience?: string; expectedVersion?: number },
): Promise<WritePageOutcome> {
  try {
    const res = await fetch(`/api/forms/${formId}/offer/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: input.description.trim(),
        audience: (input.audience || "").trim(),
        ...(typeof input.expectedVersion === "number" ? { expected_version: input.expectedVersion } : {}),
      }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; filled?: string[]; message?: string; offer?: unknown } | null;
    const offer = data?.offer ?? null;
    if (data?.ok) return { ok: true, filled: Array.isArray(data.filled) ? data.filled : [], offer };
    return { ok: false, message: data?.message || "The page couldn't be written just now. Your draft is saved; try again in a minute.", offer };
  } catch {
    return { ok: false, message: "The connection dropped while the page was being written. Your draft is saved; try again.", offer: null };
  }
}
