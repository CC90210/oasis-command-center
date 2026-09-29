/**
 * The Settings section list, and who may open each section — declared once.
 *
 * Settings is split into one page per section (docs/os-revamp/01 §(c) "Settings
 * split"). The left-hand section nav (app/settings/layout.tsx) and every
 * section page's own gate read the SAME predicate below, so a section link can
 * never sit over a 404 and a page can never be reachable when its link is
 * hidden. Same contract as the rail's `mayOpenOsHref`.
 *
 * PURE: no session, no database. The server resolves a `SettingsAccess` once
 * per request (components/settings/settings-viewer.ts) and passes it in, which
 * is what lets tests/os-connectors.test.ts exercise every persona in bare node.
 */

export type SettingsSectionKey =
  | "profile"
  | "team"
  | "connections"
  | "chat-apps"
  | "ai"
  | "brand"
  | "billing"
  | "notifications"
  | "privacy"
  | "audit-log"
  | "devices";

/**
 *   everyone          any member who can open Settings at all
 *   manage            workspace owner / admin (canManageWorkspaceSettings)
 *   team              manage, OR a sales manager on the OASIS workspace (their
 *                     read-only team scorecard lives here)
 *   team_performance  capabilities.canSeeTeamPerformance — the audit log's own gate
 *   operator          a verified platform operator (resolvePlatformOperator)
 */
export type SettingsAudience = "everyone" | "manage" | "team" | "team_performance" | "operator";

export type SettingsSectionDef = {
  key: SettingsSectionKey;
  href: string;
  label: string;
  audience: SettingsAudience;
};

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  { key: "profile", href: "/settings", label: "Profile", audience: "everyone" },
  { key: "team", href: "/settings/team", label: "Team", audience: "team" },
  { key: "connections", href: "/settings/connections", label: "Connections", audience: "everyone" },
  { key: "chat-apps", href: "/settings/chat-apps", label: "Chat apps", audience: "everyone" },
  { key: "ai", href: "/settings/ai", label: "AI brain", audience: "manage" },
  { key: "brand", href: "/settings/brand", label: "Brand & domain", audience: "manage" },
  { key: "billing", href: "/settings/billing", label: "Billing & add-ons", audience: "manage" },
  { key: "notifications", href: "/settings/notifications", label: "Notifications", audience: "everyone" },
  { key: "privacy", href: "/settings/privacy", label: "Data & privacy", audience: "everyone" },
  { key: "audit-log", href: "/settings/audit-log", label: "Audit log", audience: "team_performance" },
  { key: "devices", href: "/settings/devices", label: "Devices", audience: "operator" },
];

/** What the section gates need to know about the viewer. */
export type SettingsAccess = {
  /** Owner / admin / admin-access toggle, on a surface with system access. */
  canManage: boolean;
  /** Verified platform operator — never the session email alone. */
  isOperator: boolean;
  canSeeTeamPerformance: boolean;
  /** The workspace is one of OASIS's own (isOasisSurfaceTenant). */
  oasisWorkspace: boolean;
};

export function maySeeSettingsSection(access: SettingsAccess, key: SettingsSectionKey): boolean {
  const def = SETTINGS_SECTIONS.find((s) => s.key === key);
  if (!def) return false;
  switch (def.audience) {
    case "everyone":
      return true;
    case "manage":
      return access.canManage;
    case "team":
      return access.canManage || (access.canSeeTeamPerformance && access.oasisWorkspace);
    case "team_performance":
      return access.canSeeTeamPerformance;
    case "operator":
      return access.isOperator;
    default:
      // A new audience word with no rule here is refused, not waved through.
      return false;
  }
}

export function visibleSettingsSections(access: SettingsAccess): SettingsSectionDef[] {
  return SETTINGS_SECTIONS.filter((s) => maySeeSettingsSection(access, s.key));
}

/**
 * Owner / admin rights over workspace Settings (branding, shared keys, AI setup,
 * team, agents). Base owner/admin, or the admin_access toggle — and only on a
 * surface that already grants system access.
 *
 * Lifted out of SettingsContent unchanged so the section nav and the section
 * bodies decide "is this person an admin here" with one rule, not two copies.
 */
export function canManageWorkspaceSettings(
  profile: {
    is_owner?: boolean | number | null;
    team_role?: string | null;
    admin_access?: boolean | null;
  } | null,
  canSeeSystemSurfaces: boolean | undefined,
): boolean {
  return (
    !!profile &&
    (!!profile.is_owner ||
      profile.team_role === "owner" ||
      profile.team_role === "admin" ||
      profile.admin_access === true) &&
    (canSeeSystemSurfaces ?? true)
  );
}

/**
 * Old single-page anchors, and the section page each one now lives on.
 *
 * `/settings#providers` and `/settings#agents` are linked from chat FAILURE
 * states; `/settings#integrations` is where the Google OAuth callback and the
 * setup checklist send people. Those links keep working: /settings forwards the
 * fragment to its new page — but only when the viewer may open that page, so a
 * rep following an admin-only link stays on their own Settings instead of
 * landing on a 404.
 */
export const LEGACY_SETTINGS_ANCHORS: Readonly<Record<string, SettingsSectionKey>> = {
  providers: "ai",
  agents: "ai",
  integrations: "connections",
  devices: "devices",
};

/** The fragment → href map a given viewer may be forwarded along. */
export function legacyAnchorTargets(access: SettingsAccess): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [hash, key] of Object.entries(LEGACY_SETTINGS_ANCHORS)) {
    if (!maySeeSettingsSection(access, key)) continue;
    const def = SETTINGS_SECTIONS.find((s) => s.key === key);
    if (def) out[hash] = def.href;
  }
  return out;
}
