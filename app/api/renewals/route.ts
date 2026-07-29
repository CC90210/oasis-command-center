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
  lead_id?: unknown;
  merchant_name?: unknown;
  contact_name?: unknown;
  lender_name?: unknown;
  funded_amount_usd?: unknown;
  factor_rate?: unknown;
  term_months?: unknown;
  points_pct?: unknown;
  funded_at?: unknown;
  notes?: unknown;
  /** Set by the form's second submit to accept a flagged possible duplicate. */
  confirm_duplicate?: unknown;
};

type LeadData = Record<string, unknown>;

function firstText(data: LeadData, keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Searchable lead directory for the intake picker. Tenant is session-derived. */
export async function GET(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!sess.tenantId) return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });

  const query = (req.nextUrl.searchParams.get("q") || "").trim().toLowerCase().slice(0, 100);
  const db = getServiceSupabase();
  const result = await db
    .from("tenant_records")
    .select("id, data, updated_at")
    .eq("tenant_id", sess.tenantId)
    .eq("entity_type", "lead")
    .order("updated_at", { ascending: false })
    .limit(250);

  if (result.error) {
    console.error("[renewals] lead search failed:", result.error.message);
    return NextResponse.json({ ok: false, error: "search_failed" }, { status: 500 });
  }

  const leads = (result.data || [])
    .map((row) => {
      const data = (row.data || {}) as LeadData;
      return {
        id: row.id as string,
        business_name: firstText(data, ["business_name", "legal_name", "company_name", "name"]) || "Unnamed lead",
        contact_name: firstText(data, ["contact_name", "owner_name", "full_name"]),
        phone: firstText(data, ["phone", "phone_number", "mobile"]),
        email: firstText(data, ["email", "email_address"]),
      };
    })
    .filter((lead) => {
      if (!query) return true;
      return [lead.business_name, lead.contact_name, lead.phone, lead.email]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query));
    })
    .slice(0, 25);

  return NextResponse.json({ ok: true, leads });
}

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

/**
 * A real calendar date, not merely a well-shaped one.
 *
 * Date.parse NORMALISES rather than rejects: "2026-02-30" becomes March 2. That
 * would sail past a shape check, then Postgres would reject the original value
 * and the caller would get a 500 instead of the field-level 400 this route
 * promises. Round-tripping the components is what catches it.
 */
