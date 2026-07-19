/**
 * GET /api/automations/breeze-deals — the Breeze BD deal queue
 * (scrub_candidates) for the SunBiz Automations tab.
 *
 * Source of truth: public.scrub_candidates (SunBiz-Agent migration 081).
 * The VPS scrubber daemon (mca-lead-scrubber) writes pending_review rows
 * from Breeze UW Entry Sheets on the shared Drive; Ezra approves/denies in
 * Telegram (ezra-telegram-bridge). This route is READ-ONLY — the dashboard
 * shows the queue; approval stays in the Telegram bridge where the
 * inject_lead() path is proven.
 *
 * PII discipline: lead_data can carry EIN/contact/address (the table is
 * RLS-locked for exactly that reason — see 081). This route whitelists
 * display fields and NEVER ships raw lead_data to the browser.
 *
 * Auth: session tenant must resolve to the SunBiz profile ("sun" /
 * tenants.slug "submissions"); empire operators get access via the
 * slug-lookup escape hatch (same convention as lib/bridge-proxy.ts).
 *
 * Query params:
 *   status = pending_review | approved | declined | all   (default pending_review)
 *   limit  = 1..100                                        (default 25)
 */

import { NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { getTenant } from "@/lib/queries";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { isOperatorEmail } from "@/lib/operator-credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["pending_review", "approved", "declined"] as const;
type DealStatus = (typeof STATUSES)[number];

type CandidateRow = {
  id: string;
  status: string;
  tier: string;
  score: number;
  reasons: unknown;
  previously_submitted: boolean;
  leverage_pct: number | null;
  monthly_revenue: number | null;
  source_file: string | null;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_lead_id: string | null;
  lead_data: Record<string, unknown> | null;
};

/** Whitelisted, PII-free display shape. */
function toSafeDeal(row: CandidateRow) {
  const ld = row.lead_data || {};
  const pick = (k: string) => {
    const v = ld[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  // needs_lookup: live subs arrive 0-filled (no contact PII), so a promoted
  // deal is uncontactable until a phone is added. Surface it as a PII-FREE
  // boolean (presence only, never the number) so the operator queue can flag it
  // and offer a one-click fill. A "0"/"0000000000" placeholder counts as absent.
  const phoneRaw = typeof ld.phone === "string" ? ld.phone : ld.phone != null ? String(ld.phone) : "";
  const digits = phoneRaw.replace(/\D/g, "");
  const hasPhone = digits.length >= 10 && !/^0+$/.test(digits);
  return {
    id: row.id,
    status: row.status,
    tier: row.tier,
    score: row.score,
    reasons: Array.isArray(row.reasons)
      ? (row.reasons as unknown[]).filter((r) => typeof r === "string").slice(0, 8)
      : [],
    previously_submitted: row.previously_submitted,
    leverage_pct: row.leverage_pct,
    monthly_revenue: row.monthly_revenue,
    business_name:
      pick("business_name") || pick("business_legal_name") || pick("dba") || pick("company") || "(unnamed business)",
    iso_broker: pick("iso_broker"),
    source_file: row.source_file,
    created_at: row.created_at,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    created_lead_id: row.created_lead_id,
    needs_lookup: !hasPhone,
  };
}

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const db = getServiceSupabase();

  const profile = await db
    .from("user_profiles")
    .select("id, tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const sessionTenantId = (profile.data as { tenant_id: string | null } | null)?.tenant_id ?? null;
  if (!sessionTenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  // Resolve the SunBiz tenant. Sun operators use their own tenant; empire
  // operators fall through to the slug lookup (bridge-proxy convention).
  let dealsTenantId: string | null = null;
  const tenant = await getTenant(sessionTenantId);
  if (tenant && resolveClientProfileSlug(tenant) === "sun") {
    dealsTenantId = sessionTenantId;
  } else if (isOperatorEmail(user.email || undefined)) {
    const sun = await db
      .from("tenants")
      .select("id")
      .eq("slug", "submissions")
      .maybeSingle();
    dealsTenantId = (sun.data as { id: string } | null)?.id ?? null;
  }
  if (!dealsTenantId) {
    return NextResponse.json({ ok: false, error: "not_available_for_tenant" }, { status: 403 });
  }

  const url = new URL(req.url);
  const statusParam = (url.searchParams.get("status") || "pending_review").toLowerCase();
  const status: DealStatus | "all" = (STATUSES as readonly string[]).includes(statusParam)
    ? (statusParam as DealStatus)
    : "all";
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25));

  // Counts per status (head-only, exact) + the visible page, in parallel.
  const countQueries = STATUSES.map((s) =>
    db
      .from("scrub_candidates")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", dealsTenantId)
      .eq("status", s),
  );
  let dealsQuery = db
    .from("scrub_candidates")
    .select(
      "id, status, tier, score, reasons, previously_submitted, leverage_pct, monthly_revenue, source_file, created_at, reviewed_by, reviewed_at, created_lead_id, lead_data",
    )
    .eq("tenant_id", dealsTenantId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status !== "all") dealsQuery = dealsQuery.eq("status", status);

  const [pendingC, approvedC, declinedC, dealsRes] = await Promise.all([...countQueries, dealsQuery]);
  if (dealsRes.error) {
    return NextResponse.json({ ok: false, error: dealsRes.error.message }, { status: 500 });
  }

  const counts = {
    pending_review: pendingC.count ?? 0,
    approved: approvedC.count ?? 0,
    declined: declinedC.count ?? 0,
    total: (pendingC.count ?? 0) + (approvedC.count ?? 0) + (declinedC.count ?? 0),
  };

  return NextResponse.json({
    ok: true,
    counts,
    status,
    deals: ((dealsRes.data || []) as CandidateRow[]).map(toSafeDeal),
  });
}
