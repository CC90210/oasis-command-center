"use client";

/**
 * CallOutcomeLog — what happened on the call, and when we try again.
 *
 * THE DESIGN DECISION (see lib/web-leads/outcome.ts's header): logging the
 * outcome IS the transfer to the pipeline. There is no separate "move to
 * pipeline" button anywhere in this component -- recording what happened both
 * logs it AND advances the stage, as a byproduct.
 *
 * WHAT CHANGED 2026-08-23. This panel offered four outcomes and never captured
 * a next action, while Rep Today ranks a rep's whole day on `next_action_at`.
 * A prospect who said "call me Thursday at 2" produced no Thursday anything.
 * See lib/website-sales-workflow.ts for the full account of how the product
 * ended up with two call-logging vocabularies and only one of them wired to
 * the queue.
 *
 * TWO GROUPS, NOT EIGHT BUTTONS IN A ROW. "Did not reach them" and "Reached
 * them" is the first thing true about any call, and it is the split that
 * decides whether the rest of the panel is about scheduling another attempt or
 * about what the prospect said. A flat grid of eight makes a rep read all
 * eight labels mid-call; two groups of three and five makes them read one.
 *
 * CONFIRM, DO NOT ASSUME (operator decision, Adon 2026-08-23). Picking a
 * no-contact outcome pre-fills the next attempt and shows it. The rep still
 * presses Save, and the Save button takes focus so Enter finishes the call
 * without reaching for the mouse. A blank field on all 200 calls of a block is
 * the friction that stops reps logging; a time written silently behind them
 * produces a queue full of appointments nobody chose.
 *
 * NO COLOUR EDITORIALISES. "Not interested" is information a rep needs to log
 * accurately, not a failure to dress in red -- a red button trains reps to
 * avoid logging it, and log rate matters more than sentiment. Every button
 * shares one neutral style. Same reasoning WebsiteComparison.tsx documents for
 * score colours, and tests/web-leads-outcome-guards.test.ts pins it.
 *
 * PARTIAL FAILURE IS REPORTED AS PARTIAL. The two writes behind a logged call
 * are not atomic. When the history lands and the queue update does not, the
 * route answers 409 with `logged: true`, and this panel says exactly that and
 * offers Retry -- which repairs from history rather than logging the call
 * twice. It never renders a scheduled callback that was not scheduled.
 *
 * Uses the same `alive`-after-body-parse fetch pattern as WebLeadDetail.tsx
 * and WebsiteComparison.tsx, so a slow response for lead A can never land
 * after a faster response for lead B and overwrite it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PhoneMissed, Voicemail, ShieldAlert, PhoneCall, CalendarClock,
  ThumbsUp, ThumbsDown, Ban, Loader2,
} from "lucide-react";
// Type-only: lib/web-leads/outcome.ts imports getServiceSupabase() (server-only).
// A value import here would pull that whole module into the client bundle and
// fail the build -- same reasoning WebsiteComparison.tsx documents.
import type { CallOutcome, CallOutcomeRecord } from "@/lib/web-leads/outcome";
// Value import, and safe: lib/website-sales-workflow.ts is pure (it has no
// imports at all) and is the single owner of the disposition vocabulary, the
// suggested spacing between attempts, and which outcomes require a time. The
// client asking a second source for any of those is how the two vocabularies
// diverged in the first place.
import {
  isTerminalDisposition,
  requiresNextAction,
  suggestedNextActionAt,
} from "@/lib/website-sales-workflow";

const OUTCOME_LABEL: Record<CallOutcome, string> = {
  no_answer: "No answer",
  voicemail: "Left voicemail",
  gatekeeper: "Gatekeeper",
  connected: "Connected",
  callback: "Callback requested",
  interested: "Interested",
  not_interested: "Not interested",
  do_not_call: "Do not call",
};

/** The one-line explanation under each button. A new rep should not need to be
 *  told what "gatekeeper" means by another rep. */
const OUTCOME_HINT: Partial<Record<CallOutcome, string>> = {
  gatekeeper: "Someone answered, not the decision maker",
  callback: "They named a time",
  do_not_call: "They asked us never to call again",
};

type Group = { title: string; outcomes: { outcome: CallOutcome; icon: React.ReactNode }[] };

