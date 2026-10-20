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
import { dbBool } from "@/lib/db-bool";
import { OASIS_OPERATOR_TENANT_ID } from "@/lib/platform-operator";
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
      return ((res.data || []) as AgentRow[]).filter((r) => {
        if (servedTo(r, filter.tenant_id)) return true;
        logDrop(r, "another workspace's public row");
        return false;
      });
    })(),
    [] as AgentRow[]
  );
}

/**
 * A row this workspace may load: its own, or one OASIS stands behind (managed,
 * or published from OASIS's own workspace). Only a platform operator can
 * publish now (lib/agents/persistence.ts), so a client workspace's public row
 * is one written before that rule, or around it: it stays in its own
 * workspace and never reaches another one's library, chat or department turns
 * (independent review of #713).
 */
function servedTo(row: AgentRow, tenantId: string | null | undefined): boolean {
  if (tenantId && row.tenant_id === tenantId) return true;
  return isOasisManaged(row) || row.tenant_id === OASIS_OPERATOR_TENANT_ID;
}

/** Each workspace row that a built-in slug or the visibility rule drops is logged once per process. */
const loggedDrops = new Set<string>();
function logDrop(row: AgentRow, why: string): void {
  const key = `${row.slug}|${why}`;
  if (loggedDrops.has(key)) return;
  loggedDrops.add(key);
  console.warn("[agents.loader] a workspace's agent row is not served", { slug: row.slug, tenant_id: row.tenant_id, why });
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
  const rows = dbRows.filter((r) => {
    if (!seedSlugs.has(r.slug) || isOasisManaged(r)) return true;
    logDrop(r, "a built-in agent's slug");
    return false;
  });
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
      const row = (res.data || null) as AgentRow | null;
      if (row && !servedTo(row, tenantId)) {
        logDrop(row, "another workspace's public row");
        return null;
      }
      return row;
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
  if (fromDb) logDrop(fromDb, "a built-in agent's slug");
  return seed;
});

/** The flag as every other reader takes it (lib/db-bool.ts): true, 1 or "1". */
function isOasisManaged(row: AgentRow): boolean {
  return dbBool((row as { is_oasis_managed?: unknown }).is_oasis_managed);
}

/** Cheap existence check — used by routes that need to 404 unknown slugs. */
export async function agentExists(slug: string, tenantId?: string | null): Promise<boolean> {
  const found = await getAgentBySlug(slug, tenantId);
  return !!found;
}
