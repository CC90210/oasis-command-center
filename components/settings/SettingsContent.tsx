/**
 * SettingsContent — shared body of the Settings surface.
 *
 * Used by:
 *   - `app/settings/page.tsx` (top-level, always rendered for the
 *     signed-in user's home tenant)
 *   - `components/settings/TenantSettings.tsx` (mounted by the catch-all
 *     dispatcher for the `settings` page kind, scoped to a specific
 *     tenant slug under /t/<slug>/settings)
 *
 * Single source of truth — extracted 2026-05-25 to fix the cross-tenant
 * Settings leak. Previously the Sun Biz tenant's "Settings" nav link
 * pointed at top-level /settings, which always showed the operator's
 * OWN data even when the operator was previewing a tenant they didn't
 * own. Routing /t/sun/settings through the catch-all (with the
 * `settings` page kind) lets the catch-all gate render via
 * resolveDataTenant() — when the operator doesn't own the tenant, this
 * component renders in preview mode (no fetches, no data, scaffold only).
 *
 * Real-mode rendering is byte-identical to the prior SettingsPage. The
 * only logical change is the `previewMode` short-circuit at the top.
 */

import Link from "next/link";
import { Card, PageHeader, Tag, EmptyState } from "@/components/Card";
import { IntegrationDot } from "@/components/IntegrationDot";
import {
  getActiveProfile,
  integrationsHealth,
  getTenant,
  aiServicesWithKey,
  getBridgeOnline,
} from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { CustomCredentialsVault } from "@/components/settings/CustomCredentialsVault";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { OpenSectionOnHash } from "@/components/settings/OpenSectionOnHash";
import { ProfileEditor } from "@/components/settings/ProfileEditor";
import { BrandLogoCard } from "@/components/settings/BrandLogoCard";
import { QuickInviteCard } from "@/components/settings/QuickInviteCard";
import { TelegramLinkCard } from "@/components/settings/TelegramLinkCard";
import { AgentConfigEditor } from "@/components/settings/AgentConfigEditor";
import { IntegrationKeysPanel } from "@/components/settings/IntegrationKeysPanel";
import { PersonalIntegrationsPanel } from "@/components/settings/PersonalIntegrationsPanel";
import { TelegramConnectCard } from "@/components/settings/TelegramConnectCard";
import { SafeBoundary } from "@/components/SafeBoundary";
import { AgentMarketplaceCard } from "@/components/settings/AgentMarketplaceCard";
import { KixieWebhookSyncCard } from "@/components/settings/KixieWebhookSyncCard";
import { DevicesEditor } from "@/components/settings/DevicesEditor";
import { OperationsTrackerPanel } from "@/components/settings/OperationsTrackerPanel";
import { ProviderAccountsCard } from "@/components/settings/ProviderAccountsCard";
import { LocalCliProvidersCard } from "@/components/settings/LocalCliProvidersCard";
import { TOOL_DEFINITIONS } from "@/lib/cloud-tool-runner";
import { chatAgentKeys } from "@/lib/agent-personas";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getManifest } from "@/lib/manifest/loader";
import { resolveEnabledAgentSlugs } from "@/lib/manifest/agent-roster";
import { visibleIntegrationsForTenant } from "@/lib/integrations-registry";
import { isSharedInboxTenant } from "@/lib/shared-inbox-tenants";
import { resolveAgentKey } from "@/lib/agents";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { getSessionUser } from "@/lib/supabase-server";
import type { IntegrationHealth } from "@/lib/supabase";

/**
 * `previewMode = true` is set by TenantSettings when the operator is
 * viewing a tenant they don't own (resolveDataTenant returned null).
 * In that case we render the same Card chrome the real Settings page
 * has, but with empty scaffolds in place of every sub-component —
 * critically, NO sub-component mounts, so no client-side fetch can
 * leak operator-scoped data (CC's devices, AI keys, profile, etc.)
 * into the tenant view.
 *
 * `tenantSlug` is passed in preview-mode renders so the empty scaffold
 * can correctly label "for <tenant>" without referencing the operator's
 * own tenant.
 */
