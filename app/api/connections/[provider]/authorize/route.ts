/**
 * GET /api/connections/[provider]/authorize - start an app install / OAuth
 * consent for the signed-in owner's workspace, then send the browser to the
 * provider.
 *
 * Owner/admin only (lib/connections/access.ts); the tenant and user come from
 * the session and are bound into a signed, single-use consent state
 * (lib/connections/oauth.ts startAuthorize). Refused, before anything is
 * written, when:
 *   - the provider is not live on this deployment (Slack needs OASIS's Slack
 *     app secrets: registry.providerAvailability);
 *   - CONNECTIONS_OAUTH_STATE_SECRET or the provider's app credentials are
 *     missing (no fallback secret, ever);
 *   - OASIS has no finish step for the provider yet (only Slack does), so a
 *     consent that could never complete is never started.
 *
 * A browser navigation lands back on the provider's settings page with a
 * reason code (?slack=error&reason=...), never on a JSON error page.
 *
 * WHOSE SLACK APP. A workspace that saved its own Slack app (Settings >
 * Connections > Slack) installs THAT app: its client ID goes to Slack and its
 * secret finishes the install (lib/slack/own-app.ts slackInstallEnv). With
 * nothing saved, OASIS's app, exactly as before. A half-saved or unreadable
 * app is refused, never swapped for OASIS's.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveProvider } from "@/lib/connections/service";
import { resolveConnectionsActor, routeFailure } from "@/lib/connections/route-helpers";
import { OAuthFlowError, startAuthorize } from "@/lib/connections/oauth";
import { scopesForDepartments } from "@/lib/connections/registry";
import { appOrigin } from "@/lib/connections/popup";
import { installReturnPath, INSTALL_PROVIDERS } from "@/lib/slack/routing";
import { slackInstallEnv, slackInstallsPossible } from "@/lib/slack/own-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(origin: string | null, provider: string, status: "error", reason: string): NextResponse {
  if (!origin) {
    return NextResponse.json({ ok: false, error: reason }, { status: 400, headers: { "cache-control": "no-store" } });
  }
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
    if (!resolved.ok) return resolved.response;
    if (!origin) return back(null, providerId, "error", "app_url_missing");
    let env: Readonly<Record<string, string | undefined>> = process.env;
    if (providerId === "slack") {
      const install = await slackInstallEnv(resolved.actor.tenantId);
      if (!install.ok) return back(origin, providerId, "error", install.reason);
      // The workspace's own app is saved, but no install can run here (no
      // consent-state secret): say that, not that OASIS's app is missing.
      if (install.app === "own" && !slackInstallsPossible(install.env)) return back(origin, providerId, "error", "installs_unavailable");
      env = install.env;
    }
    const provider = resolveProvider(providerId, env);
    if (!provider.ok) {
      return back(origin, providerId, "error", provider.result.body.error === "coming_soon" ? "not_configured" : "unknown_provider");
    }
    if (!INSTALL_PROVIDERS.includes(provider.provider.id)) return back(origin, providerId, "error", "no_install_flow");

    const redirectUri = `${origin}/api/connections/${provider.provider.id}/callback`;
    try {
      const started = await startAuthorize(resolved.deps.db, {
        provider: provider.provider,
        tenantId: resolved.actor.tenantId,
        userId: resolved.actor.userId,
        scopes: scopesForDepartments(provider.provider, []),
        redirectUri,
        now: resolved.deps.now(),
        env,
      });
      return NextResponse.redirect(started.url, { status: 303, headers: { "cache-control": "no-store" } });
    } catch (err) {
      if (err instanceof OAuthFlowError) return back(origin, provider.provider.id, "error", err.code);
      throw err;
    }
  } catch (error) {
    return routeFailure("api/connections/authorize", error);
  }
}
