"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MessageSquarePlus } from "lucide-react";

export function LeadNoteComposer({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [refreshPending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    const value = note.trim();
    if (!value) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/leads/${leadId}/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: value }),
      });
      const json = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
        noteSaved?: boolean;
      };
      if (!response.ok || !json.ok) {
        if (json.noteSaved) {
          setNote("");
          setMessage("Note saved, but Last Touch needs an admin check.");
          window.dispatchEvent(new CustomEvent("oasis:lead-touch", { detail: { leadId } }));
          startTransition(() => router.refresh());
          return;
        }
        throw new Error(json.message || json.error || `note_${response.status}`);
      }
      setNote("");
      setMessage("Activity note added. Last Touch and the timeline are up to date.");
      window.dispatchEvent(new CustomEvent("oasis:lead-touch", { detail: { leadId } }));
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Note failed to save.");
    } finally {
      setSaving(false);
    }
  }

  const disabled = saving || refreshPending;
  return (
    <section className="rounded-2xl border border-bg-border bg-bg-deep/50 p-5">
      <div className="flex items-center gap-2">
        <MessageSquarePlus className="h-4 w-4 text-accent" aria-hidden />
        <h2 className="text-sm font-semibold text-fg">Add activity note</h2>
      </div>
      <p className="mt-1 text-xs text-fg-muted">
        A note is a tracked touch. It appears chronologically and refreshes Last Touch.
      </p>
      <textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={4}
        maxLength={4000}
        placeholder='What happened, what was promised, and what happens next? Example: "Client requested the founder meeting for 4:00 p.m."'
        className="mt-3 w-full rounded-lg border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-accent/70 focus:ring-1 focus:ring-accent/30"
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[10px] text-fg-dim">{note.length}/4000</span>
        <button
          type="button"
          disabled={disabled || !note.trim()}
          onClick={save}
          className="btn-primary !px-4 !py-2 text-xs"
        >
          {saving ? "Adding…" : "Add note and touch"}
        </button>
      </div>
      {message && (
        <div role="status" className="mt-3 rounded-lg border border-bg-border bg-bg-elev/35 px-3 py-2 text-xs text-fg-muted">
          {message}
        </div>
      )}
    </section>
  );
}
