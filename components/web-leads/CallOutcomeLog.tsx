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

import { useEffect, useRef, useState } from "react";
import { PhoneMissed, PhoneCall, ThumbsUp, ThumbsDown, PhoneOff, Loader2 } from "lucide-react";
// Type-only: lib/web-leads/outcome.ts imports getServiceSupabase() (server-only).
// A value import here would pull that whole module into the client bundle and
// fail the build -- same reasoning WebsiteComparison.tsx documents.
import type { CallOutcome, CallOutcomeRecord } from "@/lib/web-leads/outcome";
import { NEXT_ACTION_PRESETS, presetToIso } from "@/lib/web-leads/next-action-presets";

const OUTCOME_LABEL: Record<CallOutcome, string> = {
  no_answer: "No answer",
  connected: "Connected",
  interested: "Interested",
  not_interested: "Not interested",
  do_not_call: "Do not call",
};

const BUTTONS: { outcome: CallOutcome; icon: React.ReactNode }[] = [
  { outcome: "no_answer", icon: <PhoneMissed className="h-4 w-4" /> },
  { outcome: "connected", icon: <PhoneCall className="h-4 w-4" /> },
  { outcome: "interested", icon: <ThumbsUp className="h-4 w-4" /> },
  { outcome: "not_interested", icon: <ThumbsDown className="h-4 w-4" /> },
  { outcome: "do_not_call", icon: <PhoneOff className="h-4 w-4" /> },
];

/**
 * "Do not call" asks twice, and it is the only outcome that does.
 *
 * Every other outcome on this panel is correctable by logging a later one --
 * the route's own header says a mis-click is fixed by appending, not editing.
 * That is not true here. The flag this outcome sets is read by claim.ts, which
 * states it "never expires", and nothing in the codebase writes it back to
 * false. So a slip of the thumb permanently removes a business from the pool
 * with no route back through the product.
 *
 * A confirm step on a genuinely irreversible action is not friction, it is the
 * difference between a rep honouring a request and a rep destroying a lead.
 * No colour is used to mark it: Rule 2 bans colour keyed to meaning on this
 * surface and web-leads-guards enforces that by class name, so the warning is
 * carried by the words changing instead.
 */
const NEEDS_CONFIRM: CallOutcome = "do_not_call";

/**
 * Outcomes that leave the lead alive, and therefore owe it a date.
 *
 * Mirrors KEEPS_LEAD_OPEN in lib/web-leads/outcome.ts. The server is the
 * boundary and re-validates; this copy exists so a rep is told before the
 * round trip rather than after it.
 */
const NEEDS_NEXT_ACTION: readonly CallOutcome[] = ["no_answer", "connected", "interested"];

/**
 * When to come back, in one tap.
 *
 * THE CONSTRAINT THIS IS BUILT FOR (Adon, 2026-09-29): there is no dialer
 * integration and there will not be one for some weeks. Every call is dialled by
 * hand from a mobile and every outcome is typed immediately after hanging up. A
 * required field that is tedious does not get filled honestly, it gets filled
 * with whatever dismisses the form -- and a junk callback date is worse than no
 * date, because the due queue then lies with confidence.
 *
 * So the common answers are chips, the choice persists between calls, and a
 * rep working a list mostly never touches this: pick the cadence once, then log
 * outcome after outcome with a single click each.
 *
 * Offsets are computed AT CLICK TIME rather than at render, so a tab left open
 * overnight cannot submit yesterday's "tomorrow".
 *
 * The presets live in lib/web-leads/next-action-presets.ts, shared with Call
 * Mode, so both call screens offer the same choices and send the same dates.
 */

// Mirrors the server contract without value-importing its server-only module.
const MAX_CALL_NOTE_LENGTH = 4000;

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

