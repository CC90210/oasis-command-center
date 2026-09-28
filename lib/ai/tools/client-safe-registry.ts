/**
 * lib/ai/tools/client-safe-registry.ts — the only tools a client tenant's agent
 * may be offered, and the one list of tenants that are OASIS's own.
 *
 * WHY THIS EXISTS (docs/os-revamp/03-connectors-ai-finance.md F2, §d.4).
 * Until 2026-09-28 an agent whose manifest carried no tool_palette got EVERY
 * tool in lib/cloud-tool-runner.ts TOOL_DEFINITIONS. That catalog was built
 * for OASIS's own workspace, and it includes:
 *   - the bridge-routed tools (`defer: true`: bash, write_file, run_script,
 *     send_email, stripe, supabase …), which execute on the operator's paired
 *     machine with that machine's credentials;
 *   - get_credential, which hands a decrypted vault secret to the model, and
 *     add_credential, which writes one;
 *   - read_brain_doc / search_memory, which read OASIS's CEO-Agent brain repo;
 *   - http_post, an unauthenticated outbound write to any public URL.
 * The only thing between a client tenant and those tools was "is the bridge
 * offline", which is an availability check, not a security boundary.
 *
 * THE RULE, for every tenant that is not OASIS's own:
 *   - a missing palette means NO tools (default-deny);
 *   - a populated palette is intersected with CLIENT_SAFE_TOOLS, so neither a
 *     manifest nor an operator in Settings can opt a client into a bridge,
 *     credential or brain tool: those names are simply not on the list;
 *   - the runner ALSO strips every `defer: true` tool for a client tenant
 *     structurally, so a mistake in this file still cannot offer one;
 *   - executeTool refuses, at dispatch, any tool this list does not name.
 * OASIS's own tenants keep today's behaviour exactly.
 *
 * WHY AN ALLOWLIST AND NOT A DENYLIST. A tool added to TOOL_DEFINITIONS
 * tomorrow stays invisible to clients until someone decides, here and in
 * review, that it is safe for them. A denylist would hand it to every client
 * the moment it merged.
 *
 * Pure leaf module with no imports: lib/manifest/schema.ts (which client
 * components import) and the server-only runner and inference router both
 * read it, so it must not pull in anything server-only.
 */

/**
 * OASIS's OWN workspaces, by tenant id. Never by slug: a slug is display text a
 * workspace can claim (docs/os-revamp/02 P0-3), an id is a primary key.
 * Verified against the live `tenants` table 2026-09-28; these are the only two
 * rows whose slug contains "oasis". The historical "oasis" slug in
 * lib/role-surfaces.ts OASIS_SURFACE_TENANT_SLUGS has no tenant row, so it has
 * no id to list.
 *
 * Mirrors the "oasis" rows of TENANT_ID_BRAND in lib/email/brand-for-tenant.ts
 * and OASIS_ENV_CREDENTIAL_TENANT_IDS in lib/tenant-integration-store.ts;
 * tests/os-tool-sandbox.test.ts asserts the brand-map parity.
 */
export const OASIS_INTERNAL_TENANT_IDS: ReadonlySet<string> = new Set([
  "ef8d389e-3f15-43f2-ae00-3660f69a1452", // slug "oasis-ai-cc" (also web-leads' WEBDEV_TENANT_ID)
  "42423fde-be8b-454f-932a-750e8c9b743d", // slug "oasis-webdev"
]);

/**
 * True only for an OASIS tenant id, exact match. Another tenant, an unknown
 * id, "", null and undefined are all false, so every caller fails closed.
 */
export function isOasisInternalTenant(tenantId: string | null | undefined): boolean {
  return typeof tenantId === "string" && OASIS_INTERNAL_TENANT_IDS.has(tenantId);
}

/**
 * - `read`: returns this tenant's own records or public web content and
 *   changes nothing.
 * - `draft`: writes only inside this tenant's OWN workspace (its records, or
 *   the member's own profile facts). Nothing leaves the workspace: no send, no
 *   spend, no third-party call, nothing on a paired machine. It is the same
 *   authority the member already has in the UI, and the chat route still
 *   strips these for read_only members (lib/role-gates.ts
 *   READ_ONLY_DENIED_TOOLS) and plan mode strips them too. The approval-row
 *   draft tools from doc 03 §d.4 join this class when they exist.
 *
 * There is deliberately no `execute` class here. An outward action (an SMS,
 * an email, a payment, a call) is never model-callable for a client; in the
 * OS it runs server-side from an approved payload only.
 */
export type ClientSafeToolClass = "read" | "draft";

/** The client-safe tools, by name. Names match TOOL_DEFINITIONS entries. */
export const CLIENT_SAFE_TOOLS: ReadonlyMap<string, ClientSafeToolClass> = new Map<
  string,
  ClientSafeToolClass
>([
  // read: tenant-scoped at the query (ctx.tenantId, taken from the session).
  ["list_records", "read"],
  ["get_record", "read"],
  ["search_records", "read"],
  ["lookup_lead_by_name", "read"],
  ["list_open_leads", "read"],
  ["list_lead_documents", "read"],
  ["integration_status", "read"],
  // read: public web only, behind the runner's assertSafeUrl + DNS-aware
  // assertResolvedIpIsPublic SSRF guard, auth-shaped headers stripped.
  ["web_fetch", "read"],
  ["http_get", "read"],
  // draft: writes that stay inside the tenant's own workspace.
  ["create_record", "draft"],
  ["update_record", "draft"],
  ["import_leads_from_attachment", "draft"],
  ["save_known_fact", "draft"],
]);

/** True when `name` may be offered to, and dispatched for, a client tenant. */
export function isClientSafeTool(name: string): boolean {
  return CLIENT_SAFE_TOOLS.has(name);
}
