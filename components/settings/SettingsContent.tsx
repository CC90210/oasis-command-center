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
 *
 * ONE PAGE PER SECTION (OASIS OS, 2026-09-28). /settings is now split into
 * section pages (Profile, Team, Connections, Chat apps, AI brain, Brand &
 * domain, Devices…), each rendering `<SettingsContent section="…" />`. Every
 * card below is tagged with the section it belongs to and renders only there;
 * with no `section` (the /t/<slug>/settings mount) the whole body renders in
 * section order, as before. So each card still has exactly one definition,
 * one gate and one data source — the split moved where cards appear, not how
 * any of them behaves. Data reads follow the section: a Brand page never
 * queries integration health, and the personal (non-admin) branch still
 * returns before any workspace read.
 */

import Link from "next/link";
import { Card, PageHeader, Tag, EmptyState } from "@/components/Card";
import {
  getActiveProfile,
  getTenant,
  aiServicesWithKey,
  getBridgeOnline,
} from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { OpenSectionOnHash } from "@/components/settings/OpenSectionOnHash";
import { ProfileEditor } from "@/components/settings/ProfileEditor";
import { BrandLogoCard } from "@/components/settings/BrandLogoCard";
import { TelegramLinkCard } from "@/components/settings/TelegramLinkCard";
import { AgentConfigEditor } from "@/components/settings/AgentConfigEditor";
import { PersonalIntegrationsPanel } from "@/components/settings/PersonalIntegrationsPanel";
import { TelegramConnectCard } from "@/components/settings/TelegramConnectCard";
import { SafeBoundary } from "@/components/SafeBoundary";
import { AgentMarketplaceCard } from "@/components/settings/AgentMarketplaceCard";
import { DevicesEditor } from "@/components/settings/DevicesEditor";
import { HARNESS_REPO } from "@/lib/install-scripts";
import { OperationsTrackerPanel } from "@/components/settings/OperationsTrackerPanel";
import { ProviderAccountsCard } from "@/components/settings/ProviderAccountsCard";
import { LocalCliProvidersCard } from "@/components/settings/LocalCliProvidersCard";
import { SalesTeamOperationsPanel } from "@/components/settings/SalesTeamOperationsPanel";
import { RevenueGoalPanel } from "@/components/settings/RevenueGoalPanel";
import { TOOL_DEFINITIONS } from "@/lib/cloud-tool-runner";
import { chatAgentKeys } from "@/lib/agent-personas";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getManifestRead } from "@/lib/manifest/loader";
import { isUnprovisionedManifest } from "@/lib/manifest/seeds";
import { resolveEnabledAgentSlugs } from "@/lib/manifest/agent-roster";
import { isSharedInboxTenant } from "@/lib/shared-inbox-tenants";
import { resolveAgentKey } from "@/lib/agents";
import { teammateNamesFor, workspaceAgentsSubtitle } from "@/lib/os/teammate-names";
import { departmentLabelsFor, teammateFor } from "@/lib/os/teammates";
import { loadWorkspaceRoster } from "@/components/os/aiteam/roster";
import { isOasisSurfaceTenant, type Persona } from "@/lib/role-surfaces";
import { canManageWorkspaceSettings } from "@/components/settings/settings-sections";
import { isVerifiedOperator } from "@/components/settings/settings-viewer";

type ViewerSettingsAccess = {
  persona: Persona;
  canSeePersonalSettings: boolean;
  canSeeTeamPerformance: boolean;
  canSeeSystemSurfaces: boolean;
  degraded: boolean;
};

/**
 * The section pages SettingsContent serves. Billing, Notifications, Data &
 * privacy and Audit log have no card in here — their pages render their own
 * content.
 */
