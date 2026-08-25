"use client";

/**
 * LeadsTable — the results list.
 *
 * TWO CHANGES OF SUBSTANCE IN THE 2026-08-23 pass, both of them about what a
 * rep can do rather than how it looks:
 *
 * 1. THE SCORE IS IN THE LIST. Until now the website score existed only inside
 *    the detail panel, one lead at a time. That made the corpus's single most
 *    useful targeting fact -- most prospects worth calling score under 40, and
 *    the top 11% will win a website-quality argument -- unusable without opening
 *    31,016 panels. See lib/web-leads/scores.ts for how it is read in bulk
 *    without ever disagreeing with the panel.
 *
 * 2. ONE WEBSITE COLUMN, NOT TWO. The old table showed the OSM directory's
 *    unverified `websiteCondition` in its own column. Beside a real measured
 *    score that produces a straight contradiction -- "Has a site, not yet
 *    reviewed" sitting next to a 34 we measured on Tuesday. The two are now one
 *    column that shows whichever statement is actually true for that lead:
 *    the number when we measured it, and otherwise the honest sentence for why
 *    we did not. `websiteCondition` is still rendered verbatim for the
 *    no-website case, which is the one it describes correctly.
 *
 * CITY AND INDUSTRY LIVE UNDER THE BUSINESS NAME, not in columns of their own
 * -- the pattern the app's own ConversationListPane already uses. That is not
 * only tidier: it is what keeps the column count low enough to fit without
 * horizontal scroll, which is what lets the header be sticky, which is what
 * makes a 100-row page readable at the bottom.
 *
 * ═══ THE COLUMN BUDGET, AND WHY EVERY WIDTH HERE IS DELIBERATE ══════════════
 *
 * Operator, 2026-08-25, on a production screenshot: "theres a huge space for no
 * reason thats condensing the other info it needs to be separated equally so
 * that everything is viewable and accessible." Four separate defects were
 * visible in that one image, and all four were width, not logic:
 *
 *   1. Phone numbers wrapped onto THREE lines -- `+1-416-` / `259-` / `9326`.
 *      A browser is allowed to break after a hyphen, and the Phone column was
 *      narrow enough that it did. A phone number split across three lines is
 *      not a phone number a rep can read out. Fixed by a width that fits the
 *      longest stored value plus its icon, AND `whitespace-nowrap` on the
 *      number itself -- the width alone is a preference the browser may shrink,
 *      so without nowrap the wrap comes straight back at a narrower viewport.
 *   2. A screen-wide dead gap between the name and the phone. Business was the
 *      only column without a width, so in auto layout it absorbed every spare
 *      pixel. It is now bounded, and the slack collects in the Website column
 *      instead, where it lengthens the score meter rather than separating two
 *      facts a rep reads together.
 *   3. "Hours unknown" / "11:13 pm there" collided with the Battle card button,
 *      because Reachable and the row's actions were fighting over the same
 *      space. The actions are now their own column.
 *   4. The score was a dot with a clipped meter. It shared the last column with
 *      two buttons and lost. It now has a column to itself.
 *
 * NO `table-fixed`. It was tried on 2026-08-25 and reverted the same day on
 * review. Fixed layout sizes a table to the SUM of its column widths, so once
 * the viewport is narrower than that sum the table overflows a wrapper that is
 * `overflow-hidden` for its rounded corners and the right-hand controls are
 * silently CLIPPED with no way to scroll to them. Every width below is
 * therefore a PREFERENCE the browser may shrink, and the failure mode at a
 * narrow viewport is a shorter business name, never a lost control.
 *
 * NOR `overflow-x-auto` on the wrapper. An auto-overflow ancestor becomes the
 * scrollport for `position: sticky`, so the header would stick against that box
 * instead of the page. The sticky header is load-bearing here.
 *
 * ═══ THE ARITHMETIC, AND THE ONE THING THAT IS NOT INTUITIVE ════════════════
 *
 * `<main>` carries a 15rem sidebar margin and the content box is `max-w-7xl
 * px-8`, so the table gets min(viewport - 240, 1280) - 64 px: 974px at a 1280
 * laptop, 1134px at 1440, and 1214px at 1536 and every width above it. Note the
 * ceiling: `max-w-7xl` caps the table at 1214px however wide the monitor is.
 *
 * 🚨 A SPECIFIED COLUMN WIDTH IS A FLOOR, NOT A PREFERENCE, and this is the
 * trap. It is tempting to reason that `w-[22rem]` is "a preference the browser
 * may shrink" and therefore safe. It is not: in auto layout Chrome will not
 * take a column below its min-content contribution, and a `truncate` span
 * (`overflow:hidden; white-space:nowrap`) contributes its FULL untruncated text
 * width, not zero. So a bounded Business column sets a hard floor under the
 * whole table, and when the sum of those floors exceeds the container the table
 * overflows a wrapper that is `overflow-hidden` and the right-hand controls are
 * silently clipped -- the exact regression `table-fixed` was reverted for.
 * MEASURED IN CHROME, not reasoned about: the first draft of this layout put
 * `max-w-[22rem]` on the name block and `w-full` on Website and rendered a
 * 1122px table inside a 974px box at 1280, with "View site" clipped away.
 *
 * The fix is `min-w-full max-w-0` on the name block. `max-width:0` drops the
 * column's intrinsic contribution to nothing so it can shrink freely, and
 * `min-width:100%` (which wins over max-width) makes the block still fill
 * whatever the cell ends up being, so the text truncates instead of vanishing.
 * The column width then comes from the `w-[22rem]` on the header cell alone.
 *
 * MEASURED in Chrome at each target width, My leads (the wider case -- it
 * carries the extra Stage column), in px:
 *
 *   check / Business / Phone / Reachable / Stage / Website / Actions
 *   1280 ->  974:  32 / 199 / 163 / 135 /  98 / 123 / 224   sum 974, overflow 0
 *   1440 -> 1134:  35 / 319 / 167 / 135 / 122 / 127 / 230   sum 1134, overflow 0
 *   1536 -> 1214:  37 / 363 / 173 / 139 / 132 / 132 / 239   sum 1214, overflow 0
 *
 * At every one of those, and in the shared-pool view too: no overflow, no
 * clipped control, no wrapped phone number, no truncated reachability line, and
 * one uniform row height. The surplus at 1536 lands as a few px on each column
 * rather than as one hole.
 *
 * The table's floor is 823px, so it clips below a ~1127px viewport with the
 * sidebar open (~887px with it collapsed). That is BETTER than what shipped
 * before this change, whose floor measured 958px: production today is 16px from
 * clipping at 1280 and clips outright on anything narrower.
 *
 * Business is the column that gives at the narrowest width, deliberately: it is
 * the only one whose content degrades gracefully. It truncates, it carries a
 * title attribute, and the full name is in the drawer. Everything else holds
 * its size or is bounded so it cannot wrap.
 *
 * NO COLOUR IS KEYED TO A SCORE, here as everywhere else in this feature. The
 * meter under each number fills with one neutral colour whether the score is 4
 * or 94. A red 22 renders a judgement the measurement does not support, and a
 * rep who sees red says something they cannot back up. See
 * WebsiteComparison.tsx's header for the full reasoning.
 */

