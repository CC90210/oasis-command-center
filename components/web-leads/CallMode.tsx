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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Loader2, Phone, X } from "lucide-react";
import type { WebLeadRow } from "@/lib/web-leads/data";
import type { CallOutcome } from "@/lib/web-leads/outcome";
import { safeExternalUrl } from "@/lib/web-leads/url-safety";
import { remedyFor } from "@/lib/web-leads/remedies";
import { useAudit, biggestGaps, SCORE_STATE_WORDS } from "./useAudit";

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

/** A keyboard hint rendered as a key cap, so the shortcut is discoverable
 *  without a help screen -- reps learn these in the first ten calls. */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-bg-border bg-bg-deep px-1.5 font-mono text-[10px] font-semibold text-fg-dim">
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
  leads, queueKey, queueLabel, ready, onExit, onOpenDetail, onLoadMore, hasMore,
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
  onOpenDetail: (id: string) => void;
  onLoadMore: (() => void) | null;
  hasMore: boolean;
}) {
  const [i, setI] = useState(0);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<CallOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastLogged, setLastLogged] = useState<{ label: string; business: string } | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const exitRef = useRef<HTMLButtonElement>(null);

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
    setI((n) => n + 1);
  }, []);

  const prev = useCallback(() => {
    setNote("");
    setError(null);
    setI((n) => Math.max(0, n - 1));
  }, []);

  const log = useCallback(
    async (outcome: CallOutcome) => {
      if (!lead || pending) return;
      setPending(outcome);
      setError(null);
      const business = lead.name;
      const label = OUTCOMES.find((o) => o.key === outcome)?.label || outcome;
      try {
        const r = await fetch(`/api/web-leads/${encodeURIComponent(lead.id)}/outcome`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ outcome, note: note.trim() || undefined }),
        });
        if (!r.ok) {
          // Do NOT advance on a failed write. Advancing here would lose the
          // call silently: the rep saw the queue move, so they believe it was
          // recorded, and nothing was. Staying put with a visible error is the
          // only honest behaviour.
          setError("Could not log that. The call was not recorded, try again.");
          return;
        }
        setLastLogged({ label, business });
        next();
      } catch {
        setError("Could not log that. The call was not recorded, try again.");
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

  const websiteHref = useMemo(() => safeExternalUrl(lead?.websiteUrl ?? null), [lead?.websiteUrl]);
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
            className="inline-flex items-center gap-1.5 rounded-md border border-bg-border px-2.5 py-1.5 text-xs font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
          >
            <X className="h-3.5 w-3.5" />Exit <Key>Esc</Key>
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-fg-muted">{queueLabel}</p>
            {lastLogged && (
              <p className="mt-0.5 truncate text-[11px] text-fg-dim">
                Logged <span className="text-fg-muted">{lastLogged.label}</span> for {lastLogged.business}
              </p>
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
                  className="rounded-md bg-gradient-to-br from-accent to-accent-muted px-4 py-2.5 text-sm font-bold text-white transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  Load the next page
                </button>
              )}
              <button
                type="button"
                onClick={() => setI(0)}
                className="rounded-md border border-bg-border px-4 py-2.5 text-sm font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
              >
                Start over
              </button>
              <button
                type="button"
                onClick={onExit}
                className="rounded-md border border-bg-border px-4 py-2.5 text-sm font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
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
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row">
          {/* ── The business, the number, the script ─────────────────────── */}
          <main className="min-w-0 flex-1 px-6 py-7 lg:px-10 lg:py-9">
            <div className="mx-auto max-w-2xl">
              <h1 className="text-3xl font-bold leading-tight tracking-tight text-fg lg:text-4xl">{lead.name}</h1>
              <p className="mt-2 text-sm text-fg-muted">
                {[lead.industry, lead.city, lead.province].filter(Boolean).join(" · ") || "No location on file"}
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                {lead.phone ? (
                  <a
                    href={`tel:${lead.phone}`}
                    className="inline-flex items-center gap-2.5 rounded-lg bg-gradient-to-br from-accent to-accent-muted px-5 py-3 text-base font-bold tabular-nums text-white shadow-[0_0_0_1px_rgba(59,130,246,0.18),0_10px_28px_-10px_rgba(59,130,246,0.5)] transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    <Phone className="h-4.5 w-4.5" />{lead.phone}
                  </a>
                ) : (
                  <p className="rounded-lg border border-bg-border px-5 py-3 text-sm text-fg-dim">
                    No phone number on file
                  </p>
                )}
                {websiteHref && (
                  <a
                    href={websiteHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg border border-bg-border bg-bg-panel px-4 py-3 text-sm font-semibold text-fg transition-colors hover:border-accent/40 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    <ExternalLink className="h-4 w-4" />Their site
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => onOpenDetail(lead.id)}
                  className="inline-flex items-center gap-2 rounded-lg border border-bg-border bg-bg-panel px-4 py-3 text-sm font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  Full detail
                </button>
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
          <aside className="shrink-0 border-t border-bg-border bg-bg-panel/50 px-6 py-6 lg:w-80 lg:border-l lg:border-t-0 lg:px-6 lg:py-9">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-fg-muted">Log this call</p>
            <div className="mt-3 space-y-2">
              {OUTCOMES.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  disabled={pending !== null}
                  onClick={() => void log(o.key)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-bg-border bg-bg-panel px-3.5 py-3 text-sm font-semibold text-fg transition-colors hover:border-accent/40 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="flex items-center gap-2">
                    {pending === o.key && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
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
              rows={3}
              placeholder="Note for this call (optional)"
              className="mt-3 w-full resize-y rounded-lg border border-bg-border bg-bg-deep px-3 py-2.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
            />
            <p className="mt-1.5 text-[11px] text-fg-dim">
              <Key>N</Key> jumps here. Logging an outcome moves you to the next lead.
            </p>

            {error && <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-200">{error}</p>}

            <div className="mt-5 flex items-center gap-2 border-t border-bg-border pt-4">
              <button
                type="button"
                onClick={prev}
                // Same rule as the keyboard handler: a successful log()
                // advances on its own, so a second move mid-write skips a lead.
                disabled={i === 0 || pending !== null}
                className="inline-flex items-center gap-1.5 rounded-md border border-bg-border px-2.5 py-1.5 text-xs font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-40"
              >
                <ArrowLeft className="h-3.5 w-3.5" />Back
              </button>
              <button
                type="button"
                onClick={next}
                disabled={pending !== null}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-bg-border px-2.5 py-1.5 text-xs font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-40"
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
