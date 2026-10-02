/**
 * GET /api/connections/[provider]/callback - where the provider sends the
 * browser back after an install / consent. Today: Slack only.
 *
 *   ?error=...          the person cancelled on the provider's page: nothing
 *                       is connected; the state is left to expire.
 *   ?code=&state=       finished by lib/slack/install.ts completeSlackInstall:
 *                       the state is verified and consumed (single-use), and
 *                       it must name the SIGNED-IN person and their workspace,
 *                       so a consent started by someone else can never be
 *                       finished into this workspace (or this one into theirs).
 *
 * Always lands the browser back on Settings > Chat apps with a status and, on a
 * refusal, a reason code. The code, the state and the token never appear in a
 * redirect or a log.
 *
 * The install finishes with the workspace's app by the same rule as the
 * authorize route (lib/slack/own-app.ts slackInstallEnv): OASIS's app for
 * OASIS's own workspaces, a client's own saved app for a client. A client with
 * no complete app is refused before its state is used or its code exchanged,
 * however the consent was started, and is never finished with OASIS's app.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveProvider } from "@/lib/connections/service";
import { resolveConnectionsActor, routeFailure } from "@/lib/connections/route-helpers";
import { appOrigin } from "@/lib/connections/popup";
import { completeSlackInstall } from "@/lib/slack/install";
import { installReturnPath } from "@/lib/slack/routing";
import { slackInstallEnv } from "@/lib/slack/own-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function back(origin: string, provider: string, status: "connected" | "denied" | "error", reason?: string): NextResponse {
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
    if (!resolved.ok) return back(origin, providerId, "error", "signed_out_or_not_allowed");

    const q = req.nextUrl.searchParams;
    if (q.get("error")) return back(origin, providerId, "denied");

    if (providerId !== "slack") return back(origin, providerId, "error", resolveProvider(providerId).ok ? "no_install_flow" : "not_configured");
    const install = await slackInstallEnv(resolved.actor.tenantId);
    if (!install.ok) return back(origin, providerId, "error", install.reason);
    const provider = resolveProvider(providerId, install.env);
    if (!provider.ok) return back(origin, providerId, "error", "not_configured");

    const code = (q.get("code") || "").trim();
    const state = (q.get("state") || "").trim();
    if (!code || !state) return back(origin, providerId, "error", "missing_code");

    const done = await completeSlackInstall(resolved.deps, {
      provider: provider.provider,
      state,
      code,
      redirectUri: `${origin}/api/connections/slack/callback`,
      session: { tenantId: resolved.actor.tenantId, userId: resolved.actor.userId, email: resolved.actor.email },
      env: install.env,
    });
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
