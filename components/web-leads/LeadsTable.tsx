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
 * FIVE COLUMNS BECAME THREE. City and industry moved into a secondary line
 * under the business name -- the pattern the app's own ConversationListPane
 * already uses. That is not only tidier: three columns fit without horizontal
 * scroll, which is what lets the header be sticky, which is what makes a
 * 50-row page readable at the bottom.
 *
 * NO COLOUR IS KEYED TO A SCORE, here as everywhere else in this feature. The
 * meter under each number fills with one neutral colour whether the score is 4
 * or 94. A red 22 renders a judgement the measurement does not support, and a
 * rep who sees red says something they cannot back up. See
 * WebsiteComparison.tsx's header for the full reasoning.
 */

import { useEffect, useRef } from "react";
import { AlertCircle, Phone } from "lucide-react";
import type { WebLeadRow } from "@/lib/web-leads/data";

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
          <div className="h-3.5 w-28 shrink-0 rounded bg-bg-elev/70 animate-pulse-slow" style={{ animationDelay: `${i * 40}ms` }} />
          <div className="h-3.5 w-16 shrink-0 rounded bg-bg-elev/50 animate-pulse-slow" style={{ animationDelay: `${i * 40}ms` }} />
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
function WebsiteCell({ lead }: { lead: WebLeadRow }) {
  if (lead.scoreState === "scored" && lead.score !== null) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <span className="text-lg font-bold leading-none tabular-nums text-fg">{lead.score}</span>
        <span className="block h-1 w-14 overflow-hidden rounded-full bg-bg-border" aria-hidden>
          <span
            className="block h-full rounded-full bg-fg-dim"
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
      : lead.scoreState === "unreachable"
        ? "We could not check this site"
        : "Not scored yet";

  return <span className="block text-right text-xs italic leading-snug text-fg-dim">{text}</span>;
}

export function LeadsTable({
  leads, total, page, onPage, onOpen, loading, error, emptyHint, pageSize,
  selected, onToggle, onToggleAll, showStage,
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
}) {
  const allOnPageSelected = leads.length > 0 && leads.every((l) => selected.has(l.id));
  // pageSize is passed in rather than hardcoded: a literal 50 here would
  // silently disagree with PAGE_SIZE in data.ts the moment either changed, and
  // the pager would offer pages the API never returns.
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

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
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="sticky top-0 z-10 bg-bg-panel text-left text-[10px] uppercase tracking-[0.14em] text-fg-muted shadow-[0_1px_0_0_rgb(34_38_46)]">
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
              <th scope="col" className="px-4 py-3 font-bold">Business</th>
              <th scope="col" className="px-4 py-3 font-bold">Phone</th>
              {showStage && <th scope="col" className="px-4 py-3 font-bold">Stage</th>}
              <th scope="col" className="px-4 py-3 text-right font-bold">Website</th>
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
                className="group cursor-pointer border-t border-bg-border/50 transition-colors first:border-t-0 hover:bg-bg-hover focus-visible:bg-bg-hover focus-visible:outline-none"
              >
                {/* stopPropagation: ticking a row must not also open it. */}
                <td className="w-9 py-3 pl-4 pr-0 align-middle" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded accent-accent align-middle"
                    checked={selected.has(l.id)}
                    onChange={() => onToggle(l.id)}
                    aria-label={`Select ${l.name}`}
                  />
                </td>
                <td className="relative py-3 pr-4 align-middle">
                  {/* Left rail on hover/focus: shows which row is live without
                      moving anything, so the list does not jitter as the cursor
                      travels. */}
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-0.5 scale-y-0 bg-accent transition-transform group-hover:scale-y-100 group-focus-visible:scale-y-100"
                  />
                  <span className="block truncate font-semibold text-fg">{l.name}</span>
                  <span className="mt-0.5 block truncate text-xs text-fg-dim">
                    {[l.industry, [l.city, l.province].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "No location on file"}
                  </span>
                </td>
                <td className="px-4 py-3 align-middle">
                  {l.phone ? (
                    <a
                      href={`tel:${l.phone}`}
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1.5 rounded tabular-nums text-accent transition-colors hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
                    >
                      <Phone className="h-3 w-3 shrink-0" />{l.phone}
                    </a>
                  ) : (
                    <span className="text-fg-faint">No number</span>
                  )}
                </td>
                {showStage && (
                  <td className="px-4 py-3 align-middle">
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
                <td className="w-44 px-4 py-3 align-middle">
                  <WebsiteCell lead={l} />
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
