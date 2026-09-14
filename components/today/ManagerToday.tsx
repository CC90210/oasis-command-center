/**
 * ManagerToday — the sales manager's dashboard.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS COMPONENT HAD TO EXIST BEFORE THE MANAGER ROLE COULD SHIP
 * ─────────────────────────────────────────────────────────────────────────────
 * app/page.tsx dispatches Today by persona, and every persona without a branch
 * falls through to FounderToday. When the `manager` persona was added, it fell
 * through — and although the MONEY was safe (FounderToday takes
 * `showFinancials`, which is false for a manager), FounderToday consults no
 * other capability. A manager would have seen a founder dashboard whose scope
 * and controls were not designed for sales-team operations.
 *
 * That is the exact failure lib/role-surfaces.ts was written to prevent,
 * reintroduced by adding a persona without a surface. A capability flag that no
 * component reads is a comment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TEAM IS A THIRD SCOPE, AND IT IS THE POINT
 * ─────────────────────────────────────────────────────────────────────────────
 * An OASIS manager sees their direct reports from the canonical OASIS sales
 * roster. The roster is tenant-, role-, and manager-scoped before commission
 * rows are queried, and when it is empty the downstream query does not run.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AN ABSENT ANSWER IS NOT A ZERO
 * ─────────────────────────────────────────────────────────────────────────────
 * Same discipline as RepToday: a failed read renders as "couldn't load", never
 * as 0. A manager who sees "$0 team commission" when the query actually failed
 * will go and have a conversation with a rep about a number that was never
 * real.
 */

import Link from "next/link";
import { Card, EmptyState, PageHeader, Stat } from "@/components/Card";
import { LiveClock } from "@/components/LiveClock";
import { getServiceSupabase } from "@/lib/supabase-server";
import { operatorDateKey } from "@/lib/dates";
import { MANAGER_OVERRIDE_BPS } from "@/lib/website-sales-comp";
import { getOasisSalesRepRoster } from "@/lib/team";
import {
  formatCommissionAmounts,
  loadWebsiteSalesCommissionSummary,
  type WebsiteSalesCommissionSummary,
} from "@/lib/website-sales-commission-summary";

/** A read that can fail. `ok:false` means "could not find out", which is not zero. */
type Read<T> = { ok: true; value: T } | { ok: false };

type RepRow = { auth_user_id: string; display_name: string | null; full_name: string | null; team_role: string | null };

async function loadTeam(tenantId: string, managerUserId: string): Promise<Read<RepRow[]>> {
  try {
    const rows = await getOasisSalesRepRoster(tenantId, managerUserId);
    return {
      ok: true,
      value: rows.map((row) => ({
        auth_user_id: row.auth_user_id!,
        display_name: row.display_name,
        full_name: row.full_name,
        team_role: row.team_role,
      })),
    };
  } catch (error) {
    console.error("[manager-today.roster]", error);
    return { ok: false };
  }
}

async function loadTeamLines(
  tenantId: string,
  repIds: string[],
): Promise<Read<WebsiteSalesCommissionSummary>> {
  // No roster, no query. Sending an empty `in` list is how "this manager has no
  // reps" quietly becomes "every row in the tenant" on some clients.
  try {
    return {
      ok: true,
      value: await loadWebsiteSalesCommissionSummary(getServiceSupabase(), {
        tenantId,
        repUserIds: repIds,
        // The manager's override has its own card below. Keeping manager-role
        // rows out of team sales prevents the same dollars appearing twice.
        excludePartyRole: "manager",
      }),
    };
  } catch (error) {
    console.error("[manager-today.team-commissions]", error);
    return { ok: false };
  }
}

async function loadMyOverride(
  tenantId: string,
  managerUserId: string,
): Promise<Read<WebsiteSalesCommissionSummary>> {
  try {
    return {
      ok: true,
      value: await loadWebsiteSalesCommissionSummary(getServiceSupabase(), {
        tenantId,
        repUserId: managerUserId,
        partyRole: "manager",
      }),
    };
  } catch (error) {
    console.error("[manager-today.override]", error);
    return { ok: false };
  }
}

async function loadMySales(
  tenantId: string,
  managerUserId: string,
): Promise<Read<WebsiteSalesCommissionSummary>> {
  try {
    return {
      ok: true,
      value: await loadWebsiteSalesCommissionSummary(getServiceSupabase(), {
        tenantId,
        repUserId: managerUserId,
        // A manager may sell personally. Keep those opener/closer/full-stack
        // earnings separate from the manager override displayed beside them.
        excludePartyRole: "manager",
      }),
    };
  } catch (error) {
    console.error("[manager-today.personal-sales]", error);
    return { ok: false };
  }
}

