import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { SidebarShell } from "@/components/SidebarShell";
import { MainShell } from "@/components/MainShell";
import { SIDEBAR_BOOT_SCRIPT } from "@/lib/useSidebarCollapsed";
import { getActiveProfile, getTenant } from "@/lib/queries";
import { resolvePrimaryAgent } from "@/lib/shell-status";
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
import { SEED_MANIFESTS, isUnprovisionedManifest } from "@/lib/manifest/seeds";
import { getTenantManifestForUser } from "@/lib/manifest/tenant-scope";
import { canPreviewTenantSlug } from "@/lib/tenant-access";
import { resolveChatShellProps, type ChatShellProps } from "@/lib/chat-shell-props";
import { matchesPathPrefix } from "@/lib/path-prefix";
import { ALL_MARKETING_PATHS } from "@/lib/marketing/routes";
// NOTE: lib/marketing/* above is the PUBLIC marketing SITE (/home, /work, ...).
// lib/founders/* below is the private founders portal. Different concerns,
// similar words — keep them apart.
import { foundersAllowlist } from "@/lib/founders/gate";
import { isFounderTenant, shouldShowFoundersNav } from "@/lib/founders-marketing-core";
import { FOUNDERS_NAV } from "@/lib/portals/registry";
import { isFinanceOwnerEmail } from "@/lib/founders-finances/access";
import type { NavItem } from "@/lib/nav-config";
import {
  filterNavForPersona,
  isOasisSurfaceTenant,
  SURFACE_CAPABILITIES,
  type Persona,
} from "@/lib/role-surfaces";
import {
  isPlatformOperator,
  resolveViewerSurface,
  type ViewerSurface,
} from "@/lib/role-surfaces-session";
import { askHrefFor, buildOsNav, osNavRows } from "@/lib/os/nav";
import { resolveOsModules } from "@/lib/os/modules";
import type { OsNavSection } from "@/lib/os/types";
import { timed, logPerfSummary, type PerfSpan } from "@/lib/perf/server-timing";
import { workspaceDisplayName } from "@/lib/provisioning/workspace-name";
import { loadConnectorFacts } from "@/components/os/connections/connector-facts";
import { connectionsDot, connectionsHealth } from "@/lib/os/connectors";
import { withDeadline } from "@/lib/os/deadline";
import type { ConnectionsStatus } from "@/components/os/RailFooter";
import { PerfVitals } from "@/components/PerfVitals";
import { ClientErrorReporter } from "@/components/ClientErrorReporter";

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
  // THE DEFAULT ICON IS DECLARED HERE, NOT AS app/favicon.ico.
  //
  // A file-based icon is not overridable. Next discovers app/favicon.ico and
  // UNSHIFTS it ahead of whatever a route's generateMetadata returns, so a
  // per-tenant icon loses to it: SunBiz's bank-statement upload emitted
  // OASIS's favicon first, with the more specific sizes/type, and then
  // SunBiz's — and the browser took the first. #454 added the per-tenant icon
  // and this is why it did nothing in production.
  //
  // Declared as config it is a DEFAULT: a route that returns its own `icons`
  // replaces it outright. Moving the file to public/ keeps the same URL, so
  // nothing that links /favicon.ico changes.
  icons: { icon: "/favicon.ico" },
};

/** The only seed slugs the public demo cookie may select. /api/demo/sun, which set it, was deleted 2026-09-29; a browser can still carry one until it expires. */
const DEMO_PROFILE_SLUGS: ReadonlySet<string> = new Set(["sun"]);

/**
 * The rail's Connections dot is chrome: past this budget the shell draws no
 * dot (not measured) rather than hold every page for it (lib/os/deadline.ts).
 */
