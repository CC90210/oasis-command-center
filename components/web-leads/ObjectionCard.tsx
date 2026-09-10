"use client";

/**
 * ObjectionCard — one objection, ranked for one lead, built to be read and
 * tapped while a stranger is on the phone. Replaces the per-lead half of
 * ObjectionPanel.tsx (deleted in the next task): that component rendered the
 * same eight brush-offs on every lead from a hardcoded table; this renders
 * whatever lib/web-leads/objections/ranking.ts put in front of THIS lead,
 * from the approved catalog, with an in-call tap and an optional resolution.
 *
 * ═══ THE THREE RULES CARRIED FORWARD FROM ObjectionPanel.tsx ═══════════════
 *
 * That file is being deleted with this one taking its place, so its rules do
 * not get to lapse just because the component that stated them is gone:
 *
 * 1. NO COLOUR IS KEYED TO ANYTHING — not a score, not tap frequency, not a
 *    `lost` resolution. Dark tokens only. A red "lost" button trains a rep to
 *    avoid pressing it, exactly what CallOutcomeLog's docblock documents for
 *    `not_interested`: the four call outcomes and the three resolutions below
 *    share one neutral, un-editorialised style.
 * 2. THE SPOKEN LINE STAYS VISUALLY DOMINANT. `says` (what the prospect said)
 *    and the active answer's `body` (what the rep says back) are the only two
 *    things ever read aloud. `meaning` and `prevent` are coaching notes for
 *    between calls, not lines, and are styled quieter and smaller so neither
 *    can be mistaken for the script at a glance mid-sentence.
 * 3. `prevent` STAYS NEXT TO ITS OBJECTION, always visible under a rule, never
 *    behind a tap of its own. Only the answer postures and the standard-
 *    wording toggle are ever collapsed; the prevention line never is.
 *
 * Everything under `says`/`meaning`/`prevent` renders verbatim from the
 * catalog row — this component holds no copy of its own beyond its controls'
 * labels, the same discipline ObjectionPanel held over its fixed table.
 *
 * ═══ THE STANDARD-WORDING TOGGLE, AND WHY IT IS DEAD CODE TODAY ════════════
 *
 * An answer's `body` is always the spoken line; `libraryBody` is set only
 * when a lead-tailored variant replaced it, and holds the reviewed sentence
 * so it stays one tap away. Nothing writes `objection_lead_variant` in Phase
 * 1 (that is Phase 2's job — see lib/web-leads/objections/types.ts), so
 * `libraryBody` is absent on every answer today. The toggle is built anyway,
 * gated on the field's presence, so turning tailored variants on later is a
 * data change, not a component change — and the card renders correctly with
 * the field absent, which is both today's state and the permanent fallback.
 *
 * ═══ THE TAP: ONE THUMB, NO MODAL, NO CONFIRMATION ══════════════════════════
 *
 * `requestIdRef` is generated once per mount and reused for every retry of
 * that tap, so a flaky connection retries idempotently instead of a fresh id
 * per click turning a double-tap into two logged objections. The tap marks
 * the card "Logged" optimistically, before the network round trip returns,
 * because a rep mid-sentence needs the card to acknowledge instantly and
 * settle behind them — it must never open a dialog, block, or steal focus.
 *
 * `aliveRef` guards against a response landing after this instance stopped
 * being the right place to apply it. The brief's own sketch of this pattern
 * returned a cleanup function from inside the tap handler, which is a defect:
 * a plain event handler is not an effect, so nothing ever calls that return
 * value. The real fix used here is a ref flipped by an effect's own cleanup
 * (`useEffect(() => { aliveRef.current = true; return () => { aliveRef.current
 * = false; }; }, [])`), read after `await r.json()` (the same "alive after
 * the body parse" pattern CallOutcomeLog documents, so a slow response can
 * never land after a faster one and overwrite it). It is unmount-only rather
 * than also keyed on a `leadId` change because ObjectionConsole keys each
 * card by `${leadId}:${objection.id}` — a lead switch always unmounts and
 * remounts this component rather than reusing the instance, so there is no
 * case where one instance survives a lead change to receive a late write
 * meant for a different lead.
 */

import { useEffect, useRef, useState } from "react";
import {
  OBJECTION_RESOLUTIONS,
  POSTURE_LABEL,
  type CatalogObjection,
  type ObjectionAnswer,
  type ObjectionEventRecord,
  type ObjectionResolution,
} from "@/lib/web-leads/objections/types";

const RESOLUTION_LABEL: Record<ObjectionResolution, string> = {
  recovered: "Recovered",
  stalled: "Stalled",
  lost: "Lost",
};

function defaultAnswerId(answers: ObjectionAnswer[]): string | null {
  return (answers.find((a) => a.isDefault) ?? answers[0])?.id ?? null;
}

const PILL =
  "rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em] transition-[color,border-color,box-shadow] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-60";
const PILL_ON = "border-accent/50 bg-bg-hover text-fg shadow-glow";
const PILL_OFF = "border-bg-border text-fg-dim hover:border-accent/40 hover:text-fg";

