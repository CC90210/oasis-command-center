/**
 * Auth middleware — gates every page behind a Supabase session.
 *
 * Public routes: auth pages, public webhooks, install scripts, brand assets.
 * Everything else redirects to /login when there's no session.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { matchesPathPrefix } from "./lib/path-prefix";
import { shouldRedirectToOnboarding } from "./lib/onboarding-gate";

export const PUBLIC_PATH_PREFIXES = [
  "/welcome",              // public marketing landing
  "/download",             // public OASIS Desktop downloads
  "/configure",            // public agent configurator (pre-signup)
  "/demo/sun",             // public Sun Biz review shell; demo data only
  "/unsubscribe",          // CASL-compliant email unsubscribe landing — reached from email footers (DEFAULT_UNSUBSCRIBE_BASE in BEA/scripts/casl_compliance.py). Recipients may not have an account; the confirmation page reads ?email=&brand=&token= from the URL and POSTs to /api/unsubscribe (also public, service-role insert into email_suppressions). MUST be public or every unsub link 401s before the form renders, which is itself a CASL violation.
  "/api/unsubscribe",      // companion API for /unsubscribe — POST records the suppression via service-role Supabase client. Token-validated INSIDE the route when OASIS_UNSUBSCRIBE_HMAC_SECRET is set; otherwise email-only opt-out is accepted (matches the URL format casl_compliance.py emits today).
  "/login",
  "/signup",
  "/forgot-password",
  "/auth/callback",
  "/auth/reset-password",
  "/invite",               // Tenant-invite landing /invite/<token>. Token is opaque; preview RPC validates server-side (Phase A, master multi-tenant infra plan, 2026-05-17).
  "/api/inbound",          // n8n inbound webhook (Bearer-auth gated inside the route)
  "/api/auth/signout",
  "/api/auth/provision",   // legacy + setup-wizard provision (Bearer-auth gated inside)
  "/api/auth/provision-cli", // setup-wizard operator-account creation, called by install/bootstrap.py — CLI_SIGNUP_SECRET bearer gated INSIDE the route, no session. MUST be public or installer account-creation 401s before its secret check ("/api/auth/provision" can't cover the "-cli" suffix — matchesPathPrefix needs prefix+"/").
  "/api/auth/pair",        // setup-wizard pairing (Bearer-auth gated inside)
  "/api/auth/pair-code/redeem", // machine-facing pair-code redemption — the CODE is the auth (no session); the route is IP-rate-limited + code-shape-validated + single-use + 15-min TTL. MUST be public or every machine pairing 401s before reaching the handler (matchesPathPrefix won't let the `/api/auth/pair` entry cover `pair-code`). NOTE: the mint endpoint `/api/auth/pair-code` stays session-gated — only `/redeem` is public.
  "/api/demo/sun",         // sets Sun demo shell cookie; never exposes live tenant data
  "/api/download/desktop", // public OS-aware desktop download redirect
  "/api/bridge",           // local-bridge daemon heartbeat (Bearer token gated inside)
  "/api/cron-jobs/poll",   // local-bridge cron poll — Bearer bridge_pairings token gated + rate-limited INSIDE the route (resolveBridge), no session. MUST be public or the bridge's cron poll 401s before its bearer-auth runs (the `/api/cron` entry can't cover it — matchesPathPrefix needs prefix+"/", and it's `cron-jobs`). This is what blocks all cron automations from firing. Only `/poll` is public; the session-authed `/api/cron-jobs` CRUD stays gated.
  "/api/integrations/registry",  // canonical service+env_key list — used by the bridge to decide what to ping; non-sensitive (names only, no values), 5min Cache-Control
  "/api/integrations/constant-contact/callback",  // OAuth return leg from Constant Contact. The provider's cross-site redirect may not carry the app session cookie, so the middleware must NOT 401 it before the handler runs (verified failure mode 2026-07: the callback returned {ok:false,error:unauthorized} and the token exchange never fired). The route self-authenticates via a signed state (HMAC + 15-min replay window) + the PKCE verifier cookie — see app/api/integrations/constant-contact/callback/route.ts. Only /callback is public; /authorize + /status stay session-gated.
  "/api/exec-override",    // POST = external HMAC fallback for override approvals; GET is now session-gated inside the route (Codex pass 4, 2026-05-18).
  "/api/outbound/log",     // outbound logging from local backend (HMAC auth inside)
  "/api/internal/apply-extraction", // VPS extraction daemon → applies extracted fields. HMAC (OASIS_OUTBOUND_HMAC_SECRET) gated INSIDE the route, no session — MUST be public or the daemon's callback 401s here before its signature check ever runs, and no dropped application ever applies. The companion poll route /api/extraction-jobs/[job_id] stays session-gated (operator-facing).
  // /api/event-feed removed from public allowlist 2026-05-18 (Codex
  // pass 4): payloads carry record IDs / lead context / command
  // summaries — not safe for unauthenticated callers. Route now
  // requires a session.
  "/api/quests",           // OASIS Town Quest Log polls ACTIVE_TASKS.md mirror. Read-only, public for Phase 5 proof-of-life.
  "/api/track",            // Email-open tracking pixel (Phase 19 SunBiz CRM, 2026-05-17). Must be public — mail clients fetch the pixel without a session. Route resolves tenant_id by lookup against the interaction row (never trusts the URL parameter) and always returns a 1x1 GIF, so 401-gating it would silently break every operator's open-rate tracking. Migration 050 dedupes by (outbound_message_id, ip_hash) so a known reservation_id can't be replayed to inflate row counts.
  "/api/health",           // Liveness probe — Docker healthcheck, the desktop wizard's "dashboard reachable?" check, any external uptime monitor. The route returns a static JSON status with no sensitive payload, so 401-gating it would silently break health monitoring across the deploy.
  // /api/forms is intentionally NOT a public prefix — /api/forms (list),
  // /api/forms/[id] (CRUD), and /api/forms/[id]/mint-link are all
  // admin-only (session-authed). The two PUBLIC form endpoints below
  // are listed explicitly so middleware passes them through while
  // keeping the admin routes session-gated. Both authenticate via an
  // HMAC-signed token in the request body (NOT a session cookie) so
  // prospects can fill out the personalized form without an OASIS
  // account. Without these allowlist entries the entire public
  // application-form flow returns 401 — every inbound SunBiz lead
  // gets a broken form.
  "/api/forms/submit",     // POST per-step → inserts form_submissions row + maybe stage-transitions the lead.
  "/api/forms/upload-url", // POST HMAC-token file upload signer for public form direct-to-Storage uploads.
  "/api/forms/view",       // POST on form-page mount → records form_views + fires viewed_application drip.
  "/api/forms/address-autocomplete", // GET ?q=… → server-side address-autocomplete proxy for the public form. Public (the personalized form isn't session-authed) and IP rate-limited; returns only formatted-address strings, never provider keys (those stay server-side). See app/api/forms/address-autocomplete/route.ts.
  "/f/",                   // Public prospect-facing form pages. Two shapes: /f/<tenant>/<form>/<lead_token> (personalized, HMAC-signed via Solara mint) and /f/<tenant>/<form> (anonymous share — server creates a fresh lead on submit). Both must be reachable without a session cookie or every inbound form return 401 — verified failure mode 2026-05-18 (CC opened a copied link in incognito and landed on /login).

  "/api/cron",
  "/api/agents/operator-email/connect-imap", // operator mailbox connect (app-password). Self-authenticates INSIDE the route: Bearer SCAN_TRIGGER_SECRET (admin seed) OR the operator's own session. MUST be public or the admin-seed bearer path 401s here before its own auth runs (verified 2026-07: returned {ok:false,error:unauthorized}). Session self-serve still works either way. Runs IMAP+SMTP verify before storing; password never returned.
  "/api/cold-sending/",    // COLD/marketing sending pool (separate domains). Both sub-routes (/mailboxes, /blast) self-authenticate INSIDE: Bearer SCAN_TRIGGER_SECRET (admin/automation seed) OR a signed-in ADMIN session. MUST be public or the bearer-seed path 401s before its own auth runs (same failure mode as connect-imap). Trailing slash → covers every /api/cold-sending/* sub-path.
  "/api/webhook",          // public webhooks for clients (HMAC/Bearer gated inside)
  "/api/webhooks/",        // inbound provider webhooks — Kixie / TextTorrent / Twilio (and future). Each route self-authenticates via a timing-safe HMAC signature check INSIDE the route, so the prefix is public. Trailing slash → matchesPathPrefix covers every /api/webhooks/* sub-path. MUST be public or registered Kixie/TT/Twilio callbacks 401 before their signature verification runs — the singular "/api/webhook" entry can't cover the plural "/api/webhooks/" (matchesPathPrefix needs prefix+"/").
  "/_next",
  "/favicon",
];

const MARKETING_REDIRECT_TARGET = "/welcome"; // unauthed home goes here, not login

// Public static-asset extensions. Anything served from /public with one of
// these suffixes is allowed without auth — install scripts (curl|bash) and
// brand assets MUST be reachable anonymously.
const PUBLIC_FILE_EXTENSIONS = [
  ".sh", ".ps1",                              // install one-liners
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",  // images
  ".txt", ".webmanifest", ".xml", ".json",    // robots / manifests
  ".woff", ".woff2", ".ttf",                  // fonts
];

/**
 * Match `pathname` against the prefix set.
 *
 * IMPORTANT: a naive `pathname.startsWith(prefix)` over-matches. The
 * 2026-05-21 audit caught `"/api/cron"` letting `/api/cron-jobs/*`
 * through because "cron-jobs" starts with "cron". The route's own
 * resolveTenantId() check still 401'd unauthenticated callers, but
 * the middleware-level defence-in-depth was silently disabled for
 * every cron-jobs sub-path. The matcher now requires either an exact
 * match OR the prefix followed by `/`, so `"/api/cron"` matches
 * `/api/cron` and `/api/cron/whatever` but NOT `/api/cron-jobs`.
 *
 * Prefixes that intentionally end in `/` (like `/f/`) keep working —
 * the exact-match case still hits and the prefix+`/` case is identical
 * to the original startsWith for those entries.
 */
