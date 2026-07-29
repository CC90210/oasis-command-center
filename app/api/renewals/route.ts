/**
 * /api/renewals — manual funded-deal entry, and the list behind the Renewals tab.
 *
 * POST creates a funded_deals row from what an operator types after a deal
 * funds: merchant, amount funded, term, rate, points. It does NOT accept a
 * renewal date or a commission figure — both are DERIVED here (lib/renewals/
 * derive.ts) so nobody has to remember to keep them current and two identical
 * deals can never disagree about when they come up.
 *
 * This is phase 1. Phase 2 reads funding confirmations out of submissions@ using
 * the same IMAP + classifier pipeline as the lender-reply scanner and pre-fills
 * a draft for one-click confirm. Manual entry stays regardless — it is the
 * fallback whenever the email is ambiguous or absent.
 *
 * Authorization: session + canWriteCrm, checked BEFORE any lookup so a
 * read_only caller cannot use the response to probe what exists. Tenant comes
 * from the session, never from the body.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canWriteCrm } from "@/lib/role-gates";
import { nextRenewalDate, estCommissionUsd } from "@/lib/renewals/derive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

type Body = {
  merchant_name?: unknown;
  contact_name?: unknown;
  lender_name?: unknown;
  funded_amount_usd?: unknown;
  factor_rate?: unknown;
  term_months?: unknown;
  points_pct?: unknown;
  funded_at?: unknown;
  notes?: unknown;
};

/** Trim + bound a free-text field, or null when empty. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Accept a number or a numeric string, since the form posts strings and an
 * operator may well type "85,000" or "$85,000".
 */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // Role checked first, before touching the database, so a read_only caller
  // gets an identical 403 regardless of what exists (no enumeration oracle).
  if (!canWriteCrm(sess.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_role", message: "Read-only members can't record funded deals." },
      { status: 403 },
    );
  }
  const tenantId = sess.tenantId;
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  // ── validate ───────────────────────────────────────────────────────────────
  const errors: Record<string, string> = {};

  const merchant_name = text(body.merchant_name, 200);
  if (!merchant_name) errors.merchant_name = "Merchant or deal name is required.";

  const funded_amount_usd = num(body.funded_amount_usd);
  if (funded_amount_usd === null) errors.funded_amount_usd = "Amount funded is required.";
  else if (funded_amount_usd <= 0) errors.funded_amount_usd = "Amount funded must be greater than zero.";
  else if (funded_amount_usd > 100_000_000) errors.funded_amount_usd = "Amount funded looks too large.";

  const funded_at = typeof body.funded_at === "string" && YMD_RE.test(body.funded_at.trim())
    ? body.funded_at.trim()
    : null;
  if (!funded_at) errors.funded_at = "Funded date is required (YYYY-MM-DD).";
  else if (Number.isNaN(Date.parse(`${funded_at}T00:00:00Z`))) errors.funded_at = "Funded date is not a real date.";

  // Optional, but validated when present — the DB has matching CHECKs, and a
  // clear field-level message beats a raw constraint violation.
  const term_months = body.term_months === undefined || body.term_months === null || body.term_months === ""
    ? null : num(body.term_months);
  if (term_months !== null && (!Number.isInteger(term_months) || term_months < 1 || term_months > 60)) {
    errors.term_months = "Term must be a whole number of months, 1 to 60.";
  }

  const factor_rate = body.factor_rate === undefined || body.factor_rate === null || body.factor_rate === ""
    ? null : num(body.factor_rate);
  if (factor_rate !== null && (factor_rate < 1.0 || factor_rate > 2.0)) {
    errors.factor_rate = "Factor rate should be between 1.0 and 2.0 (e.g. 1.35).";
  }

  const points_pct = body.points_pct === undefined || body.points_pct === null || body.points_pct === ""
    ? null : num(body.points_pct);
  if (points_pct !== null && (points_pct < 0 || points_pct > 100)) {
    errors.points_pct = "Points must be between 0 and 100.";
  }

  if (Object.keys(errors).length) {
    return NextResponse.json({ ok: false, error: "validation_failed", errors }, { status: 400 });
  }

  // ── derive the two fields the operator does NOT type ───────────────────────
  const next_renewal_date = nextRenewalDate(funded_at, term_months);
  const est_commission_usd = estCommissionUsd(funded_amount_usd, points_pct);

  const db = getServiceSupabase();
  const ins = await db
    .from("funded_deals")
    .insert({
      tenant_id: tenantId,
      merchant_name,
      contact_name: text(body.contact_name, 200),
      lender_name: text(body.lender_name, 200),
      funded_amount_usd,
      factor_rate,
      term_months,
      points_pct,
      funded_at,
      next_renewal_date,
      est_commission_usd,
      notes: text(body.notes, 2000),
      source: "manual_entry",
      created_by: sess.userId ?? null,
    })
    .select("id, merchant_name, funded_at, next_renewal_date, est_commission_usd")
    .single();

  if (ins.error || !ins.data) {
    console.error("[renewals] insert failed:", ins.error?.message);
    return NextResponse.json(
      { ok: false, error: "insert_failed", message: ins.error?.message || "Could not save the funded deal." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, deal: ins.data }, { status: 201 });
}
