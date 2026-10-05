/**
 * lib/provisioning/workspace-name.ts - what a workspace is called on screen,
 * and what a new one is called before anyone names it.
 *
 * PURE. The shell header (app/layout.tsx), signup/provisioning defaults and
 * tests share these, so the rule is stated once.
 *
 * WHY. Every account-creating path used to default the workspace brand to
 * "OASIS AI" (signup_tenant's p_brand default, the OAuth callback, the setup
 * CLI). 18 workspaces that belong to strangers are named "OASIS AI" as a
 * result, and the header preferred the viewer's profile.brand (also "OASIS
 * AI") over the workspace's own name, so an operator could not tell workspaces
 * apart and a client could read their own workspace as OASIS's. Renaming those
 * 18 rows is a production write that waits for CC; until then the legacy
 * default is treated as "not named" outside OASIS's own workspaces.
 */

/** The brand every account path used to default to. Never written by new code. */
export const LEGACY_DEFAULT_WORKSPACE_NAME = "OASIS AI";

function firstName(fullName: string | null | undefined, email: string | null | undefined): string {
  const fromName = (fullName || "").trim().split(/\s+/)[0] || "";
  if (fromName && !fromName.includes("@")) return fromName.slice(0, 60);
  const local = (email || "").split("@")[0]?.trim() || "";
  const word = local.split(/[._+-]+/).find(Boolean) || "";
  if (!word) return "";
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * "<First name>'s workspace" for a workspace nobody has named yet. Built from
 * the person's own name (or their email's local part); never a company name we
 * do not know. "New workspace" when there is nothing to build it from.
 */
export function defaultWorkspaceName(fullName: string | null | undefined, email?: string | null): string {
  const first = firstName(fullName, email);
  return first ? `${first}'s workspace` : "New workspace";
}

function named(value: string | null | undefined): string | null {
  const v = (value || "").trim();
  return v ? v.slice(0, 120) : null;
}

/**
 * The name the shell header and sidebar show for the viewer's own workspace:
 * the workspace's own name first (tenants.name), then its manifest brand, then
 * the viewer's profile brand. The legacy "OASIS AI" default counts as unnamed
 * unless this IS one of OASIS's own workspaces, so a stranger's workspace never
 * reads as OASIS's.
 */
export function workspaceDisplayName(input: {
  tenantName: string | null | undefined;
  manifestBrand: string | null | undefined;
  profileBrand: string | null | undefined;
  isOasisWorkspace: boolean;
}): string {
  const usable = (value: string | null | undefined): string | null => {
    const v = named(value);
    if (!v) return null;
    if (!input.isOasisWorkspace && v.toLowerCase() === LEGACY_DEFAULT_WORKSPACE_NAME.toLowerCase()) return null;
    return v;
  };
  return usable(input.tenantName) ?? usable(input.manifestBrand) ?? usable(input.profileBrand) ?? "Workspace";
}
