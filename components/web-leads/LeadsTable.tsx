"use client";

import { useEffect } from "react";
import { AlertCircle, Phone } from "lucide-react";
import type { WebLead } from "@/lib/web-leads/data";

/** Matches LeadsTableClientSkeleton's convention (staggered animate-pulse-slow
 * bars) so a swap from skeleton to real rows is visually quiet, tuned to this
 * table's five columns rather than the CRM leads table's own shape. */
function TableSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-bg-border" aria-busy="true" aria-live="polite">
      <div className="h-9 border-b border-bg-border bg-bg-panel" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-6 border-b border-bg-border/60 px-3 py-3 last:border-0">
          <div className="h-3.5 w-36 shrink-0 rounded bg-bg-elev animate-pulse-slow" style={{ animationDelay: `${i * 45}ms` }} />
          <div className="h-3.5 w-24 shrink-0 rounded bg-bg-elev/70 animate-pulse-slow" style={{ animationDelay: `${i * 45}ms` }} />
          <div className="h-3.5 w-20 shrink-0 rounded bg-bg-elev/70 animate-pulse-slow" style={{ animationDelay: `${i * 45}ms` }} />
          <div className="h-3.5 w-28 shrink-0 rounded bg-bg-elev/70 animate-pulse-slow" style={{ animationDelay: `${i * 45}ms` }} />
          <div className="h-3.5 flex-1 rounded bg-bg-elev/50 animate-pulse-slow" style={{ animationDelay: `${i * 45}ms` }} />
        </div>
      ))}
    </div>
  );
}

export function LeadsTable({
  leads, total, page, onPage, onOpen, loading, error, emptyHint, pageSize,
}: {
  leads: WebLead[];
  total: number;
  page: number;
  onPage: (n: number) => void;
  onOpen: (id: string) => void;
  loading: boolean;
  error: string | null;
  emptyHint: string;
  pageSize: number;
}) {
  // pageSize is passed in rather than hardcoded: a literal 50 here would silently
  // disagree with PAGE_SIZE in data.ts the moment either changed, and the pager
  // would offer pages the API never returns.
  const pages = Math.max(1, Math.ceil(total / pageSize));

  // A bookmarked `?page=8` can outlive the result set it pointed to (filters
  // changed, data shrank since). Left alone, the header still reports the
  // real total ("1,247 leads") while `leads` for that stale page comes back
  // empty and the body claims "No leads ... Try removing a filter" -- two
  // contradictory statements, and the hint blames the wrong thing. Clamp
  // back to the last real page instead of showing that. Gated on !loading
  // (and !error, so a failed fetch never gets read as "page too far") so
  // this only fires once we know `pages` reflects a real response, and it
  // naturally stops re-firing once `page` settles at `pages`. Hook itself
  // must run unconditionally (before the early `return` below) per the
  // rules of hooks -- the gating lives inside the effect body instead.
  useEffect(() => {
    if (!loading && !error && page > pages) onPage(pages);
  }, [loading, error, page, pages, onPage]);

  if (error) {
    return (
      <div className="flex-1 rounded-lg border border-red-500/40 bg-red-500/10 p-6 text-sm text-red-200">
        <AlertCircle className="mb-2 h-5 w-5" />
        <p className="font-medium">Could not load leads</p>
        <p className="mt-1 text-xs text-red-300/80">{error}</p>
        <p className="mt-2 text-xs text-red-300/80">Your filters are still applied. Try again.</p>
      </div>
    );
  }

  return (
    <div className="flex-1">
      <div className="mb-3 flex items-baseline justify-between">
        {loading ? (
          <div className="h-4 w-28 rounded bg-bg-elev animate-pulse-slow" />
        ) : (
          <p className="text-sm text-fg-muted">
            <span className="tabular-nums font-semibold text-fg">{total.toLocaleString()}</span> lead{total === 1 ? "" : "s"}
          </p>
        )}
        {pages > 1 && (
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => onPage(page - 1)}
              className="rounded-md border border-bg-border px-2 py-1 text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-40"
            >
              Previous
            </button>
            <span className="tabular-nums text-fg-dim">Page {page} of {pages}</span>
            <button
              type="button"
              disabled={page >= pages}
              onClick={() => onPage(page + 1)}
              className="rounded-md border border-bg-border px-2 py-1 text-fg-muted transition-colors hover:border-accent/40 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 disabled:pointer-events-none disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <TableSkeleton />
      ) : leads.length === 0 ? (
        // Say WHICH filter emptied it. A bare "0 results" makes a rep re-check
        // every checkbox to find the one that did it.
        <div className="rounded-lg border border-bg-border bg-bg-panel p-8 text-center text-sm text-fg-muted">{emptyHint}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-bg-border">
          <table className="w-full text-sm">
            <thead className="bg-bg-panel text-left text-[10px] uppercase tracking-[0.12em] text-fg-muted">
              <tr>
                <th className="px-3 py-2.5 font-bold">Business</th>
                <th className="px-3 py-2.5 font-bold">Phone</th>
                <th className="px-3 py-2.5 font-bold">City</th>
                <th className="px-3 py-2.5 font-bold">Industry</th>
                <th className="px-3 py-2.5 font-bold">Website</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-bg-border/60">
              {leads.map((l) => (
                <tr
                  key={l.id}
                  onClick={() => onOpen(l.id)}
                  onKeyDown={(e) => { if (e.key === "Enter") onOpen(l.id); }}
                  tabIndex={0}
                  className="cursor-pointer transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:bg-bg-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/70"
                >
                  <td className="px-3 py-2.5 font-medium text-fg">{l.name}</td>
                  <td className="px-3 py-2.5">
                    {l.phone ? (
                      <a href={`tel:${l.phone}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 tabular-nums text-accent hover:underline">
                        <Phone className="h-3 w-3" />{l.phone}
                      </a>
                    ) : <span className="text-fg-faint">—</span>}
                  </td>
                  <td className="px-3 py-2.5 text-fg-muted">{l.city || "—"}</td>
                  <td className="px-3 py-2.5 text-fg-muted">{l.industry || "—"}</td>
                  {/* VERBATIM. Never a badge, never shortened. Italic reads as a
                      hedged note rather than a hard data value, on purpose. */}
                  <td className="px-3 py-2.5 italic text-fg-dim">{l.websiteCondition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
