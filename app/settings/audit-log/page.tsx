import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, EmptyState, PageHeader, Tag } from "@/components/Card";
import { canManageTeam, getSessionContext } from "@/lib/team";
import { getActivityFeed, KNOWN_ACTORS } from "@/lib/audit/activity-feed";

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
  const ctx = await getSessionContext();
  if (!ctx) redirect("/login?next=/settings/audit-log");
  if (!(ctx.isOwner || canManageTeam(ctx.teamRole, ctx.adminAccess))) redirect("/settings");

  const params = (await searchParams) || {};
  const actor = typeof params.actor === "string" ? params.actor.trim() : "";

  const { rows, errors } = await getActivityFeed(ctx.tenantId, { actor, limit: 200 });

  const toneFor = (t: "human" | "agent" | "system") =>
    t === "agent" ? "engaged" : t === "human" ? "info" : "warm";

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Activity Log"
        subtitle="Read-only trail of who did what — your team (Matt, Jordan, Alex) and your agents (Helios, Solara): sends, automations, stage changes, chats, and team changes."
        action={
          <Link href="/settings" className="btn-secondary text-xs">
            Back to settings
          </Link>
        }
      />

      <Card
        title="Recent activity"
        subtitle="Latest 200 actions across people and agents. Filter by actor below."
        action={<Tag tone="engaged">Admin only</Tag>}
      >
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Link
              href="/settings/audit-log"
              className={`rounded-md border px-2 py-1 text-[11px] font-bold ${
                actor ? "border-bg-border text-fg-muted" : "border-accent text-accent bg-accent/10"
              }`}
            >
              All
            </Link>
            {KNOWN_ACTORS.map((name) => (
              <Link
                key={name}
                href={`/settings/audit-log?actor=${encodeURIComponent(name)}`}
                className={`rounded-md border px-2 py-1 text-[11px] font-bold ${
                  actor === name
                    ? "border-accent text-accent bg-accent/10"
                    : "border-bg-border text-fg-muted"
                }`}
              >
                {name}
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
                actor
                  ? `No recorded activity for ${actor} yet.`
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
