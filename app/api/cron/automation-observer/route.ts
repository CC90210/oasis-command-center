import { NextResponse, type NextRequest } from "next/server";
import { checkAutomationObserverAuth } from "@/lib/automation-observer-auth";
import { getTursoClient } from "@/lib/turso";
import { WEBDEV_TENANT_ID } from "@/lib/oasis-tenant";
import { isObserverPagingTick, observeAutomations, observerChecks } from "@/lib/health/automation-observer";
import { runHealthChecks } from "@/lib/health/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Dedicated observer Worker calls this; the business cron driver never does. */
export async function GET(req: NextRequest) {
  const denied = checkAutomationObserverAuth(req);
  if (denied) return denied;
  const now = Date.now();
  const tick = new Date(Math.floor(now / 60_000) * 60_000).toISOString();
  try {
    const db = getTursoClient();
    const claimed = await db.execute({ sql: "INSERT OR IGNORE INTO automation_observer_ticks(tenant_id,tick_at) VALUES (?,?)", args: [WEBDEV_TENANT_ID, tick] });
    if (!claimed.rowsAffected) {
      const prior = await db.execute({ sql: "SELECT completed_at,verdict FROM automation_observer_ticks WHERE tenant_id=? AND tick_at=?", args: [WEBDEV_TENANT_ID, tick] });
      const complete = Boolean(prior.rows[0]?.completed_at);
      const ok = complete && prior.rows[0]?.verdict !== "delivery_failed";
      return NextResponse.json({ ok, status: complete ? "observed" : "awaiting_result", worst: prior.rows[0]?.verdict }, { status: ok ? 200 : 503 });
    }
    const findings = await observeAutomations(db, WEBDEV_TENANT_ID, now);
    const independentDelivery = req.headers.get("x-oasis-observer-delivery");
    findings.push({ id: "automation.independent_observer_delivery",
      observed: ["sending", "refused", "permanent_failure", "delivery_unknown"].includes(independentDelivery ?? "") ? 1 : ["none", "delivered"].includes(independentDelivery ?? "") ? 0 : null,
      reason: independentDelivery === "delivery_unknown" || independentDelivery === "sending"
        ? "Independent observer alert acknowledgment is unknown; its durable incident remains open for reconciliation."
        : independentDelivery === "permanent_failure" ? "Independent observer alert delivery needs connection repair and explicit incident reconciliation; automatic retries are stopped."
          : independentDelivery === "refused" ? "Independent observer alert was rate limited; provider backoff remains pending."
          : "Independent observer delivery state was supplied by the authenticated worker." });
    // Every minute is observed and persisted; only the quarter-hour sample may page
    // (see isObserverPagingTick). notify:false records the run without touching the
    // alert ladder, exactly as the daily digest's non-paging run does.
    const summary = await runHealthChecks(WEBDEV_TENANT_ID, {
      nowMs: now, notify: isObserverPagingTick(Date.parse(tick)), checks: observerChecks(findings),
    });
    const deliveryUnverified = findings.some((f) => f.id === "automation.health_alert_delivery" && f.observed !== 0);
    const ok = summary.failedAlerts === 0 && !deliveryUnverified;
    await db.execute({ sql: "UPDATE automation_observer_ticks SET completed_at=?,verdict=? WHERE tenant_id=? AND tick_at=?", args: [new Date().toISOString(), ok ? summary.worst : "delivery_failed", WEBDEV_TENANT_ID, tick] });
    await db.execute({ sql: "DELETE FROM automation_observer_ticks WHERE tenant_id=? AND tick_at<?", args: [WEBDEV_TENANT_ID, new Date(now - 7 * 86_400_000).toISOString()] });
    // Minute observations are bounded operational telemetry. Keep two weeks,
    // prune a small batch, and preserve every incident/outbox/RSVP state row.
    // Every check's runs, not only the observer's own: the other checks' rows were never pruned and
    // reached 117,405 for this workspace (2026-11-14), past the 100,000-row cap of the daily automation
    // snapshot (BEA scripts/state/automation_backup.py), which failed from 11-09. Seven days keeps the
    // table near 60,000 at the current rate; the streaks live in health_alert_state. 2,000 a tick clears
    // the backlog within a day.
    await db.execute({ sql: "DELETE FROM health_check_runs WHERE tenant_id=? AND id IN (SELECT id FROM health_check_runs WHERE tenant_id=? AND ran_at<? LIMIT 2000)", args: [WEBDEV_TENANT_ID, WEBDEV_TENANT_ID, new Date(now - 7 * 86_400_000).toISOString()] });
    // Business failures are persisted and alerted by the health runner. The
    // independent Worker's incident is about THIS observer being unavailable.
    return NextResponse.json({ ok, status: "observed", worst: summary.worst, findings, failed_alerts: summary.failedAlerts }, { status: ok ? 200 : 503 });
  } catch {
    return NextResponse.json({ ok: false, status: "unverified", reason: "observer_storage_or_runtime_unavailable" }, { status: 503 });
  }
}
