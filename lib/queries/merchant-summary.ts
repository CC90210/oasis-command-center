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

  // ==========================================================================
  // v2 columns — underwriting-sourced metrics surfaced from
  // application_underwriting.status='complete'. Populated when
  // SunBiz-Agent's underwriting_orchestrator daemon writes a complete row;
  // null until the first run finishes. See CEO-Agent migration 072.
  // ==========================================================================

  /** Underwriting agent's 0-100 suggestion. Not a binding decision. */
  readiness_score: number | null;

  /** Array of structured flags from the underwriting run. */
  risk_flags: Array<{
    level?: "info" | "warning" | "critical";
    code?: string;
    detail?: string;
  }> | null;

  /** Generated pitch copy from sales_angle.py. Shown in the Bank tab. */
  sales_angle: string | null;

  /** Average daily balance from parsed bank statements. */
  avg_daily_balance: number | null;

  /** Percentage of months with deposits above a tenant-set threshold. */
  deposit_consistency_pct: number | null;

  /** Monthly aggregate MCA payment burden (Adon §6 / §7). */
  debt_service_monthly: number | null;

  /** When the latest complete underwriting run finished. */
  last_underwriting_run_at: string | null;
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
 * Fetch a single merchant row by its tenant_records.id. tenant_id is
 * REQUIRED — the underlying client uses the service role which bypasses
 * RLS, so without an explicit tenant filter a caller from tenant A
 * passing a merchant_id from tenant B would receive the row. Always
 * pass the caller's tenant from the authed session (typically via
 * getActiveProfile()). Codex P1 finding 2026-05-28.
 *
 * Returns null when the merchant doesn't exist OR belongs to a
 * different tenant.
 */
export async function getMerchantSummaryRow(
  tenantId: string,
  merchantId: string,
): Promise<MerchantSummaryRow | null> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("merchant_summary")
    .select("*")
    .eq("tenant_id", tenantId)
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
 * stage-section render. Pre-initializes every DealStage key to an
 * empty array so callers can safely do `grouped['Funded'].length`
 * without a Partial-undefined check (consistency with
 * groupByMerchantStage below — Phase 1 self-review 2026-05-28).
 * Earlier Codex P2 said "either initialize all keys or return
 * Partial"; initializing is the more useful contract for the
 * Pipeline page's "render every stage even if empty" iteration.
 *
 * Rows with null deal_stage (merchant_stage='Lead' typically) are
 * not categorized — they're not in the pipeline yet.
 */
// ============================================================================
// Per-user "my active deals" — Phase 3 of the SunBiz multi-employee
// personalization plan (2026-05-29).
// ============================================================================
//
// Read tenant_records directly filtered by data->>'assigned_to' = current
// auth_user_id. Returns a leaner shape than MerchantSummaryRow because the
// widget renders compact cards (business name, stage, amount, updated_at)
// not the full merchant detail. Future enhancement: roll assigned_to into
// the merchant_summary view so both the global pipeline and the personal
// widget can share one query path.
//
// The field is data.assigned_to — set by /api/leads/[id]/assign (the
// drawer dropdown). Migration 077 (SunBiz-Agent) added the CHECK
// constraint forcing UUID shape and the partial index that backs this
// query. Anyone in the tenant CAN still act on the record regardless of
// whose assigned_to is set — this is presentation only.

export type MyAssignedRecord = {
  id: string;
  entity_type: "lead" | "application" | "funded_deal" | "renewal";
  business_name: string | null;
  stage: string | null;
  deal_stage: string | null;
  amount_requested: number | null;
  monthly_revenue: number | null;
  updated_at: string | null;
};

export async function getMyAssignedRecords(
  tenantId: string,
  userId: string,
  options?: { limit?: number },
): Promise<MyAssignedRecord[]> {
  if (!tenantId || !userId) return [];
  const db = getServiceSupabase();
  const limit = options?.limit ?? 30;

  // Direct read of tenant_records — the partial index added in migration
  // 077 means this is O(log n) on (tenant_id, assigned_to). Returns
  // applications and leads; funded_deal + renewal are out of scope for
  // the "active deals" widget (those have their own sections).
  const { data, error } = await db
    .from("tenant_records")
    .select("id, entity_type, data, updated_at")
    .eq("tenant_id", tenantId)
    .in("entity_type", ["lead", "application"])
    .filter("data->>assigned_to", "eq", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) {
    // Return empty rather than throwing — the dashboard renders an empty
    // widget state instead of crashing the whole page on a transient
    // query error. Real failures still surface in the server logs.
    console.error("[getMyAssignedRecords]", error);
    return [];
  }

  return ((data ?? []) as Array<{
    id: string;
    entity_type: string;
    data: Record<string, unknown>;
    updated_at: string | null;
  }>).map((row) => {
    const d = row.data || {};
    return {
      id: row.id,
      entity_type: row.entity_type as MyAssignedRecord["entity_type"],
      business_name: (d.business_name as string) || (d.dba as string) || null,
      stage: (d.stage as string) || null,
      deal_stage: (d.deal_stage as string) || null,
      amount_requested:
        typeof d.amount_requested === "number" ? d.amount_requested : null,
      monthly_revenue:
        typeof d.monthly_revenue === "number" ? d.monthly_revenue : null,
      updated_at: row.updated_at,
    };
  });
}


export function groupByDealStage(
  rows: MerchantSummaryRow[],
): Record<DealStage, MerchantSummaryRow[]> {
  const out: Record<DealStage, MerchantSummaryRow[]> = {
    "Application In": [],
    "Missing Info": [],
    "Shopping": [],
    "Approved": [],
    "Declined": [],
    "Funded": [],
    "Dead": [],
  };
  for (const r of rows) {
    if (!r.deal_stage) continue;
    out[r.deal_stage].push(r);
  }
  return out;
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
