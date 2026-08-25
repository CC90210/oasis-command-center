"use client";

/**
 * LeadCells — the pieces of a lead that BOTH results layouts render.
 *
 * Extracted from LeadsTable.tsx on 2026-08-25, when the results list grew a
 * second shape. Below `xl` the list is cards (LeadCards.tsx) and at `xl` and
 * above it is the table (LeadsTable.tsx), and the score, the stage name and
 * the row's two controls have to be IDENTICAL on both -- not similar. Two
 * copies of the score renderer is how a phone ends up showing a bare `0` on a
 * lead the desktop describes as "We could not check this site", which is the
 * exact failure this feature exists to prevent. One renderer, two containers.
 *
 * THIS FILE IS ON THE COLOUR BAN LIST in tests/web-leads-guards.test.ts, and
 * that is the point of the extraction as much as the reuse: LeadsTable.tsx
 * could never join that list, because it carries the repo's red
 * "could not load leads" banner. The score renderer was therefore the one
 * audit-rendering surface in this feature with no guard on it at all -- and it
 * is now the one that feeds every screen a rep sees. See the module header of
 * WebsiteComparison.tsx for why no colour may ever be keyed to a score.
 */

import Link from "next/link";
import { BarChart3, ExternalLink } from "lucide-react";
import type { WebLeadRow } from "@/lib/web-leads/data";
import { preferredSiteUrl } from "@/lib/web-leads/url-safety";

/**
 * Rep-facing names for CC's stage values.
 *
 * The raw values come from lib/website-sales.ts and are shared with the
 * commission engine, so they are not ours to rename at the source. This maps
 * them to what a rep would say out loud. Anything unmapped renders its raw
 * value rather than a blank -- an unknown stage is information, not an error.
 */
export const STAGE_LABEL: Record<string, string> = {
  researched: "New",
  assigned: "Mine, not called",
  attempting_contact: "Trying to reach",
  connected: "Spoke to them",
  qualified: "Qualified",
  founder_meeting_booked: "Meeting booked",
  demo_completed: "Demo done",
  proposal_sent: "Quote sent",
  won: "Won",
  lost: "Not interested",
  onboarding: "Onboarding",
  in_build: "Building",
  client_review: "Client review",
  launched: "Launched",
};

/**
 * "View site" straight from the row, so a rep can look at what they are about
 * to talk about without opening the lead first. Adon: "you should be able to
 * view the website directly from that without having to click into the lead."
 *
 * Renders NOTHING when safeExternalUrl returns null rather than a dead or
 * dangerous control: 217 stored websites have no scheme (a bare domain in an
 * href navigates inside our own dashboard), and these values come from
 * OpenStreetMap, which anyone can edit, so a `javascript:` href would run in
 * our origin. rel="noopener noreferrer" for the same reason it is on the panel
 * button -- these are 27,000 sites we do not control, and without it the opened
 * page can reach back through window.opener.
 *
 * `size="touch"` is the card's version: 44px tall and it fills its half of the
 * row, because on a phone this is a thumb landing on glass rather than a
 * cursor landing on a hover state.
 */
export function VisitSite({ url, name, size = "row" }: { url: string | null; name: string; size?: "row" | "touch" }) {
  const href = preferredSiteUrl(url);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // The row opens the lead; this must not. Same reason the phone link and
      // the checkbox stop propagation.
      onClick={(e) => e.stopPropagation()}
      title={`Open ${name}'s website in a new tab`}
      // Always present, never hover-revealed: a control that only exists while
      // the mouse is over it is invisible to a keyboard and easy to miss. It
      // sits back at low contrast and comes forward with the row instead, so
      // the row still feels alive without hiding anything.
      className={
        size === "touch"
          ? "inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-bg-border px-3 text-xs font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
          : "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-bg-border/70 px-2.5 py-1.5 text-[11px] font-semibold text-fg-dim opacity-70 transition-all duration-150 group-hover:border-bg-border group-hover:text-fg-muted group-hover:opacity-100 hover:!border-accent/50 hover:!bg-accent/10 hover:!text-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
      }
    >
      <ExternalLink className={size === "touch" ? "h-4 w-4" : "h-3 w-3"} />View site
    </a>
  );
}

/**
 * Straight to the battle card, without opening the drawer first.
 *
 * The row click still opens the 28rem panel, which is the right shape for
 * triage -- glance, decide, close. This is the other move: the rep has decided
 * to call this one and wants the whole case on one screen (percentile against
 * real local competitors, the head-to-head, every failed check with what it
 * costs). Making them open a drawer to find a link to the page is a click for
 * nothing.
 *
 * A real `<Link>` rather than a router push, so it middle-clicks and
 * cmd-clicks into a new tab like any other link -- a rep queueing up three
 * leads before a call block is the normal case, not an edge one.
 * stopPropagation for the same reason the phone link and the checkbox have it:
 * the row must not ALSO open behind it.
 */
