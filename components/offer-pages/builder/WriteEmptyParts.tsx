"use client";

/**
 * "Write the empty parts" in the offer editor (OfferBuilder): the way to try
 * "Write my page" (lib/offer-pages/write-page.ts) again after a write failed
 * at creation, and to fill a page whose sections are still empty. Only empty
 * fields are written; anything already on the page stays as it is. Shown only
 * while the draft has parts a write would fill (emptyWritableParts).
 *
 * It lives inside the editor, not beside it, because the editor holds unsaved
 * changes: a write waits until the last change is saved, sends the version
 * the editor holds (the route refuses any other), and hands the page the
 * route returns back to the editor instead of reloading over its state.
 */
import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { WritePageDescription } from "@/components/offer-pages/WritePageFields";
import type { OfferPageDoc } from "@/lib/offer-pages/types";
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
  version,
  saveState,
  onOffer,
}: {
  formId: string;
  doc: OfferPageDoc;
  /** The draft version the editor holds now. */
  version: () => number;
  /** The editor's save state: a write waits until its last change is saved. */
  saveState: "idle" | "pending" | "saving" | "saved" | "error";
  /** The page as the route left it, for the editor to take up. */
  onOffer: (offer: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(doc.brief?.promise ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const parts = emptyWritableParts(doc);
  if (parts.length === 0 && !notice) return null;

  const unsaved = saveState === "pending" || saveState === "saving";
  const blocked = saveState === "error";

  async function write() {
    const problem = writePageInputProblem(description);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    setNotice(null);
    const written = await requestWrittenPage(formId, { description, audience: doc.brief?.audience ?? "", expectedVersion: version() });
    setBusy(false);
    if (written.offer) onOffer(written.offer);
    if (!written.ok) return setError(written.message);
    if (written.filled.length === 0) return setNotice("Every part already has words, so nothing was changed.");
    setOpen(false);
    setNotice(`Written: ${named(written.filled)}. Read it through, and set prices yourself, before you publish.`);
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
          <WritePageDescription value={description} onChange={setDescription} />
          <p className="text-xs text-fg-muted">
            Only the empty parts are written; anything already on the page stays as it is. It stays a draft: you
            review it, and set prices yourself, before it goes live.
          </p>
          {unsaved ? <p className="text-[13px] text-fg-muted">Waiting for your last change to save...</p> : null}
          {blocked ? (
            <p className="text-[13px] text-rose-400">Your last change isn&apos;t saved. Sort that out first, so nothing you typed is lost.</p>
          ) : null}
          {error ? <p className="text-[13px] text-rose-400">{error}</p> : null}
          <div className="flex gap-2">
            <button type="button" className="btn-primary !px-3 !py-1.5 text-xs" onClick={write} disabled={busy || unsaved || blocked}>
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
