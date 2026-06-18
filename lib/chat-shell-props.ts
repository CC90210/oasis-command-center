/**
 * lib/chat-shell-props.ts — resolve the props the persistent ChatWidget needs.
 *
 * Extracted from app/agent/page.tsx on 2026-06-18 when the chat was hoisted
 * into a persistent layout shell (components/MainShell.tsx) so the live
 * transcript survives soft navigation. layout.tsx resolves these ONCE per full
 * load and threads them to the single persistent ChatWidget instance — the
 * page itself no longer mounts a ChatWidget.
 *
 * Single source of truth: this is the SAME resolution the /agent page used,
 * minus the ?agent= URL override (the client ChatWidget already honours the
 * URL param on its own, and the layout has no searchParams). Keeping it here
 * avoids drift between the layout and any other caller.
 *
 * Resolved against the OPERATOR'S OWN tenant (profile.tenant_id) — never a
 * previewed/demo tenant — so the persistent chat always speaks as the
 * operator's own agent even while they're previewing another tenant's shell.
 */

import "server-only";
import { safe } from "@/lib/api-helpers";
import { getTenant, integrationsHealth } from "@/lib/queries";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { resolveAgentKey } from "@/lib/agents";
import {
  getTenantAwareEnabledAgents,
  getTenantManifestForUser,
} from "@/lib/manifest/tenant-scope";
import type { IntegrationHealth } from "@/lib/supabase";

export type ChatShellProps = {
  agentKeys: string[];
  defaultAgent: string;
  isAdmin: boolean;
  welcomeMessages?: Partial<Record<string, string>>;
  advancedPicker: boolean;
};

type ProfileLike = {
  tenant_id?: string | null;
  agents_enabled?: string[] | null;
  primary_agent?: string | null;
  display_name?: string | null;
  full_name?: string | null;
  email?: string | null;
} | null;

function firstNameOf(name: string | null | undefined, fallback = "Jordan"): string {
  const raw = (name || "").trim();
  if (!raw) return fallback;
  return raw.split(/\s+/)[0] || fallback;
}

/**
 * Returns null when there's no tenant (no chat to render) — e.g. a brand-new
 * signup before tenant provisioning. Never throws; each side query is
 * safe()-wrapped so one failure degrades gracefully rather than blanking the
 * whole layout.
 */
export async function resolveChatShellProps(args: {
  profile: ProfileLike;
  userEmail: string | null | undefined;
}): Promise<ChatShellProps | null> {
  const { profile, userEmail } = args;
  const tenantId = profile?.tenant_id ?? null;
  if (!tenantId) return null;

  const [healthRows, manifest, tenant] = await Promise.all([
    safe("chatshell.health", integrationsHealth(tenantId), [] as IntegrationHealth[]),
    safe("chatshell.manifest", getTenantManifestForUser(tenantId), null),
    safe("chatshell.tenant", getTenant(tenantId), null),
  ]);

  // Manifest-first precedence; falls through to profile.agents_enabled, else
  // empty (never silently "bravo" — that was the cross-tenant leak we sealed).
  const enabledRaw = await getTenantAwareEnabledAgents({
    userTenantId: tenantId,
    profileAgentsEnabled: profile?.agents_enabled ?? null,
  });
  const enabled = enabledRaw.map(resolveAgentKey);
  const manifestPrimary = manifest?.agents?.find((a) => a.primary && a.enabled)?.slug;
  // Family default keyed off the authoritative tenants.slug column:
  //   SunBiz (slug 'submissions') → 'solara'; OASIS / unknown → 'bravo'.
  const tenantFamily = (tenant?.slug || "").toLowerCase();
  const familyDefault = tenantFamily === "submissions" ? "solara" : "bravo";
  const primary = resolveAgentKey(
    manifestPrimary || profile?.primary_agent || enabled[0] || familyDefault,
  );
  const agentKeys = Array.from(new Set([primary, ...enabled])).filter(Boolean);

  const clientName = firstNameOf(profile?.display_name || profile?.full_name);
  const formsHealthy =
    primary === "solara" &&
    healthRows.some((row) => row.service === "lead_forms" && row.status === "healthy");
  const welcomeMessages =
    primary === "solara"
      ? {
          solara: formsHealthy
            ? `Hello ${clientName}, I'm Solara. Your lead-intake forms are live and I'm ready to begin processing your funding pipeline.`
            : `Hello ${clientName}, I'm Solara. I'm in your Command Center and ready to help with leads, follow-up, applications, offers, and renewals.`,
        }
      : primary === "helios"
        ? {
            helios: `Hello ${clientName}, I'm Helios. I'll draft your outreach, run the follow-up cadence, and bring expired offers back to the table — just tell me which lead to open with.`,
          }
        : undefined;

  return {
    agentKeys,
    defaultAgent: primary,
    isAdmin: isOperatorEmail(userEmail),
    welcomeMessages,
    advancedPicker: manifest?.ui?.advanced_picker ?? false,
  };
}
