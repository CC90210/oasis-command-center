"use client";

/**
 * TerritoryAssignment — admin-only control that hands a Web Leads sheet
 * (territory) to a rep, per Build B of the leads-to-pipeline design.
 *
 * WHY THIS SHAPE, NOT A FULL SHEET-LIST TABLE: the Web Leads browser has no
 * per-territory list surface today. FilterRail.tsx deliberately rolls the
 * 1,600+ territories up into province -> city and industry facets so the
 * rail stays usable — a strict per-sheet table would either duplicate that
 * whole hierarchy or abandon it. Rather than build a second, parallel list
 * surface just to hang one control on it, this is a minimal find-and-pick
 * control: search a sheet by name, pick a rep (or clear), save. If a real
 * sheet-management page is ever needed for other reasons, this control
 * moves onto it unchanged — it doesn't own the search/pagination story.
 *
 * Admin-only is enforced SERVER-SIDE by both endpoints this calls
 * (GET /api/web-leads/territories and PATCH .../assign both 401/403 before
 * touching data) — a non-admin who somehow renders this sees the loading
 * state resolve to nothing (`visible` flips false on 401/403), never real
 * territory or assignment data.
 *
 * Team roster comes from GET /api/web-leads/assignable-reps -- the SAME roster
 * function the assign route validates the target against. It used to read
 * /api/team/members, which is every profile on the tenant, so this control
 * offered founders and admins as destinations for a whole city+industry sheet.
 * The route now refuses those (target_not_on_sales_roster), and this list can
 * no longer produce one.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Users } from "lucide-react";

type Territory = {
  id: string;
  region: string;
  locality: string;
  vertical: string;
  leads_callable: number | null;
  assigned_to: string | null;
};

type Member = { id: string; name: string };

const territoryLabel = (t: Territory) => `${t.locality}, ${t.region} - ${t.vertical}`;

export function TerritoryAssignment() {
  const [territories, setTerritories] = useState<Territory[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [visible, setVisible] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [territoryId, setTerritoryId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/web-leads/territories", { cache: "no-store" })
      .then(async (r) => {
        if (!alive) return null;
        if (r.status === 401 || r.status === 403) {
          setVisible(false);
          return null;
        }
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || "territories_failed");
        return body;
      })
      .then((body) => {
        if (!alive || !body) return;
        setTerritories(body.territories || []);
        // Best-effort roster fetch — an assignment control that can't list
        // reps yet is still useful (search + unassign still work), so a
        // members-fetch failure doesn't block the whole control.
        fetch("/api/web-leads/assignable-reps", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : { reps: [] }))
          .then((m) => {
            if (alive) setMembers(Array.isArray(m.reps) ? m.reps : []);
          })
          .catch(() => undefined);
      })
      .catch((e) => {
        if (alive) setLoadError(e instanceof Error ? e.message : "territories_failed");
      });
    return () => {
      alive = false;
    };
  }, []);

  const shown = useMemo(
    () =>
      (territories || [])
        .filter((t) => !query || territoryLabel(t).toLowerCase().includes(query.toLowerCase()))
        .slice(0, 200),
    [territories, query],
  );

  if (!visible) return null;
  if (territories === null) {
    if (!loadError) {
      return (
        <div className="space-y-2" aria-busy="true" aria-live="polite">
          <div className="h-4 w-32 rounded bg-bg-elev animate-pulse-slow" />
          <div className="h-20 rounded-lg border border-bg-border bg-bg-panel animate-pulse-slow" />
        </div>
      );
    }
    return <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">{loadError}</p>;
  }

  const selected = territories.find((t) => t.id === territoryId) || null;
  const ownerName = (id: string | null) => {
    if (!id) return "Unassigned";
    const m = members.find((mm) => mm.id.toLowerCase() === id.toLowerCase());
    return m ? m.name || id.slice(0, 8) : id.slice(0, 8);
  };

  async function save() {
    if (!territoryId) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch(`/api/web-leads/territories/${territoryId}/assign`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignedTo: assignedTo || null }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "assign_failed");
      setTerritories((rows) =>
        (rows || []).map((t) => (t.id === territoryId ? { ...t, assigned_to: assignedTo || null } : t)),
      );
      setMessage(body.message || "Saved.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "assign_failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-bg-border bg-bg-panel p-5 shadow-card">
      <div className="mb-4 flex items-center gap-2">
        <Users className="h-4 w-4 text-fg-dim" />
        <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-fg">Assign a sheet</h2>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[10px] font-bold uppercase tracking-[0.1em] text-fg-muted">
          Find a sheet
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Toronto salons"
            className="mt-1.5 block w-56 rounded-md border border-bg-border bg-bg-deep px-2.5 py-1.5 text-sm normal-case tracking-normal text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
          />
        </label>
        <label className="text-[10px] font-bold uppercase tracking-[0.1em] text-fg-muted">
          Sheet
          <select
            value={territoryId}
            onChange={(e) => {
              const id = e.target.value;
              setTerritoryId(id);
              const t = territories.find((tt) => tt.id === id);
              setAssignedTo(t?.assigned_to || "");
            }}
            className="mt-1.5 block w-80 rounded-md border border-bg-border bg-bg-deep px-2.5 py-1.5 text-sm normal-case tracking-normal text-fg focus:border-accent focus:outline-none"
          >
            <option value="">Select a sheet</option>
            {shown.map((t) => (
              <option key={t.id} value={t.id}>
                {territoryLabel(t)} ({t.leads_callable || 0})
              </option>
            ))}
          </select>
        </label>
        <label className="text-[10px] font-bold uppercase tracking-[0.1em] text-fg-muted">
          Rep
          <select
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
            disabled={!territoryId}
            className="mt-1.5 block w-52 rounded-md border border-bg-border bg-bg-deep px-2.5 py-1.5 text-sm normal-case tracking-normal text-fg focus:border-accent focus:outline-none disabled:opacity-50"
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!territoryId || busy}
          onClick={() => void save()}
          className="inline-flex items-center justify-center rounded-md bg-gradient-to-br from-accent to-accent-muted px-4 py-1.5 text-sm font-bold text-white shadow-[0_0_0_1px_rgba(59,130,246,0.18),0_8px_20px_-8px_rgba(59,130,246,0.4)] transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
        </button>
      </div>
      {selected && (
        <p className="mt-3 text-xs text-fg-dim">Current owner: <span className="text-fg-muted">{ownerName(selected.assigned_to)}</span></p>
      )}
      {message && <p className="mt-2 text-xs text-fg-muted">{message}</p>}
    </section>
  );
}
