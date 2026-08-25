"use client";

/**
 * CallMode — one lead at a time, full screen, for a rep working a call block.
 *
 * WHY THIS EXISTS (2026-08-23). Everything before it was a browser: a table you
 * scan, a row you click, a panel you read, a panel you close, a row you click.
 * That is the right shape for research and the wrong shape for dialling. Every
 * outbound-sales tool converges on the same answer -- the rep loads a queue and
 * the tool serves the next record, so the only decisions left are "what do I
 * say" and "what happened". The friction that matters is not per session, it is
 * per call, multiplied by two hundred.
 *
 * Three things follow from that, and they are the whole design:
 *
 * 1. THE DISPOSITION IS ONE KEYSTROKE, AND IT ADVANCES THE QUEUE. Logging what
 *    happened is the single highest-value and most-skipped action in outbound
 *    sales -- a pipeline is only as accurate as its worst-logged call. Pressing
 *    1-4 records the outcome AND moves to the next lead, so logging is on the
 *    path of least resistance rather than a tax a rep pays for being diligent.
 *    (It is also, per lib/web-leads/outcome.ts, what moves a lead into the
 *    pipeline -- there is no separate "transfer" button anywhere.)
 *
 * 2. EVERYTHING FOR THE CALL IS ON ONE SCREEN. Number, their website, the
 *    score, and the specific things wrong with their site with what each costs
 *    them and what we would build. Nothing behind a click, nothing in a second
 *    tab. A rep hunting for a talking point mid-sentence is a rep improvising,
 *    and improvised claims about a stranger's website are exactly what this
 *    system must never cause.
 *
 * 3. THE QUEUE IS THE FILTERED LIST, NOT A NEW CONCEPT. Whatever the rep
 *    filtered and sorted to is the queue, in that order. No second targeting
 *    model to keep in sync, and "Toronto salons scoring under 40, worst first"
 *    is expressible with controls that already exist.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: no auto-dialling, no timers, no countdown
 * to the next call. Those belong to a dialler with telephony behind it; this
 * hands the rep a tel: link and gets out of the way. And no colour keyed to a
 * score, here as everywhere else in this feature -- see WebsiteComparison.tsx.
 *
 * ═══ 2026-08-25: THIS IS THE SURFACE A REP USES ON A PHONE ══════════════════
 *
 * Everything else in /web-leads is triage a rep can do at a desk. This is the
 * one they open standing in a car park, and three of its assumptions were
 * desktop assumptions:
 *
 * 1. THE DISPOSITIONS WERE AT THE TOP OF THE SCROLL. Below `lg` the log panel
 *    was simply the second flex child of a single scrolling column, so the four
 *    buttons sat under however long the talking points ran -- a scroll away
 *    from the moment they are needed, which is the second the call ends. They
 *    are now PINNED TO THE BOTTOM of the viewport, with only the talking points
 *    scrolling. Phones are held low and worked with a thumb; the bottom of the
 *    screen is the reachable part, and the top is the part you have to
 *    re-grip for.
 *
 * 2. THE KEY CAPS WERE THE BUTTONS' ONLY WEIGHT. `1`-`4` is the fastest way to
 *    log a call and it is meaningless on glass. Below `lg` the caps are hidden
 *    and the four buttons become a 2x2 grid of 56px targets that carry
 *    themselves. The keyboard handler is untouched -- it is the same code path
 *    on both, so a disposition can never mean two different things.
 *
 * 3. THE CALL BUTTON WAS ONE OF THREE EQUAL PILLS. On the device that can
 *    actually dial, it is the whole point of the screen: full width, 64px, and
 *    first. "Their site" and "Full detail" sit under it at 44px.
 *
 * `tel:` IS THE ONE THING THAT GETS BETTER ON A PHONE -- on a desktop it opens
 * whatever handler the OS guesses at; on the device a rep is holding, it dials.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Loader2, Phone, X } from "lucide-react";
import type { WebLeadRow } from "@/lib/web-leads/data";
import type { CallOutcome } from "@/lib/web-leads/outcome";
import { preferredSiteUrl } from "@/lib/web-leads/url-safety";
import { remedyFor } from "@/lib/web-leads/remedies";
import { useAudit, biggestGaps, SCORE_STATE_WORDS } from "./useAudit";
import { PhoneTierBadge } from "./PhoneTrust";

/**
 * The four outcomes, with the digit that logs each.
 *
 * NO COLOUR EDITORIALISES, matching CallOutcomeLog.tsx: "Not interested" is
 * information a rep needs to log accurately, not a failure to dress in red. A
 * red button trains reps to avoid pressing it, and log rate matters more than
 * sentiment. All four share one neutral style.
 */
