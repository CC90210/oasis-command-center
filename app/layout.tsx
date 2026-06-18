import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { SidebarShell } from "@/components/SidebarShell";
import { MainShell } from "@/components/MainShell";
import { SIDEBAR_BOOT_SCRIPT } from "@/lib/useSidebarCollapsed";
import { getActiveProfile, getBridgeOnline } from "@/lib/queries";
import { getServiceSupabase } from "@/lib/supabase-server";
import { safe } from "@/lib/api-helpers";
import {
  DEMO_CLIENT_PROFILE_COOKIE,
  resolveClientProfileSlug,
} from "@/lib/client-profiles";
import {
  getManifest,
  manifestExists,
  manifestLogoToSidebarLogo,
  manifestNavToNavItems,
  manifestPrimaryAgentSlug,
} from "@/lib/manifest/loader";
import { SEED_MANIFESTS } from "@/lib/manifest/seeds";
import { getTenantManifestForUser } from "@/lib/manifest/tenant-scope";
import { canPreviewTenantSlug } from "@/lib/tenant-access";
import { resolveChatShellProps, type ChatShellProps } from "@/lib/chat-shell-props";

// Default metadata — tenant-neutral. Individual pages override via
// generateMetadata (forms, leads, etc.) with their own titles. Keeping
// the default brand-neutral avoids the browser tab leaking
// "OASIS AI · Agent Command Center" to a SunBiz / Suga / future-client
// operator who's browsing a page that doesn't set its own title.
// The OASIS brand is still surfaced for the OASIS tenant's own UI
// (sidebar, footer); this is just the browser-tab fallback.
export const metadata: Metadata = {
  title: "Command Center",
  description:
    "The operating system for your AI agents. Outbound, inbound, decisions, pipeline, and the daily ops plan — all in one place.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Auth + marketing pages render their own full-screen layouts; skip the
  // sidebar shell. The pathname is set as a header by middleware.ts.
  const hdrs = await headers();
  const pathname = hdrs.get("x-pathname") || hdrs.get("x-invoke-path") || "";
  // Paths that render edge-to-edge (no operator sidebar, no footer, no
  // tenant manifest resolution). Anything aimed at a prospect / pre-auth
  // visitor or a fresh signup walks through here. Mirrors middleware.ts
  // PUBLIC_PATH_PREFIXES — kept as a separate list because middleware
  // also lists API routes that aren't page-rendered.
  const FULL_BLEED_PREFIXES = [
    "/welcome",
    "/download",
    "/configure",
    "/login",
    "/signup",
    "/forgot-password",
    "/auth/callback",
    "/auth/reset-password",
    "/onboarding",
    "/f/",        // public form pages (anonymous + personalized)
    "/invite/",   // pre-signup invite landing
  ];
  const isFullBleed = FULL_BLEED_PREFIXES.some((p) => pathname.startsWith(p));

  let profile = null;
  let primaryAgentLive = false;
  let bridgeOnline = false;
  let tenantProfileSlug: string | null = null;
  let demoProfileSlug: string | null = null;
  let pathOverrideSlug: string | null = null;
  // Props for the persistent ChatWidget hoisted into MainShell (2026-06-18).
  // Resolved against the operator's OWN tenant so the persistent chat always
  // speaks as their own agent, even while previewing another tenant's shell.
  let chatProps: ChatShellProps | null = null;
  if (!isFullBleed) {
    const cookieStore = await cookies();
    // Path-based tenant slug (Phase 1): `/t/<slug>/...` URLs anchor the shell to
    // that tenant's manifest regardless of the viewer's home tenant. Demo paths
    // still take precedence — `/demo/sun` is the public, auth-free preview.
    const tSlugMatch = pathname.match(/^\/t\/([a-z0-9][a-z0-9_-]{1,62})(?:\/|$)/i);
    const pathTenantSlug = tSlugMatch ? tSlugMatch[1].toLowerCase() : null;

    // Resolve the operator's real profile FIRST so we can decide whether to
    // honour the demo cookie. The demo cookie is a public-preview cosmetic —
    // an authenticated operator with a real tenant should NEVER have their
    // shell hijacked by a stale demo cookie (the 2026-05-16 cross-tenant view
    // leak: CC touched /demo/sun on a Vercel URL once, came back signed in,
    // and the SunBiz shell rendered over his OASIS session for 8 hours).
    //
    // Each side-channel query is wrapped independently — one failure
    // (Hermes snapshot row missing, bridge_pairings table absent in dev,
    // RLS blocking a service-role call, etc.) must NOT take down the
    // whole layout. Failure mode prior to this hardening: any throw
    // here blanked the dashboard with a 500. Each catch logs via safe()
    // so a stuck sidebar indicator is searchable in Vercel logs instead
    // of silently rendering as "offline".
    profile = await safe("layout.profile", getActiveProfile(), null);

    // Demo cookie is honoured ONLY when:
    //   - the operator is on /demo/sun (explicit opt-in via URL), OR
    //   - the operator has no real tenant binding (anonymous preview)
    // Once `profile.tenant_id` exists, the cookie is ignored and best-effort
    // cleared. Best-effort because Server Components can't always mutate
    // cookies in Next 15 — middleware handles the durable clear.
    const isExplicitDemoPath = pathname.startsWith("/demo/sun");
    const operatorHasRealTenant = !!profile?.tenant_id;
    const rawDemoCookie = cookieStore.get(DEMO_CLIENT_PROFILE_COOKIE)?.value || null;
    const requestedDemoProfile = isExplicitDemoPath
      ? "sun"
      : operatorHasRealTenant
        ? null
        : rawDemoCookie;

    if (rawDemoCookie && operatorHasRealTenant && !isExplicitDemoPath) {
      try {
        cookieStore.set(DEMO_CLIENT_PROFILE_COOKIE, "", {
          maxAge: 0,
          path: "/",
        });
      } catch {
        // Server-Component cookie writes are no-ops in some Next contexts.
        // Middleware also clears this cookie; the ignore-logic above wins
        // even if the clear fails silently.
      }
    }

    const normalisedDemo = (requestedDemoProfile || "").trim().toLowerCase();
    demoProfileSlug =
      normalisedDemo && normalisedDemo !== "default" && SEED_MANIFESTS[normalisedDemo]
        ? normalisedDemo
        : null;

    const tenantId = profile?.tenant_id || null;
    // Validate primary_agent against the tenant's manifest-enabled agents
    // before using it for the heartbeat lookup. A corrupted profile carrying
    // primary_agent="atlas" or stale "bravo" would otherwise read another
    // tenant's heartbeat — cross-tenant signal leak. Fall back to the
    // manifest's primary slug (or first enabled) when the column is invalid.
    const manifestForAgent = await getTenantManifestForUser(tenantId);
    const manifestEnabledForAgent = (manifestForAgent?.agents || [])
      .filter((a) => a.enabled)
      .map((a) => a.slug.toLowerCase());
    const requestedAgent = (profile?.primary_agent || "").toLowerCase();
    const manifestPrimary = manifestForAgent?.agents?.find(
      (a) => a.primary && a.enabled,
    )?.slug?.toLowerCase();
    const agent = manifestEnabledForAgent.includes(requestedAgent)
      ? requestedAgent
      : (manifestPrimary || manifestEnabledForAgent[0] || requestedAgent || "bravo");

    // Resolve the operator's tenant slug FIRST so the path-override gate
    // below can share the same access policy the /t/[slug] page uses
    // (canPreviewTenantSlug). Tenants can override the raw slug via
    // custom_fields.command_center_profile_slug so one shell can render
    // different products cleanly.
    if (tenantId) {
      tenantProfileSlug = await safe(
        "layout.tenant_profile_slug",
        (async () => {
          const db = getServiceSupabase();
          const r = await db
            .from("tenants")
            .select("slug, custom_fields")
            .eq("id", tenantId)
            .maybeSingle();
          const tenant = (r.data as { slug?: string; custom_fields?: Record<string, unknown> | null } | null);
          return resolveClientProfileSlug({
            slug: tenant?.slug || "",
            custom_fields: tenant?.custom_fields || {},
          });
        })(),
        null
      );
    }

    // Path slug wins when present and not in demo. Lets `/t/<slug>/...`
    // render that tenant's manifest for any operator who's allowed to
    // preview it. The /t/[slug]/page.tsx + /t/[slug]/[...path]/page.tsx
    // already call requireTenantPreviewAccess (redirects unauthorized
    // callers before the layout body renders), but mirroring the same
    // gate here keeps the layout from doing wasted manifestExists work
    // on redirect-bound requests AND prevents the chrome from briefly
    // resolving to the wrong tenant if a future code path skips the
    // page-level guard.
    if (!demoProfileSlug && pathTenantSlug) {
      const allowed = canPreviewTenantSlug(
        {
          email: profile?.email,
          tenant_slug: tenantProfileSlug,
          command_center_profile_slug: tenantProfileSlug,
        },
        pathTenantSlug,
      );
      if (allowed) {
        const exists = await manifestExists(pathTenantSlug);
        if (exists) pathOverrideSlug = pathTenantSlug;
      }
    }

    // Run agent-state + bridge lookups in parallel, isolated.
    // Bridge-online check uses the shared getBridgeOnline() helper so the
    // header dot, Settings page, and any future caller agree on what
    // "online" means (last_seen_at within 5 minutes, revoked_at IS NULL).
    const emptySnap: { data: { last_tick_at?: string | null } | null } = { data: null };
    const [snapRes, bridgeOnlineResolved, chatPropsResolved] = await Promise.all([
      safe(
        "layout.agent_state_snapshot",
        (async () => {
          const db = getServiceSupabase();
          const r = await db
            .from("agent_state_snapshot")
            .select("last_tick_at")
            .eq("agent_name", agent)
            .maybeSingle();
          return { data: r.data as { last_tick_at?: string | null } | null };
        })(),
        emptySnap
      ),
      safe("layout.bridge_online", getBridgeOnline(tenantId), false),
      // Persistent-chat props, resolved in parallel so this adds no
      // wall-clock latency to the layout (just one more concurrent query set).
      safe(
        "layout.chat_props",
        resolveChatShellProps({ profile, userEmail: profile?.email }),
        null,
      ),
    ]);
    const snap = snapRes.data;
    if (snap?.last_tick_at) {
      primaryAgentLive =
        Date.now() - new Date(snap.last_tick_at).getTime() < 15 * 60 * 1000;
    }
    bridgeOnline = bridgeOnlineResolved;
    chatProps = chatPropsResolved;
    // tenantProfileSlug already resolved above so canPreviewTenantSlug
    // could use it on the path-override gate. Nothing more to do here.
  }
  const demoMode = !!demoProfileSlug;
  const manifestSlug = demoMode
    ? demoProfileSlug
    : pathOverrideSlug ?? tenantProfileSlug;
  const manifest = isFullBleed ? null : await getManifest(manifestSlug);
  // The chat-shell-vs-constrained <main> decision lives in MainShell (a CLIENT
  // component using usePathname) — NOT here. This root layout is a Server
  // Component that reads headers() once per full load and does NOT re-render on
  // soft navigation, so deciding the layout mode here froze it at the
  // first-loaded path: loading /agent (chat shell) then clicking another tab
  // left that tab rendering full-bleed inside the frozen Agents <main>. See
  // components/MainShell.tsx. (This is the real cause behind the recurring
  // "every tab looks zoomed-in" report — two prior width-only fixes couldn't
  // fix a decision that was frozen at load time.)

  return (
    <html lang="en">
      <head>
        {/* Synchronous boot script — reads localStorage and writes
            data-sidebar=collapsed|expanded on <html> before paint. CSS
            below keys main element's left margin off that attribute.
            Without this the page paints with the default sidebar width
            then visibly jolts when React hydrates with the collapsed
            value. */}
        <script
          dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOT_SCRIPT }}
        />
      </head>
      <body className="grain">
        {isFullBleed || !manifest ? (
          children
        ) : (
          <>
            {/* Brand + primary-agent resolution (fixed 2026-05-25
                Codex review caught a P2 in the first attempt — using
                bare pathOverrideSlug also fires on the OWNER'S OWN
                tenant route, which would override Ezra's saved
                profile.brand customization on /t/sun/* when he owns
                that slug. The correct distinction is "is the URL
                tenant DIFFERENT from the user's own tenant" — that's
                the preview case. Owned tenant routes still use the
                operator's saved profile values. */}
            <SidebarShell
              brand={
                demoMode || (pathOverrideSlug && pathOverrideSlug !== tenantProfileSlug)
                  ? manifest.brand.name
                  : profile?.brand || manifest.brand.name
              }
              logo={manifestLogoToSidebarLogo(manifest.brand.logo)}
              subtitle={manifest.brand.subtitle}
              items={manifestNavToNavItems(manifest.nav)}
              operatorName={
                demoMode
                  ? "Sun Demo Operator"
                  : profile?.display_name || profile?.full_name || "Operator"
              }
              operatorEmail={demoMode ? "demo@sunbizfunding.com" : profile?.email}
              primaryAgent={
                // Same gate — only force manifest primary agent when
                // the operator is previewing a tenant they don't own.
                (demoMode || (pathOverrideSlug && pathOverrideSlug !== tenantProfileSlug))
                  ? (manifestPrimaryAgentSlug(manifest) ?? "bravo")
                  : (profile?.primary_agent || manifestPrimaryAgentSlug(manifest) || "bravo")
              }
              primaryAgentLive={
                // Suppress the live indicator in preview mode — it
                // was reading the operator's agent_state_snapshot
                // even when showing the tenant's manifest agent
                // label, which misrepresented the indicator. Owned
                // tenant routes still get the real live indicator.
                demoMode || (pathOverrideSlug && pathOverrideSlug !== tenantProfileSlug)
                  ? false
                  : primaryAgentLive
              }
              bridgeOnline={
                // Same — preview mode shouldn't show CC's bridge as
                // "online" inside the Sun Biz shell.
                demoMode || (pathOverrideSlug && pathOverrideSlug !== tenantProfileSlug)
                  ? false
                  : bridgeOnline
              }
              demoMode={demoMode}
              demoLabel={`${manifest.brand.name} demo`}
            />
            {/* MainShell (client) picks chat-shell vs constrained from
                usePathname, so it re-evaluates on EVERY navigation — the
                chat shell stays scoped to /agent and never leaks onto other
                tabs via soft nav. The <main> still responds to the
                data-sidebar attribute for the collapsible sidebar margin. */}
            <MainShell
              footerLabel={manifest.brand.footer_label}
              footerTagline={manifest.brand.footer_tagline}
              chat={chatProps}
            >
              {children}
            </MainShell>
          </>
        )}
      </body>
    </html>
  );
}
