import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, EmptyState, PageHeader, Tag } from "@/components/Card";
import { canManageTeam, type TeamRole } from "@/lib/team";
import { getActivityFeed } from "@/lib/audit/activity-feed";
import { getActiveProfile, getTenant } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatTime(value: string): string {
  try {
    return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(value),
    );
  } catch {
    return value;
  }
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams?: Promise<{ actor?: string }>;
}) {
  // Use the exact profile resolver as /settings. A separate maybeSingle()
  // lookup can select a different workspace for users with legacy duplicate
  // profile rows, which is how a tenant-scoped page can still show the wrong
  // tenant's activity despite every downstream query having an eq(tenant_id).
  const profile = await getActiveProfile();
  if (!profile?.tenant_id) redirect("/login?next=/settings/audit-log");
  const accessProfile = profile as typeof profile & {
    is_owner?: boolean | null;
    team_role?: TeamRole | null;
    admin_access?: boolean | null;
  };
  if (
    !(
      accessProfile.is_owner ||
      canManageTeam(accessProfile.team_role || "member", accessProfile.admin_access === true)
    )
  ) {
    redirect("/settings");
  }

  const params = (await searchParams) || {};
  const actorFilter = typeof params.actor === "string" ? params.actor.trim() : "";
  const [{ rows, actors, errors }, tenant] = await Promise.all([
    getActivityFeed(profile.tenant_id, { actor: actorFilter, limit: 200 }),
    getTenant(profile.tenant_id).catch(() => null),
  ]);
  const selectedActor = actors.find(
    (candidate) =>
      candidate.key === actorFilter ||
      candidate.label.toLowerCase() === actorFilter.toLowerCase(),
  );
  const peopleCount = actors.filter((candidate) => candidate.type === "human").length;
  const agentCount = actors.filter((candidate) => candidate.type === "agent").length;
  const rosterSummary = [
    peopleCount > 0
      ? `${peopleCount} team member${peopleCount === 1 ? "" : "s"}`
      : null,
    agentCount > 0
      ? `${agentCount} enabled agent${agentCount === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const workspaceLabel = tenant?.name || "this workspace";

  const toneFor = (type: "human" | "agent" | "system") =>
    type === "agent" ? "engaged" : type === "human" ? "info" : "warm";

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Activity Log"
        subtitle={`Read-only trail for ${workspaceLabel}${rosterSummary ? ` across ${rosterSummary}` : ""}: calls, messages, automations, stage changes, chats, and team changes.`}
        action={
          <Link href="/settings" className="btn-secondary text-xs">
            Back to settings
          </Link>
        }
      />

      <Card
        title="Recent activity"
        subtitle="Latest 200 actions for this workspace. Filter by a current team member or enabled agent."
        action={<Tag tone="engaged">Admin only</Tag>}
      >
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Link
              href="/settings/audit-log"
              className={`rounded-md border px-2 py-1 text-[11px] font-bold ${
                actorFilter
                  ? "border-bg-border text-fg-muted"
                  : "border-accent text-accent bg-accent/10"
              }`}
            >
              All
            </Link>
            {actors.map((actor) => (
              <Link
                key={actor.key}
                href={`/settings/audit-log?actor=${encodeURIComponent(actor.key)}`}
                className={`rounded-md border px-2 py-1 text-[11px] font-bold ${
                  selectedActor?.key === actor.key
                    ? "border-accent text-accent bg-accent/10"
                    : "border-bg-border text-fg-muted"
                }`}
              >
                {actor.label}
              </Link>
            ))}
          </div>

          {errors.length > 0 && (
            <div className="text-[11px] text-status-warm">
              Some sources were unavailable: {errors.join("; ")}
            </div>
          )}

          {rows.length === 0 ? (
            <EmptyState
              message={
                selectedActor
                  ? `No recorded activity for ${selectedActor.label} yet.`
                  : actorFilter
                    ? "That actor is not part of this workspace."
                    : "No activity recorded yet."
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[10px] uppercase tracking-wider text-fg-dim">
                  <tr className="border-b border-bg-border">
                    <th className="text-left py-2 pr-3">Time</th>
                    <th className="text-left py-2 pr-3">Actor</th>
                    <th className="text-left py-2 pr-3">Action</th>
                    <th className="text-left py-2 pr-3">Target</th>
                    <th className="text-left py-2">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b border-bg-border/70 align-top">
                      <td className="py-2 pr-3 text-fg-muted whitespace-nowrap">
                        {formatTime(row.time)}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <Tag tone={toneFor(row.actorType)}>{row.actor}</Tag>
                      </td>
                      <td className="py-2 pr-3 text-fg-muted">{row.action}</td>
                      <td className="py-2 pr-3 text-fg-muted break-all">{row.target || "-"}</td>
                      <td className="py-2 text-fg-dim font-mono text-[11px] max-w-md break-all">
                        {row.detail}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