export async function ManagerToday({
  tenantId,
  userId,
  managerName,
}: {
  tenantId: string;
  userId: string;
  managerName: string;
}) {
  const dateKey = operatorDateKey();
  const teamRead = await loadTeam(tenantId, userId);
  const repIds = teamRead.ok ? teamRead.value.map((r) => r.auth_user_id).filter(Boolean) : [];
  const [rawLinesRead, ownSalesRead, overrideRead] = await Promise.all([
    loadTeamLines(tenantId, repIds),
    loadMySales(tenantId, userId),
    loadMyOverride(tenantId, userId),
  ]);

  // THIS FILE'S OWN HEADER SAYS AN ABSENT ANSWER IS NOT A ZERO, and the first
  // version broke that rule three lines after stating it. When loadTeam fails,
  // repIds is [] — and loadTeamLines answers an empty roster with a SUCCESSFUL
  // empty result, so the card rendered a confident "$0.00" for a team whose
  // roster we could not even read. A manager would go and ask a rep why they
  // earned nothing this month.
  //
  // An unknown roster makes the team total unknowable. Say so.
  const linesRead: Read<WebsiteSalesCommissionSummary> = teamRead.ok ? rawLinesRead : { ok: false };
  const activeStatuses = ["accrued", "approved", "paid"] as const;
  const nameOf = (r: RepRow) => r.display_name || r.full_name || r.auth_user_id.slice(0, 8);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Today"
        subtitle={
          <span>
            {managerName} · <LiveClock initialDateKey={dateKey} /> · your team
          </span>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Stat
          label="OASIS sales reps"
          value={teamRead.ok ? String(teamRead.value.length) : "—"}
          hint={teamRead.ok ? "your direct reports" : "couldn't load your direct reports"}
        />
        <Stat
          label="Team commissions earned"
          value={linesRead.ok ? formatCommissionAmounts(linesRead.value.totals, [...activeStatuses]) : "—"}
          hint={linesRead.ok ? "accrued, approved, and paid · currencies separated" : "couldn't load — this is not $0"}
        />
        <Stat
          label="Your sales commissions"
          value={ownSalesRead.ok ? formatCommissionAmounts(ownSalesRead.value.totals, [...activeStatuses]) : "—"}
          hint={ownSalesRead.ok ? "your own opener, closer, and full-deal earnings" : "couldn't load — this is not $0"}
        />
        <Stat
          label="Your override"
          value={overrideRead.ok ? formatCommissionAmounts(overrideRead.value.totals, [...activeStatuses]) : "—"}
          hint={`${(MANAGER_OVERRIDE_BPS / 100).toFixed(0)}% of what OASIS retains`}
        />
      </div>

      <Card
        title="OASIS sales team"
        subtitle="Your direct reports in the canonical OASIS sales roster."
      >
        {!teamRead.ok ? (
          <EmptyState message="Couldn't load your direct reports. This read failed — it does not mean you have no reps. Reload in a minute." />
        ) : teamRead.value.length === 0 ? (
          <EmptyState message="No active sales reps are assigned to you as direct reports yet." />
        ) : (
          <div className="divide-y divide-bg-border">
            {teamRead.value.map((rep) => (
              <div key={rep.auth_user_id} className="flex items-center justify-between py-2.5">
                <div className="min-w-0">
                  <div className="text-sm text-fg truncate">{nameOf(rep)}</div>
                  <div className="text-xs text-fg-dim">{rep.team_role ?? "—"}</div>
                </div>
                <div className="text-sm font-semibold text-fg tabular-nums">
                  {linesRead.ok
                    ? formatCommissionAmounts(linesRead.value.byRep[rep.auth_user_id] ?? [], [...activeStatuses])
                    : "—"}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Coaching"
        subtitle="Open the workspace sales pipeline to review ownership, follow-up, and stage progress."
      >
        <EmptyState
          message="The commission totals above include only your direct reports. The Pipeline shows the wider OASIS sales roster; use its rep filter to focus on one person."
          cta={
            <Link href="/pipeline" className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs">
              Go to pipeline
            </Link>
          }
        />
      </Card>
    </div>
  );
}
