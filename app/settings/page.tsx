/**
 * /settings — Settings › Profile, the first Settings section.
 *
 * The body is components/settings/SettingsContent.tsx (extracted 2026-05-25 so
 * the same surface also mounts under /t/<slug>/settings). Since the OASIS OS
 * split (2026-09-28) each Settings section is its own page under /settings/*;
 * this one renders the Profile section, and forwards the old single-page
 * anchors (#providers, #agents, #integrations, #devices) to the section pages
 * they moved to.
 */

import { SettingsContent } from "@/components/settings/SettingsContent";
import { LegacySettingsHash } from "@/components/settings/LegacySettingsHash";
import { legacyAnchorTargets } from "@/components/settings/settings-sections";
import { loadSettingsViewer } from "@/components/settings/settings-viewer";
import { PageFrame } from "@/components/os/PageFrame";
import { notFound } from "next/navigation";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // Every authenticated OASIS persona receives its own profile, password, and
  // personal-connection Settings. Capability checks inside SettingsContent
  // keep tenant credentials and system controls founder/admin-only, while the
  // manager capability adds the read-only sales scorecard.
  //
  // Gated HERE, not in SettingsContent: the same component is mounted at
  // /t/<slug>/settings for other tenants' operators and must stay untouched.
  const surface = await resolveViewerSurface();
  if (!surface.ok || !surface.capabilities.canSeePersonalSettings) notFound();
  const viewer = await loadSettingsViewer();
  return (
    <PageFrame title="Profile" subtitle="Your name, contact details and sign-in password.">
      {viewer.ok && <LegacySettingsHash targets={legacyAnchorTargets(viewer.access)} />}
      <SettingsContent
        section="profile"
        viewerAccess={
          {
            persona: surface.persona,
            canSeePersonalSettings: surface.capabilities.canSeePersonalSettings,
            canSeeTeamPerformance: surface.capabilities.canSeeTeamPerformance,
            canSeeSystemSurfaces: surface.capabilities.canSeeSystemSurfaces,
            degraded: surface.degraded,
          }
        }
      />
    </PageFrame>
  );
}
