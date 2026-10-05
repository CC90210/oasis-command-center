import { Suspense } from "react";
// `redirect` import removed with the manager auto-redirect (2026-09-02).
import { WebLeadsBrowser } from "@/components/web-leads/WebLeadsBrowser";
import { WebLeadsSkeleton } from "@/components/web-leads/WebLeadsSkeleton";
import { resolveSessionContext } from "@/lib/api-auth";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import { mayWorkWebsiteSalesLifecycle } from "@/lib/website-sales-workflow";

export const dynamic = "force-dynamic";

export default async function WebLeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, rawParams] = await Promise.all([resolveSessionContext(), searchParams]);
  const canMutate =
    session.ok &&
    session.tenantId === WEBDEV_TENANT_ID &&
    mayWorkWebsiteSalesLifecycle(session.teamRole, session.isAdmin);
  const isManager =
    session.ok &&
    session.tenantId === WEBDEV_TENANT_ID &&
    session.teamRole?.trim().toLowerCase() === "manager";
  const canSeeTeamAndAssign = session.ok && session.tenantId === WEBDEV_TENANT_ID && (session.isAdmin || isManager);
  // REMOVED 2026-09-02 (Adon, from a screenshot of Ethan's actual screen).
  //
  // Managers used to be redirected here to view=team — a READ-ONLY roster view
  // of leads already assigned to reps. That made sense when the pool was 31K
  // unqualified rows and a manager's job was to coach. It does not survive
  // contact with reality:
  //
  //   * the roster view shows only ASSIGNED leads, and almost nothing is
  //     assigned, so a manager landed on "No roster-assigned team leads yet" —
  //     a blank page, on the one screen the product is named after;
  //   * the team view sets canOperateCurrentView = canMutate && !team, so the
  //     Claim button is gone. `manager` IS in OASIS_SALES_LEAD_OPERATOR_ROLES,
  //     so the role was allowed to claim and the UI silently refused;
  //   * the pool is now 1,111 owner-verified leads, not 31K noise — it is the
  //     thing a manager should see first.
  //
  // Managers now land on the pool like everyone else. "Team leads" stays one
  // click away as a tab, so nothing is lost — it just is not a dead end anymore.
  return (
    <Suspense fallback={<WebLeadsSkeleton />}>
      <WebLeadsBrowser canMutate={canMutate} canSeeTeamAndAssign={canSeeTeamAndAssign} />
    </Suspense>
  );
}