export function ObjectionCard({
  leadId,
  objection,
  existingEvent,
  canMutate,
}: {
  leadId: string;
  objection: CatalogObjection;
  existingEvent: ObjectionEventRecord | null;
  canMutate: boolean;
}) {
  const answers = objection.answers;
  const [activeAnswerId, setActiveAnswerId] = useState<string | null>(() => defaultAnswerId(answers));
  const [showStandard, setShowStandard] = useState(false);

  // ONE request id per card mount, reused by every retry of that tap. See the
  // file docblock for why a fresh id per click is the failure this avoids.
  const requestIdRef = useRef<string>(crypto.randomUUID());

  const [eventId, setEventId] = useState<string | null>(existingEvent?.id ?? null);
  const [logged, setLogged] = useState<boolean>(Boolean(existingEvent));
  const [failed, setFailed] = useState(false);
  const [resolution, setResolution] = useState<ObjectionResolution | null>(existingEvent?.resolution ?? null);
  const [resolutionPending, setResolutionPending] = useState<ObjectionResolution | null>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const activeAnswer = answers.find((a) => a.id === activeAnswerId) ?? null;
  const displayedBody = activeAnswer
    ? showStandard && activeAnswer.libraryBody
      ? activeAnswer.libraryBody
      : activeAnswer.body
    : null;

  async function logTap() {
    // Optimistic. A rep is mid-sentence: the card must acknowledge instantly
    // and settle behind them. It must NOT open a dialog, block, or steal
    // focus. `logged && !failed` already disables the control below, so this
    // only ever runs as the first tap or a retry after a failure.
    if (!canMutate || (logged && !failed)) return;
    setLogged(true);
    setFailed(false);
    try {
      const r = await fetch(`/api/web-leads/${encodeURIComponent(leadId)}/objections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objectionId: objection.id,
          requestId: requestIdRef.current,
          responseId: activeAnswer?.id ?? null,
          usedVariant: Boolean(activeAnswer?.libraryBody),
        }),
      });
      const body = await r.json();
      // Read AFTER the body parse, not when the fetch first resolves, so a
      // slow response arriving after this card unmounted can never write
      // into a component instance that no longer represents this tap.
      if (!aliveRef.current) return;
      if (!r.ok || !body?.ok) {
        setLogged(false);
        setFailed(true);
        return;
      }
      setEventId(body.event.id as string);
      if (body.event?.resolution) setResolution(body.event.resolution as ObjectionResolution);
    } catch {
      if (!aliveRef.current) return;
      setLogged(false);
      setFailed(true);
    }
  }

  async function setResolutionTap(next: ObjectionResolution) {
    if (!canMutate || !eventId || resolutionPending) return;
    const prev = resolution;
    setResolution(next);
    setResolutionPending(next);
    try {
      const r = await fetch(`/api/web-leads/${encodeURIComponent(leadId)}/objections/${encodeURIComponent(eventId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution: next }),
      });
      const body = await r.json();
      if (!aliveRef.current) return;
      if (!r.ok || !body?.ok) setResolution(prev);
    } catch {
      if (!aliveRef.current) return;
      setResolution(prev);
    } finally {
      if (aliveRef.current) setResolutionPending(null);
    }
  }

  return (
    <li className="rounded-lg border border-bg-border bg-bg-raised/60 p-4">
      <p className="text-sm font-semibold text-fg">&ldquo;{objection.says}&rdquo;</p>
      <p className="mt-1.5 text-xs italic leading-relaxed text-fg-muted">{objection.meaning}</p>

      {answers.length > 0 && (
        <div className="mt-3">
          {answers.length > 1 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Answer posture">
              {answers.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  aria-pressed={a.id === activeAnswerId}
                  onClick={() => {
                    setActiveAnswerId(a.id);
                    setShowStandard(false);
                  }}
                  className={`${PILL} ${a.id === activeAnswerId ? PILL_ON : PILL_OFF}`}
                >
                  {POSTURE_LABEL[a.posture]}
                </button>
              ))}
            </div>
          )}
          {activeAnswer && (
            <div className="mt-2 border-l-2 border-accent/30 pl-3">
              <p className="text-sm leading-relaxed text-fg">{displayedBody}</p>
              {activeAnswer.libraryBody && (
                <button
                  type="button"
                  onClick={() => setShowStandard((s) => !s)}
                  className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-dim underline decoration-dotted underline-offset-2 hover:text-fg"
                >
                  {showStandard ? "Show tailored wording" : "Show standard wording"}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-3 border-t border-bg-border pt-2.5">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">So it does not come up</p>
        <p className="mt-1 text-xs leading-relaxed text-fg-muted">{objection.prevent}</p>
        {objection.source && <p className="mt-1.5 text-[11px] leading-relaxed text-fg-muted/70">Source: {objection.source}</p>}
      </div>

      {canMutate && (
        <div className="mt-3 border-t border-bg-border pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={logged && !failed}
              aria-pressed={logged && !failed}
              onClick={logTap}
              className="rounded-lg border border-accent/40 px-3 py-1.5 text-xs font-semibold text-fg transition-[color,border-color,box-shadow] hover:border-accent/70 hover:shadow-glow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
            >
              {logged && !failed ? "Logged" : "They said this"}
            </button>
            {failed && (
              <button
                type="button"
                onClick={logTap}
                className="text-[11px] font-medium text-fg-dim underline decoration-dotted underline-offset-2 hover:text-fg"
              >
                Not logged. Tap to retry.
              </button>
            )}
          </div>

          {eventId && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">How it went</span>
              {OBJECTION_RESOLUTIONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  disabled={resolutionPending !== null}
                  aria-pressed={resolution === r}
                  onClick={() => setResolutionTap(r)}
                  className={`${PILL} ${resolution === r ? PILL_ON : PILL_OFF}`}
                >
                  {resolutionPending === r ? "…" : RESOLUTION_LABEL[r]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export default ObjectionCard;
