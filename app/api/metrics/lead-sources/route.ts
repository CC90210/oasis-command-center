/**
 * GET /api/metrics/lead-sources — daily lead volume split by origination
 * channel (Text / Dial / Unknown) for the signed-in operator's tenant.
 *
 * This file is I/O only: auth, one bounded query, HTTP shape, observability.
 * All arithmetic lives in lib/metrics/lead-source-rollup.ts so it can be tested
 * without a database or a session (tests/lead-source-rollup.test.ts).
 *
 * FAILS LOUD, NOT EMPTY:
 *   A query error returns 502. It must NEVER fall through to a zero-filled
 *   body — an all-zero chart is indistinguishable from "no leads today" and
 *   would hide a broken data plane behind a plausible-looking dashboard. Same
 *   rule as the scan cap below: when coverage is partial, say so in the payload
 *   rather than letting the UI imply completeness.
 *
 * Query params:
 *   days — 1..90, default 30. Clamped, never rejected.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { resolveTenantId } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  clampDays,
  denseDayAxis,
  percentages,
  rollup,
  BUCKET_TZ,
  SCAN_CAP,
  type LeadRow,
} from "@/lib/metrics/lead-source-rollup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG = "[metrics.lead-sources]";

export async function GET(req: NextRequest) {
  const startedAt = Date.now();

  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const days = clampDays(req.nextUrl.searchParams.get("days"));

  // Widen the DB floor by one day: an ET bucket boundary sits up to 5h behind
  // UTC, so a strict `now - days` cutoff would clip the earliest ET day.
  // rollup() drops anything that lands outside the axis.
  const sinceIso = new Date(Date.now() - (days + 1) * 86_400_000).toISOString();

  const db = getServiceSupabase();
  const res = await db
    .from("tenant_records")
    .select("id, created_at, data")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "lead")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(SCAN_CAP);

  if (res.error) {
    // Fail loud. A zero-filled body here would render as a legitimate-looking
    // "no leads" dashboard and hide the outage completely.
    console.error(`${LOG} query_failed tenant=${tenantId} days=${days}`, res.error);
    return NextResponse.json(
      { ok: false, error: "query_failed", detail: res.error.message ?? "unknown" },
      { status: 502 },
    );
  }

  const rows = (res.data || []) as LeadRow[];
  const axis = denseDayAxis(days);
  const folded = rollup(rows, axis);

  const truncated = rows.length >= SCAN_CAP;
  if (truncated) {
    // No silent caps: name what was dropped, in the log AND in the payload.
    console.warn(
      `${LOG} scan_cap_hit tenant=${tenantId} days=${days} cap=${SCAN_CAP} — older days are UNDER-counted`,
    );
  }

  const durationMs = Date.now() - startedAt;
  console.info(
    `${LOG} ok tenant=${tenantId} days=${days} scanned=${rows.length} counted=${folded.counted} ` +
      `text=${folded.totals.text} dial=${folded.totals.dial} unknown=${folded.totals.unknown} ` +
      `undated=${folded.undated} truncated=${truncated} ms=${durationMs}`,
  );

  return NextResponse.json(
    {
      ok: true,
      range: { days, since: sinceIso, timezone: BUCKET_TZ, dates: axis },
      totals: { ...folded.totals, total: folded.counted },
      percentages: percentages(folded.totals, folded.counted),
      daily: folded.daily,
      meta: {
        scanned: rows.length,
        counted: folded.counted,
        undated: folded.undated,
        out_of_window: folded.outOfWindow,
        scan_cap: SCAN_CAP,
        // true => older days in this window are under-counted; the UI warns.
        truncated,
        generated_at: new Date().toISOString(),
        duration_ms: durationMs,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
