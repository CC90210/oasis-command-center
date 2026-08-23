"use client";

/**
 * PipelineBoard — the Pipeline view inside /web-leads (2026-08-23 revamp:
 * folded in from the retired standalone /web-leads/pipeline page -- the
 * operator said, verbatim, "Not a separate pipeline page"). WebLeadsBrowser
 * mounts this directly when `?view=pipeline`; it no longer owns a route or
 * a page-level header of its own -- WebLeadsBrowser's PageHeader + segmented
 * control already carry that, so this component starts at its own toolbar
 * (rep filter + count) and goes straight into the stage board.
 *
 * READ-ONLY. This component only ever calls GET /api/web-leads/pipeline and
 * renders what comes back -- no stage, assignment, or outcome is writable
 * from here. Clicking a lead pushes the existing `?lead=<id>` URL param
 * (lib/web-leads/filters.ts); WebLeadsBrowser owns the single shared
 * WebLeadDetail panel for every view, so this component does not mount its
 * own -- opening a lead from Pipeline and from Leads land on the exact same
 * panel instance, keyed off the exact same URL convention.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { WebLead } from "@/lib/web-leads/data";

type PipelineLead = WebLead & { stage: string | null; assignedTo: string | null };

type PipelineStageGroup = {
  stage: string;
  label: string;
  count: number;
  leads: PipelineLead[];
  truncated: boolean;
};

function BoardSkeleton() {
  return (
    <div className="flex gap-4 overflow-x-auto pb-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="w-72 shrink-0 rounded-lg border border-bg-border bg-bg-panel">
          <div className="border-b border-bg-border px-3 py-2.5">
            <div className="h-3.5 w-24 rounded bg-bg-elev animate-pulse-slow" style={{ animationDelay: `${i * 60}ms` }} />
            <div className="mt-1.5 h-2.5 w-14 rounded bg-bg-elev/60 animate-pulse-slow" style={{ animationDelay: `${i * 60}ms` }} />
          </div>
          <div className="space-y-2 p-2">
            {Array.from({ length: 3 }).map((__, j) => (
              <div key={j} className="h-12 rounded-md border border-bg-border/60 bg-bg-deep/40 animate-pulse-slow" style={{ animationDelay: `${i * 60 + j * 30}ms` }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PipelineBoard() {
  const router = useRouter();
  const sp = useSearchParams();
  const repFilter = sp.get("rep") || "";

  const [stages, setStages] = useState<PipelineStageGroup[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Same out-of-order-response guard as WebLeadsBrowser: `alive` is
  // re-checked after the body is parsed, not right after the fetch resolves,
  // so a slower earlier response can never overwrite a faster later one.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const qs = repFilter ? `?rep=${encodeURIComponent(repFilter)}` : "";
    fetch(`/api/web-leads/pipeline${qs}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        return r.json();
      })
      .then((body) => {
        if (!alive) return;
        setStages(body.stages);
        setTotal(body.total);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Could not load the pipeline.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [repFilter]);

  // The rep dropdown's options come from the data itself (assignedTo values
  // already on the leads an unscoped viewer receives) rather than a separate
  // team-members endpoint -- one fewer surface to keep in sync, and an admin
  // only ever needs to filter to a rep who actually has leads on this board.
  const reps = useMemo(() => {
    if (!stages) return [];
    const set = new Set<string>();
    for (const g of stages) for (const l of g.leads) if (l.assignedTo) set.add(l.assignedTo);
    return Array.from(set).sort();
  }, [stages]);

  // Pushes to /web-leads (not the retired /web-leads/pipeline) -- every other
  // param currently on the URL, including `view=pipeline` and a `lead=`
  // already open, is copied forward from the live search params, so this
  // component never needs to know about `view` itself to stay on this tab.
  const pushParams = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(sp.toString());
      mutate(next);
      const qs = next.toString();
      router.push(qs ? `/web-leads?${qs}` : "/web-leads", { scroll: false });
    },
    [router, sp],
  );

  const openLead = useCallback((id: string) => pushParams((n) => n.set("lead", id)), [pushParams]);
  const onRepChange = useCallback(
    (rep: string) => pushParams((n) => (rep ? n.set("rep", rep) : n.delete("rep"))),
    [pushParams],
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">
          {loading ? (
            <span className="inline-block h-4 w-40 animate-pulse-slow rounded bg-bg-elev align-middle" />
          ) : (
            <>
              <span className="tabular-nums font-semibold text-fg">{total.toLocaleString()}</span> lead{total === 1 ? "" : "s"} across
              the stages this business already runs on. An empty column is normal, not an error.
            </>
          )}
        </p>
        {reps.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            Rep
            <select
              value={repFilter}
              onChange={(e) => onRepChange(e.target.value)}
              className="rounded-md border border-bg-border bg-bg-deep px-2 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
            >
              <option value="">All reps</option>
              {reps.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error && (
        <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          {error}
        </p>
      )}

      {loading && !stages && <BoardSkeleton />}

      {stages && (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {stages.map((g) => (
            <div key={g.stage} className="w-72 shrink-0 rounded-lg border border-bg-border bg-bg-panel">
              <div className="border-b border-bg-border px-3 py-2.5">
                <p className="text-sm font-semibold text-fg">{g.label}</p>
                <p className="text-xs text-fg-dim">
                  <span className="tabular-nums">{g.count}</span> lead{g.count === 1 ? "" : "s"}
                  {g.truncated ? ` (showing first ${g.leads.length})` : ""}
                </p>
              </div>
              <div className="max-h-[60vh] space-y-2 overflow-y-auto p-2">
                {g.leads.length === 0 && (
                  <p className="px-2 py-4 text-center text-xs text-fg-faint">No leads in this stage yet.</p>
                )}
                {g.leads.map((lead) => (
                  <button
                    key={lead.id}
                    type="button"
                    onClick={() => openLead(lead.id)}
                    className="block w-full rounded-md border border-bg-border bg-bg-deep/40 px-3 py-2 text-left text-sm transition-colors hover:border-accent/40 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
                  >
                    <p className="truncate font-medium text-fg">{lead.name}</p>
                    <p className="truncate text-xs text-fg-dim">
                      {[lead.city, lead.province].filter(Boolean).join(", ") || "No location on file"}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
