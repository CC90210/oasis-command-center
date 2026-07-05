"use client";

/**
 * CCSegmentsTab — list Constant Contact segments and build new ones. The guided
 * builder covers the documented engagement criteria (opened / did-not-open / clicked
 * the last N campaigns) — the highest-value re-targeting case for MCA outreach — and
 * an Advanced mode accepts a raw segment_criteria JSON for anything more complex.
 * Talks to /api/campaigns/constant-contact/segments[/id].
 */

import { useCallback, useEffect, useState } from "react";
import { Card, EmptyState, Tag } from "@/components/Card";
import { Loader2, Trash2 } from "lucide-react";

type Seg = {
  segment_id?: number | string;
  name?: string;
  segment_criteria?: string;
  edited_at?: string;
  created_at?: string;
};

const FIELDS = [
  { key: "not_opened", label: "did NOT open" },
  { key: "opened", label: "opened" },
  { key: "clicked", label: "clicked" },
] as const;

function buildCriteria(field: string, n: number): string {
  return JSON.stringify({
    version: "1.0.0",
    criteria: { type: "and", group: [{ source: "tracking", field, op: "contains-any", const_value: "last-n-campaigns", param: String(n) }] },
  });
}

/** Renders a raw segment_criteria JSON string back into the plain-English sentence, when we recognize the shape. */
function summarizeCriteria(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { criteria?: { group?: { field?: string; param?: string }[] } };
    const g = parsed?.criteria?.group?.[0];
    if (g?.field) {
      const label = FIELDS.find((f) => f.key === g.field)?.label || g.field;
      return `${label} the last ${g.param || "?"} campaigns`;
    }
  } catch {
    /* not a shape we recognize — fall through to generic label */
  }
  return "custom criteria";
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function SegmentsSkeleton() {
  return (
    <Card noPadding>
      <div className="divide-y divide-bg-border/40">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center justify-between px-4 py-3.5">
            <div className="space-y-1.5">
              <div className="h-3.5 w-40 rounded bg-bg-elev animate-pulse" />
              <div className="h-2.5 w-56 rounded bg-bg-elev animate-pulse" />
            </div>
            <div className="h-3 w-16 rounded bg-bg-elev animate-pulse" />
          </div>
        ))}
      </div>
    </Card>
  );
}

