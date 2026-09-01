/**
 * /settings (top-level) — always renders the signed-in user's home
 * tenant Settings. The body was extracted to components/settings/
 * SettingsContent.tsx on 2026-05-25 so the same surface can also be
 * mounted under /t/<slug>/settings via the manifest catch-all
 * dispatcher (kind="settings"). Single source of truth across both
 * routes — see SettingsContent for the full render logic.
 */

import { SettingsContent } from "@/components/settings/SettingsContent";
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
  return (
    <SettingsContent
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
  );
}
