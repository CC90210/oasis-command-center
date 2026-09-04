"use client";

/**
 * LeadCards — the results list below `xl`. One card per lead.
 *
 * A NARROWER TABLE IS NOT THE ANSWER; A TABLE IS THE WRONG SHAPE. Measured in
 * Chrome (.measure/), the shared-pool table's floor is 730px and My Leads' is
 * 828px, against a content box of 358px on a 390px phone. That is not a table
 * that needs tuning, it is 2.3x too wide, and the failure is silent: the
 * wrapper is `overflow-hidden` for its rounded corners, so the row's controls
 * are not squeezed, they are CLIPPED AWAY with nothing on screen to say so.
 *
 * A card carries the same seven facts stacked instead of ranged, so the only
 * dimension it needs is the one a phone has: height.
 *
 * WHAT IS ON A CARD, and why each one earns its space -- this is the whole
 * triage decision a rep makes about a lead, and anything missing is a lead
 * they have to open to judge:
 *   - the business name and where/what it is, which is the identity;
 *   - whether they are reachable RIGHT NOW in their own time zone, because
 *     dialling a business that is shut wastes the dial AND burns the lead
 *     (nobody answers, a no-answer is logged, the expiry clock resets);
 *   - the website score, or the honest sentence for why there is not one;
 *   - the number, and on a lead the rep actually holds, a call button that
 *     fills the card.
 *
 * `tel:` IS THE ONE THING THAT GETS BETTER ON A PHONE. On a desktop it opens
 * whatever handler the OS guesses at; on the device a rep is holding it dials.
 * So the call button is the largest control on the card by a wide margin --
 * 56px tall and full width, against 44px for everything else.
 *
 * BUT ONLY ON A LEAD THEY HOLD. In the shared pool the number renders as text,
 * exactly as it does in the table, because dialling a pool lead is the thing
 * the whole claim system exists to stop: two reps working the obvious Monday
 * queue would call the same business. Claim it and the same card grows a call
 * button. (LeadsTable.tsx applies the identical `showStage && canSelect`
 * condition -- see LeadCells.tsx for why these two layouts share renderers
 * rather than resembling each other.)
 *
 * THE CARD IS NOT ONE BIG BUTTON. The name is the control that opens the lead.
 * Making the whole card tappable is the desktop row's behaviour and it is wrong
 * on glass: the card also carries a claim checkbox and a call button, and a
 * thumb that lands 6mm from where it aimed should not be able to open a panel
 * over the thing the rep was reaching for. It also keeps every interactive
 * element out of another interactive element, which the `<tr tabIndex=0>` on
 * the desktop table does not manage.
 *
 * NO COLOUR IS KEYED TO A SCORE here either -- the score comes from
 * LeadCells.tsx's one renderer, and this file is on the ban list in
 * tests/web-leads-guards.test.ts.
 */

import { ChevronRight, Phone } from "lucide-react";
import type { WebLeadRow } from "@/lib/web-leads/data";
import { OpenNowCell } from "./OpeningHours";
import { BattleCardLink, STAGE_LABEL, VisitSite, WebsiteCell } from "./LeadCells";

const LABEL = "text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted";