export async function SettingsContent({
  previewMode = false,
  tenantSlug,
  hideHeader = false,
}: {
  previewMode?: boolean;
  tenantSlug?: string;
  /**
   * When mounted by the catch-all dispatcher under /t/<slug>/settings,
   * the dispatcher already renders its own PageHeader for the page —
   * suppress the inner one to avoid the same duplicate-header bug we
   * hit on Offers / Lenders / Shopping Out earlier this week.
   * Top-level /settings (no outer PageHeader) leaves this false.
   */
  hideHeader?: boolean;
}) {
  if (previewMode) {
    return <PreviewSettings tenantSlug={tenantSlug ?? "this tenant"} hideHeader={hideHeader} />;
  }

  const profile = await safe("settings.profile", getActiveProfile(), null);
  const [integrations, tenant, connectedAiSet, user, bridgeOnline] = await Promise.all([
    safe("settings.integrations_health", integrationsHealth(profile?.tenant_id || null), []),
    profile?.tenant_id ? safe("settings.tenant", getTenant(profile.tenant_id), null) : Promise.resolve(null),
    safe("settings.ai_keys", aiServicesWithKey(profile?.tenant_id || null), new Set<string>()),
    getSessionUser().catch(() => null),
    safe("settings.bridge_online", getBridgeOnline(profile?.tenant_id ?? null), false),
  ]);

  const manifestSlug = tenant ? resolveClientProfileSlug(tenant) : null;
  const manifest = manifestSlug
    ? await safe("settings.manifest", getManifest(manifestSlug), null)
    : null;

  const manifestAgentKeys = resolveEnabledAgentSlugs({
    manifestAgents: manifest ? manifest.agents || [] : null,
    legacyProfileAgents: profile?.agents_enabled,
  });
  // Fail closed when neither the manifest nor the legacy profile supplies a
  // roster. Falling back to every chat persona here leaked OASIS agents into
  // tenants whose manifest lookup failed.
  const effectiveAgentKeys = manifestAgentKeys;
  const enabledAgents = effectiveAgentKeys.map(resolveAgentKey);
  const enabledChatAgentKeys = chatAgentKeys().filter((k) => enabledAgents.includes(k));
  const isOperator = isOperatorEmail(user?.email || undefined);
  const teamProfile = profile as
    | (typeof profile & { is_owner?: boolean; team_role?: string; admin_access?: boolean | null })
    | null;
  // Full-admin capability: base owner/admin OR the admin_access toggle grant.
  // Unlocks Settings cards (branding, integration keys, plan templates, cron
  // jobs, automations, agent config) for a toggled agent. Admin-toggle 2026-07-07.
  const canManageTenant =
    !!teamProfile &&
    (teamProfile.is_owner ||
      teamProfile.team_role === "owner" ||
      teamProfile.team_role === "admin" ||
      teamProfile.admin_access === true);
  const visibleDefs = visibleIntegrationsForTenant(enabledAgents, { isOperator });
  const visibleServices = new Set(visibleDefs.map((d) => d.service));
  const visibleIntegrations = integrations.filter((h: IntegrationHealth) => visibleServices.has(h.service));

  return (
    <div className="space-y-6 animate-fade-in">
      {!hideHeader && (
        <PageHeader
          title={tenant?.name ? `Settings · ${tenant.name}` : "Settings"}
          subtitle={
            tenant?.name
              ? `Editing the ${tenant.name} tenant. Switch tenants to manage a different one — integrations + creds + team are all per-tenant.`
              : "Profile, AI setup, business app keys, team controls, and read-only integration health."
          }
        />
      )}

      {/* Eight links across the app point at /settings#providers and
          #agents — several from chat FAILURE states. Now that the sections
          collapse, the browser scrolls to a closed bar and the control the
          error sent you for stays hidden. This opens it. */}
      <OpenSectionOnHash />

      {/* Batch 4: self-serve Telegram linking for per-lead application alerts. */}
      <TelegramLinkCard />

      {!profile ? (
        <Card title="No profile loaded">
          <EmptyState message="Sign in to edit your profile." />
        </Card>
      ) : (
        <>
          <SettingsSection
            title="Profile"
            subtitle={`Signed in as ${profile.email}`}
            action={
              <div className="flex items-center gap-2">
                {canManageTenant && (
                  <a
                    href="/settings/audit-log"
                    className="text-xs text-accent hover:text-accent/80 underline underline-offset-2"
                  >
                    Audit log →
                  </a>
                )}
              </div>
            }
          >
            <SafeBoundary label="Profile editor">
              <ProfileEditor
                key={manifestAgentKeys.join(":")}
                profile={profile}
                tenantAgents={manifestAgentKeys}
              />
            </SafeBoundary>
          </SettingsSection>

          <SettingsSection
            title="Branding"
            subtitle="Your logo is applied to every new form, public application page, and anywhere else the dashboard shows your brand."
          >
            <SafeBoundary label="Branding">
              <BrandLogoCard initialLogoUrl={tenant?.logo_url ?? null} canManage={canManageTenant} />
            </SafeBoundary>
          </SettingsSection>

          {/* Credentials — single parent Card with two clearly-labeled
              sub-sections. Was previously two top-level cards
              (Integration Keys + Custom Credentials) which CC read as
              redundant ("there are two sections for uploading and
              storing your credentials"). They actually serve different
              purposes — structured known integrations with health
              checks vs raw KEY=VALUE for anything else — but the
              parent grouping makes that obvious. */}
          <SettingsSection
            defaultOpen
            title="Credentials"
            subtitle="All your API keys, OAuth tokens, and webhook URLs in one place. Known integrations get health-checked; custom KEY=VALUE secrets cover anything else your agents need."
          >
            {/* FOLDED, 2026-08-17. Both panels rendered open, which made this one
                card the tallest thing on the page and buried everything under it.
                Known integrations opens by default because it is the one people
                come here for; custom secrets is the long tail and starts closed.
                Each header keeps its description while collapsed — a fold that
                hides what is behind it just makes you open all of them. */}
            <div className="space-y-3">
              <SettingsSection
                tone="nested"
                title="Known integrations"
                subtitle="Pre-configured slots for services your agents already know how to use (Gmail, Stripe, Telegram…). Live health check plus paste-once setup."
                defaultOpen
              >
                <SafeBoundary label="Integration keys">
                  <IntegrationKeysPanel canManage={canManageTenant} />
                </SafeBoundary>
              </SettingsSection>

              {canManageTenant && (
                <SettingsSection
                  tone="nested"
                  title="Custom secrets"
                  subtitle="Anything that doesn't fit a known slot — client tokens, one-off webhook URLs, internal keys. Encrypted at rest; agents read them via get_credential."
                >
                  <SafeBoundary label="Custom credentials vault">
                    <CustomCredentialsVault />
                  </SafeBoundary>
                </SettingsSection>
              )}
            </div>
          </SettingsSection>

          {/* Kixie webhook auto-registration — only when the tenant
              actually declares Kixie in its required_services list.
              Avoids cluttering non-Kixie tenants (OASIS, etc.) with a
              button that has no effect. */}
          {!previewMode && (manifest?.required_services || []).some((s) => s.service === "kixie") && (
            <SafeBoundary label="Kixie webhooks">
              <KixieWebhookSyncCard isOwner={canManageTenant} />
            </SafeBoundary>
          )}

          {/* Phase 4 of SunBiz multi-employee personalization (2026-05-29):
              per-user credentials section. Today this hosts Gmail OAuth
              so each employee can send mail from their own address.
              Tenant-shared credentials (TextTorrent, Kixie, etc.) stay
              in the IntegrationKeysPanel above.
              SunBiz directive 2026-05-31: hidden for shared-inbox tenants
              since per-user OAuth has no effect on outbound (send_gateway
              ignores it for these tenants — see user_gmail_oauth.py
              _SHARED_INBOX_SLUGS). Showing the panel would tell the
              operator to do something that doesn't change their sends. */}
          {/* Personal integrations: always render so every employee can
              set their Kixie agent email (Phase 5 of TT + Kixie embedding).
              Gmail row is suppressed for shared-inbox tenants since
              outbound goes through the shared submissions@ identity
              and a personal Gmail OAuth has no effect. */}
          <SafeBoundary label="Personal integrations">
            <PersonalIntegrationsPanel
              showGmail={!isSharedInboxTenant(tenant?.slug ?? null)}
              // Kixie row only renders for tenants that have Helios enabled
              // (the SunBiz click-to-call agent that consumes the per-employee
              // Kixie email). CC 2026-06-06: OASIS personal (bravo/atlas/maven/
              // aura) was showing the row even though it doesn't use Kixie.
              showKixie={enabledAgents.includes("helios")}
            />
          </SafeBoundary>

          <SafeBoundary label="Telegram bot">
            <TelegramConnectCard />
          </SafeBoundary>

          {canManageTenant && (
            <SettingsSection
              title="Team"
              subtitle="Invite teammates so they can sign into this tenant. Each invite is a one-time link — send it via Slack / email / SMS."
              action={
                <a
                  href="/team"
                  className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent-bright"
                >
                  Manage team & invites →
                </a>
              }
            >
              <SafeBoundary label="Team invites">
                <QuickInviteCard />
              </SafeBoundary>
              <p className="text-[11px] text-fg-dim leading-relaxed mt-3">
                Invitees land on /invite/&lt;token&gt;, sign up, and join this tenant automatically.
                Enabled workspace agents recognize them by name and respect their role.
              </p>
            </SettingsSection>
          )}

          {/* "Known facts about you" removed 2026-08-17. It shipped with
              placeholder text still in the box — "Your Name", "Your LLC",
              "https://cal.com/your-handle" — which every cloud chat was
              injecting as authoritative operator context. A field nobody filled
              in is not neutral when its DEFAULT is fed to the model as fact. The
              same context now lives where it is actually true: brain/USER.md and
              the agent entry points. */}

          {/* Custom Credentials card removed 2026-06-06 — moved into the
              unified "Credentials" parent Card above so the operator sees
              one credentials surface, not two separate top-level cards
              that look redundant. */}

          <SettingsSection title="Password" subtitle="Change your sign-in password">
            <SafeBoundary label="Password form">
              <ChangePasswordForm />
            </SafeBoundary>
          </SettingsSection>

          {canManageTenant && (
            <SettingsSection
              id="devices"
              title="Devices (advanced)"
              subtitle="Pair a machine on your network to run the local bridge — gives your agents file-system, bash, and full MCP access. Optional: a connected AI provider account below is enough for chat without ever pairing a machine."
              action={
                <Link
                  href="/settings/devices/install"
                  className="inline-flex items-center gap-1 rounded-lg bg-accent text-bg-deep px-3 py-1.5 text-xs font-bold hover:bg-accent-bright"
                >
                  Pair a machine →
                </Link>
              }
            >
              <SafeBoundary label="Devices">
                <DevicesEditor />
              </SafeBoundary>
            </SettingsSection>
          )}

          <SettingsSection
            id="providers"
            title="AI setup"
            subtitle={
              canManageTenant
                ? "Connect one AI account here — every agent uses it by default. OpenRouter is the easiest (one key powers every model). Anthropic, OpenAI, and Google are the per-vendor alternatives."
                : "These are the team's AI accounts. Your admin connects them once — your chats route through whichever account they pick."
            }
          >
            <SafeBoundary label="AI provider accounts">
              <ProviderAccountsCard
                connectedServices={connectedAiSet}
                bridgeOnline={bridgeOnline}
                canManageTeam={canManageTenant}
              />
            </SafeBoundary>
          </SettingsSection>

          {isOperator && (
            <SafeBoundary label="Local CLI providers">
              <LocalCliProvidersCard serverBridgeOnline={bridgeOnline} />
            </SafeBoundary>
          )}

          <SettingsSection
            id="agents"
            title="Override an agent's provider"
            subtitle="Optional. Each agent uses the workspace default from AI setup above unless you set a specific provider here. Edit a row to switch which provider that agent uses."
            action={
              <Tag tone={bridgeOnline ? "engaged" : "neutral"}>
                {bridgeOnline ? "Tool access: bridge online" : "Tool access: cloud only"}
              </Tag>
            }
          >
            {canManageTenant ? (
              <SafeBoundary label="Override an agent's provider">
                <AgentConfigEditor
                  agentKeys={enabledChatAgentKeys}
                  bridgeOnline={bridgeOnline}
                  globallyConnectedServices={Array.from(connectedAiSet)}
                  agentPalettes={Object.fromEntries(
                    (manifest?.agents || []).map((a) => [
                      a.slug.toLowerCase(),
                      a.tool_palette,
                    ])
                  )}
                  manifestSlug={manifestSlug}
                  toolCatalog={TOOL_DEFINITIONS.map((t) => ({
                    name: t.name,
                    description: t.description,
                    defer: !!t.defer,
                  }))}
                />
              </SafeBoundary>
            ) : (
              <EmptyState message="Team-wide AI setup is managed by an owner or admin. Ask them to connect a provider, or set one per agent in the override table below." />
            )}
          </SettingsSection>

          {/* "Just-for-me overrides" removed 2026-08-17. It let an individual
              point their own chats at a different AI account — a team feature on
              a single-operator workspace, where it only ever added a second
              place for the provider to be configured and a second place for it
              to be wrong. Provider selection lives in AI Setup and, per agent,
              in the override table below. */}

          {/* Workspace agents (Bravo / Atlas / Maven add-on picker).
              Owner-only — non-owners see a read-only view of which
              agents the workspace has, but cannot toggle. Core agents
              (Solara/Helios for SunBiz) render as locked. */}
          {!previewMode && manifest?.agents && (
            <Card
              title="Workspace agents"
              subtitle="Manage which agents this workspace can use. Core agents are always on; add C-suite agents (Bravo / Atlas / Maven / Aura / Hermes) when your team needs them."
            >
              <SafeBoundary label="Workspace agents">
                <AgentMarketplaceCard
                  initialAgents={(manifest.agents || []).map((a) => ({
                    slug: a.slug,
                    display_name: a.display_name || a.slug,
                    enabled: a.enabled,
                    primary: a.primary,
                    core: a.core,
                  }))}
                  isOwner={canManageTenant}
                />
              </SafeBoundary>
            </Card>
          )}

          {/* Weekday/Weekend template editors removed 2026-08-17 alongside the
              "The day" card on /today that consumed them. /schedule is the live
              planner now. Configuring a template for a surface that no longer
              renders is a control with nothing on the other end. */}

          <SettingsSection
            title="Integration health"
            subtitle={
              isOperator
                ? "Read-only status across every connected system (operator view - includes platform infra). Save business app keys in the Business app keys card above."
                : "Read-only status across the systems your enabled agents actually use. Save credentials in Business app keys; enable more agents to unlock additional integrations."
            }
          >
            <div className="grid sm:grid-cols-2 gap-3">
              {visibleIntegrations.map((h: IntegrationHealth) => (
                <IntegrationDot
                  key={h.service}
                  health={h}
                  connection={{ hasCredentials: connectedAiSet.has(h.service) }}
                />
              ))}
              {visibleIntegrations.length === 0 && (
                <div className="col-span-full text-sm text-fg-muted">
                  No integrations active for your current agent set. Enable an agent above to see what they need.
                </div>
              )}
            </div>
          </SettingsSection>

          {/* CC ask 2026-06-11: "an overall tracker [hidden in Settings],
              very important feature." Read-only operations view at the
              very bottom — daemons, sequences, employee activity in
              one place. Mutations live on the surfaces it tracks. */}
          <SafeBoundary label="operations-tracker">
            <OperationsTrackerPanel
              tenantId={profile?.tenant_id ?? null}
              tenantName={tenant?.name ?? null}
            />
          </SafeBoundary>
        </>
      )}
    </div>
  );
}