export function isPublic(pathname: string): boolean {
  if (PUBLIC_PATH_PREFIXES.some((p) => matchesPathPrefix(pathname, p))) return true;
  const lower = pathname.toLowerCase();
  return PUBLIC_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Phase 6b/7 — redirect routes still folded into bigger surfaces.
  // /playbook was restored in V6.8.5 (app/playbook/page.tsx is daily-use,
  // not reference) so it no longer redirects. The remaining two really
  // are merged elsewhere and shouldn't be reachable at their old URLs:
  //   /feed → /operations         (Activity Tape is the same stream)
  //   /integrations → /settings   (setup under Settings)
  const REDIRECT_MAP: Record<string, string> = {
    "/feed": "/operations",
    "/integrations": "/settings",
  };
  if (pathname in REDIRECT_MAP) {
    return NextResponse.redirect(new URL(REDIRECT_MAP[pathname], req.url));
  }

  // Pass pathname through as a header so the root layout can decide whether
  // to render the dashboard shell vs full-bleed (marketing/auth) chrome.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", pathname);

  // Always allow public paths
  if (isPublic(pathname)) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const url = process.env.BRAVO_SUPABASE_URL;
  const anon =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.BRAVO_SUPABASE_ANON_KEY;
  // If env not configured (preview/local), let it through — page-level guards still run
  if (!url || !anon) return NextResponse.next({ request: { headers: requestHeaders } });

  // Canonical @supabase/ssr cookie-sync pattern.
  //
  // When auth.getUser() below detects an expired access token, it refreshes
  // it and asks us to persist the new cookie. We MUST write the refreshed
  // cookie to BOTH (a) the request stream — so downstream Server Components
  // reading cookies() inside this same request see the fresh token — AND
  // (b) the response — so the browser receives the new cookie for the next
  // request. Writing only to the response leaves Server Components reading
  // the stale expired token; their own auth.getUser() then returns null
  // and the page redirects to /login even though middleware just
  // successfully refreshed the session.
  //
  // Verified failure mode 2026-05-24 — /t/sun/applications click on an
  // active SunBiz session bounced to /login because the page-level
  // requireTenantPreviewAccess() saw the stale cookie after middleware
  // refreshed.
  //
  // Subtle: rebuild requestHeaders from req.headers AFTER the cookie
  // mutation. `requestHeaders` from line 114 was snapshotted before this
  // refresh fired, so reusing it would forward the original (now stale)
  // Cookie header to Server Components even though req.cookies.set
  // already updated the live req.headers Cookie value. Codex review
  // caught this in the first iteration of the fix.
  let res = NextResponse.next({ request: { headers: requestHeaders } });
  const supa = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(toSet) {
        toSet.forEach(({ name, value }) => req.cookies.set(name, value));
        const refreshedHeaders = new Headers(req.headers);
        refreshedHeaders.set("x-pathname", pathname);
        res = NextResponse.next({ request: { headers: refreshedHeaders } });
        toSet.forEach(({ name, value, options }) =>
          res.cookies.set({ name, value, ...options })
        );
      },
    },
  });

  const { data, error } = await supa.auth.getUser();

  // Cross-tenant view leak hardening (2026-05-16):
  //
  // The `oasis_demo_client_profile` cookie was originally a Sun Biz pitch
  // surface — anonymous prospects hitting /demo/sun get the SunBiz shell
  // for 8 hours. Failure mode: an authenticated operator who once touched
  // /demo/sun came back signed in, and the stale cookie hijacked their
  // shell into SunBiz for the remaining cookie TTL even though their auth
  // was their real OASIS account (RLS still protected the data; only the
  // chrome was wrong, but it routed `/api/sms/send` etc. as SunBiz which
  // is a real integrity hazard).
  //
  // Rule: an authenticated user on a non-/demo path gets the cookie
  // cleared on the response. /demo/sun itself is exempted so the
  // anonymous preview keeps working. The layout has a defense-in-depth
  // copy of this rule for the page render, but the middleware clear is
  // the durable one — Server Component cookie writes silently no-op in
  // some Next 15 contexts, so the layout-side clear can't be relied on.
  if (
    !error &&
    data.user &&
    !pathname.startsWith("/demo/sun") &&
    req.cookies.get("oasis_demo_client_profile")?.value
  ) {
    res.cookies.set("oasis_demo_client_profile", "", {
      maxAge: 0,
      path: "/",
    });
  }

  if (error || !data.user) {
    // For /api/* requests return 401 JSON so client fetch() sees a real
    // error (not an HTML redirect that breaks .json()). For pages,
    // redirect to /login.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "unauthorized" },
        { status: 401 }
      );
    }
    // For the home page, send unauthed visitors to the marketing landing.
    // For deep links into the app, send them to login with a return path.
    if (pathname === "/" || pathname === "") {
      return NextResponse.redirect(new URL(MARKETING_REDIRECT_TARGET, req.url));
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Onboarding gate: if the user signed up but never finished the wizard
  // (closed the tab between /signup and /onboarding's "Finish" button),
  // force-route them back to /onboarding for any non-API page request.
  //
  // Performance: a per-request DB query through the user-JWT supa client
  // adds ~30-80ms to every page load. Optimization: cache the "onboarded"
  // decision in an HttpOnly cookie. First page load after sign-in still
  // hits DB; every subsequent load is cookie-only. If the user clears
  // cookies, the next page hits DB and re-sets the cookie.
  //
  // The cookie value is non-sensitive — it's purely a UX redirect gate.
  // A spoofed cookie just lets the user bypass /onboarding (no security
  // impact). HttpOnly + SameSite=Lax keeps casual JS / cross-site reads
  // out, even though there's no real secret to protect here.
  //
  // Exempted paths:
  //   - /onboarding itself (and sub-paths) — the wizard's destination
  //   - /api/* — the wizard's own writes (PATCH /api/profile etc) must
  //     not get bounced
  //   - public path set (handled above by isPublic)
  //
  // Failures fall through silently: a broken gate is worse than a missed
  // redirect.
  const ONBOARDED_COOKIE = "oasis_onboarded";
  const onboardedHint = req.cookies.get(ONBOARDED_COOKIE)?.value;
  const checkOnboarding =
    !pathname.startsWith("/api/") &&
    pathname !== "/onboarding" &&
    !pathname.startsWith("/onboarding/") &&
    onboardedHint !== "1";

  if (checkOnboarding) {
    try {
      const { data: profile } = await supa
        .from("user_profiles")
        .select("onboarding_completed_at, invited_by, tenant_id")
        .eq("auth_user_id", data.user.id)
        .maybeSingle();
      // Gate decision is centralised in lib/onboarding-gate.ts so it's
      // testable in isolation. Returns the redirect path or null.
      const redirectPath = shouldRedirectToOnboarding(profile);
      if (redirectPath) {
        return NextResponse.redirect(new URL(redirectPath, req.url));
      }
      if (profile && profile.onboarding_completed_at) {
        // Cache the decision so subsequent page loads skip the DB query.
        // 30-day TTL is plenty — the only thing that invalidates it is
        // the user explicitly resetting their profile, which would also
        // require them to re-onboard. Path=/ so every route sees it.
        res.cookies.set(ONBOARDED_COOKIE, "1", {
          httpOnly: true,
          sameSite: "lax",
          secure: true,
          maxAge: 60 * 60 * 24 * 30,
          path: "/",
        });
      }
    } catch {
      // If the profile query fails (transient DB), let the page render —
      // page-level guards still run and the worst case is the user sees
      // an empty dashboard instead of being trapped on /onboarding.
    }
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