export function LeadCards({
  leads, onOpen, selected, onToggle, showStage, canSelect, now,
}: {
  leads: WebLeadRow[];
  onOpen: (id: string) => void;
  selected: Set<string>;
  onToggle: (id: string) => void;
  showStage: boolean;
  canSelect: boolean;
  /** The page's single clock, passed in for the same reason the table passes
   *  it: fifty cards read per-cell could straddle a minute boundary and show
   *  two different "now"s in one screenful. */
  now: Date | null;
}) {
  return (
    <ul data-mobile-cards className="space-y-3 xl:hidden">
      {leads.map((l) => {
        // The identical condition the table applies. A rep may only dial what
        // they hold; see the module header.
        const dialable = Boolean(l.phone) && showStage && canSelect;
        return (
          <li key={l.id} className="overflow-hidden rounded-xl border border-bg-border bg-bg-panel">
            <div className="flex items-start gap-1 px-2.5 pt-2.5">
              {canSelect && (
                // The 14px box keeps the app's dark-theme convention; the
                // 44px label around it is the hit area. Ticking a card must
                // never be a coin toss -- a claim is a compare-and-swap that
                // takes a real business out of every other rep's pool.
                <label className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-bg-elev">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded accent-accent"
                    checked={selected.has(l.id)}
                    onChange={() => onToggle(l.id)}
                    aria-label={`Select ${l.name}`}
                  />
                </label>
              )}
              <button
                type="button"
                onClick={() => onOpen(l.id)}
                aria-label={`Open ${l.name}`}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-bg-elev focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
              >
                <span className="min-w-0 flex-1">
                  {/* Two lines, then ellipsis. The desktop table truncates to
                      one because a row is one line tall; a card has the height
                      to show a real Canadian business name in full, and the
                      name is what a rep says first on the call. */}
                  <span className="block text-[15px] font-semibold leading-tight tracking-[-0.01em] text-fg line-clamp-2">
                    {l.name}
                  </span>
                  <span className="mt-1 block truncate text-xs text-fg-dim">
                    {[l.industry, [l.city, l.province].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "No location on file"}
                  </span>
                  {/* The name a rep asks for. Shown only when someone was
                      actually identified — an "Ask for —" with nothing after it
                      teaches a rep to ignore the line. */}
                  {l.ownerName ? (
                    <span className="mt-1 block truncate text-xs font-medium text-fg-muted">
                      Ask for {l.ownerName}
                      {l.ownerTitle ? <span className="font-normal text-fg-dim"> · {l.ownerTitle}</span> : null}
                      {/* The label states what we KNOW. "Confirmed" is earned by an independent
                          match; everything else says so plainly rather than staying silent,
                          because silence reads as confidence. */}
                      {l.ownerVerification === "confirmed" ? (
                        <span className="ml-1 rounded bg-accent/20 px-1 py-0.5 text-[10px] font-bold uppercase text-accent">Confirmed</span>
                      ) : l.ownerVerification === "lookup_failed" ? (
                        <span className="ml-1 rounded bg-bg-elev px-1 py-0.5 text-[10px] font-bold uppercase text-fg-dim">Not checked</span>
                      ) : (
                        <span className="ml-1 rounded bg-bg-elev px-1 py-0.5 text-[10px] font-bold uppercase text-fg-dim">Their own word</span>
                      )}
                    </span>
                  ) : null}
                  {l.ownerEvidence ? (
                    <span className="mt-1 block text-[11px] leading-snug text-fg-dim">{l.ownerEvidence}</span>
                  ) : null}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-fg-dim" aria-hidden />
              </button>
            </div>

            <dl className="space-y-2.5 px-3 pb-3 pt-2">
              <div>
                <dt className={LABEL}>Reachable</dt>
                <dd className="mt-1"><OpenNowCell lead={l} now={now} /></dd>
              </div>
              {showStage && (
                <div>
                  <dt className={LABEL}>Stage</dt>
                  <dd className="mt-1 text-xs text-fg-muted">
                    {STAGE_LABEL[l.stage || ""] || l.stage || "Not set"}
                    {/* A lapsed claim is SHOWN, not silently removed. A rep whose
                        lead vanished overnight stops trusting the tool and
                        starts keeping a private spreadsheet. */}
                    {l.released && (
                      <span className="mt-0.5 block text-[10px] text-fg-dim">Released, back in the pool</span>
                    )}
                  </dd>
                </div>
              )}
              <div>
                <dt className={LABEL}>Website</dt>
                <dd className="mt-1"><WebsiteCell lead={l} /></dd>
              </div>
            </dl>

            <div className="space-y-2 border-t border-bg-border bg-bg-panel/60 p-2.5">
              {dialable ? (
                <a
                  href={`tel:${l.phone}`}
                  className="flex min-h-14 w-full items-center justify-center gap-2.5 whitespace-nowrap rounded-lg bg-gradient-to-br from-accent to-accent-muted px-4 text-base font-bold tabular-nums text-white shadow-[0_0_0_1px_rgba(59,130,246,0.18),0_8px_20px_-8px_rgba(59,130,246,0.45)] transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  <Phone className="h-5 w-5 shrink-0" aria-hidden />
                  <span className="whitespace-nowrap">{l.phone}</span>
                </a>
              ) : l.phone ? (
                // In the pool, the number without a dial. Says WHY, because a
                // number a rep can read but not tap looks like a broken button.
                <p className="flex min-h-11 items-center justify-center gap-2 rounded-lg border border-bg-border px-4 text-center text-sm text-fg-muted">
                  <Phone className="h-4 w-4 shrink-0 text-fg-dim" aria-hidden />
                  <span className="whitespace-nowrap tabular-nums">{l.phone}</span>
                  <span className="text-xs text-fg-dim">· claim to call</span>
                </p>
              ) : (
                <p className="flex min-h-11 items-center justify-center rounded-lg border border-bg-border px-4 text-sm text-fg-dim">
                  No number
                </p>
              )}
              <div className="flex items-stretch gap-2">
                <BattleCardLink id={l.id} name={l.name} size="touch" />
                <VisitSite url={l.websiteUrl} name={l.name} size="touch" />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
