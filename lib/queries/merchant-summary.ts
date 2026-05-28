/**
 * Typed wrappers around the `merchant_summary` Postgres view (migration
 * 066). One row per merchant in a tenant, projecting JSONB fields from
 * tenant_records into the wide columnar shape Adon Yess's SunBiz
 * Pipeline frontend bundle expects.
 *
 * Contract source: docs/handoffs/sunbiz-pipeline-2026-05-18 (the design
 * bundle) plus cc-pipeline-handoff.md §1. The view IS the contract — if
 * Adon's bundle needs a new column, add it to migration 066 first, then
 * extend the type below to match. Type drift between this file and the
 * view is the single most common breakage mode for the dashboard.
 *
 * RLS: the view inherits RLS from base tables, so every query through
 * here is automatically tenant-scoped via the session user's tenant_id.
 * Service-role callers see all tenants — server-side only.
 */

import { getServiceSupabase } from "@/lib/supabase-server";

// ============================================================================
// Type — one row per merchant
// ============================================================================
//
// Field-by-field alignment with the columns in migration 066. Mark
// nullables explicitly so the frontend can do safe `??` fallbacks.

export type MerchantStage = "Lead" | "Active" | "Funded" | "Dormant";

export type DealStage =
  | "Application In"
  | "Missing Info"
  | "Shopping"
  | "Approved"
  | "Declined"
  | "Funded"
  | "Dead";

export type MerchantSummaryRow = {
  // Identity
  merchant_id: string;
  tenant_id: string;
  dba: string | null;
  legal_name: string | null;
  state: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  industry: string | null;
  ein: string | null;
  tib_years: number | null;

  // Owner (usually null until JARVIS underwriting populates)
  owner_name: string | null;
  owner_title: string | null;
  ownership_pct: number | null;
  owner_dob: string | null;
  owner_citizenship: string | null;
  ssn_last4: string | null;
  credit_score: number | null;

  // Addresses
  physical_line1: string | null;
  physical_line2: string | null;
  physical_city: string | null;
  physical_state: string | null;
  physical_zip: string | null;
  physical_years_at: number | null;
  home_line1: string | null;
  home_city: string | null;
  home_state: string | null;
  home_zip: string | null;
  home_years_at: number | null;

  // Agent (assignee)
  agent: string | null;
  agent_initials: string | null;
  agent_color: string | null;

  // Stage model (ADR-0006)
  merchant_stage: MerchantStage;
  // deal_stage may be null when the merchant has no application yet
  // (merchant_stage='Lead').
  deal_stage: DealStage | null;
  days_in_stage: number;
  sla_overdue_days: number;

  // Risk flags
  is_hot: boolean;
  is_shopped_stale: boolean;
  is_cold: boolean;
  is_renewal_candidate: boolean;
  is_high_leverage: boolean;

  // Deal economics
  paper_grade: "A" | "B" | "C" | "D" | "JUNK" | null;
  leverage_ratio: number | null;
  avg_monthly_revenue: number | null;
  nsf_avg_per_month: number | null;
  position_count: number;
  funding_potential_usd: number | null;
  current_funded_amount: number | null;
  submitted_at: string | null;
  last_touch_at: string | null;
  last_sms_at: string | null;
  last_email_at: string | null;

  // Lender shop counts
  shop_sent_count: number;
  shop_replied_count: number;
  shop_offer_count: number;
  shop_declined_count: number;
  shop_pending_count: number;
  shop_info_requested_count: number;
  shop_no_response_count: number;
  last_lender_response_at: string | null;
  best_offer_amount: number | null;

  // Priority scoring
  priority_score: number;
  priority_reason: string | null;

  // Metadata
  created_at: string;
  updated_at: string;
  active_application_id: string | null;
};

// ============================================================================
// Query functions
// ============================================================================

/**
 * Fetches the full merchant_summary list for a tenant. Server-side
 * callers should pass the tenant_id explicitly (cheap belt-and-braces
 * — the view also enforces RLS, but explicit scoping makes the query
 * cacheable and predictable in EXPLAIN ANALYZE).
 *
 * Default order: priority_score DESC so the most-urgent merchants
 * surface first. Pass `orderBy: 'updated_at'` to override.
 */
export async function getMerchantSummary(
  tenantId: string,
  options?: {
    orderBy?: "priority_score" | "updated_at" | "created_at";
    limit?: number;
  },
): Promise<MerchantSummaryRow[]> {
  const db = getServiceSupabase();
  const orderBy = options?.orderBy ?? "priority_score";
  const ascending = orderBy === "priority_score" ? false : false; // both DESC
  const limit = options?.limit ?? 1000;

  const { data, error } = await db
    .from("merchant_summary")
    .select("*")
    .eq("tenant_id", tenantId)
    .order(orderBy, { ascending })
    .limit(limit);

  if (error) {
    // Distinguish "view not yet applied" from real errors so the dashboard
    // can render a useful empty-state instead of a crash during the
    // rollout window before migration 066 is run.
    if (error.code === "42P01" || /merchant_summary/i.test(error.message)) {
      return [];
    }
    throw error;
  }
  return (data ?? []) as MerchantSummaryRow[];
}

/**
 * Fetch a single merchant row by its tenant_records.id. Returns null
 * when no such merchant exists (or RLS blocks the read).
 */
export async function getMerchantSummaryRow(
  merchantId: string,
): Promise<MerchantSummaryRow | null> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("merchant_summary")
    .select("*")
    .eq("merchant_id", merchantId)
    .maybeSingle();

  if (error) {
    if (error.code === "42P01" || /merchant_summary/i.test(error.message)) {
      return null;
    }
    throw error;
  }
  return (data as MerchantSummaryRow | null) ?? null;
}

/**
 * Group rows by deal_stage for the Pipeline page's collapsible
 * stage-section render. Empty groups omitted — the frontend handles
 * "show all stages even if empty" via its own stage-list constant.
 */
export function groupByDealStage(
  rows: MerchantSummaryRow[],
): Record<DealStage, MerchantSummaryRow[]> {
  const out: Record<string, MerchantSummaryRow[]> = {};
  for (const r of rows) {
    if (!r.deal_stage) continue;
    if (!out[r.deal_stage]) out[r.deal_stage] = [];
    out[r.deal_stage]!.push(r);
  }
  return out as Record<DealStage, MerchantSummaryRow[]>;
}

/**
 * Group rows by merchant_stage for the dashboard counts strip
 * (Lead / Active / Funded / Dormant tiles).
 */
export function groupByMerchantStage(
  rows: MerchantSummaryRow[],
): Record<MerchantStage, MerchantSummaryRow[]> {
  const out: Record<string, MerchantSummaryRow[]> = {
    Lead: [],
    Active: [],
    Funded: [],
    Dormant: [],
  };
  for (const r of rows) {
    out[r.merchant_stage]!.push(r);
  }
  return out as Record<MerchantStage, MerchantSummaryRow[]>;
}
