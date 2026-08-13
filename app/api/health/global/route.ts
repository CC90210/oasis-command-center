/**
 * GET /api/health/global — the dashboard's read API.
 *
 * AUTHORIZATION: system admins only. This is a cross-tenant view — it shows
 * every tenant's feature health at once — so tenant membership is NOT
 * sufficient. `resolveSessionContext().isAdmin` (owner / admin team_role) is
 * the gate, and it fails CLOSED: any error resolving the session is a 403, not
 * a fallthrough.
 *
 * The underlying tables are service_role-only at the RLS layer, so this route
 * is the single authorized door to them.
 *
 * Reads feature_health_status (one row per check) rather than the sample table,
 * so the page cost is O(checks) and stays flat as history grows.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  let isAdmin = false;
  try {
    const ctx = await resolveSessionContext();
    // SessionContext is a discriminated union: narrow on `ok` before reading
    // isAdmin, so a failed session resolution can never read as authorized.
    isAdmin = ctx.ok && ctx.isAdmin;
  } catch {
    // Fail closed. An unresolvable session is not an authorized one.
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!isAdmin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const db = getServiceSupabase();
  const includeHistory = req.nextUrl.searchParams.get("history") === "1";

  const { data: checks, error: checksErr } = await db
    .from("feature_health_checks")
    .select(
      "check_key, feature, surface, severity, enabled, weights, thresholds, healthy_at, degraded_at, alert_channels, notes",
    )
    .eq("enabled", true);

  if (checksErr) {
    return NextResponse.json(
      { error: "query_failed", detail: checksErr.message },
      { status: 500 },
    );
  }

  const { data: statuses } = await db
    .from("feature_health_status")
    .select(
      "check_key, score, status, breakdown, error, consecutive_bad, consecutive_ok, last_ok_at, last_bad_at, observed_at",
    );

  const statusByKey = new Map<string, Record<string, unknown>>(
    ((statuses || []) as Record<string, unknown>[]).map((s) => [s.check_key as string, s]),
  );

  const rows = (checks || []).map((c: Record<string, unknown>) => ({
    ...c,
    status: statusByKey.get(c.check_key as string) ?? null,
  }));

  // The monitor's own liveness, so the UI can say "these numbers are stale"
  // instead of rendering a confidently green wall of last week's data.
  const { data: heartbeat } = await db
    .from("health_alert_state")
    .select("last_alert_at, last_text")
    .eq("condition_key", "monitor:scan_heartbeat")
    .maybeSingle<{ last_alert_at: string; last_text: string }>();

  let history: unknown[] = [];
  if (includeHistory) {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    const { data } = await db
      .from("feature_health_samples")
      .select("check_key, observed_at, score, status")
      .gte("observed_at", since)
      .order("observed_at", { ascending: true })
      .limit(5000);
    history = data || [];
  }

  const openIncidents = rows.filter(
    (r) => r.status && ["down", "degraded"].includes((r.status as { status: string }).status),
  ).length;

  return NextResponse.json({
    ok: true,
    generated_at: new Date().toISOString(),
    monitor: {
      last_scan_at: heartbeat?.last_alert_at ?? null,
      last_scan_note: heartbeat?.last_text ?? null,
      // Anything older than 3 polling intervals means the scanner is not
      // running and every score below is history, not status.
      stale: heartbeat?.last_alert_at
        ? Date.now() - new Date(heartbeat.last_alert_at).getTime() > 45 * 60_000
        : true,
    },
    summary: {
      total: rows.length,
      open_incidents: openIncidents,
    },
    checks: rows,
    history,
  });
}
