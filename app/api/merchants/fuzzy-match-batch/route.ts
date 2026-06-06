/**
 * POST /api/merchants/fuzzy-match-batch
 *
 * Batch counterpart to /api/merchants/fuzzy-match. Takes a list of
 * {idx, business_name, state} tuples and returns the top matches per
 * tuple in one round-trip. Used by the import wizard's confirm step
 * to surface "potential merger" candidates against the tenant's
 * existing merchant book — single network call covers a whole CSV
 * preview, rather than the client making one call per row.
 *
 * Auth: session-cookie → tenant. Read-only RPC, no mutation possible.
 * Rate-limited per tenant + IP (10 batches/min — plenty for an
 * operator's import preview, but cuts off scraper-style abuse).
 *
 * Body:
 *   {
 *     rows: Array<{ idx: number, business_name: string, state?: string }>,
 *     threshold?: number,    // 0.0-1.0, default 0.4
 *     per_row_limit?: number // matches per row, default 5, max 10
 *   }
 *
 * Response:
 *   { ok: true, results: Array<{ idx: number, matches: FuzzyMerchantMatch[] }> }
 *
 * Rows with no business_name are returned as { idx, matches: [] }.
 * Max 50 rows per request; the wizard chunks larger CSVs.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { findSimilarMerchants } from "@/lib/import/fuzzy-merchant-match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_ROWS_PER_REQUEST = 50;
const MAX_PER_ROW = 10;

type IncomingRow = {
  idx?: unknown;
  business_name?: unknown;
  state?: unknown;
};

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }

  // Tighter rate limit than the single endpoint — each batch call
  // does up to MAX_ROWS_PER_REQUEST RPC invocations under the hood,
  // so abuse is amplified.
  const limit = rateLimit({
    key: `merchant-fuzzy-batch:${sess.tenantId}:${getClientIp(req) || "unknown"}`,
    capacity: 10,
    refillPerSec: 10 / 60,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", retry_in_sec: limit.resetIn },
      { status: 429 },
    );
  }

  let body: {
    rows?: unknown;
    threshold?: unknown;
    per_row_limit?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const incoming = Array.isArray(body.rows) ? (body.rows as IncomingRow[]) : [];
  if (incoming.length === 0) {
    return NextResponse.json({ ok: false, error: "no_rows" }, { status: 400 });
  }
  if (incoming.length > MAX_ROWS_PER_REQUEST) {
    return NextResponse.json(
      { ok: false, error: "too_many_rows", max: MAX_ROWS_PER_REQUEST },
      { status: 413 },
    );
  }

  const threshold =
    typeof body.threshold === "number" && body.threshold >= 0 && body.threshold <= 1
      ? body.threshold
      : 0.4;
  const perRowLimit =
    typeof body.per_row_limit === "number" &&
    body.per_row_limit >= 1 &&
    body.per_row_limit <= MAX_PER_ROW
      ? Math.floor(body.per_row_limit)
      : 5;

  // Validate + normalize the incoming rows. Any row without a valid
  // business_name returns matches:[] in its slot so the caller can
  // keep aligning by idx without special-casing.
  const tasks: Array<{ idx: number; biz: string | null; state: string | null }> = incoming.map(
    (row, i) => {
      const idx = typeof row.idx === "number" ? row.idx : i;
      const biz =
        typeof row.business_name === "string" && row.business_name.trim().length > 0
          ? row.business_name.trim().slice(0, 200)
          : null;
      const state =
        typeof row.state === "string" && row.state.trim().length > 0
          ? row.state.trim().slice(0, 80)
          : null;
      return { idx, biz, state };
    },
  );

  const db = getServiceSupabase();
  // RPC calls fan out concurrently — pg_trgm + GIN keeps each <5ms
  // even at million-row scale; 50 in parallel finishes well under
  // the 30s maxDuration.
  const results = await Promise.all(
    tasks.map(async (t) => {
      if (!t.biz) return { idx: t.idx, matches: [] };
      const matches = await findSimilarMerchants(db, sess.tenantId, t.biz, {
        threshold,
        limit: perRowLimit,
        state: t.state,
      });
      return { idx: t.idx, matches };
    }),
  );

  return NextResponse.json({ ok: true, results });
}