function isRealYmd(s: string): boolean {
  if (!YMD_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Read an optional numeric field, keeping "absent" and "present but unparsable"
 * distinct so the latter can be rejected instead of silently dropped.
 */
function optionalNum(v: unknown): { provided: boolean; value: number | null } {
  const absent = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  if (absent) return { provided: false, value: null };
  return { provided: true, value: num(v) };
}

/**
 * One shape for "this looks like a deal you already recorded", whether it came
 * from the friendly pre-check or from the unique index winning a race. The
 * client keys off `error` to arm its next submit.
 */
function duplicateResponse(existing: { id: string | null; lender_name: string | null }) {
  return NextResponse.json(
    {
      ok: false,
      error: "possible_duplicate",
      message:
        "A funded deal for this merchant on this date is already recorded" +
        `${existing.lender_name ? ` (${existing.lender_name})` : ""}. ` +
        "Submit again to record it anyway.",
      existing,
    },
    { status: 409 },
  );
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

  const lead_id = typeof body.lead_id === "string" ? body.lead_id.trim() : "";
  if (!lead_id) {
    return NextResponse.json(
      { ok: false, error: "validation_failed", errors: { lead_id: "Select a lead first." } },
      { status: 400 },
    );
  }

  const db = getServiceSupabase();
  const leadResult = await db
    .from("tenant_records")
    .select("id, data")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "lead")
    .eq("id", lead_id)
    .maybeSingle();
  if (leadResult.error || !leadResult.data) {
    return NextResponse.json(
      { ok: false, error: "invalid_lead", errors: { lead_id: "That lead was not found in this workspace." } },
      { status: 400 },
    );
  }
  const leadData = (leadResult.data.data || {}) as LeadData;

  // ── validate ───────────────────────────────────────────────────────────────
  const errors: Record<string, string> = {};

  const merchant_name =
    text(body.merchant_name, 200) ||
    firstText(leadData, ["business_name", "legal_name", "company_name", "name"]);
  if (!merchant_name) errors.merchant_name = "Merchant or deal name is required.";

  const funded_amount_usd = num(body.funded_amount_usd);
  if (funded_amount_usd === null) errors.funded_amount_usd = "Amount funded is required.";
  else if (funded_amount_usd <= 0) errors.funded_amount_usd = "Amount funded must be greater than zero.";
  else if (funded_amount_usd > 100_000_000) errors.funded_amount_usd = "Amount funded looks too large.";

  const funded_at = typeof body.funded_at === "string" && isRealYmd(body.funded_at.trim())
    ? body.funded_at.trim()
    : null;
  if (!funded_at) errors.funded_at = "Funded date is required, as a real calendar date (YYYY-MM-DD).";

  // Optional, but validated when PRESENT — the DB has matching CHECKs, and a
  // clear field-level message beats a raw constraint violation.
  //
  // `provided` distinguishes "left blank" from "typed something unparsable".
  // Without it, term_months: "abc" parses to null, looks identical to omitted,
  // and the request quietly succeeds having thrown the operator's input away —
  // leaving no renewal date on a deal they thought they had dated.
  const term = optionalNum(body.term_months);
  const term_months = term.value;
  if (term.provided && term_months === null) errors.term_months = "Term must be a number of months.";
  else if (term_months !== null && (!Number.isInteger(term_months) || term_months < 1 || term_months > 60)) {
    errors.term_months = "Term must be a whole number of months, 1 to 60.";
  }

  const factor = optionalNum(body.factor_rate);
  const factor_rate = factor.value;
  if (factor.provided && factor_rate === null) errors.factor_rate = "Factor rate must be a number.";
  else if (factor_rate !== null && (factor_rate < 1.0 || factor_rate > 2.0)) {
    errors.factor_rate = "Factor rate should be between 1.0 and 2.0 (e.g. 1.35).";
  }

  const points = optionalNum(body.points_pct);
  const points_pct = points.value;
  if (points.provided && points_pct === null) errors.points_pct = "Points must be a number.";
  else if (points_pct !== null && (points_pct < 0 || points_pct > 100)) {
    errors.points_pct = "Points must be between 0 and 100.";
  }

  if (Object.keys(errors).length) {
    return NextResponse.json({ ok: false, error: "validation_failed", errors }, { status: 400 });
  }

  // ── derive the two fields the operator does NOT type ───────────────────────
  const next_renewal_date = nextRenewalDate(funded_at, term_months);
  const est_commission_usd = estCommissionUsd(funded_amount_usd, points_pct);

  // ── duplicate guard ────────────────────────────────────────────────────────
  //
  // A double-click or a retry after a timeout would otherwise create a second
  // funded deal, which does not merely clutter the list — it double-counts the
  // commission in the Renewals summary tiles and puts two renewal rows on one
  // deal.
  //
  // The DATABASE is what actually prevents it, via the partial unique index on
  // (tenant_id, dedupe_key) in migration 131. A route-level select-then-insert
  // cannot: two concurrent submissions both finish their lookup before either
  // insert, and both rows land. The lookup below is kept only to produce a
  // helpful message ("already recorded, funded by X") — the index is the
  // guarantee, and the 23505 handler after the insert is what closes the race.
  //
  // confirm_duplicate writes a NULL dedupe_key. NULLs never conflict in a unique
  // index, so a genuine second funding on the same day by a different funder is
  // still recordable — no hard constraint on real data, no race on accidents.
  const confirmed = body.confirm_duplicate === true;
  const dedupe_key = confirmed
    ? null
    : `${merchant_name!.toLowerCase()}|${funded_at}|${funded_amount_usd}`;

  if (!confirmed) {
    const dupe = await db
      .from("funded_deals")
      .select("id, merchant_name, funded_at, funded_amount_usd, lender_name")
      .eq("tenant_id", tenantId)
      .ilike("merchant_name", merchant_name as string)
      .eq("funded_at", funded_at as string)
      .limit(1);
    const existing = dupe.data?.[0] as { id: string; lender_name: string | null } | undefined;
    if (!dupe.error && existing) return duplicateResponse(existing);
    // A failed lookup is NOT a reason to block the write — it only costs a
    // friendlier message, and the unique index still holds the line.
  }

  const ins = await db
    .from("funded_deals")
    .insert({
      tenant_id: tenantId,
      lead_id,
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
      dedupe_key,
    })
    .select("id, merchant_name, funded_at, next_renewal_date, est_commission_usd")
    .single();

  if (ins.error || !ins.data) {
    // 23505 = unique violation on uq_funded_deals_dedupe. This is the branch the
    // pre-check cannot cover: a concurrent identical submission that got there
    // first. Same confirmable answer, so a racing double-click reads as "already
    // recorded" rather than a 500.
    if (ins.error?.code === "23505") {
      return duplicateResponse({ id: null, lender_name: null });
    }
    console.error("[renewals] insert failed:", ins.error?.message);
    return NextResponse.json(
      { ok: false, error: "insert_failed", message: ins.error?.message || "Could not save the funded deal." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, deal: ins.data }, { status: 201 });
}
