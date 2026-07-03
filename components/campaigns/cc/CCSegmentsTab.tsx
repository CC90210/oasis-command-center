"use client";

/**
 * CCSegmentsTab — list Constant Contact segments and build new ones. The guided
 * builder covers the documented engagement criteria (opened / did-not-open / clicked
 * the last N campaigns) — the highest-value re-targeting case for MCA outreach — and
 * an Advanced mode accepts a raw segment_criteria JSON for anything more complex.
 * Talks to /api/campaigns/constant-contact/segments[/id].
 */

import { useCallback, useEffect, useState } from "react";
import { Card, EmptyState } from "@/components/Card";
import { Loader2 } from "lucide-react";

type Seg = { segment_id?: number | string; name?: string; edited_at?: string };

const input = "text-[12px] rounded-md border border-bg-border bg-transparent px-2 py-1.5";
const btnPri = "rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[12px] font-semibold hover:bg-accent/20 disabled:opacity-50";

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
        <div className="space-y-3">
          <div className="inline-flex rounded-md border border-bg-border overflow-hidden text-[11px]">
            {(["guided", "advanced"] as const).map((m, i) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={`px-2.5 py-1 ${i > 0 ? "border-l border-bg-border" : ""} ${mode === m ? "bg-bg-elev text-fg" : "text-fg-muted"}`}>
                {m === "guided" ? "Guided" : "Advanced (raw JSON)"}
              </button>
            ))}
          </div>

          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Segment name" className={`${input} w-full`} />

          {mode === "guided" ? (
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-muted">
              <span>Contacts who</span>
              <select value={field} onChange={(e) => setField(e.target.value)} className={input}>
                {FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
              <span>the last</span>
              <input type="number" min={1} max={20} value={n} onChange={(e) => setN(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} className={`${input} w-16`} />
              <span>campaigns.</span>
            </div>
          ) : (
            <textarea value={rawCriteria} onChange={(e) => setRawCriteria(e.target.value)} rows={4} placeholder='{"version":"1.0.0","criteria":{...}}' className={`${input} w-full font-mono`} />
          )}

          <button type="button" className={btnPri} disabled={busy === "create"} onClick={create}>
            {busy === "create" ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : "Create segment"}
          </button>
        </div>
      </Card>

      {notice && (
        <div className={`text-[12px] rounded-md border px-2.5 py-1.5 ${notice.kind === "ok" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300" : "border-red-500/40 bg-red-500/10 text-red-300"}`}>{notice.text}</div>
      )}

      {loading ? (
        <Card noPadding><div className="p-6 text-sm text-fg-dim italic">Loading segments…</div></Card>
      ) : error ? (
        <Card><div className="text-sm text-status-warm">{error}</div></Card>
      ) : segs.length === 0 ? (
        <Card noPadding><EmptyState message="No segments yet. Build one above." /></Card>
      ) : (
        <Card noPadding>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-fg-dim border-b border-bg-border">
                <th className="px-4 py-2.5 font-medium">Segment</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {segs.map((s) => {
                const sid = String(s.segment_id);
                return (
                  <tr key={sid} className="border-b border-bg-border/40 last:border-b-0">
                    <td className="px-4 py-2.5 text-fg">{s.name || "(unnamed)"}</td>
                    <td className="px-4 py-2.5 text-right">
                      {confirmId === sid ? (
                        <span className="text-[12px]">
                          <button type="button" className="text-red-300 font-semibold mr-2" disabled={busy === "del"} onClick={() => void run("del", () => fetch(`/api/campaigns/constant-contact/segments/${encodeURIComponent(sid)}`, { method: "DELETE" }), "Segment deleted.", () => { setConfirmId(null); void load(); })}>Confirm</button>
                          <button type="button" className="text-fg-dim" onClick={() => setConfirmId(null)}>Cancel</button>
                        </span>
                      ) : (
                        <button type="button" className="text-[12px] text-red-300 hover:text-red-200" onClick={() => setConfirmId(sid)}>Delete</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
