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
 * It alerts whenever the oldest pending job is past the threshold. This
 * deliberately has NO "just crossed the threshold" window: a window silently
 * misses a backlog that was already stale at deploy time or when a run is
 * skipped — which is exactly the sustained outage the watchdog exists to report
 * (Codex 2026-07-24). That property is intact — shouldAlert() is asked about the
 * condition as it stands, never about a transition, so the first observation of a
 * standing backlog always sends.
 *
 * DECAY ADDED 2026-08-03. The flat 6-hourly re-alert above was the theory; the
 * practice was ten straight days of identical messages into the shared OASIS
 * group while 21 Live Subs sat behind a workstation that was switched off. Every
 * one of them was true, and by day three they were wallpaper. Repeats now decay
 * 6h → 12h → 24h and reset after 72h quiet (lib/notify/alert-decay.ts), keyed on
 * the CONDITION — the live `~236.7h` age in the message body is what made every
 * previous suppression attempt useless, so it is not part of the identity.
 *
 * Auth: Bearer SCAN_TRIGGER_SECRET | CRON_SECRET.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { sendTelegram } from "@/lib/notify/telegram";
import { shouldAlert } from "@/lib/notify/alert-decay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const THRESHOLD_H = Number(process.env.TPS_BACKLOG_HOURS || 2);
const ALERT_KEY = "tps_backlog";
// Same constant the sibling SunBiz crons use (collect-outreach-intel, scan-bounces).
const TENANT_ID = process.env.TEXTTORRENT_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

/**
 * Coarse identity of the backlog condition. NOT the age and NOT the exact count:
 * both move on every run, and an identity that changes every run suppresses
 * nothing. Escalating past 20 stuck jobs is a materially worse problem, so that
 * crosses into a new signature and re-alerts immediately.
 */
function backlogSignature(stuck: number, running: number): string {
  const size = stuck >= 20 ? "severe" : stuck >= 5 ? "elevated" : "small";
  return `${ALERT_KEY}:${size}${running > 0 ? ":worker-crashed" : ""}`;
}

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

  // Decay gate. Read what we persisted last time, decide, and only then send.
  // A read failure must NOT silence the alert — suppression is never worth
  // swallowing a real outage, so a broken state row falls through to sending.
  const signature = backlogSignature(stuck, running);
  const { data: alertState } = await db
    .from("ops_alert_state")
    .select("condition_signature, last_alerted_at, repeat_n")
    .eq("tenant_id", TENANT_ID)
    .eq("alert_key", ALERT_KEY)
    .maybeSingle();

  const decision = shouldAlert(signature, {
    lastSignature: alertState?.condition_signature,
    lastAlertedAt: alertState?.last_alerted_at,
    repeatN: alertState?.repeat_n,
  });

  if (!decision.send) {
    return NextResponse.json({
      ok: true, pending, running, ageHours: Number(ageH.toFixed(1)),
      alerted: false, suppressed: true, nextWindowHours: decision.windowH,
    });
  }

  const stuckNote = running > 0 ? ` (${running} stuck mid-lookup — worker may have crashed)` : "";
  const msg =
    `⏳ <b>TPS enrichment backlog</b>\n` +
    `${stuck} Live Sub${stuck === 1 ? "" : "s"} waiting for a phone lookup${stuckNote} ` +
    `(oldest ~${ageH.toFixed(1)}h). The local scrape worker may be offline — ` +
    `check that the workstation is on and the APEX-TPS-Enricher task is running.`;

  // sendTelegram returns {ok, reason} — it does not throw. Faithful reporting:
  // surface a send failure rather than claiming we alerted.
  // sunbiz-ops: only Adon can act on this — it asks someone to go check that a
  // workstation is powered on and a scheduled task is running. Routing it to CC
  // is pure noise to him and silence to the one person who can fix it.
  const sent = await sendTelegram(msg, { lane: "sunbiz-ops" });
  if (!sent.ok) {
    return NextResponse.json(
      { ok: false, pending, running, ageHours: Number(ageH.toFixed(1)), error: `telegram_failed:${sent.reason}` },
      { status: 502 },
    );
  }
  // Record the send AFTER Telegram confirms. Stamping before would let a failed
  // send start a suppression window, and the next 6h tick would go quiet on an
  // alert that was never actually delivered.
  const { error: stateErr } = await db.from("ops_alert_state").upsert({
    tenant_id: TENANT_ID,
    alert_key: ALERT_KEY,
    condition_signature: signature,
    last_alerted_at: new Date().toISOString(),
    repeat_n: decision.nextRepeatN,
    updated_at: new Date().toISOString(),
  }, { onConflict: "tenant_id,alert_key" });

  return NextResponse.json({
    ok: true, pending, running, ageHours: Number(ageH.toFixed(1)),
    alerted: true, repeatN: decision.nextRepeatN, reason: decision.reason,
    // Surfaced, not swallowed: if the state write fails the alert still went out,
    // but suppression is now broken and the next tick will re-alert.
    ...(stateErr ? { stateWriteError: stateErr.message } : {}),
  });
}
