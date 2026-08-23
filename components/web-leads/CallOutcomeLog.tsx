"use client";

/**
 * CallOutcomeLog — the four call-outcome buttons plus recent history.
 *
 * THE DESIGN DECISION (see lib/web-leads/outcome.ts's header): logging the
 * outcome IS the transfer to the pipeline. There is no separate "move to
 * pipeline" button anywhere in this component -- clicking one of these four
 * buttons both records what happened AND advances the stage, as a byproduct.
 *
 * NO COLOUR EDITORIALISES. "Not interested" is information a rep needs to
 * log accurately, not a failure to dress in red -- a red button trains reps
 * to avoid logging it, and log rate matters more than sentiment. All four
 * buttons share one neutral style. Same reasoning WebsiteComparison.tsx
 * documents for score colours.
 *
 * Uses the same `alive`-after-body-parse fetch pattern as WebLeadDetail.tsx
 * and WebsiteComparison.tsx, so a slow response for lead A can never land
 * after a faster response for lead B and overwrite it.
 */

import { useEffect, useState } from "react";
import { PhoneMissed, PhoneCall, ThumbsUp, ThumbsDown, Loader2 } from "lucide-react";
// Type-only: lib/web-leads/outcome.ts imports getServiceSupabase() (server-only).
// A value import here would pull that whole module into the client bundle and
// fail the build -- same reasoning WebsiteComparison.tsx documents.
import type { CallOutcome, CallOutcomeRecord } from "@/lib/web-leads/outcome";

const OUTCOME_LABEL: Record<CallOutcome, string> = {
  no_answer: "No answer",
  connected: "Connected",
  interested: "Interested",
  not_interested: "Not interested",
};

const BUTTONS: { outcome: CallOutcome; icon: React.ReactNode }[] = [
  { outcome: "no_answer", icon: <PhoneMissed className="h-4 w-4" /> },
  { outcome: "connected", icon: <PhoneCall className="h-4 w-4" /> },
  { outcome: "interested", icon: <ThumbsUp className="h-4 w-4" /> },
  { outcome: "not_interested", icon: <ThumbsDown className="h-4 w-4" /> },
];

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function labelFor(outcome: string): string {
  return OUTCOME_LABEL[outcome as CallOutcome] || outcome;
}

function HistorySkeleton() {
  return (
    <ul className="space-y-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: 2 }).map((_, i) => (
        <li key={i} className="h-11 rounded-md border border-bg-border/60 bg-bg-deep/40 animate-pulse-slow" style={{ animationDelay: `${i * 60}ms` }} />
      ))}
    </ul>
  );
}

export function CallOutcomeLog({ leadId }: { leadId: string }) {
  const [history, setHistory] = useState<CallOutcomeRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<CallOutcome | null>(null);
  const [note, setNote] = useState("");

  function loadHistory(alive: () => boolean) {
    fetch(`/api/web-leads/${encodeURIComponent(leadId)}/outcome`)
      .then(async (r) => {
        if (!r.ok) {
          if (alive()) setError("Could not load call history.");
          return;
        }
        const body = await r.json();
        if (alive()) setHistory(body.outcomes || []);
      })
      .catch(() => { if (alive()) setError("Could not load call history."); });
  }

  useEffect(() => {
    let ok = true;
    setHistory(null);
    setError(null);
    loadHistory(() => ok);
    return () => { ok = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  async function logOutcome(outcome: CallOutcome) {
    setPending(outcome);
    setError(null);
    try {
      const r = await fetch(`/api/web-leads/${encodeURIComponent(leadId)}/outcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, note: note.trim() || undefined }),
      });
      if (!r.ok) {
        setError("Could not log that outcome. Try again.");
        return;
      }
      setNote("");
      loadHistory(() => true);
    } catch {
      setError("Could not log that outcome. Try again.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-5 border-t border-bg-border pt-4">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Log this call</p>

      <div className="grid grid-cols-2 gap-2">
        {BUTTONS.map(({ outcome, icon }) => (
          <button
            key={outcome}
            type="button"
            disabled={pending !== null}
            onClick={() => logOutcome(outcome)}
            className="flex items-center justify-center gap-2 rounded-md border border-bg-border bg-bg-panel px-3 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/40 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === outcome ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
            {pending === outcome ? "Logging…" : OUTCOME_LABEL[outcome]}
          </button>
        ))}
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note for this call"
        rows={2}
        className="mt-2 w-full resize-y rounded-md border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
      />

      {error && <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">{error}</p>}

      <p className="mb-2 mt-4 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Recent calls</p>
      {history === null && !error && <HistorySkeleton />}
      {history && history.length === 0 && <p className="text-sm text-fg-dim">No calls logged yet.</p>}
      {history && history.length > 0 && (
        <ul className="space-y-2">
          {history.map((h) => (
            <li key={h.id} className="rounded-md border border-bg-border/60 bg-bg-deep/40 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-fg">{labelFor(h.outcome)}</span>
                <span className="text-xs text-fg-dim">{formatWhen(h.calledAt)}</span>
              </div>
              {h.note && <p className="mt-1 text-xs text-fg-muted">{h.note}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
