/**
 * `/` — the Today screen. A DISPATCHER, not a page.
 *
 * WHAT CHANGED AND WHY (2026-08-19)
 * This file used to be the founder dashboard itself: it fetched Net MRR, the
 * gap to goal, the 30-day MRR trajectory, top-client concentration and the
 * whole tenant's pipeline, then rendered them to whoever was logged in. OASIS
 * is onboarding outside commission-only sales contractors this week. A
 * contractor opening this URL would have read the company's revenue and the
 * name of its largest client.
 *
 * The fix is not a hidden card. Each persona now gets its OWN component, and
 * each component issues only the queries its persona may see — so the money
 * literally never enters the render for a rep. Hiding a fetched number in CSS
 * still ships it in the RSC payload, which is a leak wearing a stylesheet.
 *
 * ORDER MATTERS HERE. The SunBiz redirect stays exactly where it was, ABOVE the
 * persona branch, so SunBiz operators (and their loan_officer / processor
 * roles) keep the behaviour they have today: straight to /t/sun, never through
 * this dispatcher at all.
 *
 * Policy lives in lib/role-surfaces.ts. This file makes no access decisions of
 * its own — it asks, then renders.
 */

import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Card, EmptyState, PageHeader } from "@/components/Card";
import { getActiveProfile, getTenant } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import {
  DEMO_CLIENT_PROFILE_COOKIE,
  getClientCommandCenterProfileById,
  resolveClientProfileSlug,
} from "@/lib/client-profiles";
import { SunBizDashboard } from "@/components/sunbiz/SunBizDashboard";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";
import { FounderToday } from "@/components/today/FounderToday";
import { RepToday } from "@/components/today/RepToday";
import { DeliveryToday } from "@/components/today/DeliveryToday";
import { ManagerToday } from "@/components/today/ManagerToday";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const profile = await getActiveProfile();
  if (!profile) {
    return (
      <div>
        <PageHeader title="Today" subtitle="No operator profile found." />
        <Card title="Set up your profile">
          <EmptyState message="Sign in to load your profile." />
        </Card>
      </div>
    );
  }

  const tenantId = profile.tenant_id || "";
  const rawDemoProfileSlug = (await cookies()).get(DEMO_CLIENT_PROFILE_COOKIE)?.value || null;
  const demoProfileSlug = profile.tenant_id ? null : rawDemoProfileSlug;
  const demoProfile = getClientCommandCenterProfileById(demoProfileSlug);
  const tenantProfileSlug =
    demoProfile.id !== "default"
      ? demoProfile.id
      : tenantId
        ? await safe(
          "today.tenant_profile_slug",
          (async () => {
            const tenant = await getTenant(tenantId);
            return resolveClientProfileSlug(tenant);
          })(),
          null
        )
        : null;
  // SunBiz operators (Matt et al.) land directly on the manifest
  // dashboard at /t/sun. The prior welcome/setup-wizard screen was
  // removed 2026-05-25 per CC — real operators don't need an intro
  // screen on every login; they need the work surface. Demo previews
  // (unauthenticated visitors with the demo cookie) keep the welcome
  // surface so /demo/sun still shows what the onboarding looks like.
  if (tenantProfileSlug === "sun") {
    const isDemo = demoProfile.id === "sun";
    if (!isDemo) {
      redirect("/t/sun");
    }
    return <SunBizDashboard demoMode={isDemo} />;
  }

  const surface = await resolveViewerSurface();
  const viewerName = profile.display_name || profile.full_name || "Operator";

  /**
   * NO RESOLVABLE SESSION CONTEXT — render NOTHING about the tenant.
   *
   * This branch first shipped rendering FounderToday with showFinancials={false},
   * on the reasoning that an unauthorised session should lose the money. That
   * was half a fix and therefore a bug: FounderToday's non-financial reads run
   * unconditionally, so the page still issued priorityInbound (the company
   * mailbox — real subjects and AI summaries), topOpenLead (a named lead with
   * their phone number) and pipelineBreakdown (tenant-wide counts). Suppressing
   * the MRR while serving the inbox is not failing closed.
   *
   * Who lands here is the part that makes it matter. getActiveProfile() falls
   * back to an EMAIL lookup when the auth_user_id match returns nothing (its
   * "post-migration link case"), while resolveSessionContext does not — so a
   * user whose profile row is not linked by auth_user_id gets a truthy profile
   * and a failed session. A freshly-invited contractor with a broken linkage is
   * exactly that shape.
   *
   * So: no tenantId is passed anywhere, no query runs, and the screen says what
   * happened. An unauthorised session gets an explanation, not a dashboard.
   */
  if (!surface.ok) {
    return (
      <div className="space-y-6 animate-fade-in">
        <PageHeader title="Today" subtitle="Session not verified" />
        <Card title="We could not confirm your workspace">
          <EmptyState
            message="You are signed in, but this account is not currently linked to a workspace, so nothing has been loaded. This is an account-linking problem, not missing data. Sign out and back in — if it persists, send CC your account email and he can relink it."
            cta={
              <Link
                href="/login"
                className="inline-flex items-center rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-xs font-bold uppercase tracking-wider text-accent transition-colors hover:bg-accent/15"
              >
                Sign in again
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  if (surface.persona === "sales") {
    return (
      <RepToday
        tenantId={surface.tenantId}
        userId={surface.userId}
        teamRole={surface.teamRole}
        repName={viewerName}
      />
    );
  }

  // The manager MUST have its own branch. Without one it falls through to
  // FounderToday below, which takes `showFinancials` (correctly false here) but
  // consults no other capability — so it would render the whole tenant's
  // pipeline and the company inbound tape to someone whose capability record
  // denies both. A persona without a surface is a leak waiting for its first
  // login.
  if (surface.persona === "manager") {
    return (
      <ManagerToday
        tenantId={surface.tenantId}
        userId={surface.userId}
        managerName={viewerName}
      />
    );
  }

  if (surface.persona === "worker" || surface.persona === "readonly") {
    return (
      <DeliveryToday
        tenantId={surface.tenantId}
        viewerName={viewerName}
        readOnly={surface.persona === "readonly"}
        teamRole={surface.teamRole}
      />
    );
  }

  // founder | legacy. `capabilities.canSeeCompanyFinancials` already folds in
  // the workspace check, so a founder whose tenant lookup degraded gets the
  // dashboard minus the money plus an explanation, rather than a page of zeros.
  return (
    <FounderToday
      profile={profile}
      showFinancials={surface.capabilities.canSeeCompanyFinancials}
      financialsNote={
        surface.degraded
          ? "This workspace could not be confirmed just now, so company revenue was not requested. The numbers are fine — this read failed. Reload in a minute."
          : null
      }
    />
  );
}
