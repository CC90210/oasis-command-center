/**
 * Manifest loader — single async entry point the layout and routes call to
 * resolve "what's this tenant's Command Center supposed to look like."
 *
 * Lookup order:
 *   1. Supabase `tenant_manifests` row keyed by slug (Phase 1b on once
 *      migration 038 is applied; until then this call returns null fast).
 *   2. In-code seed manifests in ./seeds.ts (OASIS, SUGA). A slug with no row
 *      and no seed gets UNPROVISIONED_SEED, the empty "being set up"
 *      workspace, never OASIS's own (see getSeedManifest). The retired SunBiz
 *      seed ("sun") is gone (2026-10-01, OS plan W0), so manifestExists("sun")
 *      is false and /t/sun/* answers the not-found page like every unknown slug.
 *
 * The loader NEVER throws. Invalid stored manifests (malformed JSON, schema
 * drift) log via safe() and fall back to seeds, so a bad row in DB can't
 * 500 the whole shell. The audit log captures the failure for follow-up.
 *
 * Caching: Next.js Server Components already de-dupe identical fetches within
 * a single render. We additionally memoize per-request via a Map so multiple
 * server components in the same request share one parse + DB hit.
 */

import { cache } from "react";
import { safe } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import type { NavItem } from "@/lib/nav-config";
import { safeParseManifest, type ManifestNavItem, type TenantManifest, primaryAgent } from "./schema";
import { getSeedManifest, SEED_MANIFESTS } from "./seeds";

type ManifestRow = {
  slug: string;
  manifest: unknown;
  version: number;
  updated_at: string;
};

async function fetchManifestFromSupabase(slug: string): Promise<TenantManifest | null> {
  return safe(
    "manifest.loader.supabase",
    (async () => {
      const db = getServiceSupabase();
      const result = await db
        .from("tenant_manifests")
        .select("slug, manifest, version, updated_at")
        .eq("slug", slug)
        .maybeSingle();
      const row = (result.data || null) as ManifestRow | null;
      if (!row?.manifest) return null;
      const parsed = safeParseManifest(row.manifest);
      if (!parsed.ok) {
        // Don't throw — log via the wrapper, fall back to seed. Surface the
        // parse error path so the audit log makes the failure searchable.
        console.warn(
          `[manifest.loader] stored manifest for slug="${slug}" failed validation: ${parsed.error.message}`
        );
        return null;
      }
      return parsed.manifest;
    })(),
    null as TenantManifest | null
  );
}

/**
 * `viewerTenantId` is optional and only reaches the seed fallback: pass the
 * SESSION tenant id where the caller has it, so an OASIS viewer whose slug did
 * not resolve (null slug → "default") still gets OASIS's seed. Without it,
 * "default" and "oasis" fail closed to UNPROVISIONED_SEED like any unknown
 * slug. A primitive, not an options object, so React's cache() still dedupes.
 */
export const getManifest = cache(async (
  slug: string | null | undefined,
  viewerTenantId?: string | null,
): Promise<TenantManifest> => {
  const key = (slug || "").trim().toLowerCase() || "default";
  const fromDb = await fetchManifestFromSupabase(key);
  if (fromDb) return fromDb;
  return getSeedManifest(key, viewerTenantId);
});

/**
 * The manifest a workspace owns, found by its tenant id.
 *
 * WHY THIS EXISTS (2026-09-30). getManifest looks rows up by SLUG, and the
 * onboarding wizard saves a manifest under the slug the owner typed
 * ("nodeops-control-center"), not the workspace's own tenants.slug
 * ("malikfaysalawan"). Invite finalization asked getManifest for the workspace
 * slug, missed the row, got UNPROVISIONED_SEED (no agents) and threw, so every
 * teammate invite into a client workspace died with profile_finalize_failed.
 * tenant_manifests.tenant_id is UNIQUE (tenant_manifests_tenant_id_key), so a
 * workspace has at most one row and this answers "which manifest is theirs".
 *
 * Unlike getManifest this does NOT hide failures behind a seed:
 *   - no row                         -> null (the caller decides the fallback)
 *   - a stored body that fails to parse -> null, logged (same as getManifest)
 *   - a failed read                  -> throws, because "could not tell" is not
 *                                       "has no manifest"; invite redemption
 *                                       refuses rather than claim the invite.
 */
