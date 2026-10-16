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
import type { WrittenCopy } from "./write-page";

export const WRITE_PAGE_INPUT = { minDescription: 20, maxDescription: 2000, maxAudience: 300 } as const;

/** Why this description can't be written from, or null when it can. */
export function writePageInputProblem(description: string): string | null {
  return description.trim().length < WRITE_PAGE_INPUT.minDescription
    ? "Say in a sentence or two what the offer is and does, so the page can be written from it."
    : null;
}

/**
 * True when a section's card or FAQ item holds anything: words, or media such
 * as a step's video ({ title: "", video }, "Or add a step with its video").
 * The editor's Add buttons save blank placeholders ({ title: "" },
 * { q: "", a: "" }) that the page never draws, so a section of only those is
 * empty, and a write may replace them; never one holding a video.
 */
export function itemHasContent(item: object): boolean {
  return Object.values(item).some((value) =>
    typeof value === "string" ? value.trim() !== "" : value !== null && typeof value === "object",
  );
}

/**
 * The parts of a draft a write would still fill: what the prompt asks the
 * model for (writePageSystemPrompt) that the draft has empty. The route skips
 * the paid model call for a new offer's draft with none, and the offer editor
 * offers "Write the empty parts" only while its page has some. The FAQ has no
 * lede in the prompt, so an FAQ without one is not counted as empty.
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
        if (blank(section.title) || blank(section.lede) || !section.items.some(itemHasContent)) parts.push(section.key);
        break;
      case "faq":
        if (blank(section.title) || !section.items.some(itemHasContent)) parts.push("faq");
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
 * Two ways to ask. The New offer and Turn into an offer dialogs leave `save`
 * on: the route writes the words into the new page's draft and saves it. The
 * offer editor sends `save: false`: the route saves nothing and returns the
 * vetted `copy`, and the editor fills its own empty fields with it and saves
 * through its own autosave, so there is only ever one writer to the draft it
 * holds.
 */
export type WritePageOutcome =
  | { ok: true; filled: string[]; copy: WrittenCopy | null }
  | { ok: false; message: string };

export async function requestWrittenPage(
  formId: string,
  input: { description: string; audience?: string; save?: boolean },
): Promise<WritePageOutcome> {
  try {
    const res = await fetch(`/api/forms/${formId}/offer/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: input.description.trim(),
        audience: (input.audience || "").trim(),
        save: input.save !== false,
      }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; filled?: string[]; message?: string; copy?: WrittenCopy } | null;
    if (data?.ok) return { ok: true, filled: Array.isArray(data.filled) ? data.filled : [], copy: data.copy ?? null };
    return { ok: false, message: data?.message || "The page couldn't be written just now. Your draft is saved; try again in a minute." };
  } catch {
    return { ok: false, message: "The connection dropped while the page was being written. Your draft is saved; try again." };
  }
}
