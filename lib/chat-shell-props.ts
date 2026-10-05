/**
 * lib/chat-shell-props.ts — resolve the props the persistent ChatWidget needs.
 *
 * Extracted from app/agent/page.tsx on 2026-06-18 when the chat was hoisted
 * into a persistent layout shell (components/MainShell.tsx) so the live
 * transcript survives soft navigation. layout.tsx resolves these ONCE per full
 * load and threads them to the single persistent ChatWidget instance — the
 * page itself no longer mounts a ChatWidget.
 *
 * THE CODING HARNESS (2026-09-30). That persistent chat is Admin › Coding
 * harness: Claude Code / Codex in a department's repo on the operator's
 * computer, through the bridge. So:
 *   - it resolves for the verified platform operator only. Everyone else gets
 *     null, and /agent sends them to Chief of Staff;
 *   - no tenant means no chat. The old no-tenant fallback handed any profile
 *     without a tenant a working "bravo" chat;
 *   - the picker lists the harness targets (lib/admin/harness-targets.ts:
 *     Chief of Staff & Operations = Business-Empire-Agent, Marketing =
 *     CMO-Agent, Finance = CFO-Agent), not the workspace's agent personas,
 *     which duplicated the department channels;
 *   - only an OASIS workspace has the bridge the harness runs through.
 *
 * Resolved against the OPERATOR'S OWN tenant (profile.tenant_id) — never a
 * previewed/demo tenant.
 */

import "server-only";
import { safe } from "@/lib/api-helpers";
import { getTenant } from "@/lib/queries";
import { resolveAgentKey } from "@/lib/agents";
import { getTenantManifestForUser } from "@/lib/manifest/tenant-scope";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
import { HARNESS_TARGETS, harnessTargetLabels } from "@/lib/admin/harness-targets";

export type ChatShellProps = {
  agentKeys: string[];
  defaultAgent: string;
  isAdmin: boolean;
  welcomeMessages?: Partial<Record<string, string>>;
  advancedPicker: boolean;
  /** Picker labels per agent key; the harness names its repos, not personas. */
  targetLabels?: Record<string, string>;
};

type ProfileLike = {
  tenant_id?: string | null;
  agents_enabled?: string[] | null;
  primary_agent?: string | null;
  display_name?: string | null;
  full_name?: string | null;
  email?: string | null;
} | null;

/**
 * The Coding harness's props for the verified operator, or null (not an
 * operator, no tenant, not an OASIS workspace, or the workspace read failed —
 * logged). Never throws.
 */
export async function resolveChatShellProps(args: {
  profile: ProfileLike;
  userEmail: string | null | undefined;
  /**
   * The VERIFIED platform-operator verdict (lib/platform-operator.ts), computed
   * by the caller on the server. It gates the whole harness and drives
   * `isAdmin`. Required, not derived from `userEmail` here: an email match
   * alone is what a registered alias squatter holds.
   */
  isPlatformOperator: boolean;
}): Promise<ChatShellProps | null> {
  const { profile, isPlatformOperator } = args;
  if (!isPlatformOperator) return null;
  const tenantId = profile?.tenant_id ?? null;
  if (!tenantId) return null;

  const [manifest, tenant] = await Promise.all([
    safe("chatshell.manifest", getTenantManifestForUser(tenantId), null),
    safe("chatshell.tenant", getTenant(tenantId), null),
  ]);
  // getTenant answers null for a failed read as well as a missing row, and
  // throws for neither, so safe() above logs nothing. Log it here: the /agent
  // fallback tells the operator the reason is in the server log.
  if (!tenant) {
    console.error("[chatshell.tenant_unread] the workspace row could not be read or does not exist; the harness is not mounted", { tenantId });
    return null;
  }
  if (!isOasisSurfaceTenant((tenant.slug || "").trim().toLowerCase())) return null;

  const enabled = HARNESS_TARGETS.map((t) => t.agent as string);
  const manifestPrimary = manifest?.agents?.find((a) => a.primary && a.enabled)?.slug;
  const requestedPrimary = resolveAgentKey(manifestPrimary || profile?.primary_agent || "");
  // A primary outside the harness targets never becomes the default.
  const primary = enabled.includes(requestedPrimary) ? requestedPrimary : enabled[0];

  return {
    agentKeys: enabled,
    defaultAgent: primary,
    isAdmin: isPlatformOperator,
    welcomeMessages: undefined,
    advancedPicker: manifest?.ui?.advanced_picker ?? false,
    targetLabels: harnessTargetLabels(),
  };
}
