/**
 * POST /api/applications/[id]/underwriting/run
 *
 * Enqueue a new underwriting run for one application. The
 * underwriting_orchestrator.py daemon picks up 'pending' rows within ~30s
 * and drives the statement_parser → debt_detector → sales_angle pipeline,
 * writing results back to application_underwriting.status='complete'.
 *
 * Body: { triggered_by?: 'manual' | 'automatic' | 'rerun' }   (default 'manual')
 *
 * Responses:
 *   201 { ok: true, run_id }              — row created, daemon will pick it up
 *   409 { ok: false, error: 'run_in_progress', existing_run_id }
 *       — a pending/parsing run already exists; wait or check /latest
 *   401 { ok: false, error: 'unauthorized' }
 *   404 { ok: false, error: 'application_not_found' }
 *
 * Phase 7.3 SunBiz CRM (second-meeting 2026-05-25).
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TriggeredBy = "manual" | "automatic" | "rerun";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const { tenantId, userId } = session;
  const { id: applicationId } = await ctx.params;

  let body: { triggered_by?: string } = {};
  try {
    body = (await req.json()) as { triggered_by?: string };
  } catch {
    // Body is optional — empty body is fine, we default to 'manual'.
  }

  const triggeredBy: TriggeredBy =
    body.triggered_by === "automatic" || body.triggered_by === "rerun"
      ? body.triggered_by
      : "manual";

  const db = getServiceSupabase();

  // Defense-in-depth: confirm application exists in this tenant before
  // inserting. Prevents a cross-tenant run enqueue via a guessed UUID.
  const appCheck = await db
    .from("tenant_records")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "application")
    .eq("id", applicationId)
    .maybeSingle();
  if (appCheck.error || !appCheck.data) {
    return NextResponse.json({ ok: false, error: "application_not_found" }, { status: 404 });
  }

  // 409 guard — don't double-fire if a run is already in flight.
  const inFlight = await db
    .from("application_underwriting")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("application_id", applicationId)
    .in("status", ["pending", "parsing"])
    .limit(1)
    .maybeSingle();
  if (inFlight.data) {
    return NextResponse.json(
      {
        ok: false,
        error: "run_in_progress",
        existing_run_id: (inFlight.data as { id: string }).id,
      },
      { status: 409 },
    );
  }

  // Insert the new underwriting run at status='pending'. The daemon polls
  // for rows in this state and begins processing within ~30s.
  const insert = await db
    .from("application_underwriting")
    .insert({
      tenant_id: tenantId,
      application_id: applicationId,
      status: "pending",
      triggered_by: triggeredBy,
      triggered_by_user_id: userId,
      run_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insert.error || !insert.data) {
    return NextResponse.json(
      { ok: false, error: insert.error?.message ?? "insert_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { ok: true, run_id: (insert.data as { id: string }).id },
    { status: 201 },
  );
}
