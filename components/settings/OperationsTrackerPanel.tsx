/**
 * Tenant-scoped Settings summary of team and automation activity.
 * The full-history link deliberately resolves through the signed-in session's
 * /settings/audit-log route; no tenant id is accepted from the browser.
 */

import Link from "next/link";
import { Card } from "@/components/Card";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTenantMembers, type MemberRow } from "@/lib/team";
import { getActivityFeed, type ActivityRow } from "@/lib/audit/activity-feed";
import {
  buildEmployeeActivityRollup,
  type EmployeeAuditMetric,
  type EmployeeInteractionMetric,
  type EmployeeRollup,
} from "@/lib/audit/employee-rollup";
import { timeAgo } from "@/lib/fmt";
import {
  ArrowRight,
  Workflow,
  Bot,
  Mail,
  MessageSquare,
  Phone,
  FileText,
} from "lucide-react";

function iconForAction(actionType: string | null) {
  const type = (actionType || "").toLowerCase();
  if (type.includes("email") || type.includes("send")) return <Mail className="w-3 h-3" />;
  if (type.includes("sms") || type.includes("message")) {
    return <MessageSquare className="w-3 h-3" />;
  }
  if (type.includes("call") || type.includes("phone")) return <Phone className="w-3 h-3" />;
  return <Workflow className="w-3 h-3" />;
}

async function loadEmployeeRollup(
  tenantId: string,
  members: MemberRow[],
): Promise<{ rows: EmployeeRollup[]; error: string | null }> {
  try {
    const db = getServiceSupabase();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const pageSize = 500;

    const loadInteractions = async (): Promise<EmployeeInteractionMetric[]> => {
      const rows: EmployeeInteractionMetric[] = [];
      for (let from = 0; ; from += pageSize) {
        const result = await db
          .from("lead_interactions")
          .select("id, channel, direction, actor_user_id, metadata")
          .eq("tenant_id", tenantId)
          .gte("created_at", since)
          .order("id", { ascending: true })
          .range(from, from + pageSize - 1);
        if (result.error) throw new Error(result.error.message);
        const page = (result.data || []) as EmployeeInteractionMetric[];
        rows.push(...page);
        if (page.length < pageSize) return rows;
      }
    };

    const loadAudits = async (): Promise<EmployeeAuditMetric[]> => {
      const rows: EmployeeAuditMetric[] = [];
      for (let from = 0; ; from += pageSize) {
        const result = await db
          .from("tenant_audit_log")
          .select("id, actor_email, actor_user_id")
          .eq("tenant_id", tenantId)
          .gte("created_at", since)
          .order("id", { ascending: true })
          .range(from, from + pageSize - 1);
        if (result.error) throw new Error(result.error.message);
        const page = (result.data || []) as EmployeeAuditMetric[];
        rows.push(...page);
        if (page.length < pageSize) return rows;
      }
    };

    const [interactions, audits] = await Promise.all([loadInteractions(), loadAudits()]);
    return { rows: buildEmployeeActivityRollup(
      members,
      interactions,
      audits,
    ), error: null };
  } catch (error) {
    console.error("[OperationsTrackerPanel.loadEmployeeRollup]", error);
    return {
      rows: [],
      error: "Team metrics are temporarily unavailable; no partial totals are being shown.",
    };
  }
}

