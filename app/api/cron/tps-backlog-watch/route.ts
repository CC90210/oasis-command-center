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

  // A backlog is BOTH pending jobs (worker offline, not claiming) AND stale
  // running jobs (worker crashed mid-scrape, leaving a row claimed forever). The
  // second is a real outage the pending-only check would miss — the job never
  // completes, the UI polls forever, and it is never retried. Age pending by
  // created_at, stale-running by claimed_at.
  const [oldestPendRes, pendCountRes, oldestRunRes, runCountRes] = await Promise.all([
    db.from("phone_lookup_jobs").select("created_at").eq("status", "pending")
      .order("created_at", { ascending: true }).limit(1).maybeSingle(),
    db.from("phone_lookup_jobs").select("id", { count: "exact", head: true }).eq("status", "pending"),
    db.from("phone_lookup_jobs").select("claimed_at").eq("status", "running")
      .order("claimed_at", { ascending: true }).limit(1).maybeSingle(),
    db.from("phone_lookup_jobs").select("id", { count: "exact", head: true }).eq("status", "running"),
  ]);

  // Fail closed: a query failure must NOT read as an empty, healthy backlog —
  // that would suppress the alert during the exact DB/permission outage the
  // watchdog should surface. Return an error instead of a false all-clear.
  const anyErr = oldestPendRes.error || pendCountRes.error || oldestRunRes.error || runCountRes.error;
  if (anyErr) {
    return NextResponse.json({ ok: false, error: `query_failed:${anyErr.message}` }, { status: 500 });
  }

  const pending = pendCountRes.count ?? 0;
  const running = runCountRes.count ?? 0;
  const stuck = pending + running;
  if (stuck === 0) {
    return NextResponse.json({ ok: true, pending: 0, running: 0, alerted: false });
  }

  // The most-aged waiting job, whether pending (created_at) or running (claimed_at).
  const pendAgeH = oldestPendRes.data?.created_at
    ? (Date.now() - new Date(oldestPendRes.data.created_at).getTime()) / 3_600_000 : 0;
  const runAgeH = oldestRunRes.data?.claimed_at
    ? (Date.now() - new Date(oldestRunRes.data.claimed_at).getTime()) / 3_600_000 : 0;
  const ageH = Math.max(pendAgeH, runAgeH);
  if (ageH < THRESHOLD_H) {
    return NextResponse.json({ ok: true, pending, running, ageHours: Number(ageH.toFixed(1)), alerted: false });
  }

  const stuckNote = running > 0 ? ` (${running} stuck mid-lookup — worker may have crashed)` : "";
  const msg =
    `⏳ <b>TPS enrichment backlog</b>\n` +
    `${stuck} Live Sub${stuck === 1 ? "" : "s"} waiting for a phone lookup${stuckNote} ` +
    `(oldest ~${ageH.toFixed(1)}h). The local scrape worker may be offline — ` +
    `check that the workstation is on and the APEX-TPS-Enricher task is running.`;

  // sendTelegram returns {ok, reason} — it does not throw. Faithful reporting:
  // surface a send failure rather than claiming we alerted.
  const sent = await sendTelegram(msg);
  if (!sent.ok) {
    return NextResponse.json(
      { ok: false, pending, running, ageHours: Number(ageH.toFixed(1)), error: `telegram_failed:${sent.reason}` },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, pending, running, ageHours: Number(ageH.toFixed(1)), alerted: true });
}
