/**
 * /settings/audit-log — Settings › Activity log. Owners and admins read the
 * whole workspace; an OASIS sales manager reads their reps' lead actions only.
 *
 * THE ROSTER IS CURRENT, THE ROWS ARE HISTORY. The chips and the "N team
 * members" count come from the feed's active actors; a teammate deactivated
 * since keeps their name on old rows and sits in a collapsed "Former
 * teammates" group, never among the current team (S1-C1). Consecutive
 * identical rows (one bulk claim wrote thirty) fold into one line with the
 * count and the leads behind it (S1-C3). Same chrome as the sections beside
 * it: PageFrame and the OS table, sentence case throughout; the section nav
 * is the way back (S1-C4).
 */

import { redirect } from "next/navigation";
import { PageFrame } from "@/components/os/PageFrame";
import { ActivityActorChips } from "@/components/settings/ActivityActorChips";
import { groupSummary, humanizeAction } from "@/components/settings/activity-log-format";
import { getActivityFeed, type ActivityRow } from "@/lib/audit/activity-feed";
import { getActiveProfile, getTenant } from "@/lib/queries";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";
import { getOasisSalesRepRoster } from "@/lib/team";

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

function Who({ row }: { row: ActivityRow }) {
  if (row.actorType === "agent") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-hairline bg-bg-raised text-[11px] font-semibold text-fg"
        >
          {(row.actor.trim().charAt(0) || "?").toUpperCase()}
        </span>
        <span className="text-fg">{row.actor}</span>
      </span>
    );
  }
  return <span className={row.actorType === "human" ? "text-fg" : "text-fg-muted"}>{row.actor}</span>;
}

function About({ row }: { row: ActivityRow }) {
  if (!row.count || !row.items) return <>{row.target || "-"}</>;
  return (
    <details>
      <summary className="cursor-pointer text-fg">{groupSummary(row)}</summary>
      <ul className="mt-1.5 space-y-0.5 text-[12px] leading-4 text-fg-muted">
        {row.items.map((item) => (
          <li key={item.id}>{item.target || humanizeAction(item.action)}</li>
        ))}
      </ul>
    </details>
  );
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
  const surface = await resolveViewerSurface();
  if (!surface.ok || !surface.capabilities.canSeeTeamPerformance) redirect("/settings");
  const salesTeamScope = !surface.capabilities.canSeeSystemSurfaces;

  const params = (await searchParams) || {};
  const actorFilter = typeof params.actor === "string" ? params.actor.trim() : "";
  let salesRosterError: string | null = null;
  const salesRoster = salesTeamScope
    ? await getOasisSalesRepRoster(profile.tenant_id, undefined, { includeInactive: true }).catch((error) => {
        console.error("[settings.audit-log.sales-roster]", error);
        salesRosterError = "sales_roster_unavailable";
        return [];
      })
    : [];
  const [feed, tenant] = await Promise.all([
    salesRosterError
      ? Promise.resolve({ rows: [], actors: [], activeActors: [], formerActors: [], errors: [salesRosterError] })
      : getActivityFeed(profile.tenant_id, {
          actor: actorFilter,
          limit: 200,
          // This page renders the count and the leads behind a folded row
          // (About); the Operations and Sales panels do not, so they keep
          // every row.
          group: true,
          oasis: isOasisSurfaceTenant(surface.tenantSlug),
          ...(salesTeamScope
            ? {
                scope: "sales_team" as const,
                members: salesRoster,
                salesActorUserIds: salesRoster
                  .map((member) => member.auth_user_id || "")
                  .filter(Boolean),
              }
            : {}),
        }),
    getTenant(profile.tenant_id).catch(() => null),
  ]);
  const { rows, actors, activeActors, formerActors, errors } = feed;
  const selectedActor = actors.find(
    (candidate) =>
      candidate.key === actorFilter ||
      candidate.label.toLowerCase() === actorFilter.toLowerCase(),
  );
  const peopleCount = activeActors.filter((candidate) => candidate.type === "human").length;
  const agentCount = activeActors.filter((candidate) => candidate.type === "agent").length;
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

  return (
    <PageFrame
      title="Activity log"
      subtitle={
        salesTeamScope
          ? `Read-only OASIS sales activity for ${workspaceLabel}${rosterSummary ? ` across ${rosterSummary}` : ""}: the latest 200 rep-attributed lead actions. Internal agents, automations, chats, crons, secrets and admin changes are excluded.`
          : `Read-only trail for ${workspaceLabel}${rosterSummary ? ` across ${rosterSummary}` : ""}: the latest 200 calls, messages, automations, stage changes, chats and team changes.`
      }
    >
      <div className="space-y-4">
        <ActivityActorChips
          active={activeActors}
          former={formerActors}
          selectedKey={selectedActor?.key ?? null}
          filtering={Boolean(actorFilter)}
        />

        {errors.length > 0 && (
          <p className="text-[12px] leading-4 text-status-warm">
            Some sources were unavailable: {errors.join("; ")}
          </p>
        )}

        {rows.length === 0 ? (
          <p className="rounded-lg border border-hairline bg-bg-panel px-4 py-6 text-center text-[13px] text-fg-muted">
            {selectedActor
              ? `No recorded activity for ${selectedActor.label} yet.`
              : actorFilter
                ? "That person or agent is not part of this workspace."
                : "No activity recorded yet."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-hairline bg-bg-panel">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-b border-hairline text-[12px] text-fg-dim">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Time</th>
                  <th scope="col" className="px-3 py-2 font-medium">Who</th>
                  <th scope="col" className="px-3 py-2 font-medium">What</th>
                  <th scope="col" className="px-3 py-2 font-medium">About</th>
                  <th scope="col" className="px-3 py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((row) => (
                  <tr key={row.id} className="align-top">
                    <td className="whitespace-nowrap px-3 py-2 text-fg-muted">{formatTime(row.time)}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <Who row={row} />
                    </td>
                    <td className="px-3 py-2 text-fg">{humanizeAction(row.action)}</td>
                    <td className="max-w-xs break-words px-3 py-2 text-fg-muted">
                      <About row={row} />
                    </td>
                    <td className="max-w-md break-words px-3 py-2 text-[12px] leading-4 text-fg-dim">{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PageFrame>
  );
}