/**
 * Preview-mode render — operator is viewing /t/<slug>/settings for a
 * tenant they don't own. Renders ONLY chrome + empty scaffolds; no
 * sub-components mount, so no client-side fetch can leak the operator's
 * own profile / devices / AI keys / team into the tenant view.
 *
 * Sections shown (empty): Branding, Team, Devices, AI Setup,
 * Integration health.
 * Sections hidden (user-scoped, no tenant equivalent): Profile, Password.
 * (Known facts, Plan templates and Just-for-me overrides were removed from the
 * page entirely on 2026-08-17 — they are not hidden here, they no longer exist.)
 */
/**
 * Preview-mode scaffold cards — kept as one list so future tenants
 * adopting the `settings` page kind get a consistent shape with one
 * edit. Add/remove a card by editing this array; the renderer below
 * stays unchanged.
 */
const PREVIEW_SECTIONS: { id?: string; title: string; subtitle: string; empty: string }[] = [
  {
    title: "Branding",
    subtitle: "Logo + name shown on this tenant's forms, public pages, and dashboard chrome.",
    empty: "No brand set yet. The tenant operator can upload a logo from this section once signed in.",
  },
  {
    title: "Team",
    subtitle: "Tenant operator + invited teammates.",
    empty: "No team members visible in preview mode. The tenant operator manages invites here once signed in.",
  },
  {
    title: "Devices (advanced)",
    subtitle: "Machines paired by this tenant to run the local bridge — gives the tenant's agents file-system, bash, and full MCP access.",
    empty: "No devices paired for this tenant yet. The tenant operator pairs machines from here once signed in.",
  },
  {
    id: "providers",
    title: "AI setup",
    subtitle: "AI provider account(s) connected to this tenant. Powers chat + agent reasoning for everyone in the tenant.",
    empty: "No AI providers connected to this tenant yet. The tenant operator connects them from here once signed in.",
  },
  {
    title: "Integration health",
    subtitle: "Read-only status across the systems this tenant's enabled agents use.",
    empty: "No integration data in preview mode.",
  },
];

