/**
 * Agent library loader — single entry point the marketplace + chat use.
 *
 * Lookup posture mirrors the manifest loader:
 *   1. Supabase `agents` first (so user customs + Phase 3.1 promoted
 *      platform agents win).
 *   2. In-code seeds (./library.ts) as the fallback so the marketplace is
 *      never empty even before the DB is seeded.
 *
 * Caching: per-request via React `cache()`. Server components calling
 *   getAgentBySlug("bravo") twice in one render hit the DB once.
 */

import { cache } from "react";
import { safe } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  SEED_AGENTS,
  getSeedAgent,
  type AgentCategory,
  type AgentLibraryEntry,
} from "./library";

type AgentRow = AgentLibraryEntry;

export type AgentListFilter = {
  /** Filter by category. If omitted, returns every category. */
  category?: AgentCategory;
  /** Filter by tenant for the "my custom agents" view. Falls through to public if null. */
  tenant_id?: string | null;
  /** Include user-created customs alongside platform seeds. Default true. */
  include_customs?: boolean;
};

async function fetchAgentRows(filter: AgentListFilter): Promise<AgentRow[]> {
  return safe(
    "agents.loader.list",
    (async () => {
      const db = getServiceSupabase();
      let q = db
        .from("agents")
        .select(
          "slug, name, category, short_description, description, base_prompt, required_tools, suggested_model, pricing, is_public, is_oasis_managed, created_by, tenant_id, created_at, updated_at"
        );
      if (filter.category) q = q.eq("category", filter.category);
      // Visibility — either public, or owned by the caller's tenant.
      if (filter.tenant_id) {
        q = q.or(`is_public.eq.true,tenant_id.eq.${filter.tenant_id}`);
      } else {
        q = q.eq("is_public", true);
      }
      const res = await q;
      return (res.data || []) as AgentRow[];
    })(),
    [] as AgentRow[]
  );
}

export const listAgents = cache(async (filter: AgentListFilter = {}): Promise<AgentLibraryEntry[]> => {
  const includeCustoms = filter.include_customs ?? true;
  const dbRows = includeCustoms ? await fetchAgentRows(filter) : [];
  const seedFiltered = filter.category
    ? SEED_AGENTS.filter((a) => a.category === filter.category)
    : SEED_AGENTS;

  // A DB row wins a slug collision with a seed only when OASIS manages it
  // (the Phase 3.1 promotion path); a workspace's row under a built-in slug is
  // dropped, the same rule as getAgentBySlug (2026-10-19 audit).
  const seedSlugs = new Set(SEED_AGENTS.map((a) => a.slug));
  const rows = dbRows.filter((r) => !seedSlugs.has(r.slug) || isOasisManaged(r));
  const dbSlugs = new Set(rows.map((r) => r.slug));
  const merged: AgentLibraryEntry[] = [
    ...rows,
    ...seedFiltered.filter((s) => !dbSlugs.has(s.slug)),
  ];

  // Stable sort: oasis-managed first (the "blessed" set the operator sees at
  // the top), then alphabetical by name. Within those, newer customs surface
  // ahead of older ones.
  return merged.sort((a, b) => {
    if (a.is_oasis_managed !== b.is_oasis_managed) return a.is_oasis_managed ? -1 : 1;
    if (a.is_oasis_managed) return a.name.localeCompare(b.name);
    return b.updated_at.localeCompare(a.updated_at);
  });
});

export const getAgentBySlug = cache(async (slug: string, tenantId?: string | null): Promise<AgentLibraryEntry | null> => {
  const key = (slug || "").trim().toLowerCase();
  if (!key) return null;
  const fromDb = await safe(
    "agents.loader.bySlug",
    (async () => {
      const db = getServiceSupabase();
      let q = db
        .from("agents")
        .select(
          "slug, name, category, short_description, description, base_prompt, required_tools, suggested_model, pricing, is_public, is_oasis_managed, created_by, tenant_id, created_at, updated_at"
        )
        .eq("slug", key);
      if (tenantId) {
        q = q.or(`is_public.eq.true,tenant_id.eq.${tenantId}`);
      } else {
        q = q.eq("is_public", true);
      }
      const res = await q.maybeSingle();
      return (res.data || null) as AgentRow | null;
    })(),
    null as AgentRow | null
  );
  const seed = getSeedAgent(key);
  // A built-in agent's slug belongs to OASIS. A database row stands in for it
  // only when OASIS manages that row; otherwise a workspace's public row under
  // "sdr" would replace the Sales agent in every workspace (2026-10-19 audit).
  // The persistence layer now refuses such slugs; this holds for any row
  // written before it did, or written around it.
  if (fromDb && (!seed || isOasisManaged(fromDb))) return fromDb;
  return seed;
});

function isOasisManaged(row: AgentRow): boolean {
  const v = (row as { is_oasis_managed?: unknown }).is_oasis_managed;
  return v === true || v === 1 || v === "1" || v === "true";
}

/** Cheap existence check — used by routes that need to 404 unknown slugs. */
export async function agentExists(slug: string, tenantId?: string | null): Promise<boolean> {
  const found = await getAgentBySlug(slug, tenantId);
  return !!found;
}
