import { redirect } from "next/navigation";
import { OnboardingWizardClient } from "@/components/onboarding/OnboardingWizardClient";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { OasisLogo } from "@/components/brand/OasisLogo";

export const dynamic = "force-dynamic";

/**
 * /onboarding/wizard — industry-template onboarding flow.
 *
 * Renders full-bleed (no sidebar) because the layout exempts /onboarding
 * prefixes. The client component runs the state machine; the finalize
 * POST lives at /api/onboarding/wizard.
 *
 * Already-onboarded users get redirected to "/" so they don't accidentally
 * re-create their tenant. This is the canonical onboarding gate — the
 * legacy /onboarding page now redirects here, and the middleware sends
 * un-onboarded users here on every signed-in page load.
 */
export default async function OnboardingWizardPage() {
  const user = await getSessionUser().catch(() => null);
  if (!user) redirect("/login?next=/onboarding/wizard");

  // If the user already completed onboarding (either via the legacy
  // /onboarding flow OR via brand-hinted provisioning that sets
  // onboarding_completed_at automatically), don't make them walk the
  // wizard again — send them to their dashboard.
  try {
    const db = getServiceSupabase();
    const { data } = await db
      .from("user_profiles")
      .select("onboarding_completed_at")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    if (data?.onboarding_completed_at) {
      // Before redirecting to dashboard, check if there's an active automated provisioning run
      if (tursoConfigured()) {
        const { data: profile } = await db
          .from("user_profiles")
          .select("tenant_id")
          .eq("auth_user_id", user.id)
          .maybeSingle();

        if (profile?.tenant_id) {
          const turso = getTursoClient();
          const r = await turso.execute({
            sql: `SELECT * FROM provisioning_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`,
            args: [profile.tenant_id],
          });
          const run = r.rows[0];
          if (run && run.status !== "complete" && run.status !== "failed") {
            return <WorkspaceBeingSetUp />;
          }
        }
      }
      redirect("/");
    }
  } catch (err) {
    // Allow the page to render — if the DB lookup transiently fails we'd
    // rather show the wizard than 500. Logged for ops visibility.
    if ((err as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw err;
    console.error("[onboarding.wizard.gate]", err);
  }

  return <OnboardingWizardClient userEmail={user.email || ""} />;
}

/**
 * Shown while a provisioning run is open for this workspace.
 *
 * WHY THIS REPLACED ProvisioningProgress (2026-09-28, P0-2). That screen said
 * "Payment verified", listed the run's steps and refreshed every 3 seconds.
 * The only writer of provisioning_runs was /api/webhooks/stripe-provision,
 * which checked no signature and took the tenant id from the request body, so
 * anyone could make any workspace's owner see a payment confirmation and
 * progress that never happened. The route is deleted. Until a verified billing
 * webhook writes real runs, this page claims nothing it cannot know: no
 * payment status, no steps, no polling.
 */
function WorkspaceBeingSetUp() {
  return (
    <div className="min-h-screen bg-bg-deep flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4">
        <div className="flex justify-center mb-6">
          <OasisLogo />
        </div>
        <div className="rounded-2xl border border-bg-border bg-bg-elev p-6 space-y-2">
          <h1 className="text-lg font-bold text-fg">OASIS sets up your workspace</h1>
          <p className="text-sm text-fg-muted leading-relaxed">
            Your workspace is being prepared by the OASIS team. It opens here once setup is done,
            and there is nothing you need to do on this page.
          </p>
        </div>
      </div>
    </div>
  );
}