import { useEffect, useRef } from "react";
import Link from "next/link";
import { AlertCircle, ExternalLink, Phone, BarChart3 } from "lucide-react";
import type { WebLeadRow } from "@/lib/web-leads/data";
import { preferredSiteUrl } from "@/lib/web-leads/url-safety";
import { OpenNowCell, useNow } from "./OpeningHours";

/**
 * Rep-facing names for CC's stage values.
 *
 * The raw values come from lib/website-sales.ts and are shared with the
 * commission engine, so they are not ours to rename at the source. This maps
 * them to what a rep would say out loud. Anything unmapped renders its raw
 * value rather than a blank -- an unknown stage is information, not an error.
 */
const STAGE_LABEL: Record<string, string> = {
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

/** Matches the app's staggered animate-pulse-slow convention so the swap from
 *  skeleton to real rows is visually quiet. */
function TableSkeleton({ rows = 12 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-bg-border" aria-busy="true" aria-live="polite">
      <div className="h-10 border-b border-bg-border bg-bg-panel" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-6 border-b border-bg-border/50 px-4 py-3.5 last:border-0">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3.5 w-44 rounded bg-bg-elev animate-pulse-slow" style={{ animationDelay: `${i * 40}ms` }} />
            <div className="h-2.5 w-32 rounded bg-bg-elev/60 animate-pulse-slow" style={{ animationDelay: `${i * 40}ms` }} />
          </div>
          {/* One block per column that follows the name, so the swap from
              skeleton to real rows does not visibly re-flow: phone,
              reachability, score meter, actions. */}
          <div className="h-3.5 w-28 shrink-0 rounded bg-bg-elev/70 animate-pulse-slow" style={{ animationDelay: `${i * 40}ms` }} />
          <div className="h-3.5 w-20 shrink-0 rounded bg-bg-elev/60 animate-pulse-slow" style={{ animationDelay: `${i * 40}ms` }} />
          <div className="h-3.5 w-16 shrink-0 rounded bg-bg-elev/50 animate-pulse-slow" style={{ animationDelay: `${i * 40}ms` }} />
          <div className="h-3.5 w-44 shrink-0 rounded bg-bg-elev/40 animate-pulse-slow" style={{ animationDelay: `${i * 40}ms` }} />
        </div>
      ))}
    </div>
  );
}

