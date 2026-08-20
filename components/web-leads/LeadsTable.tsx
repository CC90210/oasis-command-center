"use client";

import { AlertCircle, Phone } from "lucide-react";
import type { WebLead } from "@/lib/web-leads/data";

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
  if (error) {
    return (
      <div className="flex-1 rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-800">
        <AlertCircle className="mb-2 h-5 w-5" />
        <p className="font-medium">Could not load leads</p>
        <p className="mt-1 text-xs text-red-700">{error}</p>
        <p className="mt-2 text-xs text-red-700">Your filters are still applied. Try again.</p>
      </div>
    );
  }

  // pageSize is passed in rather than hardcoded: a literal 50 here would silently
  // disagree with PAGE_SIZE in data.ts the moment either changed, and the pager
  // would offer pages the API never returns.
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex-1">
      <div className="mb-3 flex items-baseline justify-between">
        <p className="text-sm text-slate-600">
          {loading ? "Loading…" : `${total.toLocaleString()} lead${total === 1 ? "" : "s"}`}
        </p>
        {pages > 1 && (
          <div className="flex items-center gap-2 text-sm">
            <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40">Previous</button>
            <span className="tabular-nums text-slate-500">Page {page} of {pages}</span>
            <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)} className="rounded border border-slate-200 px-2 py-1 disabled:opacity-40">Next</button>
          </div>
        )}
      </div>

      {!loading && leads.length === 0 ? (
        // Say WHICH filter emptied it. A bare "0 results" makes a rep re-check
        // every checkbox to find the one that did it.
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-600">{emptyHint}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Business</th>
                <th className="px-3 py-2 font-semibold">Phone</th>
                <th className="px-3 py-2 font-semibold">City</th>
                <th className="px-3 py-2 font-semibold">Industry</th>
                <th className="px-3 py-2 font-semibold">Website</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {leads.map((l) => (
                <tr key={l.id} onClick={() => onOpen(l.id)} className="cursor-pointer hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium text-slate-900">{l.name}</td>
                  <td className="px-3 py-2">
                    {l.phone ? (
                      <a href={`tel:${l.phone}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-blue-700 hover:underline">
                        <Phone className="h-3 w-3" />{l.phone}
                      </a>
                    ) : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{l.city || "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{l.industry || "—"}</td>
                  {/* VERBATIM. Never a badge, never shortened. */}
                  <td className="px-3 py-2 text-slate-600">{l.websiteCondition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
