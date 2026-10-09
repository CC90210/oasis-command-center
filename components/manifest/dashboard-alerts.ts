/**
 * components/manifest/dashboard-alerts.ts - the workspace dashboard's System
 * health card: which open alert cards it reads, and for whom.
 *
 * Only the people who may resolve a card read one: the workspace's owners and
 * admins, the same audience as Needs you (lib/notify/alert-access.ts), decided
 * from the session. For anyone else the query never runs. Every row the card
 * shows carries a Dismiss form, and the Resolve route refuses everyone outside
 * that audience; until 2026-10-08 any member of the workspace read the cards
 * and could dismiss them.
 */
import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";
import { mayManageWorkspaceAlerts } from "@/lib/notify/alert-access";

export type AgentAlertRow = {
  id: string;
  alert_type: string;
  severity: "info" | "warn" | "urgent";
  subject_type: string | null;
  subject_id: string | null;
  title: string;
  body: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
};

/** The open cards for `tenantId`'s System health card, newest first, one per kind and subject. */
export async function loadDashboardAlerts(tenantId: string | null): Promise<AgentAlertRow[]> {
  if (!tenantId) return [];
  const viewer = await resolveViewerSurface().catch(() => null);
  if (!viewer?.ok || viewer.tenantId !== tenantId || !mayManageWorkspaceAlerts(viewer.persona, viewer.capabilities)) {
    return [];
  }
  try {
    const sb = getServiceSupabase();
    const { data, error } = await sb
      .from("agent_alerts")
      .select("id, alert_type, severity, subject_type, subject_id, title, body, payload, created_at")
      .eq("tenant_id", tenantId)
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return [];
    // Dedupe by alert_type: health_check runs hourly and creates a
    // new row every 6h even when the underlying issue is unchanged.
    // Showing 10 stale "Health check: N HIGH" rows is noise; keep
    // only the most-recent of each type. Operator clears via the
    // dismiss button which sets resolved_at.
    const seen = new Set<string>();
    const deduped: AgentAlertRow[] = [];
    for (const row of (data || []) as AgentAlertRow[]) {
      const dedupeKey = `${row.alert_type}:${row.subject_type || ""}:${row.subject_id || ""}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      deduped.push(row);
      if (deduped.length >= 10) break;
    }
    return deduped;
  } catch {
    return [];
  }
}