/**
 * The website cell: a number when we measured one, an honest sentence when we
 * did not. Never a zero, never a dash, never a badge -- see the module header
 * and lib/web-leads/audit.ts.
 */
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
 */
function VisitSite({ url, name }: { url: string | null; name: string }) {
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
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-bg-border/70 px-2.5 py-1.5 text-[11px] font-semibold text-fg-dim opacity-70 transition-all duration-150 group-hover:border-bg-border group-hover:text-fg-muted group-hover:opacity-100 hover:!border-accent/50 hover:!bg-accent/10 hover:!text-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
    >
      <ExternalLink className="h-3 w-3" />View site
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
function BattleCardLink({ id, name }: { id: string; name: string }) {
  return (
    <Link
      href={`/web-leads/${encodeURIComponent(id)}`}
      onClick={(e) => e.stopPropagation()}
      title={`Open the full battle card for ${name}`}
      // Same always-present, low-contrast-until-hover treatment as "View site":
      // a control that only exists while the mouse is over it is invisible to a
      // keyboard and easy to miss.
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-bg-border/70 px-2.5 py-1.5 text-[11px] font-semibold text-fg-dim opacity-70 transition-all duration-150 group-hover:border-bg-border group-hover:text-fg-muted group-hover:opacity-100 hover:!border-accent/50 hover:!bg-accent/10 hover:!text-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
    >
      <BarChart3 className="h-3 w-3" />Battle card
    </Link>
  );
}

/**
 * The website cell. THE SCORE AND THE ROW'S BUTTONS ARE NO LONGER THE SAME
 * COLUMN.
 *
 * They were, and the operator's screenshot shows what that cost: three
 * controls and a number sharing one cell meant the number lost, and the score
 * arrived on screen as a dot with its meter clipped off at the right edge. The
 * score is the single most useful targeting fact in the corpus and it was the
 * least legible thing in the row.
 *
 * Split out, this column holds nothing but the measurement, and it is the
 * column that takes the table's slack -- so on a wider screen the meter gets
 * LONGER rather than a gap opening up somewhere. Number beside the bar rather
 * than stacked above it: at 22rem of column the stacked form left the number
 * floating over a very long rule.
 *
 * Still colourless. One neutral fill whether the score is 4 or 94, because a
 * red 22 renders a judgement the measurement does not support and a rep who
 * sees red says something they cannot back up. See the module header.
 */
function WebsiteCell({ lead }: { lead: WebLeadRow }) {
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
 * The row's two controls, in a column of their own.
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
function RowActions({ lead }: { lead: WebLeadRow }) {
  return (
    <div className="flex items-center justify-end gap-2 whitespace-nowrap">
      <BattleCardLink id={lead.id} name={lead.name} />
      <VisitSite url={lead.websiteUrl} name={lead.name} />
    </div>
  );
}

export function LeadsTable({
  leads, total, page, onPage, onOpen, loading, error, emptyHint, pageSize,
  selected, onToggle, onToggleAll, showStage, canSelect,
}: {
  leads: WebLeadRow[];
  total: number;
  page: number;
  onPage: (n: number) => void;
  onOpen: (id: string) => void;
  loading: boolean;
  error: string | null;
  emptyHint: string;
  pageSize: number;
  /** Ids currently ticked. Selection lives in the parent so the toolbar's
   *  "Claim N" button and this table cannot disagree about what is selected. */
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (ids: string[], select: boolean) => void;
  /** My Leads shows what stage each lead is at; the shared pool does not,
   *  because every lead in the pool is at the same one. */
  showStage: boolean;
  /** False for read-only/non-sales accounts: selection exists only to mutate
   *  ownership, so its checkboxes are not read controls. */
  canSelect: boolean;
}) {
  const allOnPageSelected = leads.length > 0 && leads.every((l) => selected.has(l.id));
  // pageSize is passed in rather than hardcoded: a literal 50 here would
  // silently disagree with PAGE_SIZE in data.ts the moment either changed, and
  // the pager would offer pages the API never returns.
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  // ONE clock for the whole page. Read per-cell, fifty rows could straddle a
  // minute boundary and show two different "now"s in one screenful.
  const now = useNow();

  // A bookmarked `?page=8` can outlive the result set it pointed to (filters
  // changed, data shrank). Left alone, the header still reports the real total
  // while `leads` for that stale page comes back empty and the body claims "no
  // leads, try removing a filter" -- two contradictory statements, and the hint
  // blames the wrong thing. Clamp back to the last real page. Gated on
  // !loading && !error so a failed fetch is never read as "page too far", and
  // it stops re-firing once page settles at pages. The hook itself must run
  // unconditionally (rules of hooks), so the gating lives in the body.
  useEffect(() => {
    if (!loading && !error && page > pages) onPage(pages);
  }, [loading, error, page, pages, onPage]);

  /** Roving focus: up/down walk the list without leaving the keyboard, Enter
   *  opens. A rep triaging a page should never have to reach for the mouse. */
  const move = (from: number, delta: number) => {
    const to = Math.min(leads.length - 1, Math.max(0, from + delta));
    rowRefs.current[to]?.focus();
  };

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-6 text-sm text-red-200">
        <AlertCircle className="mb-2 h-5 w-5" />
        <p className="font-semibold">Could not load leads</p>
        <p className="mt-1 text-xs text-red-300/80">{error}</p>
        <p className="mt-2 text-xs text-red-300/80">Your filters are still applied. Try again.</p>
      </div>
    );
  }

  if (loading) return <TableSkeleton />;

  if (leads.length === 0) {
    // Say WHICH filter emptied it. A bare "0 results" makes a rep re-check
    // every checkbox to find the one that did it.
    return (
      <div className="rounded-xl border border-bg-border bg-bg-panel px-8 py-14 text-center">
        <p className="text-sm text-fg-muted">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="overflow-hidden rounded-xl border border-bg-border">
        {/* Auto layout, deliberately -- see the module header for why
            `table-fixed` was tried, clipped the row's controls below ~1000px
            and was reverted, and why `overflow-x-auto` on this wrapper would
            break the sticky header. Every width below is a preference. */}
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="sticky top-0 z-10 bg-bg-panel text-left text-[10px] uppercase tracking-[0.14em] text-fg-muted shadow-[0_1px_0_0_rgb(34_38_46)]">
              {canSelect && (
                <th scope="col" className="w-9 pl-4 pr-0 py-3">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded accent-accent align-middle"
                    checked={allOnPageSelected}
                    // Selects THIS PAGE, not the whole filtered set. A checkbox
                    // that silently ticked 31,016 rows would let one click claim
                    // far past a rep's cap and read as if it had worked.
                    onChange={() => onToggleAll(leads.map((l) => l.id), !allOnPageSelected)}
                    aria-label={allOnPageSelected ? "Clear selection on this page" : "Select every lead on this page"}
                  />
                </th>
              )}
              {/* Bounded rather than greedy. Without a width this column was
                  the only one that could absorb the spare pixels, and it took
                  all of them -- the name hard left, the phone most of a screen
                  away. 22rem holds the great majority of the corpus's names and
                  truncates the rest, and it is a preference, so this is also
                  the column that gives first at 1280 (see the module header's
                  arithmetic). It gives first because it is the only one whose
                  content degrades gracefully: a truncated name still reads, and
                  the full one is on the title attribute and in the drawer. */}
              <th scope="col" className={`w-[22rem] ${canSelect ? "pl-3" : "pl-4"} pr-4 py-3 font-bold`}>Business</th>
              {/* Wide enough for the longest stored value plus its icon.
                  `+1-905-812-2229` at 14px tabular is ~114px, the icon and its
                  gap another 18, and the cell's own padding 32 -- 168px, which
                  is 10.5rem. The number ALSO carries whitespace-nowrap: this
                  width is a preference the browser may shrink, and a browser
                  shrinking it will happily break the number after a hyphen,
                  which is exactly the three-line phone number in the operator's
                  screenshot. */}
              <th scope="col" className="w-[10.5rem] whitespace-nowrap px-4 py-3 font-bold">Phone</th>
              {/* Beside the phone number on purpose. A rep reads the number and
                  the reachability together, or they dial a business that is
                  shut -- which wastes the dial AND burns the lead, because
                  nobody answers, a no-answer is logged, and the expiry clock
                  resets. Operator, 2026-08-24: "we need to see the times that
                  they're able to actually reach out."
                  8rem, down from 11rem: it holds "Hours unknown" and the local
                  time beneath it and needs nothing more. It was never the
                  column that needed the room -- it was the column that got
                  pushed into the Battle card button. */}
              <th scope="col" className="w-[8rem] whitespace-nowrap px-4 py-3 font-bold">Reachable</th>
              {showStage && <th scope="col" className="w-[8rem] whitespace-nowrap px-4 py-3 font-bold">Stage</th>}
              {/* NOT `w-full`. A column asking for 100% wins the whole
                  distribution: measured in Chrome, it took the leftover AND
                  starved Business down to its 86px header width. With every
                  column carrying an honest width instead, Chrome spreads the
                  surplus across all of them -- which is what the operator
                  actually asked for ("separated equally"), and it means the
                  extra space at 1536 arrives as ~8px on each column rather than
                  as one dead 200px hole between the score and the buttons. */}
              <th scope="col" className="w-[8rem] px-4 py-3 font-bold">Website</th>
              {/* Their own column, at a width that fits both buttons on one
                  line. They shared the Website cell until 2026-08-25, which is
                  how "Hours unknown" ended up colliding with "Battle card" and
                  how the score got squeezed down to a dot. */}
              <th scope="col" className="w-[14.5rem] whitespace-nowrap px-4 py-3 text-right font-bold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l, idx) => (
              <tr
                key={l.id}
                ref={(el) => { rowRefs.current[idx] = el; }}
                onClick={() => onOpen(l.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(l.id); }
                  else if (e.key === "ArrowDown") { e.preventDefault(); move(idx, 1); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); move(idx, -1); }
                }}
                tabIndex={0}
                aria-label={`Open ${l.name}`}
                className="group cursor-pointer border-t border-bg-border/50 transition-[background-color,box-shadow] duration-150 first:border-t-0 hover:bg-bg-raised hover:shadow-[inset_0_0_0_1px_rgba(59,130,246,0.16)] focus-visible:bg-bg-raised focus-visible:shadow-[inset_0_0_0_1px_rgba(59,130,246,0.45)] focus-visible:outline-none"
              >
                {/* stopPropagation: ticking a row must not also open it. */}
                {canSelect && <td className="w-9 py-3 pl-4 pr-0 align-middle" onClick={(e) => e.stopPropagation()}>
                  {/* NO HOVER BAR. There was a 3px accent rail here; moving it
                      off the name cell was not enough, because the problem was
                      never where it sat -- a hard vertical line beside a row of
                      text reads as a strike through it wherever you put it.
                      Adon: "I wanted to also have that interactive feel but
                      without that blue line."
                      The row now lifts instead: a warmer surface plus a hairline
                      inset ring, and the row's actions fade in. Nothing draws a
                      line, nothing shifts position, so the list does not jitter
                      as the cursor travels down it. */}
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded accent-accent align-middle"
                    checked={selected.has(l.id)}
                    onChange={() => onToggle(l.id)}
                    aria-label={`Select ${l.name}`}
                  />
                </td>}
                <td className={`py-3.5 ${canSelect ? "pl-3" : "pl-4"} pr-4 align-middle`}>
                  {/* `min-w-full max-w-0` IS LOAD-BEARING, not decoration. See
                      the module header: a `truncate` span contributes its full
                      untruncated text width to the column's minimum, and Chrome
                      will not shrink a column past that -- so an unbounded name
                      block puts a hard floor under the table and the row's
                      controls get clipped out of an `overflow-hidden` wrapper.
                      `max-width:0` drops that contribution to nothing;
                      `min-width:100%` wins over it and makes the block still
                      fill the cell, so the text truncates rather than vanishing.
                      Measured: this is what took the table from 1122px inside a
                      974px box down to 974px at a 1280 viewport.
                      `title` because the name is the one thing here that
                      truncates by design -- at 1280 this column is the one that
                      gives, and a rep must still be able to read the whole name
                      without opening the lead. */}
                  <div className="min-w-full max-w-0">
                    <span
                      className="block truncate text-[15px] font-semibold leading-tight tracking-[-0.01em] text-fg"
                      title={l.name}
                    >
                      {l.name}
                    </span>
                    <span className="mt-1 block truncate text-xs text-fg-dim">
                      {[l.industry, [l.city, l.province].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "No location on file"}
                    </span>
                  </div>
                </td>
                {/* whitespace-nowrap on the CELL and on the number. A browser
                    may break after a hyphen, and `+1-416-259-9326` in a column
                    the browser had shrunk is precisely how the operator's
                    screenshot ended up with a phone number stacked three lines
                    deep. A number a rep cannot read in one glance is not a
                    number. */}
                <td className="w-[10.5rem] whitespace-nowrap px-4 py-3 align-middle">
                  {l.phone && showStage && canSelect ? (
                    <a
                      href={`tel:${l.phone}`}
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded tabular-nums text-accent transition-colors hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
                    >
                      <Phone className="h-3 w-3 shrink-0" />{l.phone}
                    </a>
                  ) : l.phone ? (
                    <span className="whitespace-nowrap tabular-nums text-fg-muted">{l.phone}</span>
                  ) : (
                    <span className="text-fg-faint">No number</span>
                  )}
                </td>
                <td className="w-[8rem] px-4 py-3 align-middle">
                  <OpenNowCell lead={l} now={now} />
                </td>
                {showStage && (
                  <td className="w-[8rem] px-4 py-3 align-middle">
                    <span className="text-xs text-fg-muted">{STAGE_LABEL[l.stage || ""] || l.stage || "—"}</span>
                    {/* A lapsed claim is SHOWN, not silently removed. A rep whose
                        lead vanished overnight stops trusting the tool and
                        starts keeping a private spreadsheet. */}
                    {l.released && (
                      <span className="mt-0.5 block text-[10px] text-fg-dim">
                        Released — back in the pool
                      </span>
                    )}
                  </td>
                )}
                {/* Its own column at last, so the number and its meter get room
                    to be legible instead of losing to two buttons. */}
                <td className="w-[8rem] px-4 py-3 align-middle">
                  <WebsiteCell lead={l} />
                </td>
                <td className="w-[14.5rem] px-4 py-3 align-middle">
                  <RowActions lead={l} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-xs tabular-nums text-fg-dim">
            Page {page} of {pages.toLocaleString()}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => onPage(page - 1)}
              className="rounded-md border border-bg-border px-3 py-1.5 text-xs font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= pages}
              onClick={() => onPage(page + 1)}
              className="rounded-md border border-bg-border px-3 py-1.5 text-xs font-semibold text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
