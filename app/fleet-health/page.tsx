/**
 * /fleet-health — the global, cross-tenant feature-health dashboard.
 *
 * Distinct from the two pages that already exist, on purpose:
 *   /health        — tenant-scoped operator view (errors, stuck threads, stalled leads)
 *   /system-health — guard-stack and agent-state view
 *   /fleet-health  — THIS: every monitored feature, scored, across all tenants
 *
 * Server-rendered and dynamic. Reads the status rollup directly (service role)
 * after enforcing the admin gate, which is the same gate /api/health/global
 * uses — the client component never fetches privileged data itself.
 *
 * THE STALENESS BANNER IS LOAD-BEARING. A monitor whose scanner has died shows
 * a confidently green wall of last week's data, which is worse than no
 * dashboard at all. If the heartbeat is old, that is the headline, and every
 * score below it is labelled history rather than status.
 */
import { PageHeader, Card } from "@/components/Card";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { FeatureHealthGrid, type HealthCheckRow } from "@/components/health/FeatureHealthGrid";
import { AlertTriangle, Activity, ShieldAlert } from "lucide-react";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const STALE_AFTER_MS = 45 * 60_000;

export default async function FleetHealthPage() {
  // Fail closed: an unresolvable session is not an authorized one.
  // SessionContext is a discriminated union: narrow on `ok` before reading
  // isAdmin, so a failed session resolution can never read as authorized.
  const ctx = await resolveSessionContext();
  if (!ctx.ok || !ctx.isAdmin) redirect("/");

  const db = getServiceSupabase();

  const [{ data: checks }, { data: statuses }, { data: heartbeat }] = await Promise.all([
    db
      .from("feature_health_checks")
      .select("check_key, feature, surface, severity, notes")
      .eq("enabled", true),
    db
      .from("feature_health_status")
      .select("check_key, score, status, breakdown, error, consecutive_bad, last_ok_at, last_bad_at, observed_at"),
    db
      .from("health_alert_state")
      .select("last_alert_at, last_text")
      .eq("condition_key", "monitor:scan_heartbeat")
      .maybeSingle<{ last_alert_at: string; last_text: string }>(),
  ]);

  const statusByKey = new Map<string, unknown>(
    ((statuses || []) as Record<string, unknown>[]).map((s) => [s.check_key as string, s]),
  );
  const rows: HealthCheckRow[] = ((checks || []) as Record<string, unknown>[]).map((c) => ({
    check_key: c.check_key as string,
    feature: c.feature as string,
    surface: c.surface as string,
    severity: c.severity as string,
    notes: (c.notes as string) ?? null,
    status: (statusByKey.get(c.check_key as string) as HealthCheckRow["status"]) ?? null,
  }));

  const lastScanAt = heartbeat?.last_alert_at ? new Date(heartbeat.last_alert_at) : null;
  const monitorStale = !lastScanAt || Date.now() - lastScanAt.getTime() > STALE_AFTER_MS;

  const down = rows.filter((r) => r.status?.status === "down").length;
  const degraded = rows.filter((r) => r.status?.status === "degraded").length;
  const unknown = rows.filter((r) => !r.status || r.status.status === "unknown").length;
  const healthy = rows.filter((r) => r.status?.status === "healthy").length;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Fleet health"
        subtitle="Every monitored feature, scored on uptime, errors, latency and outcome. Outcome is weighted highest because 'the process is up' was true throughout every outage this exists to catch."
      />

      {monitorStale && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 flex gap-3"
        >
          <ShieldAlert className="w-5 h-5 shrink-0 text-rose-500" aria-hidden />
          <div className="text-sm">
            <p className="font-semibold text-rose-600 dark:text-rose-400">
              The scanner is not running.
            </p>
            <p className="text-fg-muted mt-1">
              {lastScanAt
                ? `Last scan ${lastScanAt.toISOString()}. `
                : "No scan has ever been recorded. "}
              Every score below is history, not current status. Check the{" "}
              <code className="font-mono text-xs">/api/cron/health-scan</code> cron before trusting
              this page.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        {[
          { label: "Down", value: down, cls: "text-rose-500", Icon: AlertTriangle },
          { label: "Degraded", value: degraded, cls: "text-amber-500", Icon: AlertTriangle },
          { label: "Unknown", value: unknown, cls: "text-fg-muted", Icon: Activity },
          { label: "Healthy", value: healthy, cls: "text-emerald-500", Icon: Activity },
        ].map(({ label, value, cls, Icon }) => (
          <div key={label} className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-center gap-2 text-xs text-fg-muted mb-1">
              <Icon className={`w-3.5 h-3.5 ${cls}`} aria-hidden />
              {label}
            </div>
            <div className={`text-2xl font-bold tabular-nums ${cls}`}>{value}</div>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <Card title="No checks registered">
          <p className="text-sm text-fg-muted">
            Apply <code className="font-mono text-xs">database/112_feature_health.sql</code>, then
            run the scanner once with{" "}
            <code className="font-mono text-xs">/api/cron/health-scan?write=1</code> to
            self-register the code-defined checks.
          </p>
        </Card>
      ) : (
        <FeatureHealthGrid rows={rows} />
      )}
    </div>
  );
}
