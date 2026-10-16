/**
 * The browser side of "Write my page": one call every entry point shares (New
 * offer in FormsListClient, Turn into an offer in TurnIntoOffer, Write the
 * empty parts in the offer editor), so they ask and report the same way. The
 * route is app/api/forms/[id]/offer/write.
 *
 * The input limits live here, not in write-page.ts, so the browser can check
 * them without bundling the prompts; write-page.ts and the route read them
 * from here, so the dialog and the route refuse the same input.
 */

export const WRITE_PAGE_INPUT = { minDescription: 20, maxDescription: 2000, maxAudience: 300 } as const;

/** Why this description can't be written from, or null when it can. */
export function writePageInputProblem(description: string): string | null {
  return description.trim().length < WRITE_PAGE_INPUT.minDescription
    ? "Say in a sentence or two what the offer is and does, so the page can be written from it."
    : null;
}

export type WritePageOutcome = { ok: true; filled: string[] } | { ok: false; message: string };

export async function requestWrittenPage(
  formId: string,
  input: { description: string; audience?: string },
): Promise<WritePageOutcome> {
  try {
    const res = await fetch(`/api/forms/${formId}/offer/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: input.description.trim(), audience: (input.audience || "").trim() }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; filled?: string[]; message?: string } | null;
    if (data?.ok) return { ok: true, filled: Array.isArray(data.filled) ? data.filled : [] };
    return { ok: false, message: data?.message || "The page couldn't be written just now. Your draft is saved; try again in a minute." };
  } catch {
    return { ok: false, message: "The connection dropped while the page was being written. Your draft is saved; try again." };
  }
}
