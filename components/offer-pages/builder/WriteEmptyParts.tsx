"use client";

/**
 * "Write the empty parts" on an offer page's editor: the way to try "Write my
 * page" (lib/offer-pages/write-page.ts) again after a write failed at creation,
 * and to fill a page whose sections are still empty. Only empty fields are
 * written; anything already on the page stays as it is. Shown only while the
 * draft has parts a write would fill (emptyWritableParts).
 *
 * The route saves the draft, so the editor reloads to show the new words.
 */
import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { WritePageDescription } from "@/components/offer-pages/WritePageFields";
import { requestWrittenPage, writePageInputProblem } from "@/lib/offer-pages/write-page-client";

const PART_LABELS: Record<string, string> = {
  hero: "the top of the page",
  obstacles: "the problems it solves",
  what_you_get: "what you get",
  work: "how it works",
  faq: "the FAQ",
  book: "the booking section",
  seo: "the link preview",
};

export function WriteEmptyParts({
  formId,
  emptyParts,
  initialDescription,
  audience,
}: {
  formId: string;
  emptyParts: string[];
  initialDescription: string;
  audience: string;
}) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(initialDescription);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const named = emptyParts.map((p) => PART_LABELS[p] ?? p).join(", ");

  async function write() {
    const problem = writePageInputProblem(description);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    setNotice(null);
    const written = await requestWrittenPage(formId, { description, audience });
    setBusy(false);
    if (!written.ok) return setError(written.message);
    if (written.filled.length === 0) return setNotice("Every part already has words, so nothing was changed.");
    window.location.reload();
  }

  return (
    <div className="space-y-3 rounded-xl border border-bg-border bg-bg-elev/40 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Sparkles className="h-4 w-4 text-accent" />
        <div className="min-w-0 flex-1 text-sm text-fg">
          Some parts of this page have no words yet: {named}.
        </div>
        {open ? null : (
          <button type="button" className="btn-primary !px-3 !py-1.5 text-xs" onClick={() => setOpen(true)}>
            Write them for me
          </button>
        )}
      </div>
      {open ? (
        <>
          <WritePageDescription value={description} onChange={setDescription} />
          <p className="text-xs text-fg-muted">
            Only the empty parts are written; anything already on the page stays as it is. It stays a draft: you
            review it, and set prices yourself, before it goes live.
          </p>
          {error ? <p className="text-[13px] text-rose-400">{error}</p> : null}
          {notice ? <p className="text-[13px] text-fg-muted">{notice}</p> : null}
          <div className="flex gap-2">
            <button type="button" className="btn-primary !px-3 !py-1.5 text-xs" onClick={write} disabled={busy}>
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
