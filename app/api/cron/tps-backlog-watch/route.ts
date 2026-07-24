/**
 * GET /api/cron/tps-backlog-watch — alert when Live Subs pile up unenriched.
 *
 * The local scrape worker is the only thing that can drain phone_lookup_jobs (it
 * needs the residential/interactive context). If Adon's workstation is off, jobs
 * queue safely but silently. This watchdog makes that visible: if the oldest
 * pending job has aged past a threshold, it Telegram-alerts once per episode.
 *
 * The alert is also the trigger signal for whether the Phase-2 VPS + residential
 * proxy fallback is actually needed.
 *
 * De-dupe WITHOUT a marker table: alert only in the cron-interval-wide window
 * right after the oldest job first crosses the threshold. On later runs the same
 * backlog's oldest job is already past the window, so it does not re-fire.
 *
 * Auth: Bearer SCAN_TRIGGER_SECRET | CRON_SECRET.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { sendTelegram } from "@/lib/notify/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const THRESHOLD_H = Number(process.env.TPS_BACKLOG_HOURS || 2);
/** The cron cadence in hours — the de-dupe window width. Keep in sync with the
 * schedule in vercel.json. */
const INTERVAL_H = Number(process.env.TPS_BACKLOG_INTERVAL_H || 2);

function checkAuth(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer) return false;
  for (const secret of [process.env.SCAN_TRIGGER_SECRET, process.env.CRON_SECRET]) {
    if (!secret) continue;
    const a = Buffer.from(bearer);
    const b = Buffer.from(secret);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const db = getServiceSupabase();

  // Oldest pending job + total pending count.
  const [{ data: oldest }, { count }] = await Promise.all([
    db
      .from("phone_lookup_jobs")
      .select("created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    db.from("phone_lookup_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  const pending = count ?? 0;
  if (!oldest?.created_at || pending === 0) {
    return NextResponse.json({ ok: true, pending: 0, alerted: false });
  }

  const ageH = (Date.now() - new Date(oldest.created_at).getTime()) / 3_600_000;
  const justCrossed = ageH >= THRESHOLD_H && ageH < THRESHOLD_H + INTERVAL_H;

  if (!justCrossed) {
    return NextResponse.json({ ok: true, pending, ageHours: Number(ageH.toFixed(1)), alerted: false });
  }

  const msg =
    `⏳ <b>TPS enrichment backlog</b>\n` +
    `${pending} Live Sub${pending === 1 ? "" : "s"} waiting for a phone lookup ` +
    `(oldest ~${ageH.toFixed(1)}h). The local scrape worker may be offline — ` +
    `check that the workstation is on and the APEX-TPS-Enricher task is running.`;

  // sendTelegram returns {ok, reason} — it does not throw. Faithful reporting:
  // surface a send failure rather than claiming we alerted.
  const sent = await sendTelegram(msg);
  if (!sent.ok) {
    return NextResponse.json(
      { ok: false, pending, ageHours: Number(ageH.toFixed(1)), error: `telegram_failed:${sent.reason}` },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, pending, ageHours: Number(ageH.toFixed(1)), alerted: true });
}
