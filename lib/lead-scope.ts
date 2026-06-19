/**
 * lead-scope.ts — per-agent lead visibility (Adon Batch 2, 2026-06-19).
 *
 * Agents (loan_officer / processor / member / read_only) see ONLY leads +
 * applications assigned to them (data.assigned_to === their auth_user_id).
 * Admins (owner / admin) see all, and can narrow to one agent or the
 * unassigned bucket. Enforced SERVER-SIDE in every lead/application read
 * path — the dashboard queries with the service-role key, so this is the
 * authorization boundary, not RLS (RLS is a planned fast-follow).
 *
 * Fail-closed: a non-admin whose identity can't be resolved gets NO rows
 * (the NO_LEADS sentinel matches nothing) rather than the full pool.
 */

/** assigned_to value that can never match a real auth_user_id (UUID) — used
 *  to force an empty result set when a viewer's identity is unresolved. */
export const NO_LEADS = "__no_access__";

/**
 * Rollout switch. Per-agent scoping is fail-closed, so flipping it on before
 * leads are assigned would drop every agent to an empty board. It stays OFF
 * until an admin has distributed the existing unassigned leads, then is enabled
 * by setting LEAD_SCOPING_ENABLED=true (Vercel env). Server-only read; the pure
 * functions below take `enabled` as a param so they stay unit-testable
 * (defaulting to true — tests exercise the enabled behavior).
 */
export function leadScopingEnabled(): boolean {
  return (process.env.LEAD_SCOPING_ENABLED || "").toLowerCase() === "true";
}

export type LeadViewer = { isAdmin: boolean; userId: string | null };

export type AdminLeadFilter = { agent?: string | null; unassigned?: boolean };

/**
 * Resolve the assigned_to filter for a lead/application LIST read.
 *   undefined → no filter (admin: all leads)
 *   string    → assigned_to === value (agent: own; admin: a chosen agent; or NO_LEADS)
 *   null      → assigned_to IS NULL (admin: unassigned bucket)
 */
export function resolveAssignedScope(
  viewer: LeadViewer,
  requested?: AdminLeadFilter,
  enabled = true,
): string | null | undefined {
  if (!enabled) return undefined; // rollout flag off → everyone sees all (legacy behavior)
  if (!viewer.isAdmin) {
    // Agents are always locked to their own leads. Fail closed if no identity.
    return viewer.userId ? viewer.userId.toLowerCase() : NO_LEADS;
  }
  if (requested?.unassigned) return null;
  if (requested?.agent && requested.agent.trim()) {
    return requested.agent.trim().toLowerCase();
  }
  return undefined; // admin default: all
}

/** Turn a resolved scope into a listRecords `where` fragment (or undefined). */
export function assignedWhere(
  scope: string | null | undefined,
): Record<string, string | null> | undefined {
  if (scope === undefined) return undefined;
  return { assigned_to: scope };
}

/** Filter already-fetched rows by a resolved scope (for in-memory lists that
 *  didn't go through listRecords' where). undefined = pass everything. */
export function filterRowsByScope<T extends { data: Record<string, unknown> }>(
  rows: T[],
  scope: string | null | undefined,
): T[] {
  if (scope === undefined) return rows;
  return rows.filter((r) => {
    const owner =
      typeof r.data.assigned_to === "string" ? r.data.assigned_to.toLowerCase() : null;
    return scope === null ? owner === null : owner === scope;
  });
}

/** Whether a viewer may open a single lead/application record. Admins always;
 *  agents only their own. Used to lock direct URL / API access (Adon's
 *  "guess the lead URL" requirement). */
export function canViewLead(
  viewer: LeadViewer,
  data: Record<string, unknown>,
  enabled = true,
): boolean {
  if (!enabled) return true; // rollout flag off → no single-lead lock (legacy behavior)
  if (viewer.isAdmin) return true;
  if (!viewer.userId) return false;
  const owner = typeof data.assigned_to === "string" ? data.assigned_to.toLowerCase() : null;
  return owner === viewer.userId.toLowerCase();
}
