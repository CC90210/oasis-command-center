/**
 * lib/manifest/agent-bindings.ts - the one write to a workspace's agent lineup
 * (manifest.agents): add, enable, disable or remove one binding.
 *
 * Two callers, one rule set (W4a, 2026-10-01; audit S2-06):
 *   POST /api/tenant/agents/toggle   an owner or admin switching a teammate on
 *                                    or off (AI Team rows, Settings > AI brain);
 *   POST /api/agents                 a teammate just built in the builder: its
 *                                    binding is added the moment its agents
 *                                    row exists, so it starts On. It used to
 *                                    get the row only and sat "Off" on the AI
 *                                    Team with no control to turn it on.
 *
 * Rules:
 *   add      the slug must not be bound yet, and must be either a teammate this
 *            workspace built (a tenant-owned `agents` row) or, in OASIS's own
 *            workspace only, an OASIS house agent (lib/agents.ts). A house
 *            agent is refused anywhere else: the OASIS-only add-on rule used to
 *            live only in the Settings card (S2 verifier). Added on, not core,
 *            with no departments (a custom teammate), named by its agents row.
 *   enable   switches it on.
 *   disable  switches it off; refused for a core binding.
 *   remove   drops it; refused for a core binding.
 * Every message names the teammate the way the workspace's roster does
 * (lib/os/teammates.ts), never by a persona (S2-14).
 *
 * The write is the one the toggle route has always made: the workspace's
 * tenant_manifests row (found by tenant id) is updated in place, or, for a
 * workspace still on its in-code seed (OASIS has no row), the seed plus the
 * change is inserted under the workspace's slug.
 *
 * The CALLER has already checked that the session may manage this workspace.
 */
import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTenantManifestForUser } from "@/lib/manifest/tenant-scope";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getAgentInfo, isHouseAgentSlug } from "@/lib/agents";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
import { teammateFor } from "@/lib/os/teammates";
import type { ManifestAgentBinding } from "./schema";

export type AgentLineupAction = "add" | "enable" | "disable" | "remove";

export type AgentLineupResult =
  | { ok: true; agents: ManifestAgentBinding[]; message: string }
  | { ok: false; status: number; error: string; message: string };

const refuse = (status: number, error: string, message: string): AgentLineupResult => ({ ok: false, status, error, message });

/**
 * A teammate this workspace built: a tenant-owned `agents` row that OASIS does
 * not manage. Its name, or null when there is no such row. A failed read
 * throws: "could not tell" is not "no such teammate".
 */
async function ownAgentName(tenantId: string, slug: string): Promise<string | null> {
  const res = await getServiceSupabase()
    .from("agents")
    .select("slug, name, tenant_id, is_oasis_managed")
    .eq("slug", slug)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (res.error) throw new Error(`agent_bindings.own_agent: ${res.error.message}`);
  const row = res.data as { slug: string; name: string | null; tenant_id: string | null; is_oasis_managed: unknown } | null;
  if (!row || row.tenant_id !== tenantId || row.is_oasis_managed === true || row.is_oasis_managed === 1) return null;
  return (row.name || "").trim() || row.slug;
}

