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
  // Phase 3d (2026-06-02) Kixie/TextTorrent comms tools. All mutate or
  // send outbound, so a read_only member must never trigger them via chat
  // — even though the dashboard's dry-run gate is a second backstop.
  "kixie_call",
  "kixie_send_sms",
  "texttorrent_send",
  "texttorrent_blast",
  "texttorrent_inbox_reply",
  "texttorrent_create_list",
  "texttorrent_add_contact",
  "texttorrent_block",
  "texttorrent_unblock",
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
 * VPS-bridge tool gating (distinct from READ_ONLY_DENIED_TOOLS above).
 *
 * READ_ONLY_DENIED_TOOLS lists CLOUD tool / marker names (snake_case:
 * write_file, bash, send_email...) the cloud /api/chat path strips for
 * read_only operators. THIS list is the Claude Code CLI tool names
 * (PascalCase: Bash, Write, Edit...) passed to the bridge spawn as
 * `--disallowed-tools` — the hard wall that prevents a non-owner SunBiz
 * employee from getting a shell on the shared VPS.
 *
 * Enforcement: the /api/bridge/chat proxy computes this server-side from the
 * DB-resolved team_role, forwards it as `disallowed_tools`, and the bridge
 * appends `--disallowed-tools Bash Write Edit MultiEdit NotebookEdit WebFetch`
 * to BOTH the cold-spawn and warm-pool claude argv. See
 * CEO-Agent/bravo_cli/bridge_chat_server.py and warm_claude_pool.py. Claude
 * Code itself refuses to invoke a denied tool, so the model literally cannot
 * shell out — this is not advisory persona text, it is the CLI boundary.
 */
export const BRIDGE_MUTATING_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
] as const;

/**
 * Map a team_role to the Claude Code CLI tools to deny at bridge spawn time.
 *
 *   owner / admin  → []  (full harness, same power CC has)
 *   every other role (read_only, member, loan_officer, processor, ...)
 *                  → the full mutating set (no shell, no file writes, no WebFetch
 *                    SSRF surface). Read / Glob / Grep stay allowed so the agent
 *                    can still answer business questions.
 *
 * Fail-closed by construction: an unknown / null / empty role falls into the
 * non-owner branch and gets the full deny list. Callers should ALSO default
 * teamRole to 'read_only' on any resolution error so the least-privilege path
 * is taken twice over.
 */
export function bridgeDisallowedToolsForRole(
  teamRole: string | null | undefined,
): string[] {
  const r = (teamRole || "").trim().toLowerCase();
  if (r === "owner" || r === "admin") return [];
  return [...BRIDGE_MUTATING_TOOLS];
}

/**
 * Bridge `/exec-tool` registry tool names (lowercase, snake_case) that are
 * SAFE for non-owner/non-admin roles. Source of truth:
 * Business-Empire-Agent/bravo_cli/bridge_tools.py:TOOL_REGISTRY.
 *
 * Codex audit 2026-06-09 round-7 [high]: read_file and load_skill were
 * REMOVED from this allowlist. Both are "read-only" in the local-machine
 * sense but the bridge implementation lets them read under all registered
 * agent repo roots (Bravo/Atlas/Maven/Aura/Hermes). A non-admin SunBiz
 * employee (read_only, loan_officer, processor) could POST tool_name=
 * read_file and read CC's empire code, brain notes, memory — a clear
 * tenant-boundary break.
 *
 * Codex audit 2026-06-09 round-8 [medium]: list_scripts and list_skills
 * were ALSO removed. The bridge implementations don't return names
 * only — list_scripts extracts first-line docstrings from each script,
 * list_skills returns SKILL.md frontmatter (description, triggers, tags).
 * That's operator-repo authored content, not pure enumeration. The
 * surviving allowlist:
 *   - cli_status   — daemon health probe (uptime, last error). No data.
 *
 * For non-admin SunBiz operators who legitimately want a "what can
 * Solara do?" surface, the proper long-term fix is a tenant-safe
 * static catalog served from the dashboard (filtered to the tenant's
 * enabled agents/skills, with copy CC explicitly authors for non-admin
 * consumption). Tracked as ADR-0009.
 *
 * Every other tool in TOOL_REGISTRY (read_file, load_skill, list_scripts,
 * list_skills, write_file, bash, send_email, send_sms, run_script,
 * stripe, supabase, n8n, firecrawl, notebooklm, underwriting_run,
 * shop_out_send_batch, install_cli, cli_auth_start) is denied for
 * non-owner/non-admin.
 *
 * Allowlist over denylist: when a new tool gets added to the bridge registry
 * it MUST default to "denied for non-admin" rather than "allowed by accident."
 *
 * Codex audit 2026-06-09 round-3 [critical] context: the previous gate
 * reused bridgeDisallowedToolsForRole() (Claude CLI PascalCase names)
 * against bridge registry names (lowercase snake_case). The exact-match
 * comparison never triggered, so a non-admin POST with tool_name="bash"
 * passed straight through.
 */
export const BRIDGE_EXEC_TOOL_READ_ONLY: ReadonlySet<string> = new Set([
  "cli_status",
]);

/**
 * Return true when the given bridge-registry tool name is callable by the
 * given team role via /api/bridge/exec-tool. owner / admin can call any
 * registered tool; every other role can only call the read-only allowlist.
 *
 * Fail-closed: unknown role => non-admin path => allowlist-only.
 */
export function bridgeExecToolAllowedForRole(
  teamRole: string | null | undefined,
  toolName: string,
): boolean {
  const r = (teamRole || "").trim().toLowerCase();
  if (r === "owner" || r === "admin") return true;
  return BRIDGE_EXEC_TOOL_READ_ONLY.has(toolName);
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