async function PreviewSettings({ tenantSlug, hideHeader }: { tenantSlug: string; hideHeader: boolean }) {
  // Tenant-scoped panels stay hidden in preview (no cross-tenant data). BUT the
  // signed-in user's OWN profile + personal integrations are THEIR data — every
  // employee must be able to manage their own settings + personal API keys
  // (e.g. Connect Gmail) even when the tenant surface resolves to preview mode.
  // getActiveProfile() is the signed-in user's own record, so rendering it here
  // is never a cross-tenant leak. (2026-07 — unblock employee self-service.)
  const profile = await safe("settings.preview.profile", getActiveProfile(), null);
  return (
    <div className="space-y-6 animate-fade-in">
      {!hideHeader && (
        <PageHeader
          title="Settings"
          subtitle={`Your profile + personal integrations. Tenant-wide settings for ${tenantSlug} are managed by an owner/admin.`}
          action={<Tag tone="warm">Personal settings</Tag>}
        />
      )}
      {profile && (
        <>
          <Card title="Profile" subtitle={`Signed in as ${profile.email}`}>
            <SafeBoundary label="Profile editor">
              <ProfileEditor profile={profile} tenantAgents={[]} />
            </SafeBoundary>
          </Card>
          <SafeBoundary label="Personal integrations">
            {/* Your own Gmail / personal API keys — always yours to manage. */}
            <PersonalIntegrationsPanel showGmail showKixie={false} />
          </SafeBoundary>
          <SafeBoundary label="Telegram bot">
            <TelegramConnectCard />
          </SafeBoundary>
        </>
      )}
      {PREVIEW_SECTIONS.map((s) => (
        <Card key={s.title} id={s.id} title={s.title} subtitle={s.subtitle}>
          <EmptyState message={s.empty} />
        </Card>
      ))}
    </div>
  );
}