export async function changeAgentLineup(input: {
  tenantId: string;
  action: AgentLineupAction;
  /** Lowercased, alias-resolved slug (lib/agents.ts resolveAgentKey). */
  slug: string;
}): Promise<AgentLineupResult> {
  const { tenantId, action, slug } = input;
  const db = getServiceSupabase();

  const tenantRow = await db.from("tenants").select("slug, custom_fields").eq("id", tenantId).maybeSingle();
  if (tenantRow.error) return refuse(503, "workspace_unavailable", "This workspace could not be read just now. Try again.");
  const rawSlug = (tenantRow.data as { slug?: string } | null)?.slug || "";
  const tenantSlug = resolveClientProfileSlug({
    slug: rawSlug,
    custom_fields: (tenantRow.data as { custom_fields?: Record<string, unknown> } | null)?.custom_fields || {},
  });
  if (!tenantSlug) return refuse(400, "no_tenant_slug", "This workspace's settings could not be found.");
  const oasis = isOasisSurfaceTenant(rawSlug);

  // The stored row, by tenant id; a workspace still on its in-code seed gets
  // the seed copied into a row so there is something to change.
  const existingRow = await db.from("tenant_manifests").select("id, manifest").eq("tenant_id", tenantId).maybeSingle();
  // A failed read is not "no row": inserting the seed over it would fork the lineup.
  if (existingRow.error) return refuse(503, "manifest_unavailable", "This workspace's teammates could not be read just now. Try again.");
  const existingManifestId = (existingRow.data as { id?: string } | null)?.id || null;
  let manifest = (existingRow.data as { manifest?: Record<string, unknown> } | null)?.manifest;
  if (!manifest) {
    const seed = await getTenantManifestForUser(tenantId);
    if (!seed) return refuse(400, "no_manifest", "No manifest found for this workspace.");
    manifest = seed as unknown as Record<string, unknown>;
  }

  const before: ManifestAgentBinding[] = Array.isArray((manifest as { agents?: unknown }).agents)
    ? ((manifest as { agents: ManifestAgentBinding[] }).agents).map((a) => ({ ...a }))
    : [];
  const agents = before.map((a) => ({ ...a }));
  const idx = agents.findIndex((a) => a.slug.toLowerCase() === slug);

  if (action === "add") {
    if (idx >= 0) return refuse(409, "already_in_workspace", "That teammate is already in this workspace.");
    let displayName: string | null;
    if (isHouseAgentSlug(slug)) {
      // OASIS's own agents never join another workspace, whatever a request says.
      if (!oasis) return refuse(403, "house_agent_not_offered", "That agent is not available in this workspace.");
      displayName = getAgentInfo(slug).label;
    } else {
      try {
        displayName = await ownAgentName(tenantId, slug);
      } catch (err) {
        console.error("[agent_bindings.own_agent]", { tenantId, slug, error: err instanceof Error ? err.message : String(err) });
        return refuse(503, "agents_unavailable", "This workspace's teammates could not be read just now. Try again.");
      }
      if (!displayName) return refuse(400, "unknown_agent", "That teammate does not exist in this workspace.");
    }
    agents.push({ slug, display_name: displayName, enabled: true, core: false });
  } else {
    if (idx < 0) return refuse(404, "not_in_workspace", "That teammate is not in this workspace.");
    const current = agents[idx];
    if (action === "enable") {
      current.enabled = true;
    } else if (action === "disable") {
      if (current.core === true) return refuse(409, "core_locked", "Core teammates cannot be switched off.");
      current.enabled = false;
    } else {
      if (current.core === true) return refuse(409, "core_locked", "Core teammates cannot be removed.");
      agents.splice(idx, 1);
    }
  }

  const newManifest = { ...(manifest as Record<string, unknown>), agents };

  // Existing row: UPDATE the manifest column only (slug + id stay put).
  // Missing row: INSERT a new row with the resolved tenant slug + the
  // seed-derived manifest. UPSERT-via-on_conflict was the original approach,
  // but tenant_manifests.slug is NOT NULL and PostgREST's upsert path does
  // INSERT-first (would fail on slug NULL) even when the unique tenant_id
  // constraint would have matched. The two-path pattern is explicit and safe.
  const write = existingManifestId
    ? await db.from("tenant_manifests").update({ manifest: newManifest }).eq("id", existingManifestId)
    : await db.from("tenant_manifests").insert({ tenant_id: tenantId, slug: tenantSlug, manifest: newManifest });
  if (write.error) {
    console.error("[agent_bindings.write]", { tenantId, action, slug, error: write.error.message });
    return refuse(500, "manifest_write_failed", "The change could not be saved. Try again.");
  }

  // The roster's own name for it: after the change, or before it for a removal.
  const named = teammateFor(slug, { oasis, manifest: { agents: action === "remove" ? before : agents } })?.name || "the teammate";
  const message =
    action === "add" ? `Added ${named}` : action === "remove" ? `Removed ${named}` : action === "enable" ? `Enabled ${named}` : `Disabled ${named}`;
  return { ok: true, agents, message };
}
