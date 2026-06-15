import ChatWidget from "@/components/ChatWidget";
import { safe } from "@/lib/api-helpers";
import { getActiveProfile, getTenant, integrationsHealth } from "@/lib/queries";
import { getSessionUser } from "@/lib/supabase-server";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { resolveAgentKey } from "@/lib/agents";
import { getTenantAwareEnabledAgents, getTenantManifestForUser } from "@/lib/manifest/tenant-scope";
import type { IntegrationHealth } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function firstNameOf(name: string | null | undefined, fallback = "Jordan"): string {
  const raw = (name || "").trim();
  if (!raw) return fallback;
  return raw.split(/\s+/)[0] || fallback;
}

export default async function ClientAgentPage({
  searchParams,
}: {
  searchParams?: Promise<{ agent?: string }>;
}) {
  const [profile, user, params] = await Promise.all([
    safe("agent.profile", getActiveProfile(), null),
    getSessionUser().catch(() => null),
    searchParams ?? Promise.resolve({} as { agent?: string }),
  ]);
  const [healthRows, manifest, tenant] = await Promise.all([
    safe(
      "agent.health",
      integrationsHealth(profile?.tenant_id || null),
      [] as IntegrationHealth[]
    ),
    safe("agent.manifest", getTenantManifestForUser(profile?.tenant_id ?? null), null),
    // Tenant row — needed for the degraded-state family discriminator
    // below. Codex finding 2026-06-10 [medium]: the manifest's tenant_slug
    // field is "sun" for SunBiz (not "submissions"), AND is null when the
    // manifest lookup fails. Family default must come from the tenants.slug
    // column (= "submissions" for SunBiz), which is authoritative.
    profile?.tenant_id
      ? safe("agent.tenant", getTenant(profile.tenant_id), null)
      : Promise.resolve(null),
  ]);
  // Manifest-first precedence via the shared helper. Returns lowercased
  // slugs from the manifest, OR falls through to profile.agents_enabled,
  // OR empty array (never "bravo" — that was the leak we sealed).
  const enabledRaw = await getTenantAwareEnabledAgents({
    userTenantId: profile?.tenant_id ?? null,
    profileAgentsEnabled: profile?.agents_enabled ?? null,
  });
  const enabled = enabledRaw.map(resolveAgentKey);
  const manifestPrimary = manifest?.agents?.find((a) => a.primary && a.enabled)?.slug;
  // Fallback chain: manifest.primary → profile.primary_agent → enabled[0] →
  // tenant-family default. The family default is keyed off the TENANT ROW
  // slug (authoritative — matches what the bridge proxy gates on at
  // lib/bridge-proxy.ts:GLOBAL_FALLBACK_TENANT_SLUGS), NOT the manifest's
  // `tenant_slug` field (which is "sun" for SunBiz — different concept,
  // and null when the manifest fetch fails — Codex 2026-06-10 [medium]).
  //   SunBiz (tenant.slug='submissions') → 'solara' (ops primary)
  //   OASIS / unknown → 'bravo' (empire flagship)
  const tenantFamily = (tenant?.slug || "").toLowerCase();
  const familyDefault = tenantFamily === "submissions" ? "solara" : "bravo";
  const profilePrimary = resolveAgentKey(
    manifestPrimary || profile?.primary_agent || enabled[0] || familyDefault,
  );
  // Honor ?agent=<slug> only if the user actually has that agent enabled —
  // prevents an arbitrary URL param from making us claim an agent the user
  // didn't purchase. Falls back to their provisioned primary.
  const requested = params?.agent ? resolveAgentKey(params.agent.toLowerCase()) : null;
  const primary = (requested && enabled.includes(requested)) ? requested : profilePrimary;
  // Primary first, then siblings, dedup. If no agents enabled (fresh tenant),
  // fall back to the primary alone so the page still renders something.
  const agentKeys = Array.from(new Set([primary, ...enabled])).filter(Boolean);
  const clientName = firstNameOf(profile?.display_name || profile?.full_name);
  // Service key renamed from "jotform" → "lead_forms" on 2026-06-06
  // (zero data migration cost — integration_health table doesn't carry
  // any historical rows). Status flips to healthy when the tenant has
  // at least one published form on /forms feeding /api/inbound/lead.
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
  // Full-screen Claude-style chat (2026-06-15, hardened). The chat is
  // pinned to the viewport via `fixed` so it fills the screen REGARDLESS
  // of whether the root layout detected this route (the earlier version
  // depended on the layout's isChatShell pathname match — which can be
  // false when middleware doesn't set x-pathname, collapsing the chat to
  // a tiny box). This approach is self-sufficient:
  //   - left tracks the nav sidebar's --sidebar-w var (15rem expanded,
  //     0 collapsed) so the chat reflows when the sidebar toggles, with a
  //     matching transition. On mobile the sidebar is an overlay drawer,
  //     so the chat is full-width (left-0) below the 3.5rem mobile topbar.
  //   - z-20 sits above page content (z-10) but below the sidebar (z-40
  //     mobile / md:z-20, no horizontal overlap) + the floating reopen
  //     button (z-30), so navigation still works.
  // ChatWidget variant="fullscreen" fills this fixed box (definite height
  // from the inset), so the transcript scrolls internally — no collapse.
  return (
    <div className="fixed top-14 md:top-0 left-0 md:left-[var(--sidebar-w,15rem)] right-0 bottom-0 z-20 bg-bg-deep transition-[left] duration-200">
      <ChatWidget
        agentKeys={agentKeys}
        defaultAgent={primary}
        isAdmin={isOperatorEmail(user?.email)}
        welcomeMessages={welcomeMessages}
        // Phase 1 of SunBiz CRM build — read the per-tenant manifest
        // flag. SunBiz / SUGA tenants see no picker (Auto-mode silently
        // routes). Operator-only tenants like OASIS keep the 4-mode
        // dropdown for billing-path control.
        advancedPicker={manifest?.ui?.advanced_picker ?? false}
        variant="fullscreen"
      />
    </div>
  );
}
