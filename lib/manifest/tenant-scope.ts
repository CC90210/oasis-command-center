/**
 * Single source of truth for "which tenant_id should scope records for
 * this manifest slug + this caller?"
 *
 * The rule that all three call sites (the tenant-root page renderer,
 * the catch-all page renderer, and the records API) MUST agree on:
 *
 *   - If the manifest has a DB row whose tenant_id matches the
 *     caller's tenant_id → grant data access. This is the operator's
 *     legitimately-claimed slug (created via the onboarding wizard).
 *
 *   - If no DB row exists (code-seed manifest like the platform's
 *     "default" / "oasis" / "sun" / "suga") AND the caller's home
 *     tenant_slug matches this URL slug → grant data access. Covers
 *     legacy pre-wizard tenants that map via tenants.custom_fields.
 *
 *   - Otherwise → null. Preview mode for page renderers; 403 for
 *     write APIs. Prevents:
 *       a) cross-shell data bleed (records of tenant X rendering
 *          inside the shell of slug Y);
 *       b) cross-tenant writes (POST /api/manifest/<slug-not-yours>/
 *          records/<entity> writing into the caller's records under
 *          someone else's manifest namespace).
 *
 * One DB hop on the happy path (getManifestRow); two on the fallback
 * path (also getTenant). Acceptable cost for the correctness guarantee.
 */

import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getTenant } from "@/lib/queries";
import { chatAgentKeys } from "@/lib/agent-personas";
import { getManifest } from "./loader";
import { getManifestRow, getManifestSlugForTenant } from "./persistence";

/**
 * Resolve the tenant_id that should scope tenant_records reads/writes
 * for `slug`, called by `userTenantId`. Returns null when the caller
 * doesn't own the slug — primitives render preview mode, write APIs
 * should return 403.
 */
export async function resolveDataTenant(
  slug: string,
  userTenantId: string | null
): Promise<string | null> {
  if (!userTenantId) return null;
  const row = await getManifestRow(slug).catch(() => null);
  if (row?.tenant_id && row.tenant_id === userTenantId) return userTenantId;
  if (!row) {
    const tenant = await getTenant(userTenantId).catch(() => null);
    const userSlug = resolveClientProfileSlug(tenant || null);
    if (userSlug && userSlug.toLowerCase() === slug.toLowerCase()) {
      return userTenantId;
    }
  }
  return null;
}

/**
 * The inverse of resolveDataTenant: "which slug does THIS caller own?"
 *
 * Pages that render a write surface (ManifestRecordForm, LeadPipelineView)
 * must send a slug the records API will accept, or every save 403s with
 * slug_not_owned. Hardcoding one — /pipeline shipped `tenantSlug="oasis"` —
 * breaks the moment the real tenant is slugged anything else, which every
 * OASIS workspace is (oasis-ai-cc, oasis-webdev). The seed manifest keyed
 * "oasis" let the request past manifestExists() and straight into the
 * ownership gate, so the failure surfaced as a permission error on a lead
 * the operator plainly owns.
 *
 * Both branches below return a value resolveDataTenant grants on:
 *   1. the tenant's own manifest row slug → matches on row.tenant_id;
 *   2. resolveClientProfileSlug(tenant) → matches the no-row fallback.
 * Client and server therefore cannot disagree about the namespace.
 *
 * Returns null when there's no tenant or no resolvable slug — callers
 * render read-only rather than shipping a slug that is going to 403.
 */
export async function resolveOwnedSlug(
  userTenantId: string | null
): Promise<string | null> {
  if (!userTenantId) return null;
  const claimed = await getManifestSlugForTenant(userTenantId).catch(() => null);
  if (claimed) return claimed;
  const tenant = await getTenant(userTenantId).catch(() => null);
  return resolveClientProfileSlug(tenant || null);
}

/** True when the caller owns the slug (data access granted). */
export async function ownsSlug(
  slug: string,
  userTenantId: string | null
): Promise<boolean> {
  return (await resolveDataTenant(slug, userTenantId)) !== null;
}

/**
 * Resolve the full manifest for the tenant the caller belongs to. Returns
 * null when there's no tenant, no resolvable slug, or the manifest load
 * fails. Used by pages that need both the enabled-agent list AND other
 * manifest fields (primary agent, compliance posture, brand etc.) so we
 * don't pay two DB hops for the same data.
 */