export type SettingsContentSection =
  | "profile"
  | "team"
  | "connections"
  | "chat-apps"
  | "ai"
  | "brand"
  | "devices";

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
  viewerAccess,
  section,
}: {
  previewMode?: boolean;
  tenantSlug?: string;
  viewerAccess?: ViewerSettingsAccess | null;
  /**
   * When mounted by the catch-all dispatcher under /t/<slug>/settings,
   * the dispatcher already renders its own PageHeader for the page —
   * suppress the inner one to avoid the same duplicate-header bug we
   * hit on Offers / Lenders / Shopping Out earlier this week.
   * Top-level /settings (no outer PageHeader) leaves this false.
   */
  hideHeader?: boolean;
  /**
   * Render only this section's cards (a /settings/<section> page, which draws
   * its own title). Omitted: every section, in order, with the header.
   */
  section?: SettingsContentSection;
}) {
  if (previewMode) {
    return <PreviewSettings tenantSlug={tenantSlug ?? "this tenant"} hideHeader={hideHeader} />;
  }

  const show = (s: SettingsContentSection) => !section || section === s;
  // On a section's own page its sections start open: the page IS the section,
  // and a column of closed bars would be one more click for nothing.
  const focused = section !== undefined;
  const showHeader = !hideHeader && !focused;

  const profile = await safe("settings.profile", getActiveProfile(), null);
  const [tenant, isOperator] = await Promise.all([
    profile?.tenant_id
      ? safe("settings.tenant", getTenant(profile.tenant_id), null)
      : Promise.resolve(null),
    // VERIFIED operator (email alias AND an owner/admin seat in OASIS, by auth
    // id) — not isOperatorEmail alone, which trusts an unproven signup email.
    // It gates the local-CLI card, the Devices section and the operator view of
    // integration health.
    isVerifiedOperator(),
  ]);

  const manifestSlug = tenant ? resolveClientProfileSlug(tenant) : null;
  const manifestRead = manifestSlug
    ? await safe("settings.manifest", getManifestRead(manifestSlug), null)
    : null;
  const manifest = manifestRead?.manifest ?? null;

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
  const teamProfile = profile as
    | (typeof profile & { is_owner?: boolean; team_role?: string; admin_access?: boolean | null })
    | null;
  // Full-admin capability: base owner/admin OR the admin_access toggle grant.
  // Unlocks Settings cards (branding, integration keys, plan templates, cron
  // jobs, automations, agent config) for a toggled agent. Admin-toggle 2026-07-07.
  // The rule lives in settings-sections.ts so the section nav asks the same one.
  const canManageTenant = canManageWorkspaceSettings(teamProfile, viewerAccess?.canSeeSystemSurfaces);
  const canSeeTeamPerformance = viewerAccess?.canSeeTeamPerformance === true;
  const oasisSalesWorkspace = isOasisSurfaceTenant(tenant?.slug ?? null);
  // What each agent is called on screen: its name on THIS workspace's roster
  // (lib/os/teammate-names.ts over lib/os/teammates.ts: the manifest binding's
  // display_name), never the persona behind it. Computed here, once, with the
  // same OASIS flag and manifest the AI Team roster and the department tabs
  // read, so the profile picker, the provider overrides, the workspace card and
  // a client's own /team tabs all agree.
  const teammateScope = { oasis: oasisSalesWorkspace, manifest };
  const teammateNames = teammateNamesFor(
    [...new Set([...manifestAgentKeys, ...enabledAgents, ...(manifest?.agents || []).map((a) => a.slug)])],
    teammateScope,
  );
  // The profile picker and the provider overrides offer only this workspace's
  // teammates. A house agent a client's manifest still binds (the self-signup
  // wizard wrote bravo, atlas and maven) or the legacy profile list names is
  // not one of them, and would otherwise be offered by its persona's name
  // (W4a review R1).
  const onRoster = (slug: string) => teammateFor(slug, teammateScope) !== null;
  const rosterAgentKeys = manifestAgentKeys.filter(onRoster);
  const rosterChatAgentKeys = enabledChatAgentKeys.filter(onRoster);

  // Every authenticated persona owns their profile, password and personal
  // connections. Non-admins stop here: no credential vault, AI/provider
  // configuration, device inventory, team mutation, agent roster, cron or
  // automation data is queried or rendered. Managers receive one additional
  // read-only, query-scoped OASIS sales scorecard below.
  if (profile && !canManageTenant) {
    return (
      <PersonalSettingsView
        profile={profile}
        tenantName={tenant?.name ?? null}
        tenantId={profile.tenant_id}
        hideHeader={hideHeader}
        showGmail={!isSharedInboxTenant(tenant?.slug ?? null)}
        showKixie={enabledAgents.includes("helios")}
        showTeamPerformance={canSeeTeamPerformance && oasisSalesWorkspace}
        accessDegraded={viewerAccess?.degraded === true}
        section={section}
      />
    );
  }

  // Only the reads the requested section renders: the AI key set and the
  // bridge heartbeat feed AI setup and the provider override table. An owner's
  // Connections page is the app hub (app/settings/connections/page.tsx), which
  // does not render this component; the integration heartbeats moved to /health.
  // Both reads throw on failure; null is "Couldn't check" in every card below,
  // never "Not connected" / "offline" for a key or a machine that may be fine.
  const needsAiKeys = show("ai");
  const needsBridge = show("ai");
  // Workspace agents read the AI Team's own roster (components/os/aiteam/
  // roster.ts loadWorkspaceRoster), so the two pages list the same teammates.
  const needsRoster = show("ai") && !!manifest && !!profile?.tenant_id;
  const [connectedAiSet, bridgeOnline, roster] = await Promise.all([
    needsAiKeys
      ? safe("settings.ai_keys", aiServicesWithKey(profile?.tenant_id || null), null)
      : Promise.resolve(new Set<string>()),
    needsBridge
      ? safe("settings.bridge_online", getBridgeOnline(profile?.tenant_id ?? null), null)
      : Promise.resolve(false),
    needsRoster && profile?.tenant_id
      ? safe("settings.roster", loadWorkspaceRoster({ tenantId: profile.tenant_id, scope: teammateScope }), null)
      : Promise.resolve(null),
  ]);
  // The Workspace agents card cannot state the roster when the workspace's
  // manifest read failed (the in-code seed answered in its place, which for a
  // client is the empty unprovisioned one) or the roster load threw.
  const rosterUnread = manifestRead?.storedReadFailed === true || (needsRoster && roster === null);
  // The AI Team page, for a viewer its rail row opens for (owners and admins,
  // lib/os/nav.ts "ai-team") in a workspace OASIS has set up.
  const aiTeamHref =
    viewerAccess?.persona === "founder" && manifest && !isUnprovisionedManifest(manifest) ? "/agents" : null;

  return (
    <div className="space-y-6 animate-fade-in">
      {showHeader && (
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

      {!profile ? (
        <Card title="No profile loaded">
          <EmptyState message="Sign in to edit your profile." />
        </Card>
      ) : (
        <>
          {/* ── Profile ─────────────────────────────────────────────── */}
          {show("profile") && (
            <SettingsSection
              defaultOpen={focused}
              title="Profile"
              subtitle={`Signed in as ${profile.email}`}
              action={
                <div className="flex items-center gap-2">
                  {canManageTenant && !focused && (
                    <a
                      href="/settings/audit-log"
                      className="text-xs text-accent hover:text-accent/80 underline underline-offset-2"
                    >
                      Activity log →
                    </a>
                  )}
                </div>
              }
            >
              <SafeBoundary label="Profile editor">
                <ProfileEditor
                  key={rosterAgentKeys.join(":")}
                  profile={profile}
                  tenantAgents={rosterAgentKeys}
                  agentNames={teammateNames}
                />
              </SafeBoundary>
            </SettingsSection>
          )}

          {/* "Known facts about you" removed 2026-08-17. It shipped with
              placeholder text still in the box — "Your Name", "Your LLC",
              "https://cal.com/your-handle" — which every cloud chat was
              injecting as authoritative operator context. A field nobody filled
              in is not neutral when its DEFAULT is fed to the model as fact. The
              same context now lives where it is actually true: brain/USER.md and
              the agent entry points. */}

          {show("profile") && (
            <SettingsSection defaultOpen={focused} title="Password" subtitle="Change your sign-in password">
              <SafeBoundary label="Password form">
                <ChangePasswordForm />
              </SafeBoundary>
            </SettingsSection>
          )}

          {/* ── Team ────────────────────────────────────────────────── */}
          {show("team") && canManageTenant && (
            <SettingsSection
              defaultOpen={focused}
              title="Team"
              subtitle="Invite teammates by work email, and switch anyone Active or Inactive. Inactive people disappear from the pipeline, assign lists, and reports and can't sign in; their history is kept and they can be reactivated."
              action={
                <Link
                  href="/team"
                  prefetch={false}
                  className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent-bright"
                >
                  Manage team, invites & active status →
                </Link>
              }
            >
              <p className="text-sm text-fg-muted leading-relaxed">
                Add teammates, choose their job role, review pending invitations, and revoke access from the dedicated Team page.
              </p>
            </SettingsSection>
          )}

          {/* id="revenue-goal": Today's Goal pace card links
              /settings/team#revenue-goal, and OpenSectionOnHash opens it. */}
          {show("team") && canManageTenant && oasisSalesWorkspace && (
            <SettingsSection
              id="revenue-goal"
              defaultOpen={focused}
              title="Revenue goal"
              subtitle="The one goal Today counts down to: money collected in a period, computed from the Finances ledger. MRR is never typed — it is read live from Stripe."
            >
              <RevenueGoalPanel
                canEdit={
                  !!teamProfile &&
                  (teamProfile.is_owner === true || teamProfile.team_role === "owner" || teamProfile.team_role === "admin")
                }
              />
            </SettingsSection>
          )}

          {/* CC ask 2026-06-11: "an overall tracker [hidden in Settings],
              very important feature." Read-only operations view — daemons,
              sequences, employee activity in one place. Mutations live on the
              surfaces it tracks. It lives under Team now: it is the team's week
              at a glance, and its full history link is the Audit log. */}
          {show("team") && canSeeTeamPerformance && oasisSalesWorkspace && profile.tenant_id && (
            <SafeBoundary label="sales-team-performance">
              <SalesTeamOperationsPanel
                tenantId={profile.tenant_id}
                tenantName={tenant?.name ?? null}
              />
            </SafeBoundary>
          )}

          {show("team") && (
            <SafeBoundary label="operations-tracker">
              <OperationsTrackerPanel
                tenantId={profile?.tenant_id ?? null}
                tenantName={tenant?.name ?? null}
              />
            </SafeBoundary>
          )}

          {/* ── Connections ─────────────────────────────────────────── */}
          {/* An owner's Connections page is the app hub (one card per app,
              app/settings/connections/page.tsx), which never renders this
              component; the integration heartbeats that lived here are on
              /health. Members get their own Google in PersonalSettingsView. */}

          {/* ── Chat apps ───────────────────────────────────────────── */}
          {/* This bot is a SunBiz application-upload integration. Mounting it in
              OASIS exposed SunBiz wording and a foreign workflow in the wrong
              tenant's Settings surface. */}
          {show("chat-apps") && manifestSlug === "sun" && <TelegramLinkCard />}

          {show("chat-apps") && (
            <SettingsSection
              defaultOpen
              title="Your Telegram alert bot"
              subtitle="A bot that belongs only to your login and sends your own alerts to your phone. Set it up once; it is separate from every teammate's."
            >
              <SafeBoundary label="Personal Telegram bot">
                <TelegramConnectCard />
              </SafeBoundary>
            </SettingsSection>
          )}

          {/* ── AI brain ────────────────────────────────────────────── */}
          {show("ai") && (
            <SettingsSection
              id="providers"
              defaultOpen={focused}
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
                  canInstallBridge={isOperator}
                />
              </SafeBoundary>
            </SettingsSection>
          )}

          {show("ai") && isOperator && (
            <SafeBoundary label="Local CLI providers">
              <LocalCliProvidersCard serverBridgeOnline={bridgeOnline} />
            </SafeBoundary>
          )}

          {show("ai") && (
            <SettingsSection
              id="agents"
              defaultOpen={focused}
              title="Override an agent's provider"
              subtitle="Optional. Each agent uses the workspace default from AI setup above unless you set a specific provider here. Edit a row to switch which provider that agent uses."
              action={
                <Tag tone={bridgeOnline ? "engaged" : "neutral"}>
                  {bridgeOnline === null
                    ? "Tool access: couldn't check the bridge"
                    : bridgeOnline
                      ? "Tool access: bridge online"
                      : "Tool access: cloud only"}
                </Tag>
              }
            >
              {canManageTenant ? (
                <SafeBoundary label="Override an agent's provider">
                  <AgentConfigEditor
                    agentKeys={rosterChatAgentKeys}
                    agentLabels={teammateNames}
                    bridgeOnline={bridgeOnline}
                    canInstallBridge={isOperator}
                    globallyConnectedServices={connectedAiSet ? Array.from(connectedAiSet) : null}
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
          )}

          {/* "Just-for-me overrides" removed 2026-08-17. It let an individual
              point their own chats at a different AI account — a team feature on
              a single-operator workspace, where it only ever added a second
              place for the provider to be configured and a second place for it
              to be wrong. Provider selection lives in AI Setup and, per agent,
              in the override table above. */}

          {/* Workspace agents: the AI Team's own roster (one list, W4a), with
              owner toggles and a link to the AI Team page. Every teammate is
              named by its manifest binding, never by persona. No add-ons:
              OASIS's house agents live in Admin > Fleet. When the workspace's
              manifest or the roster could not be read, the card says so
              instead of vanishing or listing the seed's guess (W4a review R3). */}
          {show("ai") && !previewMode && manifest?.agents && needsRoster && (
            <Card
              title="Workspace agents"
              subtitle={rosterUnread ? "The AI teammates this workspace runs." : workspaceAgentsSubtitle(teammateScope)}
              action={
                aiTeamHref ? (
                  <Link
                    href={aiTeamHref}
                    prefetch={false}
                    className="shrink-0 text-xs text-accent hover:text-accent/80 underline underline-offset-2"
                  >
                    Open AI Team →
                  </Link>
                ) : undefined
              }
            >
              {rosterUnread || !roster ? (
                <EmptyState message="Couldn't check this workspace's AI teammates just now. Refresh to try again; nothing was changed." />
              ) : (
                <SafeBoundary label="Workspace agents">
                  <AgentMarketplaceCard
                    leads={roster.leads.map((l) => ({
                      slug: l.slug,
                      name: l.name,
                      summary: l.summary,
                      departments: departmentLabelsFor(l.departments),
                      enabled: l.enabled,
                      core: l.core,
                      bound: l.bound,
                    }))}
                    custom={
                      roster.custom.ok
                        ? roster.custom.value.map((c) => ({
                            slug: c.slug,
                            name: c.name,
                            summary: c.summary,
                            departments: [],
                            enabled: c.enabled,
                            core: c.core,
                            bound: c.bound,
                          }))
                        : null
                    }
                    isOwner={canManageTenant}
                    aiTeamHref={aiTeamHref}
                  />
                </SafeBoundary>
              )}
            </Card>
          )}

          {/* Weekday/Weekend template editors removed 2026-08-17 alongside the
              "The day" card on /today that consumed them. /schedule is the live
              planner now. Configuring a template for a surface that no longer
              renders is a control with nothing on the other end. */}

          {/* ── Brand & domain ──────────────────────────────────────── */}
          {show("brand") && (
            <SettingsSection
              defaultOpen={focused}
              title="Branding"
              subtitle="Your logo is applied to every new form, public application page, and anywhere else the dashboard shows your brand."
            >
              <SafeBoundary label="Branding">
                <BrandLogoCard initialLogoUrl={tenant?.logo_url ?? null} canManage={canManageTenant} />
              </SafeBoundary>
            </SettingsSection>
          )}

          {/* ── Devices (operators only) ────────────────────────────── */}
          {/* The bridge gives an agent a shell, files and every MCP on the
              paired machine. It is never client-facing (plan: "the bridge
              becomes operator-only"), so the section follows the VERIFIED
              operator check, not workspace admin. */}
          {show("devices") && isOperator && (
            <SettingsSection
              id="devices"
              defaultOpen={focused}
              title="Devices (advanced)"
              subtitle="Pair a machine on your network to run the local bridge — gives your agents file-system, bash, and full MCP access. Optional: a connected AI provider account under AI brain is enough for chat without ever pairing a machine."
              action={
                <Link
                  href="/settings/devices/install"
                  className="btn-primary inline-flex items-center gap-1 !px-3 !py-1.5 !text-xs"
                >
                  Pair a machine →
                </Link>
              }
            >
              <SafeBoundary label="Devices">
                <DevicesEditor installRepo={HARNESS_REPO} />
              </SafeBoundary>
            </SettingsSection>
          )}
        </>
      )}
    </div>
  );
}

async function PersonalSettingsView({
  profile,
  tenantName,
  tenantId,
  hideHeader,
  showGmail,
  showKixie,
  showTeamPerformance,
  accessDegraded,
  section,
}: {
  profile: NonNullable<Awaited<ReturnType<typeof getActiveProfile>>>;
  tenantName: string | null;
  tenantId: string | null;
  hideHeader: boolean;
  showGmail: boolean;
  showKixie: boolean;
  showTeamPerformance: boolean;
  accessDegraded: boolean;
  section?: SettingsContentSection;
}) {
  const show = (s: SettingsContentSection) => !section || section === s;
  return (
    <div className="space-y-6 animate-fade-in">
      {!hideHeader && !section && (
        <PageHeader
          title={tenantName ? `Settings · ${tenantName}` : "Settings"}
          subtitle={
            showTeamPerformance
              ? "Your profile and account connections, plus a read-only scorecard for the OASIS sales team."
              : "Your profile, password, and account connections. Workspace administration stays with an owner or admin."
          }
          action={
            showTeamPerformance ? (
              <Tag tone="info">Sales manager view</Tag>
            ) : (
              <Tag tone="neutral">Personal settings</Tag>
            )
          }
        />
      )}

      {show("profile") && accessDegraded && (
        <Card
          title="Team access status unavailable"
          subtitle="OASIS could not verify this workspace right now, so team performance is temporarily hidden instead of showing incomplete or unauthorized data. Refresh to retry."
          action={<Tag tone="warm">Retry needed</Tag>}
        >
          <p className="text-sm text-fg-muted">
            Your personal profile and connections remain available below. No team-access setting was changed.
          </p>
        </Card>
      )}

      {show("profile") && (
        <SettingsSection
          defaultOpen
          title="Your profile"
          subtitle={`Signed in as ${profile.email}. Only your identity and contact information are editable here.`}
          action={
            showTeamPerformance ? (
              <Link href="/settings/audit-log" className="text-xs text-accent hover:text-accent-bright">
                Sales activity →
              </Link>
            ) : null
          }
        >
          <SafeBoundary label="Personal profile editor">
            <ProfileEditor profile={profile} tenantAgents={[]} personalOnly />
          </SafeBoundary>
        </SettingsSection>
      )}

      {show("profile") && (
        <SettingsSection defaultOpen={!!section} title="Password" subtitle="Change your sign-in password">
          <SafeBoundary label="Password form">
            <ChangePasswordForm />
          </SafeBoundary>
        </SettingsSection>
      )}

      {/* id="integrations": the Google OAuth callback and the setup checklist
          land here, and /settings forwards the old fragment to this page. */}
      {show("connections") && (
        <SettingsSection
          id="integrations"
          defaultOpen
          title="Your Google account"
          subtitle="Connect the Google account used by your own login. This does not change the workspace's shared services or a teammate's account. Workspace apps are connected by an owner or admin."
        >
          <SafeBoundary label="Personal integrations">
            <PersonalIntegrationsPanel showGmail={showGmail} showKixie={showKixie} />
          </SafeBoundary>
        </SettingsSection>
      )}

      {show("chat-apps") && (
        <SettingsSection
          defaultOpen
          title="Your Telegram alert bot"
          subtitle="A bot that belongs only to your login and sends your own alerts to your phone. It does not change the workspace's shared services or a teammate's account."
        >
          <SafeBoundary label="Personal Telegram bot">
            <TelegramConnectCard />
          </SafeBoundary>
        </SettingsSection>
      )}

      {show("team") && showTeamPerformance && tenantId && (
        <SafeBoundary label="sales-team-performance">
          <SalesTeamOperationsPanel tenantId={tenantId} tenantName={tenantName} />
        </SafeBoundary>
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
              <ProfileEditor profile={profile} tenantAgents={[]} personalOnly />
            </SafeBoundary>
          </Card>
          <SettingsSection
            defaultOpen
            title="Your connections"
            subtitle="Your personal Google and Telegram connections remain editable while tenant-wide settings stay read-only."
          >
            <div className="space-y-3">
              <SafeBoundary label="Personal integrations">
                <PersonalIntegrationsPanel showGmail showKixie={false} />
              </SafeBoundary>
              <SafeBoundary label="Telegram bot">
                <TelegramConnectCard />
              </SafeBoundary>
            </div>
          </SettingsSection>
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
