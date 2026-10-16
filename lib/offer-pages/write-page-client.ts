/**
 * The browser side of "Write my page": one call both entry points share (New
 * offer in FormsListClient, Turn into an offer in TurnIntoOffer), so they ask
 * and report the same way. The route is app/api/forms/[id]/offer/write.
 */

/** Below this many characters the route refuses: there is too little to write from. */
export const WRITE_PAGE_MIN_DESCRIPTION = 20;

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
    return { ok: false, message: data?.message || "The page couldn't be written just now. Your draft is saved; try again from the builder." };
  } catch {
    return { ok: false, message: "The connection dropped while the page was being written. Your draft is saved; try again." };
  }
}
