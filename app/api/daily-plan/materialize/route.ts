/**
 * POST /api/daily-plan/materialize — manual operator "reset today" path.
 *
 * Calls the FORCE variant of materialize_today_plan (migration 098) which
 * explicitly overwrites today's row from the latest plan_templates value.
 * Used when CC just edited a template and wants today's plan to pick up
 * the new structure right now instead of waiting for tomorrow's cron.
 *
 * The default materialize_today_plan RPC is idempotent (no-op if a row
 * exists) — that's the safe path used by the nightly cron. This endpoint
 * is the explicit clobber path; it WILL discard in-flight edits.
 */
import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { bad, profileForUser } from "@/lib/api-helpers";
import { operatorDateKey } from "@/lib/dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const profile = await profileForUser();
  if (!profile) return bad(401, "unauthorized");
  const today = operatorDateKey();
  const db = getServiceSupabase();
  const r = await db.rpc("force_materialize_today_plan", {
    p_profile_id: profile.id,
    p_target_date: today,
  });
  if (r.error) return bad(500, r.error.message);
  return NextResponse.json({ ok: true, plan_id: r.data });
}
