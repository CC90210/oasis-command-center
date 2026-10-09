"use client";

/**
 * "Turn into an offer" on an intake form's editor (design 2.2): pick a
 * template, and the form gets a DRAFT page built around it. Its only words
 * are the headline and subheadline the form already shows. The public link
 * does not change until someone publishes.
 *
 * Not offered for a support desk's form: that form files tickets for clients
 * and never creates a lead (the API answers 409 for it too).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { OFFER_TEMPLATES } from "@/lib/offer-pages/templates";
import type { TemplateKey } from "@/lib/offer-pages/types";

export function TurnIntoOffer({ formId }: { formId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState<TemplateKey>("free_audit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/forms/${formId}/offer`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      if (!data.ok) {
        setError(data.message || "Couldn't make the page. Try again in a moment.");
        return;
      }
      router.refresh();
    } catch {
      setError("Couldn't make the page. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-bg-border bg-bg-elev/40 p-4">
        <Sparkles className="h-4 w-4 text-accent" />
        <div className="text-sm text-fg">
          Turn this form into an offer: a full page with a video, what people get, your proof, and this form to book.
        </div>
        <button type="button" className="btn-primary ml-auto !px-3 !py-1.5 text-xs" onClick={() => setOpen(true)}>
          Turn into an offer
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-accent/40 bg-bg-elev/40 p-4">
      <div className="text-sm font-bold text-fg">Pick a template</div>
      <div className="grid gap-3 sm:grid-cols-3">
        {OFFER_TEMPLATES.map((t) => (
          <button
            type="button"
            key={t.key}
            onClick={() => setTemplate(t.key)}
            aria-pressed={template === t.key}
            className={`rounded-xl border p-3 text-left ${template === t.key ? "border-accent bg-accent/10" : "border-bg-border hover:border-bg-border-strong"}`}
          >
            <div className="text-sm font-bold text-fg">{t.label}</div>
            <div className="mt-1 text-xs text-fg-muted">{t.summary}</div>
          </button>
        ))}
      </div>
      <p className="text-[12px] text-fg-muted">
        The page starts as a draft with only this form&apos;s own headline. Your link keeps showing the plain form until you publish.
      </p>
      {error ? <p className="text-[13px] text-rose-400">{error}</p> : null}
      <div className="flex gap-2">
        <button type="button" className="btn-primary !px-3 !py-1.5 text-xs" onClick={go} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Make the draft page"}
        </button>
        <button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
