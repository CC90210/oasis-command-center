"use client";

/**
 * CollaboratorsControl — drawer control to share a deal with other agents
 * (2026-06-22). Mirrors AssignmentControl, but manages the `data.collaborators`
 * array (additive viewers/workers) rather than the single `assigned_to` owner.
 * A shared deal is visible to the owner + every collaborator (+ admins) — see
 * lib/lead-scope recordMatchesViewer.
 *
 * Data flow:
 *   - GET /api/team/members → dropdown options
 *   - POST /api/leads/[id]/collaborators { add | remove } → updates the array
 *
 * Only the owner/admin can edit (the endpoint enforces it). Renders current
 * collaborators as removable chips + an "Add collaborator" select that excludes
 * the owner and anyone already on the list.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Users, X } from "lucide-react";

type Member = {
  id: string;
  auth_user_id: string;
  full_name: string | null;
  display_name: string | null;
};

export function CollaboratorsControl({
  recordId,
  currentCollaborators,
  ownerAssignedTo,
  onSaved,
}: {
  recordId: string;
  /** auth_user_ids currently in data.collaborators (lowercased). */
  currentCollaborators: string[];
  /** the deal's owner (data.assigned_to) — excluded from the add list. */
  ownerAssignedTo: string | null;
  onSaved?: (next: string[]) => void;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [collabs, setCollabs] = useState<string[]>(
    currentCollaborators.map((c) => c.toLowerCase()),
  );
  const [busy, setBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/team/members", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return;
        const body = (await r.json().catch(() => ({}))) as { ok?: boolean; members?: Member[] };
        if (!body.ok || !body.members || cancelled) return;
        setMembers(body.members);
      })
      .catch(() => {
        /* soft-fail — control degrades to chips-only */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const owner = (ownerAssignedTo || "").toLowerCase();
  const nameFor = (id: string) => {
    const m = members?.find((x) => x.auth_user_id.toLowerCase() === id);
    return m?.display_name || m?.full_name || id.slice(0, 8);
  };

  // Members eligible to ADD: not the owner, not already a collaborator.
  const addable = useMemo(
    () =>
      (members || []).filter((m) => {
        const id = m.auth_user_id.toLowerCase();
        return id !== owner && !collabs.includes(id);
      }),
    [members, owner, collabs],
  );

  async function mutate(body: { add?: string; remove?: string }) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/leads/${recordId}/collaborators`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        collaborators?: string[];
        error?: string;
        message?: string;
      };
      if (!r.ok || !j.ok) {
        setError(j.message || j.error || `save_failed:${r.status}`);
        return;
      }
      const next = (j.collaborators || []).map((c) => c.toLowerCase());
      setCollabs(next);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onSaved?.(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "save_failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-start gap-2">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-bg-border bg-bg-elev/60 text-fg-dim">
        <Users className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 space-y-1.5">
        <div className="text-[9.5px] uppercase tracking-wider font-semibold text-fg-dim">
          Collaborators
          <span className="ml-1 normal-case text-fg-dim/80 font-normal">(also see + work this deal)</span>
        </div>

        {collabs.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {collabs.map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full border border-bg-border bg-bg-elev/60 pl-2 pr-1 py-0.5 text-[11.5px] text-fg"
              >
                {nameFor(id)}
                <button
                  type="button"
                  onClick={() => void mutate({ remove: id })}
                  disabled={busy}
                  className="rounded-full p-0.5 text-fg-dim hover:text-red-300 disabled:opacity-50"
                  aria-label={`Remove ${nameFor(id)}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <select
          value=""
          onChange={(e) => {
            const id = e.target.value;
            if (id) void mutate({ add: id });
          }}
          disabled={busy || !members || addable.length === 0}
          className="w-full bg-bg-deep border border-bg-border rounded-md px-2 py-1.5 text-[12.5px] text-fg focus:border-accent focus:outline-none disabled:opacity-60"
        >
          <option value="">
            {addable.length === 0 ? "— No one else to add —" : "+ Add collaborator…"}
          </option>
          {addable.map((m) => (
            <option key={m.auth_user_id} value={m.auth_user_id.toLowerCase()}>
              {m.display_name || m.full_name || m.auth_user_id.slice(0, 8)}
            </option>
          ))}
        </select>
        {error && <div className="text-[11px] text-red-300">{error}</div>}
      </div>
      <div className="mt-0.5 w-5 shrink-0">
        {busy && <Loader2 className="h-4 w-4 animate-spin text-fg-dim" />}
        {!busy && savedFlash && <Check className="h-4 w-4 text-emerald-300" aria-label="Saved" />}
      </div>
    </div>
  );
}
