"use client";

/**
 * PipelineBoard — the client half of app/web-leads/pipeline/page.tsx.
 *
 * Split from the page the same way WebLeadsBrowser is split from
 * app/web-leads/page.tsx: useSearchParams() needs a Suspense boundary, so
 * the page stays a server component with a <Suspense> wrapper and this file
 * carries the actual fetch-and-render logic.
 *
 * READ-ONLY. This component only ever calls GET /api/web-leads/pipeline and
 * renders what comes back -- no stage, assignment, or outcome is writable
 * from here. Clicking a lead opens the existing detail panel via the
 * established `?lead=<id>` URL convention (lib/web-leads/filters.ts), the
 * same panel WebLeadsBrowser uses.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { WebLead } from "@/lib/web-leads/data";
import { WebLeadDetail } from "./WebLeadDetail";

type PipelineLead = WebLead & { stage: string | null; assignedTo: string | null };

type PipelineStageGroup = {
  stage: string;
  label: string;
  count: number;
  leads: PipelineLead[];
  truncated: boolean;
};

export function PipelineBoard() {
  const router = useRouter();
  const sp = useSearchParams();
  const leadId = sp.get("lead");
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

  const pushParams = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(sp.toString());
      mutate(next);
      const qs = next.toString();
      router.push(qs ? `/web-leads/pipeline?${qs}` : "/web-leads/pipeline", { scroll: false });
    },
    [router, sp],
  );

  const openLead = useCallback((id: string) => pushParams((n) => n.set("lead", id)), [pushParams]);
  const closeLead = useCallback(() => pushParams((n) => n.delete("lead")), [pushParams]);
  const onRepChange = useCallback(
    (rep: string) => pushParams((n) => (rep ? n.set("rep", rep) : n.delete("rep"))),
    [pushParams],
  );

  return (
    <div>
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Pipeline</h1>
          <p className="text-sm text-slate-500">
            {total} lead{total === 1 ? "" : "s"} across the stages this business already runs on. An empty
            column is normal, not an error.
          </p>
        </div>
        {reps.length > 0 && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Rep
            <select
              value={repFilter}
              onChange={(e) => onRepChange(e.target.value)}
              className="rounded-md border border-slate-200 px-2 py-1 text-sm"
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
      </header>

      {error && (
        <p className="mx-6 mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {error}
        </p>
      )}

      {loading && !stages && <div className="p-6 text-sm text-slate-500">Loading…</div>}

      {stages && (
        <div className="flex gap-4 overflow-x-auto p-6">
          {stages.map((g) => (
            <div key={g.stage} className="w-72 flex-shrink-0 rounded-lg border border-slate-200 bg-slate-50">
              <div className="border-b border-slate-200 px-3 py-2">
                <p className="text-sm font-semibold text-slate-900">{g.label}</p>
                <p className="text-xs text-slate-500">
                  {g.count} lead{g.count === 1 ? "" : "s"}
                  {g.truncated ? ` (showing first ${g.leads.length})` : ""}
                </p>
              </div>
              <div className="max-h-[60vh] space-y-2 overflow-y-auto p-2">
                {g.leads.length === 0 && (
                  <p className="px-2 py-4 text-center text-xs text-slate-400">No leads in this stage yet.</p>
                )}
                {g.leads.map((lead) => (
                  <button
                    key={lead.id}
                    type="button"
                    onClick={() => openLead(lead.id)}
                    className="block w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-left text-sm hover:border-slate-300 hover:bg-slate-50"
                  >
                    <p className="truncate font-medium text-slate-900">{lead.name}</p>
                    <p className="truncate text-xs text-slate-500">
                      {[lead.city, lead.province].filter(Boolean).join(", ") || "No location on file"}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {leadId && <WebLeadDetail leadId={leadId} onClose={closeLead} />}
    </div>
  );
}