const OUTCOMES: { key: CallOutcome; label: string; digit: string }[] = [
  { key: "no_answer", label: "No answer", digit: "1" },
  { key: "connected", label: "Connected", digit: "2" },
  { key: "interested", label: "Interested", digit: "3" },
  { key: "not_interested", label: "Not interested", digit: "4" },
];

// Mirrors the server contract without value-importing its server-only module.
const MAX_CALL_NOTE_LENGTH = 4000;

/**
 * A keyboard hint rendered as a key cap, so the shortcut is discoverable
 * without a help screen -- reps learn these in the first ten calls.
 *
 * `hidden lg:inline-flex`: a key cap on a phone is not a hint, it is a claim
 * about a keyboard that is not there. Every control that carries one also
 * carries its own label, so nothing is lost by hiding it -- and the handler
 * that reads the key is unchanged, so the shortcut still works the moment a
 * keyboard exists.
 */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="hidden h-5 min-w-[1.25rem] items-center justify-center rounded border border-bg-border bg-bg-deep px-1.5 font-mono text-[10px] font-semibold text-fg-dim lg:inline-flex">
      {children}
    </kbd>
  );
}

/** The talking points, at call size. Same source and same wording as the detail
 *  panel; only the type scale differs. */
function TalkingPoints({ leadId }: { leadId: string }) {
  const state = useAudit(leadId);

  if (state.status === "loading") {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="h-14 w-24 rounded bg-bg-panel animate-pulse-slow" />
        <div className="h-20 rounded-lg bg-bg-panel animate-pulse-slow" />
        <div className="h-20 rounded-lg bg-bg-panel/70 animate-pulse-slow" />
      </div>
    );
  }

  if (state.status === "error") {
    // Single-line `{error}` -- see WebsiteComparison.tsx's matching comment.
    // The colour guard in tests/web-leads-guards.test.ts covers this file too,
    // and recognises the repo's fetch-failure banner only in that exact shape.
    const error = `${state.message} You can still make this call, just without the site notes.`;
    return <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">{error}</p>;
  }

  const { audit } = state;

  // The three non-scored states are SENTENCES, never numbers and never blanks.
  if (audit.state !== "scored") {
    return (
      <div className="rounded-lg border border-bg-border bg-bg-panel/60 p-4">
        <p className="text-sm text-fg-muted">{SCORE_STATE_WORDS[audit.state] || "Not scored yet"}</p>
        {audit.state === "unreachable" && (
          <p className="mt-1 text-xs text-fg-faint">{audit.reason}</p>
        )}
        <p className="mt-3 text-xs text-fg-dim">
          Ask what they have today and what it is doing for them. Nothing here has been measured, so do not
          describe their site.
        </p>
      </div>
    );
  }

  const gaps = biggestGaps(audit.dimensions, 3);

  return (
    <div className="space-y-5">
      <div className="flex items-end gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-fg-muted">Website score</p>
          <p className="mt-1 text-5xl font-bold leading-none tracking-tight tabular-nums text-fg">
            {audit.composite}
          </p>
        </div>
        <p className="pb-1 text-xs text-fg-dim">
          measured{" "}
          {new Date(audit.measuredAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </p>
      </div>

      {gaps.length > 0 && (
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-fg-muted">What to say</p>
          <ul className="mt-2.5 space-y-2.5">
            {gaps.map((check) => {
              const remedy = remedyFor(check.code);
              return (
                <li key={check.code} className="rounded-lg border border-bg-border bg-bg-panel/60 p-3.5">
                  <p className="text-sm font-semibold text-fg">{check.label}</p>
                  {/* Renders nothing at all when a code has no pair -- never an
                      empty bullet, never "undefined". */}
                  {remedy && (
                    <div className="mt-2 space-y-1.5 text-xs leading-relaxed text-fg-dim">
                      <p><span className="font-semibold text-fg-muted">Costs them:</span> {remedy.costs}</p>
                      <p><span className="font-semibold text-fg-muted">We&apos;d fix it:</span> {remedy.fix}</p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export function CallMode({
  leads, queueKey, queueLabel, ready, onExit, onLoadMore, hasMore,
}: {
  leads: WebLeadRow[];
  /** Changes whenever `leads` becomes a DIFFERENT queue (a new page, or new
   *  filters applied behind the overlay). Resets the cursor to the top -- see
   *  the effect below. */
  queueKey: string;
  queueLabel: string;
  /**
   * True only when `leads` is the data for THIS `queueKey`.
   *
   * Not merely "not loading". When a rep hits "load the next page", queueKey
   * changes instantly while the parent still holds the PREVIOUS page's leads
   * until the fetch lands. Without this flag the cursor resets to 0 and Call
   * Mode renders lead #1 of the page just finished, with live disposition
   * buttons -- so the rep calls and logs a business they already called
   * moments ago, and the duplicate looks exactly like a real second attempt.
   * (Codex caught this in review, 2026-08-23.) Nothing renders a lead until
   * the leads on screen belong to the queue named in the header.
   */
  ready: boolean;
  onExit: () => void;
  onLoadMore: (() => void) | null;
  hasMore: boolean;
}) {
  const [i, setI] = useState(0);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<CallOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastLogged, setLastLogged] = useState<{
    label: string;
    business: string;
    trackingWarning: boolean;
  } | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const exitRef = useRef<HTMLButtonElement>(null);
  const submissionRef = useRef<{ signature: string; requestId: string } | null>(null);

  // A NEW queue starts at the top. Without this, "load the next 50" leaves the
  // cursor at 50 -- past the end of the fresh array -- so the rep lands on the
  // finished screen again and the button appears broken. Keyed on queueKey
  // rather than on `leads` identity, because the parent re-creates that array
  // on every poll of the SAME page and resetting there would yank a rep back
  // to lead 1 mid-block.
  useEffect(() => {
    setI(0);
    setNote("");
    setError(null);
    submissionRef.current = null;
  }, [queueKey]);

  // Nothing resolves to a lead until the leads on screen belong to this queue
  // -- see the `ready` prop's doc comment. Everything downstream (the rendered
  // lead, the disposition buttons, the end-of-queue screen, the keyboard
  // shortcuts via `lead`) is gated through these two, so there is no second
  // place to remember. A shorter queue (a filter changed behind the overlay)
  // also cannot strand the cursor past the end.
  const lead: WebLeadRow | undefined = ready ? leads[i] : undefined;
  const atEnd = ready && i >= leads.length;

  const next = useCallback(() => {
    setNote("");
    setError(null);
    submissionRef.current = null;
    setI((n) => n + 1);
  }, []);

  const prev = useCallback(() => {
    setNote("");
    setError(null);
    submissionRef.current = null;
    setI((n) => Math.max(0, n - 1));
  }, []);

  const log = useCallback(
    async (outcome: CallOutcome) => {
      if (!lead || pending) return;
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
      setPending(outcome);
      setError(null);
      const business = lead.name;
      const label = OUTCOMES.find((o) => o.key === outcome)?.label || outcome;
      const signature = JSON.stringify([lead.id, outcome, trimmedNote]);
      const requestId =
        submissionRef.current?.signature === signature
          ? submissionRef.current.requestId
          : crypto.randomUUID();
      submissionRef.current = { signature, requestId };
      try {
        const r = await fetch(`/api/web-leads/${encodeURIComponent(lead.id)}/outcome`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcome, note: trimmedNote || undefined, requestId }),
        });
        const body = await r.json().catch(() => ({})) as {
          error?: string;
          trackingWarning?: string | null;
          retrySafe?: boolean;
          saved?: { outcomeSaved?: boolean; stageSaved?: boolean; leadContextSaved?: boolean; touchSaved?: boolean; trackingSaved?: boolean };
        };
        if (!r.ok) {
          // Do NOT advance on a failed write. Advancing here would lose the
          // call silently: the rep saw the queue move, so they believe it was
          // recorded, and nothing was. Staying put with a visible error is the
          // only honest behaviour.
          if (r.status < 500 || body.retrySafe === false) submissionRef.current = null;
          setError(
            body.error === "reason_required"
              ? "Add the reason before logging Not interested."
              : body.error === "note_too_long"
                ? `Keep the call note to ${MAX_CALL_NOTE_LENGTH.toLocaleString()} characters or fewer.`
                : body.error === "tracking_failed"
                  ? "The call and Pipeline update are saved, but its timeline entry is not. Try again; this retry will repair it without duplicating the call."
                  : body.error === "ownership_changed"
                    ? "The call was saved, but this lead changed owners before every update finished. Refresh the queue."
                  : body.saved?.outcomeSaved
                  ? "The call was saved, but Pipeline is not fully updated. Try again; this retry will not duplicate it."
                  : body.error === "request_id_conflict"
                    ? "This retry no longer matches the saved call. Refresh before logging again."
                    : "Could not confirm the call. Try again with the same details; it will not duplicate it.",
          );
          return;
        }
        submissionRef.current = null;
        setLastLogged({ label, business, trackingWarning: Boolean(body.trackingWarning) });
        next();
      } catch {
        setError("Could not confirm whether the server finished. Try again with the same details; it will not duplicate the call.");
      } finally {
        setPending(null);
      }
    },
    [lead, note, pending, next],
  );

  // Focus the exit button on mount so the overlay owns the keyboard immediately
  // (and so Tab starts inside it), and lock body scroll behind the overlay --
  // the same two affordances WebLeadDetail.tsx documents for its drawer.
  useEffect(() => {
    exitRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never steal a keystroke the rep is typing. Without this, writing the
      // word "no answer, call back" into the note box fires four dispositions
      // and skips four leads. Checked against the live target, not a ref, so
      // any future input in this overlay is covered by the same guard.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.isContentEditable)) {
        if (e.key === "Escape") (t as HTMLTextAreaElement).blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Escape stays live even mid-write: leaving is always allowed, and the
      // POST either lands or does not regardless of what is on screen.
      if (e.key === "Escape") { e.preventDefault(); onExit(); return; }
      if (e.key.toLowerCase() === "n") { e.preventDefault(); noteRef.current?.focus(); return; }

      /**
       * NOTHING MOVES THE QUEUE UNLESS A LEAD IS ACTUALLY ON SCREEN.
       *
       * Written as one condition rather than a list, because this bug arrived
       * twice in review as two different-looking instances of the same thing --
       * a keystroke advancing the cursor at a moment when the number it points
       * at means nothing:
       *
       *   - mid-write: a successful log() advances by itself, so a Skip pressed
       *     between the POST leaving and returning advances a SECOND time;
       *   - mid-load: after "load the next page" the cursor has reset and the
       *     new leads have not arrived, so a Skip lands the rep on lead 2 of
       *     the incoming page.
       *
       * Both silently skip a lead: never called, never logged, and nothing on
       * screen to suggest it was missed. On a 200-call day that is invisible
       * attrition out of a queue a rep believes they worked. `lead` is
       * undefined in exactly the states where the cursor is meaningless (not
       * ready, past the end), so gating on it closes the class rather than the
       * two reported instances. (Codex review, 2026-08-23, rounds 4 and 5.)
       */
      if (pending || !lead) return;

      if (e.key === "ArrowRight" || e.key.toLowerCase() === "s") { e.preventDefault(); next(); return; }
      if (e.key === "ArrowLeft" || e.key.toLowerCase() === "b") { e.preventDefault(); prev(); return; }
      const hit = OUTCOMES.find((o) => o.digit === e.key);
      if (hit) { e.preventDefault(); void log(hit.key); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // `lead` is in the deps for a reason: without it the handler closes over a
    // stale `lead` from the render where it was last re-bound, and the guard
    // above would test the wrong queue state.
  }, [log, next, prev, onExit, pending, lead]);

  const websiteHref = useMemo(() => preferredSiteUrl(lead?.websiteUrl ?? null), [lead?.websiteUrl]);
  const progress = leads.length ? Math.min(100, ((i + (atEnd ? 0 : 1)) / leads.length) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg" role="dialog" aria-modal="true" aria-label="Call mode">
      {/* ── Top bar: where am I, how far in, what did I just log ───────────── */}
      <header className="shrink-0 border-b border-bg-border bg-bg-panel/80 backdrop-blur">
        <div className="flex items-center gap-4 px-5 py-3">
          <button
            ref={exitRef}
            type="button"
            onClick={onExit}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-bg-border px-3 text-xs font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 xl:min-h-0 xl:px-2.5 xl:py-1.5"
          >
            <X className="h-4 w-4" />Exit <Key>Esc</Key>
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-fg-muted">{queueLabel}</p>
            {lastLogged && (
              <>
                <p className="mt-0.5 truncate text-[11px] text-fg-dim">
                  Logged <span className="text-fg-muted">{lastLogged.label}</span> for {lastLogged.business}
                </p>
                {lastLogged.trackingWarning && (
                  <p className="mt-0.5 truncate text-[11px] text-amber-300">
                    Lead updated; its timeline entry was not recorded.
                  </p>
                )}
              </>
            )}
          </div>

          <p className="shrink-0 text-xs tabular-nums text-fg-dim">
            <span className="font-semibold text-fg">{Math.min(i + 1, leads.length)}</span> of {leads.length}
          </p>
        </div>
        <div className="h-0.5 w-full bg-bg-border">
          <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${progress}%` }} />
        </div>
      </header>

      {/* ── End of queue ───────────────────────────────────────────────────── */}
      {atEnd ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md text-center">
            <p className="text-2xl font-bold text-fg">Queue finished</p>
            <p className="mt-2 text-sm text-fg-muted">
              You worked all {leads.length} lead{leads.length === 1 ? "" : "s"} in {queueLabel}.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              {hasMore && onLoadMore && (
                <button
                  type="button"
                  onClick={onLoadMore}
                  className="inline-flex min-h-11 items-center rounded-md bg-gradient-to-br from-accent to-accent-muted px-4 text-sm font-bold text-white transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  Load the next page
                </button>
              )}
              <button
                type="button"
                onClick={() => setI(0)}
                className="inline-flex min-h-11 items-center rounded-md border border-bg-border px-4 text-sm font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
              >
                Start over
              </button>
              <button
                type="button"
                onClick={onExit}
                className="inline-flex min-h-11 items-center rounded-md border border-bg-border px-4 text-sm font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
              >
                Back to the list
              </button>
            </div>
          </div>
        </div>
      ) : !lead ? (
        <div className="flex flex-1 items-center justify-center p-8" aria-busy="true" aria-live="polite">
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 className="h-4 w-4 animate-spin" />Loading the next leads…
          </p>
        </div>
      ) : (
        // THE SCROLLER MOVED FROM THIS ROW INTO <main>. It used to be
        // `overflow-y-auto` here, which made the whole column one scroll
        // region: on a phone the four disposition buttons were the bottom of
        // that scroll, i.e. below however long the talking points ran. Scrolled
        // to reach, at the exact moment a rep has a phone in one hand. With the
        // scroll on <main> instead, <aside> is a sibling that keeps its own
        // height and the buttons sit on the bottom edge of the viewport.
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* ── The business, the number, the script ─────────────────────── */}
          <main className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-6 sm:py-7 lg:px-10 lg:py-9">
            <div className="mx-auto max-w-2xl">
              <h1 className="text-3xl font-bold leading-tight tracking-tight text-fg lg:text-4xl">{lead.name}</h1>
              <p className="mt-2 text-sm text-fg-muted">
                {[lead.industry, lead.city, lead.province].filter(Boolean).join(" · ") || "No location on file"}
              </p>

              {/* THE CALL BUTTON IS NOT ONE OF THREE EQUAL PILLS ANY MORE.
                  Full width and 64px tall below `sm`, because on the device
                  that can actually dial it is the whole reason this screen is
                  open; the other two drop to a 44px row underneath it. On a
                  desktop they go back to sitting in one line, where the call
                  button opens whatever handler the OS guesses at and deserves
                  no more room than its neighbours. */}
              <div className="mt-6 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
                {lead.phone ? (
                  <a
                    href={`tel:${lead.phone}`}
                    className="inline-flex min-h-16 w-full items-center justify-center gap-2.5 whitespace-nowrap rounded-lg bg-gradient-to-br from-accent to-accent-muted px-5 text-xl font-bold tabular-nums text-white shadow-[0_0_0_1px_rgba(59,130,246,0.18),0_10px_28px_-10px_rgba(59,130,246,0.5)] transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:min-h-0 sm:w-auto sm:py-3 sm:text-base"
                  >
                    <Phone className="h-5 w-5 shrink-0" />{lead.phone}
                    {lead.phoneExt && (
                      <span className="text-base font-semibold opacity-90">ext. {lead.phoneExt}</span>
                    )}
                  </a>
                ) : (
                  <p className="rounded-lg border border-bg-border px-5 py-3 text-sm text-fg-dim">
                    No phone number on file
                  </p>
                )}

              {/* WHAT WE KNOW ABOUT THAT NUMBER, directly under the button that
                  dials it. This is the last thing a rep reads before the call
                  connects, so a warning anywhere else arrives too late. It never
                  disables or hides the button: an uncertain number still reaches
                  the rep, with a warning. */}
              {lead.phone && (
                <div className="mt-3">
                  <PhoneTierBadge tier={lead.phoneTier} />
                  {lead.phoneReasons.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {lead.phoneReasons.map((r) => (
                        <li key={r} className="flex gap-2 text-xs leading-relaxed text-fg-muted">
                          <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-fg-muted" aria-hidden />
                          {r}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
                <div className="flex items-stretch gap-2.5 sm:contents">
                {websiteHref && (
                  <a
                    href={websiteHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-bg-border bg-bg-panel px-4 text-sm font-semibold text-fg transition-colors hover:border-accent/40 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:flex-none sm:py-3"
                  >
                    <ExternalLink className="h-4 w-4" />Their site
                  </a>
                )}
                {/* FULL DETAIL IS THE BATTLE CARD NOW, IN A NEW TAB.
                    It used to drop out of Call Mode and open the 28rem drawer
                    behind it, which cost the rep their place in the queue to
                    read a narrower version of what they were already looking
                    at. /web-leads/[id] is the deeper view -- percentile against
                    real local competitors, the head-to-head, every failed check
                    with what it costs -- and opening it in its own tab means
                    the queue, the cursor and the disposition keys survive
                    intact behind it. */}
                <a
                  href={`/web-leads/${encodeURIComponent(lead.id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-bg-border bg-bg-panel px-4 text-sm font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:flex-none sm:py-3"
                >
                  Full detail
                </a>
                </div>
              </div>

              {/* VERBATIM, and it stays next to the call button rather than
                  buried below the score: this is the unverified directory
                  status, and a rep should see the hedge before they speak. */}
              <p className="mt-4 text-xs italic text-fg-dim">{lead.websiteCondition}</p>

              <div className="mt-8 border-t border-bg-border pt-7">
                <TalkingPoints leadId={lead.id} />
              </div>
            </div>
          </main>

          {/* ── What happened ────────────────────────────────────────────── */}
          {/* `shrink-0` and NOT inside the scroller: this is the thumb-reachable
              bottom of the phone, and it stays there while the talking points
              scroll behind it. `pb-[env(safe-area-inset-bottom)]` keeps the
              disposition row clear of the iOS home indicator, which otherwise
              sits on top of the bottom 34px of a full-height overlay.

              🚨 `max-h-[65vh] overflow-y-auto` IS NOT DECORATION. (Codex review,
              2026-08-25, P2, then MEASURED.) Pinning this panel trades a scroll
              for reach, and the trade goes bad the moment the panel is taller
              than the screen: only <main> scrolls, the page behind is
              scroll-locked by the overlay, so a `shrink-0` aside that overruns
              pushes its own lower half past the bottom edge with nothing able
              to bring it back. Measured on iPhone landscape (844x390) with the
              "Add the reason before logging Not interested" banner up: the
              panel wanted 348px of a 390px viewport and Back/Skip sat at
              top 419 -- 29px below the screen, unreachable. Capping it means it
              scrolls INSIDE itself instead, and because the dispositions are at
              the top of the panel they stay visible while the note, the error
              and Back/Skip become reachable. The cap does nothing on a normal
              portrait phone (65vh of 844 is 548px against a 348px panel); it
              only ever engages when the alternative was losing a control. */}
          <aside className="max-h-[65vh] shrink-0 overflow-y-auto overscroll-contain border-t border-bg-border bg-bg-panel/50 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 lg:max-h-none lg:w-80 lg:border-l lg:border-t-0 lg:px-6 lg:py-9 lg:pb-9">
            <p className="hidden text-[10px] font-bold uppercase tracking-[0.16em] text-fg-muted lg:block">Log this call</p>
            {/* A 2x2 GRID BELOW `lg`, not a stack. Four full-width rows would
                push the note box off a 390x844 screen; a grid keeps all four
                dispositions AND the note above the fold, and 56px squares are
                a thumb target rather than a cursor target. The key caps are
                hidden here (see Key) -- the label carries the button. */}
            <div className="grid grid-cols-2 gap-2 lg:mt-3 lg:grid-cols-1">
              {OUTCOMES.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  disabled={pending !== null}
                  onClick={() => void log(o.key)}
                  className="flex min-h-14 w-full items-center justify-center gap-2 rounded-lg border border-bg-border bg-bg-panel px-2 text-sm font-semibold text-fg transition-colors hover:border-accent/40 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-50 lg:justify-between lg:gap-3 lg:px-3.5 lg:py-3"
                >
                  <span className="flex items-center gap-2 text-center lg:text-left">
                    {pending === o.key && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
                    {o.label}
                  </span>
                  <Key>{o.digit}</Key>
                </button>
              ))}
            </div>

            <textarea
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={MAX_CALL_NOTE_LENGTH}
              // Two rows on a phone, three at a desk. The box is required for
              // "Not interested", so it cannot be collapsed behind a toggle --
              // a rep who cannot see it reads the validation error as a bug.
              rows={2}
              placeholder="Call note (required for Not interested)"
              className="mt-2 w-full resize-y rounded-lg border border-bg-border bg-bg-deep px-3 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none lg:mt-3"
            />
            {/* The keyboard sentence is desktop-only; the rest is true on both. */}
            <p className="mt-1.5 text-[11px] text-fg-dim">
              <span className="hidden lg:inline"><Key>N</Key> jumps here. </span>
              A reason is required for Not interested. Logging moves to the next lead.
            </p>

            {error && <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-200">{error}</p>}

            <div className="mt-2.5 flex items-stretch gap-2 lg:mt-5 lg:items-center lg:border-t lg:border-bg-border lg:pt-4">
              <button
                type="button"
                onClick={prev}
                // Same rule as the keyboard handler: a successful log()
                // advances on its own, so a second move mid-write skips a lead.
                disabled={i === 0 || pending !== null}
                className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-bg-border px-4 text-xs font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-40 xl:min-h-0 xl:px-2.5 xl:py-1.5"
              >
                <ArrowLeft className="h-3.5 w-3.5" />Back
              </button>
              <button
                type="button"
                onClick={next}
                disabled={pending !== null}
                className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md border border-bg-border px-2.5 text-xs font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-40 xl:min-h-0 xl:py-1.5"
              >
                Skip <Key>S</Key><ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
