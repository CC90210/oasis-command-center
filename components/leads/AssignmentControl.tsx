"use client";

/**
 * AssignmentControl — drawer-footer dropdown that sets
 * tenant_records.data.assigned_to to a tenant member's auth_user_id.
 *
 * Phase 3 of the SunBiz multi-employee personalization plan
 * (2026-05-29). Soft preference / surfacing only — anyone can still
 * act on any deal regardless of who's assigned. This control just
 * promotes the record into the assignee's personal "My active deals"
 * widget on their dashboard.
 *
 * Data flow:
 *   - GET /api/team/members → populates the dropdown options
 *   - POST /api/leads/[id]/assign → writes the new assigned_to (UUID
 *     or null to clear)
 *
 * Renders compact inline so it fits in the drawer's existing layout.
 * Optimistic update on save — the dropdown reflects the new value
 * immediately, and the parent drawer re-fetches when the operator
 * closes/reopens.
 */

import { useEffect, useState } from "react";
import { Check, Loader2, UserPlus } from "lucide-react";

type Member = {
  id: string;
  auth_user_id: string;
  full_name: string | null;
  display_name: string | null;
};

export function AssignmentControl({
  recordId,
  currentAssignedTo,
  onSaved,
}: {
  recordId: string;
  /** auth_user_id currently set on data.assigned_to, or null. */
  currentAssignedTo: string | null;
  /** Optional callback fired after a successful save. The parent
   *  drawer can use this to re-fetch its data so the rest of the UI
   *  picks up the new value too. */
  onSaved?: (newAssignedTo: string | null) => void;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [value, setValue] = useState<string>(currentAssignedTo || "");
  const [busy, setBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch members once on mount. If the team API is unreachable the
  // control degrades to a disabled "Loading…" state — better than
  // crashing the drawer.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/team/members", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return;
        const body = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          members?: Member[];
        };
        if (!body.ok || !body.members || cancelled) return;
        setMembers(body.members);
      })
      .catch(() => {
        // Soft-fail — operator can still close the drawer.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(nextValue: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/leads/${recordId}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assigned_to: nextValue || null }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        assigned_to?: string | null;
        error?: string;
        message?: string;
      };
      if (!r.ok || !body.ok) {
        setError(body.message || body.error || `save_failed:${r.status}`);
        // Revert the local value on failure so the dropdown reflects
        // server truth.
        setValue(currentAssignedTo || "");
        return;
      }
      setValue(body.assigned_to || "");
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onSaved?.(body.assigned_to || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "save_failed");
      setValue(currentAssignedTo || "");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-bg-border bg-bg-elev/60 text-fg-dim">
        <UserPlus className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 space-y-1">
        <div className="text-[9.5px] uppercase tracking-wider font-semibold text-fg-dim">
          Assigned to
          <span className="ml-1 normal-case text-fg-dim/80 font-normal">(soft preference)</span>
        </div>
        <select
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            setValue(next);
            void save(next);
          }}
          disabled={busy || !members}
          className="w-full bg-bg-deep border border-bg-border rounded-md px-2 py-1.5 text-[12.5px] text-fg focus:border-accent focus:outline-none disabled:opacity-60"
        >
          <option value="">— Unassigned —</option>
          {(members || []).map((m) => (
            <option key={m.auth_user_id} value={m.auth_user_id}>
              {m.display_name || m.full_name || m.auth_user_id.slice(0, 8)}
            </option>
          ))}
        </select>
        {error && (
          <div className="text-[11px] text-red-300">{error}</div>
        )}
      </div>
      <div className="w-5 shrink-0">
        {busy && <Loader2 className="h-4 w-4 animate-spin text-fg-dim" />}
        {!busy && savedFlash && (
          <Check className="h-4 w-4 text-emerald-300" aria-label="Saved" />
        )}
      </div>
    </div>
  );
}