const RAIL_CONNECTIONS_DEADLINE_MS = 2_500;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Auth + marketing pages render their own full-screen layouts; skip the
  // sidebar shell. The pathname is set as a header by middleware.ts.
  const hdrs = await headers();
  const pathname = hdrs.get("x-pathname") || hdrs.get("x-invoke-path") || "";
  // P0 instrumentation (instant-load plan): time the layout's own data
  // fetches — the "session tax" every navigation pays before any page
  // content or loading state can stream. Additive only; spans wrap the
  // existing calls without changing order, parallelism, or error handling.
  const perfT0 = Date.now();
  const perfSpans: PerfSpan[] = [];
  // Paths that render edge-to-edge (no operator sidebar, no footer, no
  // tenant manifest resolution). Anything aimed at a prospect / pre-auth
  // visitor or a fresh signup walks through here. Mirrors middleware.ts
  // PUBLIC_PATH_PREFIXES — kept as a separate list because middleware
  // also lists API routes that aren't page-rendered.
  const FULL_BLEED_PREFIXES = [
    // Public marketing site + the three legal pages, from the shared
    // registry. "/home" is the rewrite target for an anonymous "/" —
    // middleware re-stamps x-pathname so it lands here. Never add "/"
    // itself: the matcher would swallow every route in the app and strip
    // the operator chrome site-wide.
    ...ALL_MARKETING_PATHS,
    "/welcome",   // legacy URL; next.config.js 308s it to "/" before middleware or this layout ever see it. Inert backstop, same reasoning as the middleware entry.
    "/download",
    "/login",
    "/signup",
    "/forgot-password",
    "/auth/callback",
    "/auth/reset-password",
    "/onboarding",
    "/f/",        // public form pages (anonymous + personalized)
    "/invite/",   // pre-signup invite landing
  ];
  // Boundary-aware match, same rule as middleware's isPublic(). A raw
  // startsWith() would let a future "/workflows" or "/aboutus" route
  // silently inherit the marketing chrome (and skip the profile
  // resolution the dashboard needs) purely because of a shared prefix.
  const isFullBleed = FULL_BLEED_PREFIXES.some((p) => matchesPathPrefix(pathname, p));

  let profile = null;
  let resolvedPrimaryAgent: string | null = null;
  let tenantProfileSlug: string | null = null;
  /** The viewer's workspace's own name (tenants.name), for the shell header. */
  let tenantName: string | null = null;
  let demoProfileSlug: string | null = null;
  let pathOverrideSlug: string | null = null;
  // Props for the persistent ChatWidget hoisted into MainShell (2026-06-18).
  // Resolved against the operator's OWN tenant so the persistent chat always
  // speaks as their own agent, even while previewing another tenant's shell.
  let chatProps: ChatShellProps | null = null;
  /**
   * Which persona's sidebar to render.
   *
   * `null` means "do not narrow" — the demo shells and any pre-auth render have
   * no session to resolve, and a fail-closed default there would hand a SunBiz
   * demo visitor a four-item contractor sidebar. Narrowing is only applied when
   * a persona is POSITIVELY identified, which is safe precisely because the nav
   * is cosmetic: every page a persona must not reach carries its own
   * server-side gate (requireSystemSurface / the founders gate). If this line
   * were the only defence it would be the wrong default.
   */
  let navPersona: Persona | null = null;
  /** The viewer's resolved surface (persona, capabilities, raw tenant slug). */
  let viewerSurface: ViewerSurface | null = null;
  /**
   * Platform operator, verified by AUTH USER (resolvePlatformOperator), never
   * by an email string. Drives the Admin shield and the operator status dots.
   * Fails closed: any lookup failure is "not an operator".
   */
  let isOperator = false;
  if (!isFullBleed) {
    const cookieStore = await cookies();
    // Path-based tenant slug (Phase 1): `/t/<slug>/...` URLs anchor the shell to
    // that tenant's manifest regardless of the viewer's home tenant.
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
    profile = await timed("profile", safe("layout.profile", getActiveProfile(), null), perfSpans);
    // The verified platform-operator verdict (alias AND owner/admin OASIS
    // membership by auth id), started now and awaited by the two readers
    // below: the /t/<slug> path override and the chat shell's admin flag. Only
    // an alias session pays its read, and it runs beside the others rather
    // than in front of them. Resolves false on any failure, loudly.
    const platformOperatorP = safe("layout.platform_operator", isPlatformOperator(), false);

    // Demo cookie is honoured ONLY when the viewer has no real tenant binding
    // (anonymous preview). Once `profile.tenant_id` exists, the cookie is
    // ignored and best-effort cleared. Best-effort because Server Components
    // can't always mutate cookies in Next 15 — middleware handles the durable
    // clear. The /demo/sun path used to force the SunBiz seed in as an explicit
    // opt-in, for every viewer; that page is a 404 since 2026-09-29 (F0
    // containment), so the opt-in went with it rather than wrap the retired
    // SunBiz brand and nav around the 404. Pinned by tests/f0-containment.test.ts.
    const operatorHasRealTenant = !!profile?.tenant_id;
    const rawDemoCookie = cookieStore.get(DEMO_CLIENT_PROFILE_COOKIE)?.value || null;
    const requestedDemoProfile = operatorHasRealTenant ? null : rawDemoCookie;

    if (rawDemoCookie && operatorHasRealTenant) {
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

    // Only the public SunBiz preview is a demo shell. A hand-set cookie naming
    // any other seed (e.g. "oasis-ai-cc") must not render OASIS's own nav to a
    // tenantless visitor.
    const normalisedDemo = (requestedDemoProfile || "").trim().toLowerCase();
    demoProfileSlug =
      DEMO_PROFILE_SLUGS.has(normalisedDemo) && SEED_MANIFESTS[normalisedDemo]
        ? normalisedDemo
        : null;

    const tenantId = profile?.tenant_id || null;
    // Validate primary_agent against the tenant's manifest-enabled agents
    // before using it for the heartbeat lookup. A corrupted profile carrying
    // primary_agent="atlas" or stale "bravo" would otherwise read another
    // tenant's heartbeat — cross-tenant signal leak. Fall back to the
    // manifest's primary slug (or first enabled) when the column is invalid.
    const manifestForAgent = await timed("manifest_scope", getTenantManifestForUser(tenantId), perfSpans);
    // Shared with /api/shell/status (lib/shell-status.ts) so the
    // manifest-validation guard on the agent slug cannot drift between the
    // sidebar label (resolved here) and the deferred live-dot lookup.
    resolvedPrimaryAgent = resolvePrimaryAgent(profile, manifestForAgent);

    // Resolve the operator's tenant slug FIRST so the path-override gate
    // below can share the same access policy the /t/[slug] page uses
    // (canPreviewTenantSlug). Tenants can override the raw slug via
    // custom_fields.command_center_profile_slug so one shell can render
    // different products cleanly.
    if (tenantId) {
      tenantProfileSlug = await timed("tenant_slug", safe(
        "layout.tenant_profile_slug",
        (async () => {
          // Was a second raw SELECT on `tenants` for columns the memoized read
          // already returns. getTenantManifestForUser above bottoms out in
          // getTenant() for this same tenant id, and getTenant is React-cache()d
          // per request — so this is now a warm hit instead of another full
          // Turso round trip (measured ~140ms, 2026-09-01) on EVERY render of
          // EVERY page. Same columns, same null-on-error degradation the
          // surrounding safe() already expects.
          const tenant = await getTenant(tenantId);
          tenantName = tenant?.name ?? null;
          return resolveClientProfileSlug({
            slug: tenant?.slug || "",
            custom_fields: tenant?.custom_fields || {},
          });
        })(),
        null
      ), perfSpans);
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
          isPlatformOperator: await platformOperatorP,
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

    // Chat props + persona stay blocking: the persona filters the nav
    // (correctness, not cosmetics) and the chat shell needs its props to
    // render at all. The agent-heartbeat + bridge reads moved OUT of the
    // layout to /api/shell/status, fetched by the Sidebar after first
    // paint (P1 instant-load, 2026-09-01): they are cosmetic chrome, and
    // the bridge check is internally sequential (two round trips), so
    // they were the long pole of this block on every full page load. The
    // "online means last_seen_at within 5 minutes" definition still lives
    // solely in the shared bridge helper (lib/queries.ts), now called by
    // the status route instead of here.
    //
    // The operator verdict is the one platformOperatorP computed above (the
    // verified check: alias AND an OASIS owner/admin profile by auth id). It
    // gates the tenant preview, the chat props and the Admin rail alike — one
    // decision, awaited here, never a second email-based guess.
    const chatProfile = profile;
    const [chatPropsResolved, surfaceResolved, operatorResolved] = await timed("side_channels", Promise.all([
      safe(
        "layout.chat_props",
        platformOperatorP.then((platformOperator) =>
          resolveChatShellProps({
            profile: chatProfile,
            userEmail: chatProfile?.email,
            isPlatformOperator: platformOperator,
          }),
        ),
        null,
      ),
      safe("layout.viewer_surface", resolveViewerSurface(), null),
      platformOperatorP,
    ]), perfSpans);
    chatProps = chatPropsResolved;
    viewerSurface = surfaceResolved;
    navPersona = surfaceResolved?.ok ? surfaceResolved.persona : null;
    isOperator = operatorResolved === true;
    // tenantProfileSlug already resolved above so canPreviewTenantSlug
    // could use it on the path-override gate. Nothing more to do here.
  }
  const demoMode = !!demoProfileSlug;
  const manifestSlug = demoMode
    ? demoProfileSlug
    : pathOverrideSlug ?? tenantProfileSlug;
  // The rail's Connections dot, for the owners and admins who get the door
  // (showConnections below): one summary of the statuses Settings > Connections
  // shows (lib/os/connectors.ts connectionsHealth), started here so it runs
  // beside the manifest read instead of after it. Null is no dot: nothing set
  // up, an unverified app or a failed read is never drawn green.
  const surfaceForConnections = viewerSurface?.ok ? viewerSurface : null;
  const connectionsStatusP: Promise<ConnectionsStatus | null> =
    !isFullBleed && !demoMode && !pathOverrideSlug && navPersona === "founder" && surfaceForConnections
      ? timed(
          "connections",
          safe(
            "layout.connections_status",
            withDeadline(
              loadConnectorFacts({ tenantId: surfaceForConnections.tenantId, userId: surfaceForConnections.userId }).then(
                (facts) => connectionsDot(connectionsHealth(facts, Date.now())),
              ),
              RAIL_CONNECTIONS_DEADLINE_MS,
              "layout.connections",
            ),
            null,
          ),
          perfSpans,
        )
      : Promise.resolve(null);
  // The viewer's tenant id lets an OASIS operator whose tenant-slug read
  // degraded (manifestSlug null → "default") keep OASIS_SEED instead of the
  // unprovisioned placeholder; it changes nothing for any other tenant.
  const manifest = isFullBleed
    ? null
    : await timed("manifest", getManifest(manifestSlug, profile?.tenant_id ?? null), perfSpans);
  const connectionsMeasured = await connectionsStatusP;
  // One `[perf]` line per shell render: the measured session tax. This is
  // the P1 before/after number; remove only when the instant-load work ends.
  logPerfSummary("layout", pathname, perfSpans, Date.now() - perfT0);

  // Founders portal nav. Injected here rather than added to CC_NAV because
  // OASIS_SEED.nav IS navToManifest(CC_NAV) and getSeedManifest() falls back to
  // OASIS_SEED for ANY unrecognised slug — so an entry in CC_NAV would render a
  // Marketing tab for every newly-onboarded tenant before their manifest exists.
  // The route would 404 them (fail-closed), but the tab itself would advertise
  // that a founders portal exists, which is exactly what this must not do.
  //
  // Calls the SAME gate the /founders/marketing route calls, so the tab can
  // never render for someone the route would reject.
  //
  // Being a founder is necessary but NOT sufficient: manifestSlug below is
  // `pathOverrideSlug ?? tenantProfileSlug`, so a founder browsing /t/sun/...
  // sees the SunBiz-branded sidebar. Rendering the tab there would paint a
  // Founders entry onto SunBiz's own portal — no data leak, but it advertises
  // the portal exists to anyone looking at that screen, which is exactly what
  // choosing 404-over-403 was meant to prevent. shouldShowFoundersNav() adds
  // the own-shell-only condition and is unit-tested.
  // Uses the `profile` this layout already loaded rather than calling
  // isFounder(), which would re-run getActiveProfile() and cost a second
  // Supabase round-trip on every authenticated page render. Same decision, same
  // pure predicate — this is exactly why the check was split out of the
  // session-touching wrapper.
  const foundersGateOpen = shouldShowFoundersNav({
    // TENANT **AND** CAPABILITY, matching lib/founders/gate.ts. The tenant
    // check alone showed the Marketing tab to everyone standing in the OASIS
    // workspace — including the 43 `member` profiles — while the page itself
    // 404s them. A visible tab over a dead page is the inverse of the leak this
    // codebase guards against, and it is how CC first noticed the marketing
    // hire could not get in: the tab was there, the page was not.
    //
    // navPersona is null before a persona resolves (demo shells, pre-auth), and
    // that falls back to the tenant answer alone — the nav is cosmetic and the
    // page gate is the real wall.
    isFounder:
      isFounderTenant(profile?.tenant_id, foundersAllowlist()) &&
      (navPersona === null || SURFACE_CAPABILITIES[navPersona].canSeeMarketing),
    isFullBleed,
    demoMode,
    pathOverrideSlug,
    tenantProfileSlug,
  });
  // Finances is narrower than the founders gate: only the two owners.
  // Cosmetic here — its pages 404 for anyone else (access-io.ts).
  const financeOwner = isFinanceOwnerEmail(profile?.email);
  // Rows for the manifest shell (the /t/<own-slug> path only — demo and
  // preview shells close the gate above). The OS rail carries the same two
  // gates as Growth › Content and Money › Overview, via buildOsNav's
  // `founders` input below.
  const foundersNavItems: NavItem[] = foundersGateOpen
    // Labels and hrefs come from FOUNDERS_NAV, NOT from a second hardcoded list
    // here. Hardcoding them is what let the sidebar and the header chips in
    // app/founders/layout.tsx disagree in PR #175, and what put an inactive
    // shell into CC's primary nav labelled "Marketing" while the live hub was
    // relabelled "Content". One list, both navs.
    ? FOUNDERS_NAV
        .filter((n) => n.audience !== "finance_owners" || financeOwner)
        .map(({ audience: _audience, ...n }) => ({ group: "Founders", ...n }))
    : [];

  // ── OASIS OS rail ────────────────────────────────────────────────────────
  // Every workspace's OWN shell renders the OS rail, computed by the pure
  // buildOsNav from the viewer's persona, capabilities, operator status,
  // workspace and modules. The /t/<slug> path shells and the demo shell keep
  // the manifest nav: they render a workspace's stored manifest (another tenant's,
  // for a preview), and demo mode rewrites every link to the demo landing.
  //
  // An unprovisioned workspace (UNPROVISIONED_SEED) gets Today only, and a
  // viewer whose persona did not resolve gets the same — buildOsNav fails
  // closed on both rather than guessing.
  const osShell = !isFullBleed && !!manifest && !demoMode && !pathOverrideSlug;
  const viewerTenantSlug = viewerSurface?.ok ? viewerSurface.tenantSlug : null;
  const provisioned = !!manifest && !isUnprovisionedManifest(manifest);
  // Connections are workspace configuration: owners/admins only.
  const showConnections = osShell && provisioned && navPersona === "founder";
  const osSections: OsNavSection[] | null = osShell
    ? buildOsNav({
        persona: navPersona,
        capabilities: viewerSurface?.ok ? viewerSurface.capabilities : null,
        isOperator,
        tenantSlug: viewerTenantSlug,
        isOasisTenant: isOasisSurfaceTenant(viewerTenantSlug),
        modules: resolveOsModules({ tenantSlug: viewerTenantSlug, provisioned }),
        provisioned,
        founders: { content: foundersGateOpen, finances: foundersGateOpen && financeOwner },
      })
    : null;
  // The workspace's OWN name first (tenants.name), then its manifest brand,
  // then the viewer's profile brand (2026-09-30). The profile brand used to
  // win, and every account path defaulted it to "OASIS AI", so a client's
  // header could read as OASIS's. The legacy default counts as unnamed outside
  // OASIS's own workspaces (lib/provisioning/workspace-name.ts).
  const ownWorkspaceName = workspaceDisplayName({
    tenantName,
    manifestBrand: manifest?.brand.name,
    profileBrand: profile?.brand,
    isOasisWorkspace: isOasisSurfaceTenant(viewerTenantSlug ?? tenantProfileSlug),
  });
  const osWorkspaceName = ownWorkspaceName;
  // The chat-shell-vs-constrained <main> decision lives in MainShell (a CLIENT
  // component using usePathname) — NOT here. This root layout is a Server
  // Component that reads headers() once per full load and does NOT re-render on
  // soft navigation, so deciding the layout mode here froze it at the
  // first-loaded path: loading /agent (chat shell) then clicking another tab
  // left that tab rendering full-bleed inside the frozen Agents <main>. See
  // components/MainShell.tsx. (This is the real cause behind the recurring
  // "every tab looks zoomed-in" report — two prior width-only fixes couldn't
  // fix a decision that was frozen at load time.)

  // suppressHydrationWarning below covers the boot scripts that deliberately
  // mutate <html> before React hydrates: SIDEBAR_BOOT_SCRIPT writes
  // data-sidebar, and the marketing layout writes className="js". Both run
  // pre-paint by design — that is the whole point of a boot script — so the
  // server markup cannot match, and React logged a hydration error on every
  // page load because of it. The suppression is one level deep: it silences
  // <html>'s own attributes and nothing inside the tree.
  return (
    <html lang="en" suppressHydrationWarning>
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
      {/* `grain` is gone entirely, not merely scoped. It drew a fixed 40px
          grid across the viewport, and a previous pass narrowed it to the
          dashboard because it tiled a checkerboard behind the public site.
          The grid is a named AI-generated tell, so the rule behind it has
          been deleted from globals.css and the class would now resolve to
          nothing. Removing the attribute keeps markup honest about that. */}
      <body>
        {/* First-party web-vitals beacon (P0). Renders nothing; posts
            TTFB/LCP/INP/CLS to /api/perf/vitals. First-party rather than
            @vercel/speed-insights because the Cloudflare cutover is in
            flight — this survives the host move. */}
        <PerfVitals />
        <ClientErrorReporter />
        {isFullBleed || !manifest ? (
          children
        ) : (
          <>
            {/* Brand + primary-agent resolution (fixed 2026-05-25
                Codex review caught a P2 in the first attempt — using
                bare pathOverrideSlug also fires on the OWNER'S OWN
                tenant route, which would override Matt's saved
                profile.brand customization on /t/sun/* when he owns
                that slug. The correct distinction is "is the URL
                tenant DIFFERENT from the user's own tenant" — that's
                the preview case. Owned tenant routes still use the
                operator's saved profile values. */}
            <SidebarShell
              brand={
                demoMode || (pathOverrideSlug && pathOverrideSlug !== tenantProfileSlug)
                  ? manifest.brand.name
                  : ownWorkspaceName
              }
              logo={manifestLogoToSidebarLogo(manifest.brand.logo)}
              subtitle={manifest.brand.subtitle}
              // Persona narrowing is the LAST step, applied to the fully
              // assembled list, so it cannot be bypassed by a future nav source
              // that forgets to filter itself. It REMOVES rows rather than
              // disabling them: a greyed row still announces the surface exists,
              // and `enabled: false` items have shipped visible here before.
              //
              // It also closes a real hole above. foundersNavItems is gated on
              // TENANT identity (FOUNDERS_TENANT_IDS) and reps share OASIS's own
              // workspace — so without this a contractor on oasis-webdev would
              // get a Marketing tab into the founders portal. The gate in
              // lib/founders/gate.ts is the wall; this is the sign on it.
              //
              // A null navPersona (demo shells, pre-auth) means "do not narrow";
              // filterNavForPersona owns that case.
              items={filterNavForPersona(
                [...manifestNavToNavItems(manifest.nav), ...foundersNavItems],
                navPersona,
              )}
              // The OS rail. When set, Sidebar renders it instead of `items`
              // (the manifest nav above is then only the preview/demo shells').
              sections={osSections}
              isOperator={isOperator}
              showConnections={showConnections}
              connectionsStatus={showConnections ? connectionsMeasured : null}
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
                  : (resolvedPrimaryAgent || manifestPrimaryAgentSlug(manifest) || "bravo")
              }
              primaryAgentLive={false}
              bridgeOnline={false}
              deferStatus={
                // The dots self-resolve from /api/shell/status after paint
                // (P1 instant-load). They describe OASIS's own machinery and
                // now live in the operator's Admin view, so only a platform
                // operator on their own OS shell pays for the read (it costs
                // 1.5-2.5 s). Never in demo/preview shells: the indicator
                // would read the OPERATOR's heartbeat under a previewed
                // tenant's agent label.
                osShell && isOperator
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
              // "Workspace › Page" + Ask, on the OS shell only. Ask appears
              // only when this viewer's rail has the Chief of Staff channel.
              header={
                osSections
                  ? {
                      workspace: osWorkspaceName,
                      entries: osNavRows(osSections).map(({ href, label }) => ({ href, label })),
                      askHref: askHrefFor(osSections),
                    }
                  : null
              }
            >
              {children}
            </MainShell>
          </>
        )}
      </body>
    </html>
  );
}
