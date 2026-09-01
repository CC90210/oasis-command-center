import Link from "next/link";
import { ArrowRight, Phone, Mail, MessageSquare, Workflow } from "lucide-react";

import { Card, EmptyState, Tag } from "@/components/Card";
import { getActivityFeed, type ActivityRow } from "@/lib/audit/activity-feed";
import { getOasisSalesTeamPerformance } from "@/lib/audit/sales-performance";
import { timeAgo } from "@/lib/fmt";
import { teamRoleLabel } from "@/lib/team-roles";

function nameOf(row: { display_name: string | null; full_name: string; email: string }): string {
  return row.display_name || row.full_name || row.email;
}

function iconFor(row: ActivityRow) {
  const value = `${row.action} ${row.target}`.toLowerCase();
  if (value.includes("call") || value.includes("phone")) return <Phone className="h-3 w-3" />;
  if (value.includes("email")) return <Mail className="h-3 w-3" />;
  if (value.includes("sms") || value.includes("message")) {
    return <MessageSquare className="h-3 w-3" />;
  }
  return <Workflow className="h-3 w-3" />;
}

export async function SalesTeamOperationsPanel({
  tenantId,
  tenantName,
}: {
  tenantId: string;
  tenantName?: string | null;
}) {
  const performance = await getOasisSalesTeamPerformance(tenantId);
  const actorIds = performance.members
    .map((member) => member.auth_user_id || "")
    .filter(Boolean);
  const activity = performance.error
    ? { rows: [], actors: [], errors: [performance.error] }
    : await getActivityFeed(tenantId, {
        scope: "sales_team",
        salesActorUserIds: actorIds,
        members: performance.members,
        limit: 12,
      });

  const allMetricsAvailable =
    !performance.error && performance.rows.every((row) => row.kpis !== null);
  const totals = allMetricsAvailable
    ? performance.rows.reduce(
        (sum, row) => ({
          assigned: sum.assigned + (row.kpis?.assigned || 0),
          booked: sum.booked + (row.kpis?.booked || 0),
          won: sum.won + (row.kpis?.won || 0),
          overdue: sum.overdue + (row.kpis?.overdue || 0),
        }),
        { assigned: 0, booked: 0, won: 0, overdue: 0 },
      )
    : null;

  return (
    <Card
      title="Sales team performance"
      subtitle={`Live, read-only scorecard for every OASIS sales rep in ${tenantName || "this workspace"}. Lead counts are cumulative; touches cover the last 7 days.`}
      action={<Tag tone="info">Sales scope only</Tag>}
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ["Assigned", totals?.assigned],
            ["Meetings booked", totals?.booked],
            ["Won", totals?.won],
            ["Overdue", totals?.overdue],
          ].map(([label, value]) => (
            <div key={String(label)} className="border-l border-bg-border pl-3 py-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-dim">
                {label}
              </div>
              <div className="mt-0.5 text-xl font-bold tabular-nums text-fg">
                {typeof value === "number" ? value : "—"}
              </div>
            </div>
          ))}
        </div>

        {performance.error ? (
          <div className="rounded-md border border-status-warm/30 bg-status-warm/10 px-3 py-2 text-xs text-status-warm">
            {performance.error} No partial totals are shown.
          </div>
        ) : performance.rows.length === 0 ? (
          <EmptyState message="No profiles in the OASIS sales-rep roster are connected to this workspace yet." />
        ) : (
          <div className="overflow-x-auto rounded-md border border-bg-border">
            <table className="w-full min-w-[850px] text-xs">
              <thead className="bg-bg-deep/60 text-[10px] uppercase tracking-wider text-fg-dim">
                <tr>
                  <th className="px-3 py-2 text-left">Rep</th>
                  <th className="px-2 py-2 text-right">Assigned</th>
                  <th className="px-2 py-2 text-right">Contacted</th>
                  <th className="px-2 py-2 text-right">Qualified</th>
                  <th className="px-2 py-2 text-right">Booked</th>
                  <th className="px-2 py-2 text-right">Won</th>
                  <th className="px-2 py-2 text-right">Lost</th>
                  <th className="px-2 py-2 text-right">Overdue</th>
                  <th className="px-3 py-2 text-right">Touches · 7d</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bg-border">
                {performance.rows.map((row) => (
                  <tr key={row.member.id} className="bg-bg-deep/20">
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-fg">{nameOf(row.member)}</div>
                      <div className="text-[10px] uppercase tracking-wide text-fg-dim">
                        {teamRoleLabel(row.member.team_role)}
                      </div>
                    </td>
                    {row.kpis ? (
                      <>
                        <td className="px-2 py-2 text-right tabular-nums">{row.kpis.assigned}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{row.kpis.contacted}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{row.kpis.qualified}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{row.kpis.booked}</td>
                        <td className="px-2 py-2 text-right tabular-nums text-status-engaged">{row.kpis.won}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{row.kpis.lost}</td>
                        <td className={`px-2 py-2 text-right tabular-nums ${row.kpis.overdue > 0 ? "text-status-warm" : ""}`}>
                          {row.kpis.overdue}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.touches7d ?? "—"}</td>
                      </>
                    ) : (
                      <td colSpan={8} className="px-3 py-2 text-right text-status-warm">
                        {row.error || "Metrics unavailable"}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-dim">
                Recent lead activity
              </div>
              <div className="text-[11px] text-fg-muted">
                Human sales actions only. Admin, automation, agent, chat, and cron events are excluded.
              </div>
            </div>
            <Link
              href="/settings/audit-log"
              className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-accent hover:text-accent-bright"
            >
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {activity.errors.length > 0 ? (
            <div className="rounded-md border border-status-warm/30 bg-status-warm/10 px-3 py-2 text-xs text-status-warm">
              Sales activity is temporarily unavailable. No workspace-wide fallback was used.
            </div>
          ) : activity.rows.length === 0 ? (
            <div className="rounded-md border border-bg-border bg-bg-deep/30 px-3 py-2.5 text-xs italic text-fg-dim">
              No rep-attributed lead activity has been recorded yet.
            </div>
          ) : (
            <ul className="divide-y divide-bg-border rounded-md border border-bg-border">
              {activity.rows.map((row) => (
                <li key={row.id} className="flex items-center gap-2 px-3 py-2 text-[11.5px]">
                  <span className="text-fg-dim">{iconFor(row)}</span>
                  <span className="min-w-0 flex-1 truncate text-fg">
                    <b>{row.actor}</b>
                    <span className="text-fg-muted"> · {row.action}</span>
                    {row.target ? <span className="text-fg-dim"> on {row.target}</span> : null}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-fg-dim">
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
