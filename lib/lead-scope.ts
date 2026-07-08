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

/**
 * Scoping MODE (Adon 2026-06-24).
 *   "isolate" (default — the original model): a non-admin can't see, open, or
 *     search a lead that isn't theirs at all.
 *   "filter": the BOARD + dashboard stay scoped to the agent's own book (a clean,
 *     uncluttered pipeline), but agents may OPEN and SEARCH any lead in the tenant
 *     (full read access). Only owner-gated ACTIONS (shop-out, bulk edit, AI-mutate)
 *     stay restricted to the owner/admin — those gates pass mode:"isolate".
 * Set with LEAD_SCOPING_MODE=filter (Vercel env). Server-only read; pure helpers
 * below take `mode` as a param (defaulting to this) so they stay unit-testable.
 */
export function leadScopingMode(): "isolate" | "filter" {
  return (process.env.LEAD_SCOPING_MODE || "").toLowerCase() === "filter" ? "filter" : "isolate";
}

/** Entities subject to per-agent scoping. lead → application → funded_deal is
 *  the personalized lifecycle (renewals render off funded_deal). Everything else
 *  (lender, offer, …) is tenant-shared. Single source of truth — imported by the
 *  records API, the catch-all pipeline page, and the dashboard. */
export const SCOPED_ENTITIES = new Set(["lead", "application", "funded_deal"]);

export type LeadViewer = { isAdmin: boolean; userId: string | null };

/**
 * "True admin" — a PERMANENT admin by base role (owner via is_owner, or an
 * explicit admin/owner team_role). EXCLUDES the `admin_access` toggle grant.
 *
 * This is the escalation-guard predicate: only a true admin may grant/alter
 * another member's team_role (setMemberRole), mint an admin (admin-role invite),
 * or flip the admin_access toggle. A temporarily-elevated agent (admin_access=
 * true) is NOT a true admin, so it can never mint permanent admins — no
 * privilege-escalation loop. Admin-toggle design, 2026-07-07.
 */
export function isTrueAdmin(
  profile: { is_owner?: boolean | null; team_role?: string | null } | null | undefined,
): boolean {
  if (!profile) return false;
  return !!profile.is_owner || profile.team_role === "admin" || profile.team_role === "owner";
}

/** Is this user_profiles row an admin (sees all leads / has admin CAPABILITIES)?
 *  A true admin (owner / admin team_role) OR an agent an admin has toggled full
 *  admin access ON via `admin_access`. SINGLE source of truth for admin
 *  capability detection — every scoped surface (records API, catch-all pipeline,
 *  dashboards) calls this so the security-critical check can't drift between
 *  them. NOTE: capability-only — escalation-sensitive gates use isTrueAdmin. */
export function isAdminProfile(
  profile:
    | { is_owner?: boolean | null; team_role?: string | null; admin_access?: boolean | null }
    | null
    | undefined,
): boolean {
  if (!profile) return false;
  return isTrueAdmin(profile) || profile.admin_access === true;
}

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

/** The jsonb key holding the shared-deal collaborator list (auth_user_ids). */
export const COLLABORATORS_KEY = "collaborators";

/** Max co-agents on a single deal (owner + up to this many collaborators). */
export const MAX_COLLABORATORS = 5;

/**
 * Normalize `data.collaborators` → a deduped array of lowercased auth_user_ids
 * (or []). Tolerates the field being absent / not-an-array / containing junk —
 * a malformed value yields [] (fail-closed: no accidental access), never throws.
 */
export function normalizeCollaborators(data: Record<string, unknown>): string[] {
  const raw = data[COLLABORATORS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const v = x.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Canonical visibility predicate — the SINGLE source of truth for "may this
 * viewer see this record". Visible when scoping is off, OR the viewer is an
 * admin, OR (in "filter" mode) for any member, OR they own it (`assigned_to`),
 * OR they're in its `collaborators` list. Every surface (lists, single-record
 * gates, dashboard counts) reduces to this so the rule can't drift between them.
 * Owner-gated ACTIONS force the strict check by passing mode:"isolate".
 */
export function recordMatchesViewer(
  data: Record<string, unknown>,
  viewer: LeadViewer,
  enabled = true,
  mode: "isolate" | "filter" = leadScopingMode(),
): boolean {
  if (!enabled) return true; // rollout flag off → legacy "everyone sees all"
  if (viewer.isAdmin) return true;
  if (!viewer.userId) return false; // fail-closed: unresolved identity sees nothing
  // Filtered-view model: every RESOLVED member may VIEW/open any lead; the board
  // itself is still narrowed by resolveAssignedScope. Action gates opt out (isolate).
  if (mode === "filter") return true;
  const me = viewer.userId.toLowerCase();
  const owner = typeof data.assigned_to === "string" ? data.assigned_to.toLowerCase() : null;
  if (owner === me) return true;
  return normalizeCollaborators(data).includes(me);
}

/** Whether a viewer may open a single lead/application record. Admins always;
 *  agents only their own OR ones they collaborate on. Used to lock direct URL /
 *  API access (Adon's "guess the lead URL" requirement). Delegates to the
 *  canonical predicate so single-record access and list visibility never drift. */
export function canViewLead(
  viewer: LeadViewer,
  data: Record<string, unknown>,
  enabled = true,
  mode: "isolate" | "filter" = leadScopingMode(),
): boolean {
  return recordMatchesViewer(data, viewer, enabled, mode);
}