export async function getManifestByTenantId(
  tenantId: string,
  db: Pick<ReturnType<typeof getServiceSupabase>, "from"> = getServiceSupabase(),
): Promise<TenantManifest | null> {
  const id = (tenantId || "").trim();
  if (!id) return null;
  const result = await db
    .from("tenant_manifests")
    .select("slug, manifest")
    .eq("tenant_id", id)
    .maybeSingle();
  if (result.error) {
    throw new Error(`manifest_by_tenant_lookup_failed: ${result.error.message}`);
  }
  const row = (result.data || null) as { slug: string; manifest: unknown } | null;
  if (!row?.manifest) return null;
  const parsed = safeParseManifest(row.manifest);
  if (!parsed.ok) {
    console.warn(
      `[manifest.loader] stored manifest for tenant="${id}" (slug="${row.slug}") failed validation: ${parsed.error.message}`
    );
    return null;
  }
  return parsed.manifest;
}

/**
 * Adapter — convert a manifest nav array (snake_case, source-of-truth) into
 * the existing Sidebar's NavItem shape (lowerCamelCase).
 *
 * Each tenant's `Agents` nav item (built into every template) is the SINGLE
 * entry point to the agent surface — it renders a chat page that picks
 * which enabled agent to talk to from a dropdown. Earlier versions of this
 * adapter auto-injected one sidebar slot per enabled agent ("Bravo"
 * "Atlas" "Maven" listed beneath the rest of the nav), which produced
 * REDUNDANCY with the Agents page and was confusing for clients. Removed.
 *
 * If the operator wants individual agents pinned to the sidebar, they
 * can add explicit nav items via the AI manifest editor.
 */
export function manifestNavToNavItems(items: ManifestNavItem[]): NavItem[] {
  return items.map((item) => ({
    href: item.href,
    label: item.label,
    icon: item.icon,
    group: item.group,
    badgeKey: item.badge_key,
    expandable: item.expandable,
  }));
}

/**
 * True when a slug exists in either the in-code seeds or the
 * tenant_manifests table. Used by routes that need to 404 for genuinely
 * unknown tenants (vs. getManifest, which answers them with
 * UNPROVISIONED_SEED).
 */
export async function manifestExists(slug: string | null | undefined): Promise<boolean> {
  const key = (slug || "").trim().toLowerCase();
  if (!key) return false;
  if (SEED_MANIFESTS[key]) return true;
  const row = await safe(
    "manifest.loader.exists",
    (async () => {
      const db = getServiceSupabase();
      const result = await db
        .from("tenant_manifests")
        .select("slug")
        .eq("slug", key)
        .maybeSingle();
      return !!result.data;
    })(),
    false
  );
  return row;
}

/** Sidebar logo prop is a closed enum. "custom" manifests fall back to "oasis". */
export function manifestLogoToSidebarLogo(
  logo: TenantManifest["brand"]["logo"]
): "oasis" | "sunbiz" | "suga" {
  if (logo === "sunbiz" || logo === "suga" || logo === "oasis") return logo;
  return "oasis";
}

/**
 * Pull the slug that drives a tenant's manifest. Returns null when the
 * manifest declares no agents — caller decides the right fallback for
 * its surface. Hardcoded "bravo" fallback was removed: on a SunBiz
 * tenant manifest mid-edit (or any tenant whose agents list temporarily
 * empties) the previous code returned CC's primary agent slug as
 * though it belonged to that tenant, which is a cross-tenant label
 * leak on per-tenant surfaces.
 */
export function manifestPrimaryAgentSlug(m: TenantManifest): string | null {
  return primaryAgent(m)?.slug ?? null;
}

