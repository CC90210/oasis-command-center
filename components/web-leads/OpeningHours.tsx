"use client";

/**
 * OpeningHours — when this business is open, in ITS time zone, and whether a
 * rep may legally phone it right now.
 *
 * ═══ WHY THIS EXISTS ════════════════════════════════════════════════════════
 *
 * Measured 2026-08-24: 31,034 leads, ZERO carrying any opening-hours field.
 * JARVIS read OpenStreetMap's `opening_hours` tag only to reject businesses
 * marked closed, then threw the value away. The operator's words: "Some
 * companies are closed on Monday. Some are closed on the weekends... we need to
 * see the times that they're able to actually reach out."
 *
 * A dial into a shut business costs twice. The dial is wasted, and the lead is
 * burned: nobody answers, the rep logs a no-answer, the expiry clock resets.
 *
 * ═══ THE FOUR RULES THIS FILE DOES NOT GET TO BREAK ═════════════════════════
 *
 * 1. UNKNOWN IS A SENTENCE. Roughly three-quarters of the corpus has no hours
 *    at all. That renders as words a rep can read, never as a blank cell and
 *    never as an assumption that they are open. A blank reads as "the page did
 *    not finish loading"; "open" wastes the dial this feature exists to save.
 *
 * 2. THE RAW STRING IS ALWAYS AVAILABLE. JARVIS's parser deliberately refuses
 *    forms it cannot read exactly — seasonal `Apr-Oct ...`, `sunrise-sunset`,
 *    "by appointment". When it refuses, the recorded string is shown verbatim.
 *    A rep reading `Apr-Oct Mo-Su 11:00-23:00` understands it instantly; a
 *    parser that silently dropped the `Apr-Oct` would have told them a summer
 *    patio is open in February.
 *
 * 3. NO COLOUR IS KEYED TO ANYTHING. Open and closed are factual states, not
 *    judgements, so they get a neutral indicator and different WORDS — never
 *    green for open and red for closed. This file is in the colour ban list in
 *    tests/web-leads-guards.test.ts alongside the battle card, because a green
 *    dot beside a score is exactly how "no colour keyed to a score" erodes.
 *
 * 4. THE CALLING-HOURS CAUTION WARNS, IT NEVER BLOCKS. CRTC Rule 23 restricts
 *    calls to 9:00 a.m.-9:30 p.m. weekdays and 10:00 a.m.-6:00 p.m. weekends
 *    IN THE RECIPIENT'S TIME ZONE. A Toronto rep dialling Vancouver at 9:00 is
 *    calling at 6:00 a.m., which is a violation at up to $15,000 per call. But
 *    our province-to-zone mapping has stated ambiguities (Northwestern Ontario,
 *    Nunavut), and a hard block built on a derived zone would refuse legitimate
 *    calls without explaining itself. Showing "it is 6:12 am there" lets a rep
 *    make the call the rule actually asks them to make.
 */

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import type { WebLead } from "@/lib/web-leads/data";
import { leadHours, type LeadHours } from "@/lib/web-leads/hours";

/**
 * The current instant, or null until the browser has mounted.
 *
 * ═══ WHY NULL AND NOT `new Date()` ══════════════════════════════════════════
 *
 * These are client components, but Next still renders them on the server. A
 * clock read during render produces one value on the server and a different one
 * in the browser, which is a hydration mismatch -- and the visible symptom is
 * React discarding the server markup, so the first thing a rep sees flickers.
 * Reading the clock only after mount removes the mismatch by construction.
 *
 * It also means there is one frame with no clock, and that frame must not lie.
 * It does not render "Hours unknown" (we do not know that yet) and it does not
 * render a blank. It says what is true: we are working the local time out.
 *
 * Re-reads every 30 seconds so a card left open across 9:00 a.m. in the
 * business's zone stops warning on its own, rather than telling a rep they may
 * not call somebody they may now call.
 */
export function useNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Matches the label treatment BusinessFacts uses, so the block sits flush. */
const LABEL = "text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted";

/**
 * The neutral state indicator.
 *
 * Three states, three shapes, one colour family. Open is a filled dot, closed
 * is a ring, unknown is a dim dash — so the state survives a greyscale screen,
 * a colourblind reader, and rule 3 above. The WORDS carry the meaning; the mark
 * is only there to make the row scannable.
 */
function StateMark({ state }: { state: LeadHours["state"] }) {
  if (state === "open") {
    return <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full bg-accent" />;
  }
  if (state === "closed") {
    return (
      <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full border border-fg-dim" />
    );
  }
  return <span aria-hidden className="inline-block h-px w-2 shrink-0 bg-fg-faint" />;
}

/**
 * The compact form, for a table row.
 *
 * Deliberately carries the local time next to the state. "Closed now" alone
 * invites a rep to move on; "Closed now, 6:12 am there" tells them it is a
 * timing problem, not a dead lead, which is the difference between skipping a
 * business and scheduling it.
 */