const GROUPS: Group[] = [
  {
    title: "Did not reach them",
    outcomes: [
      { outcome: "no_answer", icon: <PhoneMissed className="h-4 w-4" /> },
      { outcome: "voicemail", icon: <Voicemail className="h-4 w-4" /> },
      { outcome: "gatekeeper", icon: <ShieldAlert className="h-4 w-4" /> },
    ],
  },
  {
    title: "Reached them",
    outcomes: [
      { outcome: "connected", icon: <PhoneCall className="h-4 w-4" /> },
      { outcome: "callback", icon: <CalendarClock className="h-4 w-4" /> },
      { outcome: "interested", icon: <ThumbsUp className="h-4 w-4" /> },
      { outcome: "not_interested", icon: <ThumbsDown className="h-4 w-4" /> },
      { outcome: "do_not_call", icon: <Ban className="h-4 w-4" /> },
    ],
  },
];

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function labelFor(outcome: string): string {
  return OUTCOME_LABEL[outcome as CallOutcome] || outcome;
}

/**
 * ISO instant -> the value a <input type="datetime-local"> expects, in the
 * REP'S OWN timezone. Slicing an ISO string would show them UTC and they would
 * schedule a 2pm callback for 9am, which is worse than no default at all.
 */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The reverse. Returns null for an empty or unparseable field rather than an
 *  Invalid Date, which would serialize to null anyway but silently. */
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
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

