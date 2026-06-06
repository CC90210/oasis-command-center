/**
 * fuzzy-merchant-match.ts — Build C wrapper for the find_similar_merchants RPC.
 *
 * The RPC lives in migration 096 (Business-Empire-Agent/database/) and
 * uses pg_trgm for typo-tolerant business-name matching. This file is
 * the dashboard-side TypeScript surface — typed result rows + a thin
 * helper that the import wizard, the leads drawer, and any future
 * server-side merchant linking calls.
 *
 * Why a wrapper file rather than inlining the supa.rpc() call: the
 * shape of the RPC result is non-trivial (8 columns) and the threshold
 * tuning is policy-bearing — keeping it in one place means UX
 * adjustments don't drift across surfaces.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type FuzzyMerchantMatch = {
  /** UUID of the matched tenant_records row. */
  record_id: string;
  /** "lead" | "application" | "funded_deal". */
  entity_type: string;
  /** The matched business name (legal_name → business_name → name fallback). */
  business_name: string;
  /** State code or full name as stored on the row. May be null. */
  state: string | null;
  /** pg_trgm similarity score, 0.0-1.0. Higher = better match. */
  similarity: number;
  /** EIN if known. Useful for "would you confirm this is the same entity?" UX. */
  ein: string | null;
  /** Email if known. */
  email: string | null;
  /** Phone if known. */
  phone: string | null;
};

export type FuzzyMatchOptions = {
  /** 0.0-1.0. Higher = stricter. Default 0.4 (typo-tolerant). */
  threshold?: number;
  /** Max rows returned. Default 10. */
  limit?: number;
  /** Optional state filter (2-letter code or full name). When supplied,
   *  matches are restricted to that state. Useful for the auto-merge
   *  UX in import — same business name in two states is two entities. */
  state?: string | null;
};

/** Threshold for surfacing a match as "definitely the same merchant"
 *  in auto-merge UX. Below this we surface as a "did you mean?"
 *  suggestion the operator must confirm. */
export const AUTO_MERGE_SIMILARITY = 0.85;

/** Threshold below which we don't surface matches at all — they're
 *  too uncertain to be useful and would create noise. */
export const SUGGESTION_FLOOR_SIMILARITY = 0.4;

/**
 * Find merchants in the tenant that look similar to the incoming
 * business name. Returns ranked results from the find_similar_merchants
 * RPC.
 *
 * On RPC failure returns an empty array — the caller decides whether
 * to surface that to the operator. The import wizard treats no
 * matches as "this is a brand-new merchant," which is the safe
 * interpretation regardless of cause (genuine new merchant OR fuzzy
 * lookup temporarily unavailable).
 */
export async function findSimilarMerchants(
  db: SupabaseClient,
  tenantId: string,
  businessName: string,
  options: FuzzyMatchOptions = {},
): Promise<FuzzyMerchantMatch[]> {
  const cleaned = businessName.trim();
  if (!cleaned) return [];
  const threshold = options.threshold ?? SUGGESTION_FLOOR_SIMILARITY;
  const limit = options.limit ?? 10;
  const state = options.state?.trim() || null;

  const res = await db.rpc("find_similar_merchants", {
    p_tenant_id: tenantId,
    p_business_name: cleaned,
    p_state: state,
    p_threshold: threshold,
    p_limit: limit,
  });
  if (res.error || !res.data) return [];
  return (res.data as FuzzyMerchantMatch[]).map((r) => ({
    ...r,
    // Postgres returns similarity as a string in some clients; force
    // numeric so the auto-merge threshold comparison works.
    similarity: typeof r.similarity === "string" ? Number(r.similarity) : r.similarity,
  }));
}

/** Classification helper — the UI uses this to pick which affordance
 *  to render (no-op / auto-merge confirmation / picker list). */
export function classifyMatches(matches: FuzzyMerchantMatch[]): {
  best: FuzzyMerchantMatch | null;
  shouldAutoMerge: boolean;
  hasSuggestions: boolean;
} {
  const best = matches[0] || null;
  const shouldAutoMerge =
    !!best && best.similarity >= AUTO_MERGE_SIMILARITY;
  const hasSuggestions = matches.length > 0;
  return { best, shouldAutoMerge, hasSuggestions };
}
