"use client";

/**
 * "Write the empty parts" in the offer editor (OfferBuilder): the way to try
 * "Write my page" (lib/offer-pages/write-page.ts) again after a write failed
 * at creation, and to fill a page whose sections are still empty. Shown only
 * while the page has parts a write would fill (emptyWritableParts).
 *
 * ONE WRITER. The route saves nothing here (save: false): it returns vetted
 * copy, and the editor fills the fields that are still empty on the page it
 * holds when the answer arrives, then saves through its own autosave. An edit
 * made while the words were being written is kept, and no save can race the
 * editor's. The description box edits the page's own brief (the same field as
 * the Copy brief's "The promise"), so the two can never disagree.
 */
import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { WritePageDescription } from "@/components/offer-pages/WritePageFields";
import type { OfferPageDoc } from "@/lib/offer-pages/types";
import type { WrittenCopy } from "@/lib/offer-pages/write-page";
import { emptyWritableParts, requestWrittenPage, writePageInputProblem } from "@/lib/offer-pages/write-page-client";

const PART_LABELS: Record<string, string> = {
  hero: "the top of the page",
  obstacles: "the problems it solves",
  what_you_get: "what you get",
  work: "how it works",
  faq: "the FAQ",
  book: "the booking section",
  seo: "the link preview",
};

const named = (parts: string[]) => parts.map((p) => PART_LABELS[p] ?? p).join(", ");

export function WriteEmptyParts({
  formId,
  doc,
  onBrief,
  onCopy,
  saveFailed,
}: {
  formId: string;
  doc: OfferPageDoc;
  /** The owner typed in the description box: the page's brief promise. */
  onBrief: (promise: string) => void;
  /**
   * Fill the page's empty fields from vetted copy written from `asked`: the
   * parts filled, or why the editor refused it (its saves are stopped, or the
   * brief changed while the words were being written).
   */
  onCopy: (copy: WrittenCopy, asked: { description: string; audience: string }) => string[] | "conflict" | "brief_changed";
  /** The editor's last save failed: words written now might not be kept, so none are asked for. */
  saveFailed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const parts = emptyWritableParts(doc);
  if (parts.length === 0 && !notice) return null;
  const description = doc.brief?.promise ?? "";

  async function write() {
    if (saveFailed) return;
    const problem = writePageInputProblem(description);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    setNotice(null);
    const asked = { description, audience: doc.brief?.audience ?? "" };
    const written = await requestWrittenPage(formId, { ...asked, save: false });
    setBusy(false);
    if (!written.ok) return setError(written.message);
    let filled: string[] | "conflict" | "brief_changed" = [];
    try {
      filled = written.copy ? onCopy(written.copy, asked) : [];
    } catch {
      return setError("The words that came back couldn't be put on this page. Try again.");
    }
    if (filled === "conflict") {
      return setError("This page has a change that couldn't be saved, so the new words weren't added. Reload the page, then try again.");
    }
    if (filled === "brief_changed") {
      return setError("The description changed while the page was being written, so those words weren't added. Write again to use the new description.");
    }
    if (filled.length === 0) {
      return setError("Nothing usable came back for the empty parts. Try again, or say a little more about the offer.");
    }
    setOpen(false);
    setNotice(`Written: ${named(filled)}. Read it through, and set prices yourself, before you publish.`);
  }

  return (
    <div className="space-y-3 rounded-xl border border-bg-border bg-bg-elev/40 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Sparkles className="h-4 w-4 text-accent" />
        <div className="min-w-0 flex-1 text-sm text-fg">
          {parts.length ? `Some parts of this page have no words yet: ${named(parts)}.` : notice}
        </div>
        {open || parts.length === 0 ? null : (
          <button type="button" className="btn-primary !px-3 !py-1.5 text-xs" onClick={() => setOpen(true)}>
            Write them for me
          </button>
        )}
      </div>
      {parts.length && notice ? <p className="text-[13px] text-fg-muted">{notice}</p> : null}
      {open ? (
        <>
          <WritePageDescription value={description} onChange={onBrief} disabled={busy} />
          <p className="text-xs text-fg-muted">
            Only the empty parts are written; anything already on the page stays as it is. It stays a draft: you
            review it, and set prices yourself, before it goes live.
          </p>
          {saveFailed ? (
            <p className="text-[13px] text-rose-400">Your last change isn&apos;t saved. Sort that out first, so nothing written here is lost.</p>
          ) : null}
          {error ? <p className="text-[13px] text-rose-400">{error}</p> : null}
          <div className="flex gap-2">
            <button type="button" className="btn-primary !px-3 !py-1.5 text-xs" onClick={write} disabled={busy || saveFailed}>
              {busy ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Writing...
                </span>
              ) : (
                "Write the empty parts"
              )}
            </button>
            <button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