export function CallOutcomeLog({ leadId, canMutate }: { leadId: string; canMutate: boolean }) {
  const [history, setHistory] = useState<CallOutcomeRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [pending, setPending] = useState<CallOutcome | null>(null);
  const [confirmingDnc, setConfirmingDnc] = useState(false);
  // Persists between calls on purpose: a rep working a list usually wants the
  // same cadence for all of them, so the cheapest path is pick once, then one
  // click per lead.
  const [presetKey, setPresetKey] = useState<string>("3d");
  const [customDate, setCustomDate] = useState<string>("");
  const [note, setNote] = useState("");
  const [leadCanMutate, setLeadCanMutate] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const submissionRef = useRef<{ signature: string; requestId: string } | null>(null);

  function loadHistory(alive: () => boolean) {
    fetch(`/api/web-leads/${encodeURIComponent(leadId)}/outcome`)
      .then(async (r) => {
        if (!r.ok) {
          if (alive()) setError("Could not load call history.");
          return;
        }
        const body = await r.json();
        if (alive()) {
          setHistory(body.outcomes || []);
          setLeadCanMutate(canMutate && body.canMutate === true);
        }
      })
      .catch(() => { if (alive()) setError("Could not load call history."); });
  }

  useEffect(() => {
    let ok = true;
    setHistory(null);
    setError(null);
    setWarning(null);
    setLeadCanMutate(false);
    submissionRef.current = null;
    loadHistory(() => ok);
    return () => { ok = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  async function logOutcome(outcome: CallOutcome) {
    if (!leadCanMutate) return;
    const trimmedNote = note.trim();
    if (outcome === "not_interested" && !trimmedNote) {
      setError("Add the reason before logging Not interested.");
      noteRef.current?.focus();
      return;
    }
    if (trimmedNote.length > MAX_CALL_NOTE_LENGTH) {
      setError(`Keep the call note to ${MAX_CALL_NOTE_LENGTH.toLocaleString()} characters or fewer.`);
      noteRef.current?.focus();
      return;
    }
    // WHEN ARE WE COMING BACK TO THIS ONE. Only for outcomes that leave the
    // lead alive; a terminal one sends null and the server clears any date the
    // lead was carrying. Computed here rather than at render so a tab left open
    // overnight cannot submit yesterday's "tomorrow".
    let nextActionAt: string | null = null;
    if (NEEDS_NEXT_ACTION.includes(outcome)) {
      if (customDate) {
        const parsed = Date.parse(`${customDate}T12:00:00`);
        if (!Number.isFinite(parsed) || parsed <= Date.now()) {
          setError("Pick a callback date in the future.");
          return;
        }
        nextActionAt = new Date(parsed).toISOString();
      } else {
        const preset = NEXT_ACTION_PRESETS.find((p) => p.key === presetKey);
        if (!preset) {
          setError("Choose when to come back to this one.");
          return;
        }
        nextActionAt = presetToIso(preset.days);
      }
    }

    setPending(outcome);
    setError(null);
    setWarning(null);
    // The date is part of the signature: changing when you are coming back is a
    // different submission, and reusing the previous requestId would make the
    // server treat it as a duplicate of the earlier one and keep the old date.
    const signature = JSON.stringify([leadId, outcome, trimmedNote, nextActionAt]);
    const requestId =
      submissionRef.current?.signature === signature
        ? submissionRef.current.requestId
        : crypto.randomUUID();
    submissionRef.current = { signature, requestId };
    try {
      const r = await fetch(`/api/web-leads/${encodeURIComponent(leadId)}/outcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, note: trimmedNote || undefined, requestId, nextActionAt }),
      });
      const body = await r.json().catch(() => ({})) as {
        error?: string;
        trackingWarning?: string | null;
        retrySafe?: boolean;
        saved?: { outcomeSaved?: boolean; stageSaved?: boolean; leadContextSaved?: boolean; touchSaved?: boolean; trackingSaved?: boolean };
      };
      if (!r.ok) {
        if (r.status < 500 || body.retrySafe === false) submissionRef.current = null;
        setError(
          body.error === "reason_required"
            ? "Add the reason before logging Not interested."
            : body.error === "note_too_long"
              ? `Keep the call note to ${MAX_CALL_NOTE_LENGTH.toLocaleString()} characters or fewer.`
              : body.error === "tracking_failed"
                ? "The call and Pipeline update are saved, but its timeline entry is not. Try again; this retry will repair it without duplicating the call."
                : body.error === "ownership_changed"
                  ? "The call was saved, but this lead changed owners before every update finished. Refresh the lead."
                : body.saved?.outcomeSaved
                ? "The call was saved, but Pipeline is not fully updated. Try again; this retry will not duplicate it."
                : body.error === "request_id_conflict"
                  ? "This retry no longer matches the saved call. Refresh the lead before logging again."
                  : "Could not log that outcome. Try again with the same details.",
        );
        return;
      }
      submissionRef.current = null;
      if (body.trackingWarning) {
        setWarning("Outcome saved, but its timeline entry could not be recorded. The lead itself is up to date.");
      }
      setNote("");
      loadHistory(() => true);
    } catch {
      setError("Could not confirm whether the server finished. Try again with the same details; it will not duplicate the call.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-5 border-t border-bg-border pt-4">
      {leadCanMutate && (
        <>
          <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Log this call</p>

      {/* WHEN, BEFORE WHAT HAPPENED. The cadence is picked once and sticks, so
          working a list is one click per lead after the first. Selection is
          carried by border weight and aria-pressed, never by colour: Rule 2
          bans colour keyed to meaning on this surface and web-leads-guards
          enforces it by class name.

          Ignored by Not interested and Do not call, which end the lead. */}
      <div className="mb-2">
        <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
          Come back to this in
        </p>
        <div className="flex flex-wrap gap-1.5">
          {NEXT_ACTION_PRESETS.map((p) => {
            const active = !customDate && presetKey === p.key;
            return (
              <button
                key={p.key}
                type="button"
                aria-pressed={active}
                onClick={() => { setPresetKey(p.key); setCustomDate(""); }}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium text-fg transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 ${
                  active ? "border-fg font-semibold" : "border-bg-border bg-bg-panel"
                }`}
              >
                {p.label}
              </button>
            );
          })}
          <label className="flex items-center gap-1.5 text-xs text-fg-muted">
            <span className="sr-only">Or pick a specific callback date</span>
            <input
              type="date"
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              className="rounded-md border border-bg-border bg-bg-panel px-2 py-1 text-xs text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
            />
          </label>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {BUTTONS.filter(({ outcome }) => outcome !== NEEDS_CONFIRM).map(({ outcome, icon }) => (
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

      {/* Its own row, full width, below the reversible four. The separation is
          the signal, since colour is not available to carry it here. */}
      <button
        type="button"
        disabled={pending !== null}
        aria-describedby="dnc-consequence"
        onClick={() => {
          if (!confirmingDnc) { setConfirmingDnc(true); return; }
          setConfirmingDnc(false);
          void logOutcome(NEEDS_CONFIRM);
        }}
        onBlur={() => setConfirmingDnc(false)}
        className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-bg-border bg-bg-panel px-3 py-2 text-sm font-medium text-fg transition-colors hover:border-accent/40 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending === NEEDS_CONFIRM ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneOff className="h-4 w-4" />}
        {pending === NEEDS_CONFIRM
          ? "Logging…"
          : confirmingDnc
            ? "Confirm: never call this business again"
            : OUTCOME_LABEL[NEEDS_CONFIRM]}
      </button>
      <p id="dnc-consequence" className="mt-1 text-xs leading-5 text-fg-muted">
        {confirmingDnc
          ? "This cannot be undone here. The business leaves the pool permanently."
          : "Use when someone asks not to be contacted again."}
      </p>

      <textarea
        ref={noteRef}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={MAX_CALL_NOTE_LENGTH}
        placeholder="Call note (required for Not interested)"
        rows={2}
        className="mt-2 w-full resize-y rounded-md border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
      />
          <p className="mt-1 text-[11px] text-fg-dim">A reason is required for Not interested.</p>
        </>
      )}

      {error && <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">{error}</p>}
      {warning && <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">{warning}</p>}

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
