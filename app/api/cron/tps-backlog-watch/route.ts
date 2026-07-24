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
 * It alerts whenever the oldest pending job is past the threshold, and simply
 * runs on a coarse cadence (every 6h) so a sustained outage re-reminds without
 * spamming. This deliberately has NO "just crossed the threshold" window: a
 * window silently misses a backlog that was already stale at deploy time or when
 * a run is skipped — which is exactly the sustained outage the watchdog exists to
 * report (Codex 2026-07-24). A periodic re-alert during a real outage is useful,
 * not noise.
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
  const [oldestRes, countRes] = await Promise.all([
    db
      .from("phone_lookup_jobs")
      .select("created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    db.from("phone_lookup_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  // Fail closed: a query failure must NOT read as an empty, healthy backlog —
  // that would suppress the alert during the exact DB/permission outage the
  // watchdog should surface. Return an error instead of a false all-clear.
  if (oldestRes.error || countRes.error) {
    return NextResponse.json(
      { ok: false, error: `query_failed:${oldestRes.error?.message || countRes.error?.message}` },
      { status: 500 },
    );
  }

  const oldest = oldestRes.data;
  const pending = countRes.count ?? 0;
  if (!oldest?.created_at || pending === 0) {
    return NextResponse.json({ ok: true, pending: 0, alerted: false });
  }

  const ageH = (Date.now() - new Date(oldest.created_at).getTime()) / 3_600_000;
  if (ageH < THRESHOLD_H) {
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
