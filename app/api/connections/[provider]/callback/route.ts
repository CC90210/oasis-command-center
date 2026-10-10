/**
 * GET /api/connections/[provider]/callback - where the vendor sends the browser
 * back after an install / consent.
 *
 *   ?error=...          the person cancelled on the vendor's page: nothing
 *                       is connected; the state is left to expire.
 *   ?code=&state=       finished and verified against the SIGNED-IN person:
 *                       the state is verified and consumed (single-use), and
 *                       it must name that person and their workspace, so a
 *                       consent started by someone else can never be finished
 *                       into this workspace (or this one into theirs).
 *
 * Slack finishes through lib/slack/install.ts and lands back on Settings > Chat
 * apps. QuickBooks, Xero, Zoom and WhatsApp finish through
 * lib/connections/oauth-connect.ts and answer with the popup page that tells
 * the hub the result (lib/connections/popup.ts). The code, the state and every
 * token stay out of every redirect and log.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveProvider } from "@/lib/connections/service";
import { resolveConnectionsActor, routeFailure } from "@/lib/connections/route-helpers";
import { appOrigin, connectionPopupResult, type ConnectionPopupStatus } from "@/lib/connections/popup";
import { GENERIC_OAUTH_PROVIDER_IDS } from "@/lib/connections/registry";
import { completeOAuthConnect } from "@/lib/connections/oauth-connect";
import { completeSlackInstall } from "@/lib/slack/install";
import { installReturnPath } from "@/lib/slack/routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(origin: string, provider: string, status: ConnectionPopupStatus, reason?: string): NextResponse {
  if (GENERIC_OAUTH_PROVIDER_IDS.includes(provider)) return connectionPopupResult({ provider, status, reason, origin });
  const url = new URL(installReturnPath(provider), origin);
  url.searchParams.set(provider, status);
  if (reason) url.searchParams.set("reason", reason);
  return NextResponse.redirect(url, { status: 303, headers: { "cache-control": "no-store" } });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  try {
    const { provider: providerId } = await ctx.params;
    let origin: string;
    try {
      origin = appOrigin();
    } catch (err) {
      console.error("[connections.callback] PUBLIC_APP_URL is not set", err instanceof Error ? err.message : err);
      return NextResponse.json({ ok: false, error: "app_url_missing" }, { status: 500 });
    }
    const resolved = await resolveConnectionsActor();
    if (!resolved.ok) {
      // Same honesty as the authorize route: an outage (503) is not "signed
      // out, or not an owner", so it gets its own reason (Codex review, PR #574).
      const reason =
        resolved.response.status === 401
          ? "login_required"
          : resolved.response.status === 403
            ? "admin_only"
            : resolved.response.status === 503
              ? "oasis_unavailable"
              : "signed_out_or_not_allowed";
      return back(origin, providerId, "error", reason);
    }

    const q = req.nextUrl.searchParams;
    if (q.get("error")) return back(origin, providerId, "denied");

    const provider = resolveProvider(providerId);
    if (!provider.ok) return back(origin, providerId, "error", "not_configured");
    const id = provider.provider.id;
    const generic = GENERIC_OAUTH_PROVIDER_IDS.includes(id);
    if (id !== "slack" && !generic) return back(origin, providerId, "error", "no_install_flow");

    const code = (q.get("code") || "").trim();
    const state = (q.get("state") || "").trim();
    if (!code || !state) return back(origin, providerId, "error", "missing_code");

    const session = { tenantId: resolved.actor.tenantId, userId: resolved.actor.userId, email: resolved.actor.email };
    const redirectUri = `${origin}/api/connections/${id}/callback`;

    if (generic) {
      const done = await completeOAuthConnect(resolved.deps, { providerId: id, state, code, query: q, redirectUri, session });
      if (!done.ok) {
        console.error("[connections.callback] sign-in refused", { provider: id, tenantId: session.tenantId, failure: done.failure });
        return back(origin, id, "error", done.failure);
      }
      return back(origin, id, "connected");
    }

    const done = await completeSlackInstall(resolved.deps, { provider: provider.provider, state, code, redirectUri, session });
    if (!done.ok) {
      console.error("[connections.callback] slack install refused", {
        tenantId: resolved.actor.tenantId,
        failure: done.failure,
        detail: done.detail ?? null,
      });
      return back(origin, "slack", "error", done.failure);
    }
    return back(origin, "slack", "connected");
  } catch (error) {
    return routeFailure("api/connections/callback", error);
  }
}
