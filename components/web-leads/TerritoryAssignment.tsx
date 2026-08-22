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
 * Team roster reuses the existing GET /api/team/members route rather than
 * inventing a new members source, per the Build B brief.
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

type Member = {
  auth_user_id: string | null;
  display_name: string | null;
  full_name: string | null;
};

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
        fetch("/api/team/members", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : { members: [] }))
          .then((m) => {
            if (alive) setMembers(m.members || []);
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
    return loadError ? <p className="mb-4 text-sm text-red-600">{loadError}</p> : null;
  }

  const selected = territories.find((t) => t.id === territoryId) || null;
  const ownerName = (id: string | null) => {
    if (!id) return "Unassigned";
    const m = members.find((mm) => (mm.auth_user_id || "").toLowerCase() === id.toLowerCase());
    return m ? m.display_name || m.full_name || id.slice(0, 8) : id.slice(0, 8);
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
    <section className="mb-5 rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <Users className="h-4 w-4" />
        <h2 className="text-sm font-semibold">Assign a sheet</h2>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-600">
          Find a sheet
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Toronto salons"
            className="mt-1 block w-56 rounded-md border border-slate-200 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-slate-600">
          Sheet
          <select
            value={territoryId}
            onChange={(e) => {
              const id = e.target.value;
              setTerritoryId(id);
              const t = territories.find((tt) => tt.id === id);
              setAssignedTo(t?.assigned_to || "");
            }}
            className="mt-1 block w-80 rounded-md border border-slate-200 px-2 py-1.5 text-sm"
          >
            <option value="">Select a sheet</option>
            {shown.map((t) => (
              <option key={t.id} value={t.id}>
                {territoryLabel(t)} ({t.leads_callable || 0})
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-600">
          Rep
          <select
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
            disabled={!territoryId}
            className="mt-1 block w-52 rounded-md border border-slate-200 px-2 py-1.5 text-sm disabled:opacity-50"
          >
            <option value="">Unassigned</option>
            {members
              .filter((m) => m.auth_user_id)
              .map((m) => (
                <option key={m.auth_user_id} value={m.auth_user_id as string}>
                  {m.display_name || m.full_name || m.auth_user_id}
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!territoryId || busy}
          onClick={() => void save()}
          className="rounded-md bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
        </button>
      </div>
      {selected && (
        <p className="mt-2 text-xs text-slate-500">Current owner: {ownerName(selected.assigned_to)}</p>
      )}
      {message && <p className="mt-2 text-xs text-slate-600">{message}</p>}
    </section>
  );
}
