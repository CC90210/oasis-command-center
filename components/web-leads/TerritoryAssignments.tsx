"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Users } from "lucide-react";

type Territory = { id: string; name: string; leads_callable: number; assigned_to: string | null };
type Agent = { auth_user_id: string; display_name: string | null; full_name: string | null };

export function TerritoryAssignments() {
  const [territories, setTerritories] = useState<Territory[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [territoryId, setTerritoryId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/web-leads/assignments", { cache: "no-store" }).then(async (r) => {
      if (r.status === 403 || r.status === 401) return null;
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "assignment_read_failed");
      return body;
    }).then((body) => {
      if (!alive || !body) return;
      setTerritories(body.territories);
      setAgents(body.agents);
    }).catch((e) => { if (alive) setMessage(e instanceof Error ? e.message : "assignment_read_failed"); });
    return () => { alive = false; };
  }, []);

  const shown = useMemo(() => (territories || [])
    .filter((t) => !query || t.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.leads_callable - a.leads_callable || a.name.localeCompare(b.name))
    .slice(0, 200), [territories, query]);
  if (territories === null) return message ? <p className="mb-4 text-sm text-red-600">{message}</p> : null;

  const selected = territories.find((t) => t.id === territoryId);
  async function save() {
    if (!territoryId) return;
    setBusy(true); setMessage(null);
    try {
      const r = await fetch("/api/web-leads/assignments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ territory_id: territoryId, assigned_to: assignedTo || null }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "assignment_failed");
      setTerritories((rows) => (rows || []).map((t) => t.id === territoryId ? { ...t, assigned_to: assignedTo || null } : t));
      setMessage(`${selected?.name || "Territory"}: ${body.leads_updated} existing leads updated.`);
    } catch (e) { setMessage(e instanceof Error ? e.message : "assignment_failed"); }
    finally { setBusy(false); }
  }

  return (
    <section className="mb-5 rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2"><Users className="h-4 w-4" /><h2 className="text-sm font-semibold">Assign a lead territory</h2></div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-600">Find territory<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Toronto restaurants" className="mt-1 block w-56 rounded-md border border-slate-200 px-2 py-1.5 text-sm" /></label>
        <label className="text-xs text-slate-600">Territory<select value={territoryId} onChange={(e) => { const id=e.target.value; setTerritoryId(id); setAssignedTo(territories.find((t) => t.id === id)?.assigned_to || ""); }} className="mt-1 block w-80 rounded-md border border-slate-200 px-2 py-1.5 text-sm"><option value="">Select territory</option>{shown.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.leads_callable})</option>)}</select></label>
        <label className="text-xs text-slate-600">Representative<select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className="mt-1 block w-52 rounded-md border border-slate-200 px-2 py-1.5 text-sm"><option value="">Unassigned</option>{agents.map((a) => <option key={a.auth_user_id} value={a.auth_user_id}>{a.display_name || a.full_name || a.auth_user_id.slice(0, 8)}</option>)}</select></label>
        <button type="button" disabled={!territoryId || busy} onClick={() => void save()} className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save assignment"}</button>
      </div>
      {message && <p className="mt-2 text-xs text-slate-600">{message}</p>}
    </section>
  );
}
