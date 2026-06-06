/**
 * POST /api/merchants/fuzzy-match
 *
 * Operator-facing fuzzy merchant matcher. Calls find_similar_merchants
 * RPC (migration 096) and returns ranked candidates. Used by:
 *
 *   - Import wizard "did you mean…?" panel during preview/confirm step
 *   - Leads drawer when an operator types a business name and we want
 *     to surface "this looks like an existing merchant"
 *   - The /api/forms/submit anonymous-init flow (future): on first
 *     submission, check if the prospect is already a known merchant
 *     and merge instead of creating a fresh lead
 *
 * Auth: session-cookie → tenant. Read-only RPC; no mutation possible
 * through this endpoint. Returns at most 10 matches at default
 * threshold 0.4.
 *
 * Body:
 *   {
 *     business_name: string,    // required, the search term
 *     state?: string,           // optional state filter
 *     threshold?: number,       // 0.0-1.0, default 0.4
 *     limit?: number            // default 10, max 25
 *   }
 *
 * Response: { ok: true, matches: FuzzyMerchantMatch[] }
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { findSimilarMerchants } from "@/lib/import/fuzzy-merchant-match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BUSINESS_NAME_LEN = 200;
const MAX_STATE_LEN = 80;
const MAX_LIMIT = 25;

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }

  // Same rate-limit shape the pair-code routes use — keeps the API
  // surface uniform. 30/min is fine for an operator typing in the
  // drawer; bot-scale fuzzy queries would surface here as 429s.
  const limit = rateLimit({
    key: `merchant-fuzzy:${sess.tenantId}:${getClientIp(req) || "unknown"}`,
    capacity: 30,
    refillPerSec: 0.5,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", retry_in_sec: limit.resetIn },
      { status: 429 },
    );
  }

  let body: {
    business_name?: unknown;
    state?: unknown;
    threshold?: unknown;
    limit?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const businessName =
    typeof body.business_name === "string" ? body.business_name.trim() : "";
  if (!businessName) {
    return NextResponse.json(
      { ok: false, error: "business_name_required" },
      { status: 400 },
    );
  }
  if (businessName.length > MAX_BUSINESS_NAME_LEN) {
    return NextResponse.json(
      { ok: false, error: "business_name_too_long", max: MAX_BUSINESS_NAME_LEN },
      { status: 400 },
    );
  }

  const state =
    typeof body.state === "string" && body.state.trim().length > 0
      ? body.state.trim().slice(0, MAX_STATE_LEN)
      : null;

  const threshold =
    typeof body.threshold === "number" && body.threshold >= 0 && body.threshold <= 1
      ? body.threshold
      : 0.4;
  const matchLimit =
    typeof body.limit === "number" && body.limit >= 1 && body.limit <= MAX_LIMIT
      ? Math.floor(body.limit)
      : 10;

  const db = getServiceSupabase();
  const matches = await findSimilarMerchants(db, sess.tenantId, businessName, {
    threshold,
    limit: matchLimit,
    state,
  });

  return NextResponse.json({ ok: true, matches });
}