export function OpenNowCell({ lead, now }: { lead: WebLead; now: Date | null }) {
  if (!now) {
    return <p className="text-xs text-fg-dim">Working out their local time</p>;
  }
  const h = hoursFor(lead, now);
  return (
    <div className="flex items-center gap-2">
      <StateMark state={h.state} />
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold text-fg">{h.headline}</p>
        {h.clock && (
          <p className="truncate text-[11px] text-fg-dim">{h.clock.label} there</p>
        )}
      </div>
    </div>
  );
}

/**
 * The full block, for the battle card and the drawer.
 *
 * `now` is passed in rather than read here so one render cannot show two
 * different clocks for two leads a millisecond apart, and so the whole surface
 * is testable at a fixed instant.
 */
export function OpeningHoursPanel({
  lead,
  now,
  layout = "stack",
}: {
  lead: WebLead;
  now: Date | null;
  layout?: "stack" | "grid";
}) {
  const wide = layout === "grid" ? "sm:col-span-2 lg:col-span-3" : "";

  // One frame, before the clock exists. Says what is true rather than guessing
  // at a state -- see useNow's doc comment.
  if (!now) {
    return (
      <div className={`flex gap-3 border-b border-bg-border/60 py-2.5 ${wide}`}>
        <div className="mt-0.5 shrink-0 text-fg-dim" aria-hidden><Clock className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <p className={LABEL}>Opening hours</p>
          <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
            Working out the local time where this business is.
          </p>
        </div>
      </div>
    );
  }

  const h = hoursFor(lead, now);

  return (
    <div className={`flex gap-3 border-b border-bg-border/60 py-2.5 ${wide}`}>
      <div className="mt-0.5 shrink-0 text-fg-dim" aria-hidden>
        <Clock className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className={LABEL}>Opening hours</p>

        {/* Headline + the business's own clock, on one line. */}
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-raised px-2 py-1 text-xs font-semibold text-fg">
            <StateMark state={h.state} />
            {h.headline}
          </span>
          {h.clock && (
            <span className="text-xs text-fg-muted">
              {h.clock.label} where they are
            </span>
          )}
        </div>

        {/* Always a full sentence, in every state. */}
        <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{h.detail}</p>

        {/* CRTC Rule 23. A caution, never a gate -- see rule 4 in the header. */}
        {h.call.allowed === false && (
          <p className="mt-2 rounded-md border border-accent/40 bg-bg-raised px-2.5 py-2 text-xs leading-relaxed text-fg">
            <span className="font-semibold">Outside calling hours.</span> {h.call.reason}
          </p>
        )}
        {h.call.allowed === null && (
          <p className="mt-2 rounded-md border border-bg-border bg-bg-raised px-2.5 py-2 text-xs leading-relaxed text-fg-muted">
            {h.call.reason}
          </p>
        )}

        {/* The week. Seven rows, always -- a missing Monday and a Monday that
            says Closed look identical at a glance and mean opposite things. */}
        {h.week.length > 0 && (
          <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {h.week.map((row) => (
              <div key={row.day} className="contents">
                <dt className={row.isToday ? "font-semibold text-fg" : "text-fg-dim"}>
                  {row.label}
                  {row.isToday && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-fg-muted">today</span>}
                </dt>
                <dd className={row.isToday ? "text-fg" : "text-fg-muted"}>{row.hours}</dd>
              </div>
            ))}
          </dl>
        )}

        {/* Public holidays and anything else the parse could not fold into the
            week. Sentences, because they are read aloud. */}
        {h.caveats.map((c) => (
          <p key={c} className="mt-1.5 text-xs leading-relaxed text-fg-dim">{c}</p>
        ))}

        {/* The recorded string. Shown whenever we hold one -- beside a parse the
            rep can check it against, and INSTEAD of a grid when the parse
            refused. Italic and quiet, the same treatment BusinessFacts gives
            every other unverified directory value. */}
        {h.raw && (
          <p className="mt-1.5 break-words font-mono text-[11px] leading-relaxed text-fg-dim">
            <span className="font-sans not-italic">As recorded in the directory: </span>
            {h.raw}
          </p>
        )}

        {/* The zone we assumed, only where the province genuinely spans zones.
            An hour's error here is an hour of legal exposure, so it is stated
            rather than buried in a source comment. */}
        {h.zoneAssumption && h.clock && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-fg-dim">{h.zoneAssumption}</p>
        )}
      </div>
    </div>
  );
}

/** One resolution point, so no two surfaces can disagree about one business. */
function hoursFor(lead: WebLead, now: Date): LeadHours {
  return leadHours(
    {
      province: lead.province,
      openingHours: lead.openingHours,
      openingHoursRaw: lead.openingHoursRaw,
      openingHoursCheckedAt: lead.openingHoursCheckedAt,
    },
    now,
  );
}
