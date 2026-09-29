/**
 * Who is looking at Settings — resolved once per request.
 *
 * The Settings layout (section nav) and the section page under it both need
 * this, in the same render. React `cache()` makes the second call free, so the
 * session, profile and operator reads each happen once.
 *
 * Operator status is the VERIFIED check (resolvePlatformOperator: an operator
 * email AND an owner/admin seat in OASIS's own workspace, by auth id), never
 * isOperatorEmail on its own — Devices and the local-CLI card hand out bridge
 * access, and signup does not prove ownership of an email address.
 */

import "server-only";

import { cache } from "react";
import { notFound } from "next/navigation";
import { getActiveProfile } from "@/lib/queries";
import { isOasisSurfaceTenant, type Persona } from "@/lib/role-surfaces";
import { isPlatformOperator, resolveViewerSurface } from "@/lib/role-surfaces-session";
import {
  canManageWorkspaceSettings,
  maySeeSettingsSection,
  type SettingsAccess,
  type SettingsSectionKey,
} from "@/components/settings/settings-sections";

/** Verified platform-operator check, deduplicated per request. */
export const isVerifiedOperator = cache(async (): Promise<boolean> => isPlatformOperator());

export type SettingsViewer =
  | {
      ok: true;
      access: SettingsAccess;
      persona: Persona;
      userId: string;
      tenantId: string;
      tenantSlug: string | null;
      /** The narrow capabilities SettingsContent takes (see app/settings/page.tsx). */
      viewerAccess: {
        persona: Persona;
        canSeePersonalSettings: boolean;
        canSeeTeamPerformance: boolean;
        canSeeSystemSurfaces: boolean;
        degraded: boolean;
      };
    }
  | { ok: false };

export const loadSettingsViewer = cache(async (): Promise<SettingsViewer> => {
  const surface = await resolveViewerSurface();
  if (!surface.ok || !surface.capabilities.canSeePersonalSettings) return { ok: false };

  const [profile, isOperator] = await Promise.all([
    getActiveProfile().catch((error) => {
      console.error("[settings.viewer.profile]", error);
      return null;
    }),
    isVerifiedOperator(),
  ]);

  return {
    ok: true,
    persona: surface.persona,
    userId: surface.userId,
    tenantId: surface.tenantId,
    tenantSlug: surface.tenantSlug,
    access: {
      canManage: canManageWorkspaceSettings(profile, surface.capabilities.canSeeSystemSurfaces),
      isOperator,
      canSeeTeamPerformance: surface.capabilities.canSeeTeamPerformance,
      oasisWorkspace: isOasisSurfaceTenant(surface.tenantSlug),
    },
    viewerAccess: {
      persona: surface.persona,
      canSeePersonalSettings: surface.capabilities.canSeePersonalSettings,
      canSeeTeamPerformance: surface.capabilities.canSeeTeamPerformance,
      canSeeSystemSurfaces: surface.capabilities.canSeeSystemSurfaces,
      degraded: surface.degraded,
    },
  };
});

/**
 * Page guard for a Settings section. Call it FIRST in the page, before any
 * read: a viewer who may not open the section gets a 404 (never a 403, which
 * would confirm the page exists), and the data is never fetched.
 */
export async function requireSettingsSection(
  key: SettingsSectionKey,
): Promise<Extract<SettingsViewer, { ok: true }>> {
  const viewer = await loadSettingsViewer();
  if (!viewer.ok || !maySeeSettingsSection(viewer.access, key)) notFound();
  return viewer;
}
