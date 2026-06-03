/**
 * Shared chat tool palettes — single source of truth for the per-agent
 * cloud-tool allowlists.
 *
 * `SAFE_TENANT_TOOL_PALETTE` was previously a private const inside
 * app/api/chat/route.ts. It was lifted here (2026-06-02, Phase 3d) so the
 * SunBiz seed manifest can compose Helios's palette from it without
 * duplicating the list — duplication is exactly how these two surfaces
 * would silently drift.
 *
 * Palette semantics (enforced in app/api/chat/route.ts + the runner):
 *   - undefined → no per-agent filter; non-operators fall back to
 *     SAFE_TENANT_TOOL_PALETTE, operators get the full TOOL_DEFINITIONS.
 *   - populated → ONLY those tool names are advertised to the model
 *     (allowlist REPLACE, not additive — so a palette must include the
 *     base tools it still wants, not just the extras).
 */

/**
 * Safe-default tool palette for non-operator tenants. The omitted tools
 * (bash / write_file / read_file / run_script / delete_record / http_post)
 * are deliberately withheld — see the original rationale preserved inline.
 *
 * Send tools that exist here (send_email / send_sms) route through the
 * bridge's send_gateway (CASL/TCPA enforced). The Kixie/TextTorrent comms
 * tools are NOT here on purpose — they're opted into per-agent (Helios)
 * via HELIOS_TOOL_PALETTE so a generic tenant agent can't blast SMS.
 */
export const SAFE_TENANT_TOOL_PALETTE: string[] = [
  // Data tools — tenant_records CRUD, all RLS-scoped at the data layer.
  "list_records",
  "get_record",
  "search_records",
  "create_record",
  "update_record",
  "lookup_lead_by_name",
  "list_open_leads",
  "import_leads_from_attachment",
  "integration_status",
  // HTTP — fetchWithCap enforces an SSRF block list. Public reads only.
  "http_get",
  // Bridge sends — already routed through send_gateway (CASL/TCPA enforced).
  "send_email",
  "send_sms",
  // KNOWN FACTS append — per-user, auth_user_id-scoped inside the tool.
  "save_known_fact",
  // Custom credentials vault — admin-gated inside each tool (ctx.isAdmin).
  "get_credential",
  "add_credential",
];

/**
 * The SunBiz Kixie + TextTorrent comms tools (Phase 3d). Send-capable, so
 * they stay OUT of the safe default and are added only to agents that
 * should reach them (Helios — the sales/outreach persona). Also listed in
 * READ_ONLY_DENIED_TOOLS so read_only members can't fire them via chat.
 */
export const SUNBIZ_OUTBOUND_TOOLS: string[] = [
  "kixie_call",
  "kixie_send_sms",
  "texttorrent_send",
  "texttorrent_blast",
  "texttorrent_inbox_reply",
  "texttorrent_create_list",
  "texttorrent_add_contact",
  "texttorrent_block",
  "texttorrent_unblock",
];

/**
 * Helios (SunBiz front-of-house sales) gets the safe base PLUS the comms
 * send tools. Solara intentionally has NO tool_palette set → it falls back
 * to SAFE_TENANT_TOOL_PALETTE (no comms tools) — i.e. "opt-in" for Solara.
 */
export const HELIOS_TOOL_PALETTE: string[] = [
  ...SAFE_TENANT_TOOL_PALETTE,
  ...SUNBIZ_OUTBOUND_TOOLS,
];