export async function getTenantManifestForUser(
  userTenantId: string | null
): Promise<import("./schema").TenantManifest | null> {
  if (!userTenantId) return null;
  try {
    const tenant = await getTenant(userTenantId);
    if (!tenant) return null;
    const slug = resolveClientProfileSlug(tenant);
    if (!slug) return null;
    return await getManifest(slug);
  } catch {
    return null;
  }
}

/**
 * Resolve the agents a tenant has enabled via their manifest. Returns
 * lowercased slugs of `manifest.agents[].enabled === true`. Returns []
 * when the tenant has no manifest, no enabled agents, or the lookup
 * fails — callers pick the right fallback (FAMILY_AGENT_KEYS, ["bravo"],
 * ALL_AGENT_KEYS, or an empty list with messaging) based on display intent.
 *
 * Single source of truth for the "which agents does THIS tenant care
 * about?" question. Replaces three identical ~10-line resolve-manifest-
 * then-pluck-enabled blocks in /reasoning, /agents, and /operations.
 */
export async function getTenantEnabledAgents(
  userTenantId: string | null
): Promise<string[]> {
  const manifest = await getTenantManifestForUser(userTenantId);
  if (!manifest) return [];
  return (manifest.agents || [])
    .filter((a) => a.enabled)
    .map((a) => a.slug.toLowerCase());
}

/**
 * Single source of truth for "which agents should THIS user surface in
 * dashboards / heartbeats / event filters?" — replaces the 5+ duplicated
 * "manifest first, profile second, hardcoded last" chains scattered across
 * /agent, /agents, /integrations, /reasoning, /operations, /feed.
 *
 * Returns an array of lowercased agent slugs. NEVER falls back to a global
 * default like ["bravo"] or FAMILY_AGENT_KEYS — cross-tenant data leaks
 * traced to those defaults firing for users whose manifest + profile were
 * both empty (fresh invitees, broken backfills). Callers that need a
 * "last resort" should render an empty-state UI, not silently surface
 * empire-wide agents.
 *
 * Order of precedence:
 *   1. tenant_manifests.manifest.agents.filter(enabled) — the canonical
 *      "what this tenant has" list.
 *   2. user_profiles.agents_enabled — legacy per-user override (kept for
 *      back-compat with tenants that haven't fully migrated to manifest).
 *   3. empty array — caller decides what empty means.
 *
 * Operator-bypass: when isOperator is true the caller can do its own
 * full-fleet read (e.g. CC's /agents page showing every empire agent).
 * The helper does NOT apply the bypass itself — keeps the contract pure
 * so non-operator code paths can't accidentally inherit it.
 */
export async function getTenantAwareEnabledAgents(args: {
  userTenantId: string | null;
  profileAgentsEnabled?: string[] | null;
}): Promise<string[]> {
  const manifestSlugs = await getTenantEnabledAgents(args.userTenantId);
  if (manifestSlugs.length > 0) return manifestSlugs;
  const profileSlugs = (args.profileAgentsEnabled || [])
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  return profileSlugs;
}


/**
 * The set of agent slugs THIS tenant is allowed to chat with — the union of
 * (a) their manifest's enabled agents (covers custom slugs like
 * "renewal_specialist" that the operator added through the manifest editor
 * but are not in the empire-wide AGENT_REGISTRY), and (b) the empire-wide
 * chat-agent list (so OASIS operators keep family-agent access even when
 * their manifest is sparse, e.g. mid-onboarding).
 *
 * Used by /api/chat, /api/chat/resume, /api/agent-config, /api/agent-config/
 * bulk-provider to validate the operator's `agent_key`. Before this helper,
 * those routes called `chatAgentKeys()` directly and rejected any slug not
 * in AGENT_REGISTRY — manifest-declared custom agents rendered in the chat
 * picker but 400'd on first send. Codex review finding #2 (2026-05-22).
 */
export async function getTenantChatAgentKeys(
  userTenantId: string | null
): Promise<string[]> {
  const manifestAgents = await getTenantEnabledAgents(userTenantId);
  const empireAgents = chatAgentKeys();
  return Array.from(new Set([...manifestAgents, ...empireAgents]));
}

/** True when `agentKey` is a chat target this tenant is allowed to use. */
export async function isTenantChatAgent(
  userTenantId: string | null,
  agentKey: string,
): Promise<boolean> {
  const allowed = await getTenantChatAgentKeys(userTenantId);
  return allowed.includes(agentKey.toLowerCase());
}
