/**
 * assigned-names — resolve a record's `assigned_to` (an operator's
 * auth_user_id, a raw UUID) into a human display name on `assigned_to_name`.
 *
 * The SunBiz CRM surfaces were BUILT to read `assigned_to_name` and fall back
 * to the raw `assigned_to` UUID only when it's missing:
 *   - LeadPipelineView rowModel: str(d.assigned_to_name) || str(d.assigned_to)
 *   - LeadDetailDrawer OwnerAssignedRow: record.assigned_to_name || ...assigned_to
 * …but nothing ever populated `assigned_to_name`, so the operator saw the raw
 * UUID in the "AGENT" column and the drawer's "Assigned to" field. This module
 * is the missing resolution step, applied server-side wherever records are
 * surfaced (the pipeline rows + the drawer's /detail payload).
 *
 * Name source: getTenantMembers (same data the "Assign to" dropdown uses).
 * Added 2026-06-16.
 */

import { getTenantMembers } from "@/lib/team";

/**
 * Build a Map<auth_user_id, displayName> for one tenant. Soft-fails to an
 * empty map (callers then leave assigned_to_name unset → the UI keeps its
 * existing UUID fallback rather than crashing). Names follow the same
 * precedence as the assignment dropdown: display_name → full_name.
 */
export async function buildMemberNameMap(
  tenantId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const members = await getTenantMembers(tenantId).catch(() => []);
  for (const m of members) {
    if (!m.auth_user_id) continue;
    const name = (m.display_name || m.full_name || "").trim();
    if (name) map.set(m.auth_user_id, name);
  }
  return map;
}

/**
 * Return a shallow clone of `data` with `assigned_to_name` resolved from
 * `assigned_to`. No-op (returns the same object) when there's no assignee or
 * the assignee isn't in the map — so the UI falls back to its existing
 * behavior instead of showing a blank.
 */
export function withAssignedName<T extends Record<string, unknown>>(
  data: T,
  nameMap: Map<string, string>,
): T {
  const id = typeof data.assigned_to === "string" ? data.assigned_to : null;
  if (!id) return data;
  const name = nameMap.get(id);
  if (!name) return data;
  return { ...data, assigned_to_name: name };
}

/**
 * Attach `assigned_to_name` to every row's `data`. Fetches the member map
 * once for the whole list. Returns the rows untouched when the list is empty
 * or no members resolve.
 */
export async function attachAssignedNames<
  R extends { data: Record<string, unknown> },
>(rows: R[], tenantId: string): Promise<R[]> {
  if (rows.length === 0) return rows;
  const nameMap = await buildMemberNameMap(tenantId);
  if (nameMap.size === 0) return rows;
  return rows.map((r) => ({ ...r, data: withAssignedName(r.data, nameMap) }));
}