export function BattleCardLink({ id, name, size = "row" }: { id: string; name: string; size?: "row" | "touch" }) {
  return (
    <Link
      href={`/web-leads/${encodeURIComponent(id)}`}
      onClick={(e) => e.stopPropagation()}
      title={`Open the full battle card for ${name}`}
      // Same always-present, low-contrast-until-hover treatment as "View site":
      // a control that only exists while the mouse is over it is invisible to a
      // keyboard and easy to miss.
      className={
        size === "touch"
          ? "inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-bg-border px-3 text-xs font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
          : "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-bg-border/70 px-2.5 py-1.5 text-[11px] font-semibold text-fg-dim opacity-70 transition-all duration-150 group-hover:border-bg-border group-hover:text-fg-muted group-hover:opacity-100 hover:!border-accent/50 hover:!bg-accent/10 hover:!text-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
      }
    >
      <BarChart3 className={size === "touch" ? "h-4 w-4" : "h-3 w-3"} />Battle card
    </Link>
  );
}

/**
 * The website cell: a number when we measured one, an honest sentence when we
 * did not. Never a zero, never a dash, never a badge.
 *
 * On the table it is a column of its own, and it is the column that takes the
 * table's slack -- so on a wider screen the meter gets LONGER rather than a gap
 * opening up somewhere. Number beside the bar rather than stacked above it: at
 * 22rem of column the stacked form left the number floating over a very long
 * rule. On a card it is a full-width row under the business's name, which is
 * the same shape with more room.
 *
 * Still colourless. One neutral fill whether the score is 4 or 94, because a
 * red 22 renders a judgement the measurement does not support and a rep who
 * sees red says something they cannot back up.
 */
export function WebsiteCell({ lead }: { lead: WebLeadRow }) {
  if (lead.scoreState === "scored" && lead.score !== null) {
    return (
      <div className="flex items-center gap-3">
        {/* w-9 fits "100" at this size, so a three-digit score never nudges
            the meter and the numbers keep one right edge down the page. */}
        <span
          className="w-9 shrink-0 text-right text-xl font-bold leading-none tracking-tight tabular-nums text-fg"
          title={`Website score ${lead.score} out of 100`}
        >
          {lead.score}
        </span>
        {/* min-w keeps the bar a bar at the narrowest viewport instead of
            collapsing to the hairline it used to be. 2.5rem, not more: this
            min-width is part of the column's floor, and the floor is what
            decides whether the row's controls clip. Measured 43px of meter at
            1280 and 52px at 1536. */}
        <span className="block h-1.5 min-w-[2.5rem] flex-1 overflow-hidden rounded-full bg-bg-border/80" aria-hidden>
          <span
            className="block h-full rounded-full bg-fg-muted transition-[width] duration-300"
            style={{ width: `${Math.min(100, Math.max(0, lead.score))}%` }}
          />
        </span>
      </div>
    );
  }

  // VERBATIM for the no-website case: this is the OSM directory's own hedged
  // wording, and it is the one statement `websiteCondition` describes
  // correctly. Never shortened, never turned into a badge.
  const text =
    lead.scoreState === "no_website"
      ? lead.websiteCondition
      : // Their domain is for sale. Distinct from "unreachable" on purpose: we
        // reached it perfectly and got a broker's listing, so saying we could
        // not check it would replace one false statement with another.
        lead.scoreState === "parked"
        ? "Domain listed for sale, no live site"
        : lead.scoreState === "unreachable"
          ? "We could not check this site"
          : "Not scored yet";

  // A SENTENCE, never a zero, a dash or an empty meter. It reads on one line
  // now that this column is not also carrying two buttons -- which is the
  // whole point of the split: the honest hedge is as scannable as the number
  // it replaces, instead of being the thing that got squeezed.
  return <p className="text-[11px] italic leading-snug text-fg-dim">{text}</p>;
}

/**
 * The table row's two controls, in a column of their own.
 *
 * They used to share the Website cell, which is how "Hours unknown" ended up
 * colliding with "Battle card" in the operator's screenshot: Reachable, the
 * score and both buttons were all competing for whatever was left after the
 * business name had taken the screen. A column each, with the buttons pinned
 * right where the eye already expects a row's actions.
 *
 * `whitespace-nowrap` on the group is what makes this safe under auto table
 * layout: it raises the column's minimum width to the buttons' real width, so
 * a narrow viewport shrinks the business name and the meter instead of ever
 * wrapping or clipping a control.
 *
 * VisitSite renders nothing when there is no safe URL, so a lead with no
 * website simply shows one button. Battle card is present for an unscored lead
 * too -- the card is honest about having no score, and everything else it holds
 * is still what a rep wants open.
 */
export function RowActions({ lead }: { lead: WebLeadRow }) {
  return (
    <div className="flex items-center justify-end gap-2 whitespace-nowrap">
      <BattleCardLink id={lead.id} name={lead.name} />
      <VisitSite url={lead.websiteUrl} name={lead.name} />
    </div>
  );
}
