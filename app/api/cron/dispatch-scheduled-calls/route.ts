/**
 * GET+POST /api/cron/dispatch-scheduled-calls — advances due rows in
 * scheduled_calls (database/115_scheduled_calls.sql). Vercel cron, every 5 min
 * (vercel.json), cron-secret authed (lib/cron-auth.ts).
 *
 * Unlike dispatch-scheduled-sends, a booked call is not auto-placed to a merchant
 * — the rep makes the call. This cron only transitions STATE so the Calls tab is
 * accurate: it stamps `reminded_at` on calls that just came due (the tab surfaces
 * those as "due now"), and marks long-overdue still-pending calls as 'missed'.
 * (Auto-dial via the Kixie alley-oop + a real rep push are follow-on phases.)
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MISSED_AFTER_HOURS = 6;

async function handle(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const db = getServiceSupabase();
  const now = new Date();
  const nowIso = now.toISOString();

  // 1. Stamp reminded_at on calls that just came due (Calls tab highlights these).
  const due = await db
    .from("scheduled_calls")
    .update({ reminded_at: nowIso })
    .eq("status", "pending")
    .is("reminded_at", null)
    .lte("scheduled_for", nowIso)
    .select("id");

  // 2. Mark long-overdue, still-pending calls as missed.
  const missedCutoff = new Date(now.getTime() - MISSED_AFTER_HOURS * 3600_000).toISOString();
  const missed = await db
    .from("scheduled_calls")
    .update({ status: "missed" })
    .eq("status", "pending")
    .lt("scheduled_for", missedCutoff)
    .select("id");

  return NextResponse.json({
    ok: true,
    reminded: due.data?.length ?? 0,
    missed: missed.data?.length ?? 0,
  });
}

export const GET = handle;
export const POST = handle;
