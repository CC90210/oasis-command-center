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
 * OASIS OS (2026-09-28). The owner's branch renders the morning brief
 * (FounderToday → components/os/today). Every other persona keeps its own
 * screen inside the OS page frame. A workspace OASIS has not set up yet gets
 * the "being set up" page and no reads at all (plan D6) — the same answer the
 * rail gives it (Today only).
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
import { PageFrame } from "@/components/os/PageFrame";
import { WorkspaceSetupPending } from "@/components/os/today/WorkspaceSetupPending";
import { getActiveProfile, getTenant } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import {
  DEMO_CLIENT_PROFILE_COOKIE,
  getClientCommandCenterProfileById,
  resolveClientProfileSlug,
} from "@/lib/client-profiles";
import { getManifest } from "@/lib/manifest/loader";
import { isUnprovisionedManifest } from "@/lib/manifest/seeds";
import { SunBizDashboard } from "@/components/sunbiz/SunBizDashboard";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";
import { FounderToday } from "@/components/today/FounderToday";
import { RepToday } from "@/components/today/RepToday";
import { DeliveryToday } from "@/components/today/DeliveryToday";
import { ManagerToday } from "@/components/today/ManagerToday";
import { MarketingToday } from "@/components/today/MarketingToday";
import { CONTACT_EMAIL } from "@/lib/marketing/routes";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const profile = await getActiveProfile();
  if (!profile) {
    return (
      <PageFrame title="Today" subtitle="No profile found for this session.">
        <section className="max-w-2xl rounded-xl border border-hairline bg-bg-panel p-4 text-sm text-fg-muted">
          Sign in to load your profile.
        </section>
      </PageFrame>
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

  /**
   * A WORKSPACE OASIS HAS NOT SET UP (plan D6) gets the "being set up" page
   * before any session or tenant read. Same manifest the layout resolves for
   * this path (getManifest is React-cached per request, so this is a warm hit),
   * so the page and the Today-only rail cannot disagree. Only for a profile
   * that HAS a workspace: one with none is an account-linking problem, and the
   * unverified-session branch below says that instead.
   */
  if (tenantId) {
    const manifest = await safe("today.manifest", getManifest(tenantProfileSlug, tenantId), null);
    if (manifest && isUnprovisionedManifest(manifest)) return <WorkspaceSetupPending />;
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
      <PageFrame title="Today" subtitle="Session not verified">
        <section className="max-w-2xl rounded-xl border border-hairline bg-bg-panel p-4">
          <h2 className="text-sm font-semibold text-fg">We could not confirm your workspace</h2>
          <p className="mt-2 text-sm leading-[22px] text-fg-muted">
            You are signed in, but this account is not currently linked to a workspace, so nothing has been loaded.
            This is an account-linking problem, not missing data. Sign out and back in. If it persists, send us the
            email you sign in with through the{" "}
            <a
              href={SUPPORT_FORM_PATH}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline-offset-2 hover:underline"
            >
              support form
            </a>{" "}
            or to{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent underline-offset-2 hover:underline">
              {CONTACT_EMAIL}
            </a>{" "}
            and we will relink it.
          </p>
          <div className="mt-4">
            <Link href="/login" prefetch={false} className="btn-secondary inline-flex items-center">
              Sign in again
            </Link>
          </div>
        </section>
      </PageFrame>
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

  // Same reasoning as the manager branch above: without one, marketing falls
  // through to FounderToday, which would render the whole pipeline and the
  // company inbound tape.
  if (surface.persona === "marketing") {
    return <MarketingToday viewerName={viewerName} />;
  }

  // builder has its own persona now but the DELIVERY surface is still the
  // right screen for them — it is the work queue. What changed is the nav
  // and the capability record around it, not the dashboard.
  if (
    surface.persona === "worker" ||
    surface.persona === "builder" ||
    surface.persona === "readonly"
  ) {
    return (
      <DeliveryToday
        tenantId={surface.tenantId}
        viewerName={viewerName}
        readOnly={surface.persona === "readonly"}
        teamRole={surface.teamRole}
        viewerUserId={surface.userId}
      />
    );
  }

  // founder | legacy — the morning brief. `capabilities.canSeeCompanyFinancials`
  // already folds in the workspace check, so a founder whose tenant lookup
  // degraded gets the brief minus the money plus an explanation, rather than a
  // page of zeros.
  return (
    <FounderToday
      profile={profile}
      viewer={{
        persona: surface.persona,
        capabilities: surface.capabilities,
        tenantId: surface.tenantId,
        userId: surface.userId,
        tenantSlug: surface.tenantSlug,
      }}
      showFinancials={surface.capabilities.canSeeCompanyFinancials}
      financialsNote={
        surface.degraded
          ? "This workspace could not be confirmed just now, so company revenue was not requested. The numbers are fine — this read failed. Reload in a minute."
          : null
      }
    />
  );
}
