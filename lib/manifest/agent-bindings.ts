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
 *   enable   switches it on; a house agent is refused outside OASIS here too
 *            (a self-signup's wizard manifest can still bind one).
 *   disable  switches it off; refused for a core binding.
 *   remove   drops it; refused for a core binding, and for a binding that
 *            comes with the workspace's in-code seed.
 * Every message names the teammate the way the workspace's roster does
 * (lib/os/teammates.ts), never by a persona (S2-14).
 *
 * The write: a workspace with its own manifest (a tenant_manifests row, found
 * by tenant id) has it updated in place. A workspace that runs on an in-code
 * seed (OASIS has no row) stores only its own bindings, as a seed overlay
 * (lib/manifest/seed-overlay.ts): never a copy of the seed, which would stop
 * every later code change to the seed from reaching it (W4a review R2). A
 * workspace with neither has no lineup to change and is refused.
 *
 * The CALLER has already checked that the session may manage this workspace.
 */
import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getAgentInfo, isHouseAgentSlug } from "@/lib/agents";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
import { teammateFor } from "@/lib/os/teammates";
import type { ManifestAgentBinding } from "./schema";
import { applySeedOverlay, isSeedOverlay, overlaySeedFor, seedOverlayBody, seedOverlayOwnAgents } from "./seed-overlay";

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

  // The stored row, by tenant id.
  const existingRow = await db.from("tenant_manifests").select("id, manifest").eq("tenant_id", tenantId).maybeSingle();
  // A failed read is not "no row": writing over it would fork the lineup.
  if (existingRow.error) return refuse(503, "manifest_unavailable", "This workspace's teammates could not be read just now. Try again.");
  const existingManifestId = (existingRow.data as { id?: string } | null)?.id || null;
  const stored = (existingRow.data as { manifest?: unknown } | null)?.manifest || null;

  // A workspace with its own manifest changes it in place. One that runs on
  // an in-code seed (no row yet, or a seed overlay row) changes the seed's
  // lineup plus its own bindings, and stores only those bindings.
  const ownManifest = stored && !isSeedOverlay(stored) ? (stored as Record<string, unknown>) : null;
  const seed = ownManifest ? null : overlaySeedFor(tenantSlug, tenantId);
  if (!ownManifest && !seed) return refuse(409, "not_set_up", "This workspace has not been set up yet, so it has no teammates to change.");
  let manifest: Record<string, unknown>;
  if (ownManifest) {
    manifest = ownManifest;
  } else {
    try {
      manifest = applySeedOverlay(seed!, seedOverlayOwnAgents(stored)) as unknown as Record<string, unknown>;
    } catch (err) {
      console.error("[agent_bindings.overlay]", { tenantId, error: err instanceof Error ? err.message : String(err) });
      return refuse(500, "manifest_unreadable", "This workspace's teammates could not be read, so nothing was changed.");
    }
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
      // Switching one on is joining the workspace: the same rule as add.
      if (!oasis && isHouseAgentSlug(slug)) return refuse(403, "house_agent_not_offered", "That agent is not available in this workspace.");
      current.enabled = true;
    } else if (action === "disable") {
      if (current.core === true) return refuse(409, "core_locked", "Core teammates cannot be switched off.");
      current.enabled = false;
    } else {
      if (current.core === true) return refuse(409, "core_locked", "Core teammates cannot be removed.");
      // An overlay cannot take a seed binding away (it would come back on the
      // next read); switching it off is the reversible way.
      if (seed?.agents.some((a) => a.slug.toLowerCase() === slug)) {
        return refuse(409, "comes_with_setup", "This teammate comes with this workspace's setup. Switch it off instead.");
      }
      agents.splice(idx, 1);
    }
  }

  const newManifest = seed ? seedOverlayBody(seed, agents) : { ...(manifest as Record<string, unknown>), agents };

  // Existing row: UPDATE the manifest column only (slug + id stay put).
  // Missing row: INSERT a new row with the resolved tenant slug + the
  // overlay. UPSERT-via-on_conflict was the original approach,
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
