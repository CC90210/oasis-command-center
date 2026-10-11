/**
 * GET /api/connections/[provider]/authorize - start an app install / OAuth
 * consent for the signed-in owner's workspace, then send the browser to the
 * vendor's own authorization page.
 *
 * Owner/admin only (lib/connections/access.ts); the tenant and user come from
 * the session and are bound into a signed, single-use consent state
 * (lib/connections/oauth.ts startAuthorize). Refused, before anything is
 * written, when:
 *   - the provider is not live on this deployment (it needs OASIS's own app
 *     secrets for that vendor: registry.providerAvailability);
 *   - CONNECTIONS_OAUTH_STATE_SECRET or the provider's app credentials are
 *     missing (no fallback secret, ever);
 *   - OASIS has no finish step for the provider (Slack's install, or the
 *     generic sign-in of QuickBooks, Xero, Zoom and WhatsApp), so a consent
 *     that could never complete is never started.
 *
 * Slack lands back on Settings > Chat apps with a reason code. The generic
 * sign-ins run in a popup, so a refusal answers with the popup page that tells
 * the hub (lib/connections/popup.ts), never a JSON error page in a small window.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveProvider } from "@/lib/connections/service";
import { resolveConnectionsActor, routeFailure } from "@/lib/connections/route-helpers";
import { OAuthFlowError, startAuthorize } from "@/lib/connections/oauth";
import { GENERIC_OAUTH_PROVIDER_IDS, scopesForDepartments } from "@/lib/connections/registry";
import { appOrigin, connectionPopupResult } from "@/lib/connections/popup";
import { installReturnPath, INSTALL_PROVIDERS } from "@/lib/slack/routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(origin: string | null, provider: string, status: "error", reason: string): NextResponse {
  if (!origin) {
    return NextResponse.json({ ok: false, error: reason }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  if (GENERIC_OAUTH_PROVIDER_IDS.includes(provider)) return connectionPopupResult({ provider, status, reason, origin });
  const url = new URL(installReturnPath(provider), origin);
  url.searchParams.set(provider, status);
  url.searchParams.set("reason", reason);
  return NextResponse.redirect(url, { status: 303, headers: { "cache-control": "no-store" } });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  let origin: string | null = null;
  try {
    origin = appOrigin();
  } catch (err) {
    console.error("[connections.authorize] PUBLIC_APP_URL is not set", err instanceof Error ? err.message : err);
  }
  try {
    const { provider: providerId } = await ctx.params;
    const resolved = await resolveConnectionsActor();
    if (!resolved.ok) {
      // A popup shows a sentence, not a JSON body: the status maps to the hub's own words.
      if (origin && GENERIC_OAUTH_PROVIDER_IDS.includes(providerId)) {
        // A profile-store or database outage answers 503, not 401/403: it is
        // not "signed out" or "not an owner" (route-helpers.ts's own comment),
        // so it gets its own honest reason instead of falling into admin_only
        // (Codex review, PR #574).
        const reason =
          resolved.response.status === 401 ? "login_required" : resolved.response.status === 403 ? "admin_only" : "oasis_unavailable";
        return connectionPopupResult({ provider: providerId, status: "error", reason, origin });
      }
      return resolved.response;
    }
    if (!origin) return back(null, providerId, "error", "app_url_missing");
    const provider = resolveProvider(providerId);
    if (!provider.ok) {
      return back(origin, providerId, "error", provider.result.body.error === "coming_soon" ? "not_configured" : "unknown_provider");
    }
    const id = provider.provider.id;
    if (!INSTALL_PROVIDERS.includes(id) && !GENERIC_OAUTH_PROVIDER_IDS.includes(id)) return back(origin, providerId, "error", "no_install_flow");

    const redirectUri = `${origin}/api/connections/${id}/callback`;
    try {
      const started = await startAuthorize(resolved.deps.db, {
        provider: provider.provider,
        tenantId: resolved.actor.tenantId,
        userId: resolved.actor.userId,
        scopes: scopesForDepartments(provider.provider, []),
        redirectUri,
        now: resolved.deps.now(),
      });
      return NextResponse.redirect(started.url, { status: 303, headers: { "cache-control": "no-store" } });
    } catch (err) {
      if (err instanceof OAuthFlowError) return back(origin, id, "error", err.code);
      throw err;
    }
  } catch (error) {
    return routeFailure("api/connections/authorize", error);
  }
}