export async function OperationsTrackerPanel({
  tenantId,
  tenantName,
}: {
  tenantId: string | null;
  tenantName?: string | null;
}) {
  if (!tenantId) {
    return (
      <Card title="Operations tracker" subtitle="Sign in as the workspace operator to load activity.">
        <div className="text-xs text-fg-dim italic">No tenant context.</div>
      </Card>
    );
  }

  const members = await getTenantMembers(tenantId).catch((error) => {
    console.error("[OperationsTrackerPanel.getTenantMembers]", error);
    return [] as MemberRow[];
  });
  const [{ rows: recentActivity }, rollupState] = await Promise.all([
    getActivityFeed(tenantId, { limit: 15, members }),
    loadEmployeeRollup(tenantId, members),
  ]);
  const rollup = rollupState.rows;
  const workspaceLabel = tenantName || "this workspace";

  return (
    <Card
      title="Operations tracker"
      subtitle={`Live activity for ${workspaceLabel}: human touches, lifecycle work, and automations. Read-only.`}
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <Link
            href="/automations"
            className="flex items-center gap-2 rounded-md border border-bg-border bg-bg-deep/40 hover:bg-bg-elev/60 transition-colors px-3 py-2.5"
          >
            <Bot className="w-4 h-4 text-accent" />
            <div className="min-w-0">
              <div className="text-[11.5px] font-semibold text-fg">Automations</div>
              <div className="text-[10px] text-fg-dim">Schedules and workers</div>
            </div>
          </Link>
          <Link
            href="/sequences"
            className="flex items-center gap-2 rounded-md border border-bg-border bg-bg-deep/40 hover:bg-bg-elev/60 transition-colors px-3 py-2.5"
          >
            <Workflow className="w-4 h-4 text-accent" />
            <div className="min-w-0">
              <div className="text-[11.5px] font-semibold text-fg">Sequences</div>
              <div className="text-[10px] text-fg-dim">Follow-up cadences</div>
            </div>
          </Link>
          <Link
            href="/settings/audit-log"
            className="flex items-center gap-2 rounded-md border border-bg-border bg-bg-deep/40 hover:bg-bg-elev/60 transition-colors px-3 py-2.5"
          >
            <FileText className="w-4 h-4 text-accent" />
            <div className="min-w-0">
              <div className="text-[11.5px] font-semibold text-fg">Full activity log</div>
              <div className="text-[10px] text-fg-dim">This workspace only</div>
            </div>
          </Link>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold mb-1.5">
            Team activity — last 7 days
          </div>
          {rollupState.error ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11.5px] text-amber-200">
              {rollupState.error}
            </div>
          ) : rollup.length === 0 ? (
            <div className="rounded-md border border-bg-border bg-bg-deep/30 px-3 py-2.5 text-[11.5px] text-fg-dim italic">
              No team members are connected to this workspace yet.
            </div>
          ) : (
            <div className="rounded-md border border-bg-border divide-y divide-bg-border">
              {rollup.slice(0, 12).map((row) => (
                <div key={row.profileId} className="px-3 py-2 flex items-center gap-3 text-[12px]">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-fg truncate">{row.label}</div>
                    <div className="text-[10px] text-fg-dim truncate">{row.email}</div>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-fg-muted shrink-0">
                    <span className="inline-flex items-center gap-1" title="Outbound emails">
                      <Mail className="w-3 h-3" />
                      {row.email_sends}
                    </span>
                    <span className="inline-flex items-center gap-1" title="Outbound SMS">
                      <MessageSquare className="w-3 h-3" />
                      {row.sms_sends}
                    </span>
                    <span className="inline-flex items-center gap-1" title="Call actions">
                      <Phone className="w-3 h-3" />
                      {row.call_actions}
                    </span>
                    <span className="font-mono text-[10.5px] text-fg-dim">
                      {row.recent_actions} total
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold">
              Recent workspace activity
            </div>
            <Link
              href="/settings/audit-log"
              className="text-[10px] text-fg-dim hover:text-fg inline-flex items-center gap-1"
            >
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {recentActivity.length === 0 ? (
            <div className="rounded-md border border-bg-border bg-bg-deep/30 px-3 py-2.5 text-[11.5px] text-fg-dim italic">
              No activity yet. It will appear here as your team and enabled agents take action.
            </div>
          ) : (
            <ul className="space-y-1">
              {recentActivity.map((row: ActivityRow) => (
                <li
                  key={row.id}
                  className="rounded-md border border-bg-border bg-bg-deep/30 px-3 py-1.5 flex items-center gap-2 text-[11.5px]"
                >
                  <div className="text-fg-dim">{iconForAction(row.action)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-fg truncate">
                      <span className="font-semibold">{row.actor}</span>
                      <span className="text-fg-muted"> · {row.action}</span>
                      {row.target && <span className="text-fg-dim"> on {row.target}</span>}
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-fg-dim shrink-0">
                    {timeAgo(row.time)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}
