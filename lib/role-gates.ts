/**
 * Role-based action allow/deny lists.
 *
 * Centralizes the "what can read_only users NOT do" list used by both
 * the cloud-tool palette filter (strips write tools before the model
 * even sees them) and the marker-action dispatcher (hard-rejects any
 * write that slipped through via a jailbreak / prompt-leak).
 *
 * Without this constant the two surfaces carry parallel hand-typed
 * sets that can silently drift — exactly the kind of split that breaks
 * security boundaries during refactors.
 */

/**
 * Cloud-tool names a read_only operator MUST NOT call. Filtered out
 * of `toolPalette` in /api/chat/route.ts before stream start so the
 * model doesn't even see them.
 */
export const READ_ONLY_DENIED_TOOLS = new Set<string>([
  "create_record",
  "update_record",
  "delete_record",
  "send_email",
  "send_sms",
  "write_file",
  "bash",
  "run_script",
]);

/**
 * Marker action types a read_only operator MUST NOT execute. Caught
 * by the dispatcher in /api/chat/route.ts — superset of the tool list
 * above because some operator actions (update_profile,
 * toggle_agent_enabled) aren't in the cloud-tool palette but still
 * mutate state.
 */
export const READ_ONLY_DENIED_MARKERS = new Set<string>([
  "create_record",
  "update_record",
  "delete_record",
  "update_profile",
  "toggle_agent_enabled",
]);

/** Marker action types that the cloud-tool native loop ALSO emits — used
 *  to dedupe so we don't double-execute when the model both tool_calls AND
 *  text-markers the same write. */
export const TOOL_NATIVE_MARKER_TYPES = new Set<string>([
  "create_record",
  "update_record",
  "delete_record",
]);

export function isReadOnlyRole(teamRole: string | null | undefined): boolean {
  return (teamRole || "").trim().toLowerCase() === "read_only";
}

/**
 * V6.9.3 — Field-level permission enforcement.
 *
 * Manifest extension (lib/manifest/schema.ts ManifestAgentBinding):
 *   field_permissions?: { entity_type, fields: string[], mode: 'read'|'write' }[]
 *
 * Semantics:
 *   - undefined / missing on the agent binding → no filter; agent gets full
 *     read+write access on every field of every entity (preserves V5 behavior).
 *   - empty array []  → no field access; agent is metadata-only.
 *   - populated list  → only the named fields are visible (read) / mutable
 *     (write); all others are stripped from responses + rejected from writes.
 *
 * Default deny when palette narrows: if the agent has field_permissions on
 * entity_type X with only `name`, fetching X returns only { name } per row,
 * never the rest. This is the wall the 2026-05-17 audit demanded (prompt-
 * based role enforcement is advisory, lib/role-gates.ts is the wall).
 */

export type FieldPermissionMode = "read" | "write";

export type FieldPermission = {
  entity_type: string;
  fields: string[];
  mode: FieldPermissionMode;
};

/**
 * Resolve which fields of `entity_type` an agent can read or write.
 * `null` return = no restriction (full access). `[]` = no access at all.
 * `[<list>]` = only those fields.
 */
export function resolveAllowedFields(
  permissions: FieldPermission[] | undefined,
  entity_type: string,
  mode: FieldPermissionMode,
): string[] | null {
  if (permissions === undefined) return null;
  // Empty array OR populated-but-no-entry-for-this-entity → default-deny.
  // Once an operator opts in by setting field_permissions at all, every
  // entity needs an explicit allowlist or it's locked. Prevents the gap
  // where adding ANY palette accidentally widens access on other entities.
  if (permissions.length === 0) return [];
  const matches = permissions.filter(
    (p) => p.entity_type === entity_type && (p.mode === mode || (mode === "read" && p.mode === "write")),
  );
  if (matches.length === 0) return [];
  const allFields = matches.flatMap((p) => p.fields);
  return Array.from(new Set(allFields));
}

/**
 * Filter a record's `data` object to only the allowed fields. Used at API
 * response boundaries to prevent over-fetching from leaking to the agent.
 * Pass `null` allowed to mean "no restriction" (returns input unchanged).
 */
export function applyFieldReadFilter<T extends Record<string, unknown>>(
  data: T,
  allowed: string[] | null,
): Partial<T> {
  if (allowed === null) return data;
  if (allowed.length === 0) return {};
  const filtered: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in data) filtered[key] = data[key];
  }
  return filtered as Partial<T>;
}

/**
 * Validate an inbound write against field_permissions. Returns the list of
 * disallowed keys present in the input; empty list = ok. Caller should
 * reject the request when this is non-empty.
 */
export function findDisallowedWriteFields(
  data: Record<string, unknown>,
  allowed: string[] | null,
): string[] {
  if (allowed === null) return [];
  if (allowed.length === 0) return Object.keys(data);
  const allowedSet = new Set(allowed);
  return Object.keys(data).filter((k) => !allowedSet.has(k));
}
