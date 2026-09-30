import { redirect } from "next/navigation";
import Link from "next/link";
import { OnboardingWizardClient, type WizardOptions } from "@/components/onboarding/OnboardingWizardClient";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { OasisLogo } from "@/components/brand/OasisLogo";
import { isPlatformOperator } from "@/lib/role-surfaces-session";
import { wizardAccess } from "@/lib/provisioning/wizard-access";
import { getManifestSlugForTenant } from "@/lib/manifest/persistence";
import { departmentProfile } from "@/components/os/department/config";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { DEFAULT_DEPARTMENTS, OPT_IN_MODULES, neutralTeamFor } from "@/lib/provisioning/team";

export const dynamic = "force-dynamic";

/**
 * /onboarding/wizard — a workspace OWNER sets up their own workspace.
 *
 * Renders full-bleed (no sidebar) because the layout exempts /onboarding
 * prefixes. The client component runs the state machine; the finalize
 * POST lives at /api/onboarding/wizard.
 *
 * GATE (2026-09-30): the same rule as the API (lib/provisioning/wizard-access.ts)
 * - the workspace owner, or a verified platform operator. A member sees a plain
 * "only the owner can set this up" page and never the form: the old page gated
 * only on onboarding_completed_at, so an invited member could open it and, via
 * the API's first-owner promotion, make themselves owner.
 *
 * Done already (onboarding finished, or the workspace already set up) goes to
 * "/" through /api/auth/onboarding-refresh, which also clears a stale gate
 * claim from the session so the person is not sent back here.
 */
export default async function OnboardingWizardPage() {
  const user = await getSessionUser().catch(() => null);
  if (!user) redirect("/login?next=/onboarding/wizard");

  const access = await wizardAccess(user);
  if (!access.ok) return <NotForYou reason={access.reason} />;

  try {
    const db = getServiceSupabase();
    const { data } = await db
      .from("user_profiles")
      .select("onboarding_completed_at")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    const alreadySetUp = await getManifestSlugForTenant(access.profile.tenant_id);
    if (!access.operator && (data?.onboarding_completed_at || alreadySetUp)) {
      // A setup run OASIS has open for this workspace is shown as such.
      if (tursoConfigured()) {
        const turso = getTursoClient();
        const r = await turso.execute({
          sql: `SELECT * FROM provisioning_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`,
          args: [access.profile.tenant_id],
        });
        const run = r.rows[0];
        if (run && run.status !== "complete" && run.status !== "failed") {
          return <WorkspaceBeingSetUp />;
        }
      }
      redirect("/api/auth/onboarding-refresh?next=/");
    }
  } catch (err) {
    // Allow the page to render — if the DB lookup transiently fails we'd
    // rather show the wizard than 500. Logged for ops visibility.
    if ((err as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw err;
    console.error("[onboarding.wizard.gate]", err);
  }

  // Only the verified platform operator is offered the bridge install at the
  // end (F0 containment); isPlatformOperator fails closed on a lookup error.
  const canInstallBridge = await isPlatformOperator();
  const tenantRead = await getServiceSupabase()
    .from("tenants")
    .select("name")
    .eq("id", access.profile.tenant_id)
    .maybeSingle();
  const workspaceName = String((tenantRead.data as { name?: unknown } | null)?.name ?? "").trim();
  const options: WizardOptions = {
    workspaceName,
    departments: OS_DEPARTMENTS.map((d) => ({
      key: d.key,
      label: d.label,
      purpose: departmentProfile(d.key).purpose,
      teammate: neutralTeamFor([d.key])[0]?.display_name ?? null,
      locked: d.key === "chief_of_staff",
    })),
    defaultDepartments: [...DEFAULT_DEPARTMENTS],
    modules: OPT_IN_MODULES.map((m) => ({ key: m.key, label: m.label, description: m.description })),
  };
  return <OnboardingWizardClient userEmail={user.email || ""} canInstallBridge={canInstallBridge} options={options} />;
}

function NotForYou({ reason }: { reason: string }) {
  return (
    <div className="min-h-screen bg-bg-deep flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4">
        <div className="flex justify-center mb-6">
          <OasisLogo />
        </div>
        <div className="rounded-2xl border border-bg-border bg-bg-elev p-6 space-y-3">
          <h1 className="text-lg font-bold text-fg">Workspace setup</h1>
          <p className="text-sm text-fg-muted leading-relaxed">{reason}</p>
          <Link href="/" prefetch={false} className="inline-block text-sm font-medium text-accent hover:underline">
            Go to your workspace
          </Link>
        </div>
      </div>
    </div>
  );
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