export function CallOutcomeLog({ leadId, onLogged }: { leadId: string; onLogged?: () => void }) {
  const [history, setHistory] = useState<CallOutcomeRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  /** The outcome the rep has picked but not yet saved. Null = nothing staged. */
  const [staged, setStaged] = useState<CallOutcome | null>(null);
  const [nextAction, setNextAction] = useState("");
  /** Set when the call was logged but its queue update was not applied. Holds
   *  the repair affordance; never rendered as a success. */
  const [needsRepair, setNeedsRepair] = useState(false);

  const saveRef = useRef<HTMLButtonElement | null>(null);

  const loadHistory = useCallback((alive: () => boolean) => {
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
  }, [leadId]);

  useEffect(() => {
    let ok = true;
    setHistory(null);
    setError(null);
    setStaged(null);
    setNextAction("");
    setNeedsRepair(false);
    loadHistory(() => ok);
    return () => { ok = false; };
  }, [leadId, loadHistory]);

  // Move focus to Save the moment an outcome is staged, so the whole
  // interaction is click-then-Enter and never a hunt for the button.
  useEffect(() => {
    if (staged) saveRef.current?.focus();
  }, [staged]);

  function stage(outcome: CallOutcome) {
    setError(null);
    setNeedsRepair(false);
    setStaged(outcome);
    // The suggestion, computed by the same module the server validates with.
    // Terminal outcomes get no time: a prospect who said never call again must
    // not also be scheduled for tomorrow morning.
    setNextAction(isTerminalDisposition(outcome) ? "" : toLocalInput(suggestedNextActionAt(outcome)));
  }

  async function save() {
    if (!staged) return;
    const nextActionAt = isTerminalDisposition(staged) ? null : fromLocalInput(nextAction);

    // Refuse locally with the same rule the server enforces, so the rep is told
    // before a round trip rather than by a 400.
    if (requiresNextAction(staged) && !nextActionAt) {
      setError("Pick the date and time they asked you to call back.");
      return;
    }
    if (nextActionAt && Date.parse(nextActionAt) <= Date.now()) {
      setError("That time has already passed. Pick a time in the future.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/web-leads/${encodeURIComponent(leadId)}/outcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome: staged, note: note.trim() || undefined, nextActionAt }),
      });
      const body = await r.json().catch(() => ({}));

      if (r.status === 409 && body?.logged) {
        // Say the true thing: the call is recorded, the queue is not updated.
        // Retry repairs from history rather than logging the call a second time.
        setNeedsRepair(true);
        setError("Call logged, but it did not reach your queue. Retry to finish scheduling it.");
        loadHistory(() => true);
        return;
      }
      if (!r.ok) {
        setError(
          body?.error === "next_action_required"
            ? "Pick the date and time they asked you to call back."
            : body?.error === "next_action_must_be_in_future"
              ? "That time has already passed. Pick a time in the future."
              : "Could not log that outcome. Try again.",
        );
        return;
      }

      setNote("");
      setStaged(null);
      setNextAction("");
      loadHistory(() => true);
      // Let the parent refresh the list/detail so the new stage and callback
      // appear without a page reload.
      onLogged?.();
    } catch {
      setError("Could not log that outcome. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function repair() {
    setSaving(true);
    try {
      const r = await fetch(`/api/web-leads/${encodeURIComponent(leadId)}/outcome/reconcile`, { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body?.repaired) {
        setNeedsRepair(false);
        setError(null);
        setStaged(null);
        setNextAction("");
        setNote("");
        loadHistory(() => true);
        onLogged?.();
      } else {
        setError("Still could not update your queue. Tell an admin before you move on.");
      }
    } catch {
      setError("Still could not update your queue. Tell an admin before you move on.");
    } finally {
      setSaving(false);
    }
  }

  const showNextAction = staged !== null && !isTerminalDisposition(staged);

  return (
    <div className="mt-5 border-t border-bg-border pt-4">
      <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Log this call</p>

      {GROUPS.map((group) => (
        <div key={group.title} className="mb-3">
          <p className="mb-1.5 text-[10px] uppercase tracking-[0.12em] text-fg-faint">{group.title}</p>
          <div className="grid grid-cols-2 gap-2">
            {group.outcomes.map(({ outcome, icon }) => (
              <button
                key={outcome}
                type="button"
                disabled={saving}
                aria-pressed={staged === outcome}
                onClick={() => stage(outcome)}
                className={`flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left text-sm font-medium text-fg transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-50 ${
                  staged === outcome
                    ? "border-accent bg-bg-hover"
                    : "border-bg-border bg-bg-panel hover:border-accent/40 hover:bg-bg-hover"
                }`}
              >
                <span className="flex items-center gap-2">{icon}{OUTCOME_LABEL[outcome]}</span>
                {OUTCOME_HINT[outcome] && (
                  <span className="text-[10px] leading-tight text-fg-faint">{OUTCOME_HINT[outcome]}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}

      {staged && (
        <div className="mt-3 rounded-md border border-accent/30 bg-bg-deep/50 p-3">
          {showNextAction && (
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">
                {staged === "callback" ? "They asked us to call back" : "Next attempt"}
                {requiresNextAction(staged) && <span className="ml-1 text-accent">required</span>}
              </span>
              <input
                type="datetime-local"
                value={nextAction}
                onChange={(e) => setNextAction(e.target.value)}
                className="mt-1 w-full rounded-md border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
              />
              <span className="mt-1 block text-[10px] text-fg-faint">
                {staged === "callback"
                  ? "This is the time they gave you. It goes to the top of your queue."
                  : "Suggested. Change it if you know better."}
              </span>
            </label>
          )}
          {!showNextAction && (
            <p className="text-xs text-fg-muted">
              {staged === "do_not_call"
                ? "This lead will stop appearing in your queue."
                : "No follow up will be scheduled."}
            </p>
          )}

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note for this call"
            rows={2}
            className="mt-2 w-full resize-y rounded-md border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
          />

          <div className="mt-2 flex items-center gap-2">
            <button
              ref={saveRef}
              type="button"
              disabled={saving}
              onClick={save}
              className="inline-flex items-center gap-2 rounded-md border border-accent/50 bg-accent/10 px-4 py-2 text-sm font-semibold text-fg transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {saving ? "Saving…" : `Save ${OUTCOME_LABEL[staged].toLowerCase()}`}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => { setStaged(null); setNextAction(""); setError(null); }}
              className="rounded-md px-3 py-2 text-sm text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
          <p>{error}</p>
          {needsRepair && (
            <button
              type="button"
              disabled={saving}
              onClick={repair}
              className="mt-2 rounded-md border border-amber-400/50 px-3 py-1 font-semibold text-amber-100 transition-colors hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/70 disabled:opacity-50"
            >
              Retry scheduling
            </button>
          )}
        </div>
      )}

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
              {h.nextActionAt && (
                <p className="mt-1 flex items-center gap-1.5 text-xs text-fg-muted">
                  <CalendarClock className="h-3 w-3 shrink-0" />
                  Next: {formatWhen(h.nextActionAt)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
