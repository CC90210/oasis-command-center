/**
 * /onboarding/welcome — first-login personal-settings wizard for invitees.
 *
 * Phase C of the master multi-tenant infra plan (2026-05-17). After an
 * invitee redeems their invite via /invite/<token>, they land here for
 * a quick 3-step personalisation before being released to the dashboard.
 *
 * Step 1 — Confirm identity (name + display name + timezone)
 * Step 2 — Workspace preferences (default agent + daily-briefing channel)
 * Step 3 — Optional: connect a personal AI account (skippable; tenant
 *           default is used until they do)
 *
 * Re-entrant: existing employees can re-open the same wizard from
 * Settings → Personal. The middleware redirect only fires when
 * onboarding_completed_at is null AND invited_by is non-null (i.e. the
 * user joined via an invite and hasn't finished the wizard yet).
 *
 * Server component renders the shell + initial profile snapshot; client
 * component handles the multi-step form state.
 */

import { redirect } from "next/navigation";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getManifestByTenantId } from "@/lib/manifest/loader";
import { getSeedManifest, isUnprovisionedManifest } from "@/lib/manifest/seeds";
import { findActiveConnection } from "@/lib/connections/store";
import { isVerifiedHealthy } from "@/lib/connections/rules";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { OasisLogo } from "@/components/brand/OasisLogo";
import type { ManifestAgentBinding } from "@/lib/manifest/schema";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
import { workspaceTeammates } from "@/lib/os/teammates";
import { WelcomeWizardClient, type WelcomeTeammate } from "./WelcomeWizardClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ settings?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  // `?settings=1` is set by the Settings → Open personalisation wizard
  // link. When present, we render the wizard regardless of tenant
  // state so existing employees can re-edit their timezone / default
  // agent / briefing channel. Without this opt-in flag, tenant-attached
  // invitees auto-redirect to Today (see below).
  const sp = await searchParams;
  const fromSettings = sp?.settings === "1";

  const db = getServiceSupabase();
  const { data: profile } = await db
    .from("user_profiles")
    .select(
      "id, full_name, display_name, email, team_role, primary_agent, custom_fields, tenant_id, onboarding_completed_at, invited_by",
    )
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!profile) {
    // No profile yet — bounce to /onboarding/wizard which handles the
    // fresh-tenant case. (Invitees should always have a profile because
    // the redeem RPC creates one.)
    redirect("/onboarding/wizard");
  }

  const tenant = profile.tenant_id
    ? (
        await db
          .from("tenants")
          .select("id, name, slug, custom_fields")
          .eq("id", profile.tenant_id)
          .maybeSingle()
      ).data
    : null;

  // Invitees joining an existing tenant don't need the new-tenant
  // scaffolding wizard. If they have a tenant attachment AND that
  // tenant resolves to a Command Center profile, skip the wizard and
  // land them where every sign-in lands: /auth/land asks
  // lib/auth-routing.ts homePathForTenant, which is Today ("/") for a
  // workspace like theirs (W1a, U1-05; it was /t/<slug>, the legacy
  // manifest shell). The personalisation flow stays available via
  // Settings → Personal, which appends ?settings=1 so this redirect won't
  // fire for the re-entrant path (CC bug report 2026-05-29).
  if (!fromSettings && tenant) {
    const profileSlug = resolveClientProfileSlug(tenant);
    if (profileSlug) {
      // Through the claim refresh: a session that still carries a "welcome"
      // gate claim would otherwise be sent straight back here (Turso auth).
      redirect(`/api/auth/onboarding-refresh?next=${encodeURIComponent("/auth/land?next=%2F")}`);
    }
  }

  // The workspace's teammates: its own manifest (by tenant id), else its
  // in-code seed. NEVER a fallback agent: the old ["bravo"] default showed
  // OASIS's own agent to every client whose workspace was not set up yet.
  // A failed manifest read is "could not tell", never "not set up": the page
  // says it could not load the teammates (2026-09-30 fix pass; it used to fall
  // through to the seed and tell a member of a set-up workspace that its
  // teammates "appear once it is set up").
  let manifestAgents: ManifestAgentBinding[] = [];
  let teammatesUnknown = false;
  if (profile.tenant_id) {
    let stored: Awaited<ReturnType<typeof getManifestByTenantId>> = null;
    try {
      stored = await getManifestByTenantId(profile.tenant_id);
    } catch (err) {
      console.error("[onboarding.welcome] manifest read failed", err);
      teammatesUnknown = true;
    }
    if (stored) manifestAgents = stored.agents;
    else if (tenant && !teammatesUnknown) {
      const seed = getSeedManifest(resolveClientProfileSlug(tenant), profile.tenant_id);
      if (!isUnprovisionedManifest(seed)) manifestAgents = seed.agents;
    }
  }
  // The workspace's roster (lib/os/teammates.ts), the one the AI Team page and
  // Settings list: each switched-on teammate under its binding's display_name.
  // It used to rename agents through its own label map, and a house agent that
  // leads nothing here (CC's own agents) is not on the roster at all.
  const teammates: WelcomeTeammate[] = workspaceTeammates({
    oasis: isOasisSurfaceTenant(tenant?.slug ?? null),
    manifest: { agents: manifestAgents },
  })
    .filter((t) => t.enabled)
    .map((t) => ({ slug: t.slug, label: t.name }));

  // Slack is offered as a briefing channel only once the workspace has a live
  // Slack connection. A failed read hides it (and is logged).
  let slackConnected = false;
  if (profile.tenant_id && tursoConfigured()) {
    try {
      const slack = await findActiveConnection(getTursoClient(), profile.tenant_id, "slack");
      // The connection hub's own rule for a green card: connected AND a recent
      // healthy check. A claimed-but-unproven connection is not "connected".
      slackConnected = !!slack && isVerifiedHealthy(slack, Date.now());
    } catch (err) {
      console.error("[onboarding.welcome] slack connection read failed; not offering Slack", err);
    }
  }

  return (
    <div className="min-h-screen bg-bg-deep flex flex-col items-center py-12 px-6">
      <div className="w-full max-w-2xl space-y-6">
        <div className="flex justify-center mb-4">
          <OasisLogo />
        </div>

        <header className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-fg">
            Welcome{profile.full_name ? `, ${profile.full_name.split(" ")[0]}` : ""}
          </h1>
          {tenant ? (
            <p className="text-fg-muted text-sm">
              You&apos;ve joined{" "}
              <span className="text-fg font-semibold">{tenant.name || "the workspace"}</span>. Let&apos;s
              set up your personal preferences — takes about a minute.
            </p>
          ) : (
            // An account with no workspace lands here after login (lib/auth-routing.ts).
            // It has joined nothing, so the page does not say it has (2026-09-30 fix pass).
            <p className="text-fg-muted text-sm">
              Your account is not linked to a workspace yet. You can still set your personal preferences now.
            </p>
          )}
        </header>

        <WelcomeWizardClient
          initialProfile={{
            full_name: profile.full_name || "",
            display_name: profile.display_name || "",
            primary_agent: profile.primary_agent || teammates[0]?.slug || "",
            custom_fields: (profile.custom_fields as Record<string, unknown>) || {},
          }}
          teammates={teammates}
          teammatesUnknown={teammatesUnknown}
          slackConnected={slackConnected}
          alreadyCompleted={!!profile.onboarding_completed_at}
        />
      </div>
    </div>
  );
}
