import { redirect } from "next/navigation";
import { OnboardingWizardClient } from "@/components/onboarding/OnboardingWizardClient";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { ProvisioningProgress } from "@/components/onboarding/ProvisioningProgress";

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
            return <ProvisioningProgress run={run as any} />;
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