export function CCSegmentsTab() {
  const [segs, setSegs] = useState<Seg[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const [mode, setMode] = useState<"guided" | "advanced">("guided");
  const [name, setName] = useState("");
  const [field, setField] = useState<string>("not_opened");
  const [n, setN] = useState(5);
  const [rawCriteria, setRawCriteria] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns/constant-contact/segments", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j?.message || j?.error || "Couldn't load segments."); return; }
      setSegs((j.segments || j.data || []) as Seg[]);
    } catch {
      setError("Network error loading segments.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(kind: string, req: () => Promise<Response>, okText: string, after?: () => void) {
    setBusy(kind);
    setNotice(null);
    try {
      const r = await req();
      const j = await r.json();
      if (!r.ok || !j.ok) { setNotice({ kind: "err", text: j.message || j.error || "failed" }); return; }
      setNotice({ kind: "ok", text: okText });
      after?.();
    } catch {
      setNotice({ kind: "err", text: "Request failed." });
    } finally {
      setBusy("");
    }
  }

  function create() {
    const nm = name.trim();
    if (!nm) { setNotice({ kind: "err", text: "Name is required." }); return; }
    let criteria: string;
    if (mode === "advanced") {
      criteria = rawCriteria.trim();
      try { JSON.parse(criteria); } catch { setNotice({ kind: "err", text: "Criteria must be valid JSON." }); return; }
    } else {
      criteria = buildCriteria(field, n);
    }
    void run(
      "create",
      () => fetch("/api/campaigns/constant-contact/segments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: nm, segment_criteria: criteria }) }),
      "Segment created.",
      () => { setName(""); setRawCriteria(""); void load(); },
    );
  }

  return (
    <div className="space-y-3">
      <Card title="New segment">
        <div className="space-y-3.5">
          <div className="inline-flex rounded-md border border-bg-border overflow-hidden text-[11px]">
            {(["guided", "advanced"] as const).map((m, i) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 transition-colors ${i > 0 ? "border-l border-bg-border" : ""} ${mode === m ? "bg-bg-elev text-fg" : "text-fg-muted hover:text-fg"}`}
              >
                {m === "guided" ? "Guided" : "Advanced (raw JSON)"}
              </button>
            ))}
          </div>

          <div>
            <label className="label">Segment name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Non-openers — last 5" className="input" />
          </div>

          {mode === "guided" ? (
            <div className="rounded-xl border border-bg-border bg-bg-panel/40 p-4">
              <div className="mb-2 text-[10px] uppercase tracking-wide text-fg-dim">Condition</div>
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg">
                <span className="text-fg-muted">Contacts who</span>
                <select value={field} onChange={(e) => setField(e.target.value)} className="select w-auto">
                  {FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
                <span className="text-fg-muted">the last</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={n}
                  onChange={(e) => setN(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                  className="input w-16 text-center"
                />
                <span className="text-fg-muted">campaigns.</span>
              </div>
            </div>
          ) : (
            <div>
              <label className="label">segment_criteria (JSON)</label>
              <textarea
                value={rawCriteria}
                onChange={(e) => setRawCriteria(e.target.value)}
                rows={4}
                placeholder='{"version":"1.0.0","criteria":{...}}'
                className="textarea font-mono text-[12px]"
              />
            </div>
          )}

          <button type="button" className="btn-primary" disabled={busy === "create"} onClick={create}>
            {busy === "create" ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : "Create segment"}
          </button>
        </div>
      </Card>

      {notice && (
        <div
          className={`text-[12px] rounded-md border px-2.5 py-1.5 ${
            notice.kind === "ok"
              ? "border-status-engaged/30 bg-status-engaged/5 text-status-engaged"
              : "border-status-hot/40 bg-status-hot/10 text-status-hot"
          }`}
        >
          {notice.text}
        </div>
      )}

      {loading ? (
        <SegmentsSkeleton />
      ) : error ? (
        <Card><div className="text-sm text-status-warm">{error}</div></Card>
      ) : segs.length === 0 ? (
        <Card noPadding><EmptyState message="No segments yet. Build one above." /></Card>
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-fg-dim border-b border-bg-border">
                  <th className="px-4 py-2.5 font-medium">Segment</th>
                  <th className="px-4 py-2.5 font-medium">Updated</th>
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {segs.map((s) => {
                  const sid = String(s.segment_id);
                  const hint = summarizeCriteria(s.segment_criteria);
                  return (
                    <tr key={sid} className="group border-b border-bg-border/40 last:border-b-0 hover:bg-bg-elev/40 transition-colors">
                      <td className="px-4 py-3">
                        <div className="text-fg">{s.name || "(unnamed)"}</div>
                        {hint && <div className="mt-1"><Tag tone="neutral">{hint}</Tag></div>}
                      </td>
                      <td className="px-4 py-3 text-fg-muted tabular-nums">{fmtDate(s.edited_at || s.created_at)}</td>
                      <td className="px-4 py-3 text-right">
                        {confirmId === sid ? (
                          <span className="inline-flex items-center gap-2 text-[12px]">
                            <span className="text-fg-dim">Delete?</span>
                            <button
                              type="button"
                              className="font-semibold text-status-hot disabled:opacity-50"
                              disabled={busy === "del"}
                              onClick={() => void run("del", () => fetch(`/api/campaigns/constant-contact/segments/${encodeURIComponent(sid)}`, { method: "DELETE" }), "Segment deleted.", () => { setConfirmId(null); void load(); })}
                            >
                              {busy === "del" ? "…" : "Confirm"}
                            </button>
                            <button type="button" className="text-fg-dim hover:text-fg" onClick={() => setConfirmId(null)}>Cancel</button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            aria-label="Delete segment"
                            className="inline-flex opacity-0 group-hover:opacity-100 text-fg-dim hover:text-status-hot transition-colors"
                            onClick={() => setConfirmId(sid)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
